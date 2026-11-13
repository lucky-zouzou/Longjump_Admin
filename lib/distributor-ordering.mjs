import {distributorSalesContact} from './distributor-sales-contacts.mjs';
import {assertWritable, atomicBatch, guardStatement} from './atomic.mjs';
import {createWholesaleOrder, settlement, indonesiaDate, WholesaleError, canWholesale} from './wholesale.mjs';
import {publicPrice, stockForSku} from './wholesale-catalog.mjs';
import {hasPermission} from './permissions.mjs';

const hex=bytes=>Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
const digest=async text=>hex(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))));
const fail=(status,message)=>{throw new WholesaleError(status,message);};
const rows=async(db,sql,...args)=>(await db.prepare(sql).bind(...args).all()).results;
const enabledOwner="u.active=1 AND (u.role IN ('管理员','销售') OR (u.role='运营' AND u.site='印尼'))";

export async function manageDistributorLink(db,actor,{customerId,action,version}){
  if(!canWholesale(actor)||!hasPermission(actor.role,'wholesale.customer')) fail(403,'无权管理客户专属链接');
  if(typeof customerId!=='string'||!['issue','revoke'].includes(action)||!Number.isSafeInteger(version)||version<0) fail(400,'客户或链接版本无效');
  await assertWritable(db);
  const customer=await db.prepare('SELECT * FROM wholesale_customers WHERE id=?').bind(customerId).first();
  if(!customer||(actor.role!=='管理员'&&customer.sales_user_id!==actor.id)) fail(403,'请选择本人负责的客户');
  const account=await db.prepare('SELECT status,password_hash FROM distributor_stores WHERE customer_id=?').bind(customerId).first();
  const legacy=await db.prepare('SELECT customer_id FROM distributor_links WHERE customer_id=?').bind(customerId).first();
  if(action==='issue'&&(!account&&!legacy||account&&(account.status!=='active'||account.password_hash)))fail(403,'请在分销管理中由管理员审核并生成账号激活链接');
  const token=action==='issue'?hex(crypto.getRandomValues(new Uint8Array(32))):null;
  const hash=token?await digest(token):null;
  const now=new Date().toISOString();
  const guard=`EXISTS(SELECT 1 FROM wholesale_customers c JOIN users u ON u.id=c.sales_user_id
      WHERE c.id=? AND c.version=? AND c.sales_user_id=? AND (?='revoke' OR (c.active=1 AND ${enabledOwner})))
      AND COALESCE((SELECT version FROM distributor_links WHERE customer_id=?),0)=?
      AND (?='issue' OR EXISTS(SELECT 1 FROM distributor_links WHERE customer_id=? AND token_hash IS NOT NULL))`;
  await atomicBatch(db,[
    guardStatement(db,actor,action==='issue'?'生成客户分销链接':'停用客户分销链接',guard,[customerId,customer.version,customer.sales_user_id,action,customerId,version,action,customerId],crypto.randomUUID(),{customerId,version}),
    db.prepare(`INSERT INTO distributor_links(customer_id,token_hash,version,updated_by,updated_at) VALUES(?,?,?,?,?)
      ON CONFLICT(customer_id) DO UPDATE SET token_hash=excluded.token_hash,version=excluded.version,updated_by=excluded.updated_by,updated_at=excluded.updated_at`)
      .bind(customerId,hash,version+1,actor.id,now),
    db.prepare("INSERT INTO audit_logs(id,action,entity_type,entity_id,detail_json,actor_id,actor_name,created_at) VALUES(?,?, '印尼分销客户',?,?,?,?,?)")
      .bind(crypto.randomUUID(),action==='issue'?'生成客户分销链接':'停用客户分销链接',customerId,JSON.stringify({version:version+1}),actor.id,actor.name,now)
  ]);
  return {version:version+1,active:Boolean(token),path:token?`/distributor#${token}`:null};
}

export async function distributorIdentity(db,authorization){
  if(!/^Bearer [0-9a-f]{64}$/.test(authorization||'')) fail(401,'Tautan tidak aktif. Minta tautan baru kepada sales Anda.');
  const tokenHash=await digest(authorization.slice(7));
  const customer=await db.prepare(`SELECT c.* FROM distributor_links l JOIN wholesale_customers c ON c.id=l.customer_id
    JOIN users u ON u.id=c.sales_user_id WHERE l.token_hash=? AND c.active=1 AND ${enabledOwner}`).bind(tokenHash).first();
  if(!customer||await db.prepare("SELECT 1 FROM distributor_stores WHERE customer_id=? AND (status<>'active' OR password_hash IS NOT NULL)").bind(customer?.id||'').first()) fail(401,'Tautan tidak aktif. Minta tautan baru kepada sales Anda.');
  return {customer,tokenHash};
}

// The same eligibility check gates the order form, checkout and every photo request.
async function catalog(db,sku=null){
  const args=sku===null?[]:[sku];
  const [prices,stock]=await Promise.all([
    rows(db,`SELECT p.sku,s.name,p.standard_price,p.version,p.status,p.valid_until FROM wholesale_prices p JOIN sku_settings s ON s.sku=p.sku
      WHERE p.version=(SELECT MAX(version) FROM wholesale_prices WHERE sku=p.sku) ${sku===null?'':'AND p.sku=?'} ORDER BY p.sku`,...args),
    rows(db,`SELECT site,channel,sku,qty,reserved_qty FROM inventory_balances WHERE site='印尼' AND channel IN ('TikTok','Shopee') ${sku===null?'':'AND sku=?'}`,...args)
  ]);
  const inventory=new Map();
  for(const row of stock){if(!inventory.has(row.sku)) inventory.set(row.sku,[]);inventory.get(row.sku).push(row);}
  const result=[];
  for(const row of prices){
    const price=publicPrice(row);
    const available=stockForSku(inventory.get(row.sku)||[],row.sku).available;
    if(price.status==='published'&&available!==null&&available>=0)
      result.push({sku:row.sku,name:row.name,price:price.standardPrice,version:price.version,available});
  }
  return result;
}

// Explicit customer-facing fields. Staff notes, source sheets and cost references stay private.
const publicProfileFields=['sourceName','color','specification','dimensions','material','sellingPoints',
  'netWeightKg','grossWeightKg','unitVolumeCbm','cartonQty','cartonLengthCm','cartonWidthCm','cartonHeightCm','cartonVolumeCbm'];
const productImageTypes=['image/jpeg','image/png','image/webp'];

async function withProductInformation(db,products){
  if(!products.length)return products;
  const skus=JSON.stringify(products.map(p=>p.sku));
  const scope="sku IN (SELECT value FROM json_each(?))";
  const [profiles,files]=await Promise.all([
    rows(db,`SELECT sku,data_json FROM product_profiles WHERE ${scope}`,skus),
    rows(db,`SELECT sku,id,content_type FROM product_profile_files WHERE ${scope} ORDER BY sku,created_at,id`,skus)
  ]);
  const details=new Map(profiles.map(row=>{
    const data=JSON.parse(row.data_json);
    return [row.sku,Object.fromEntries(publicProfileFields.filter(k=>data[k]!=null&&data[k]!=='').map(k=>[k,data[k]]))];
  }));
  const images=new Map();
  for(const file of files){
    if(!productImageTypes.includes(file.content_type))continue;
    if(!images.has(file.sku))images.set(file.sku,[]);
    images.get(file.sku).push(file.id);
  }
  return products.map(p=>({...p,details:details.get(p.sku)||{},images:images.get(p.sku)||[]}));
}

export async function distributorImage(db,bucket,id){
  const file=await db.prepare('SELECT sku,object_key,content_type FROM product_profile_files WHERE id=?').bind(id).first();
  if(!file||!productImageTypes.includes(file.content_type)||!(await catalog(db,file.sku)).length)
    fail(404,'Foto produk tidak tersedia.');
  if(!bucket)fail(503,'Penyimpanan foto sedang tidak tersedia.');
  const object=await bucket.get(file.object_key);
  if(!object)fail(404,'Foto produk tidak tersedia.');
  return {type:file.content_type,body:object.body};
}

export async function distributorWorkspace(db,{customer}){
  const [owner,products,orders,salesContact]=await Promise.all([
    db.prepare('SELECT name FROM users WHERE id=?').bind(customer.sales_user_id).first(),
    catalog(db).then(products=>withProductInformation(db,products)),
    rows(db,`SELECT o.id,o.order_no,o.business_date,o.status,o.total_qty,o.total_amount,o.cancelled_amount,o.sale_type FROM distributor_orders d
      JOIN wholesale_orders o ON o.id=d.order_id WHERE d.customer_id=? ORDER BY o.created_at DESC LIMIT 30`,customer.id),
    distributorSalesContact(db,customer.sales_user_id)
  ]);
  const ids=orders.map(o=>o.id),params=ids.map(()=>'?').join(',');
  const [lines,shipments,entries,returns,consignment]=ids.length?await Promise.all([
    rows(db,`SELECT order_id,sku,qty,unit_price FROM wholesale_order_items WHERE order_id IN (${params}) ORDER BY sku`,...ids),
    rows(db,`SELECT order_id,carrier,tracking_no,business_date FROM wholesale_shipments WHERE order_id IN (${params}) ORDER BY created_at`,...ids),
    rows(db,`SELECT order_id,kind,amount FROM wholesale_finance_entries WHERE order_id IN (${params})`,...ids),
    rows(db,`SELECT order_id,amount,qty,consignment_sold_qty FROM wholesale_returns WHERE order_id IN (${params})`,...ids),
    rows(db,`SELECT order_id,amount FROM wholesale_consignment_sales WHERE order_id IN (${params})`,...ids)
  ]):[[],[],[],[],[]];
  const history=orders.map(({id,...o})=>({...o,
    payment:(()=>{const m=settlement(o,entries.filter(r=>r.order_id===id),returns.filter(r=>r.order_id===id),consignment.filter(r=>r.order_id===id));return {paid:m.paid,outstanding:m.outstanding,refundDue:m.refundDue};})(),
    items:lines.filter(l=>l.order_id===id).map(l=>({sku:l.sku,qty:l.qty,price:l.unit_price})),
    shipments:shipments.filter(s=>s.order_id===id).map(s=>({carrier:s.carrier,tracking:s.tracking_no,date:s.business_date}))
  }));
  return {customer:{code:customer.code,name:customer.name,city:customer.city,address:customer.address,sales:salesContact?.name||owner?.name,salesContact},products,orders:history};
}

export async function submitDistributorOrder(db,{customer,tokenHash,sessionHash},input){
  if(!input||Object.keys(input).some(k=>!['requestId','items'].includes(k))||!/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.test(input.requestId||''))
    fail(400,'Data pesanan tidak valid.');
  if(!Array.isArray(input.items)||!input.items.length) fail(400,'Pilih minimal satu SKU.');
  const seen=new Set();
  const lines=input.items.map(row=>{
    if(!row||Object.keys(row).some(k=>!['sku','qty','version'].includes(k))||typeof row.sku!=='string'||!row.sku||row.sku.length>100||
      seen.has(row.sku)||!Number.isSafeInteger(row.qty)||row.qty<1||!Number.isSafeInteger(row.version)||row.version<1)
      fail(400,'Periksa SKU, jumlah, dan versi harga.');
    seen.add(row.sku);
    return {sku:row.sku,qty:row.qty,version:row.version};
  }).sort((a,b)=>a.sku.localeCompare(b.sku));
  const fingerprint=await digest(JSON.stringify(lines));
  const previous=async()=>{
    const order=await db.prepare(`SELECT d.fingerprint,o.order_no FROM distributor_orders d JOIN wholesale_orders o ON o.id=d.order_id
      WHERE d.customer_id=? AND d.request_id=?`).bind(customer.id,input.requestId).first();
    if(order&&order.fingerprint!==fingerprint) fail(409,'Nomor permintaan sudah dipakai untuk pesanan lain.');
    return order?{orderNo:order.order_no,replayed:true}:null;
  };
  const replay=await previous();
  if(replay) return replay;
  await assertWritable(db);
  const products=new Map((await catalog(db)).map(p=>[p.sku,p]));
  const items=lines.map(({sku,qty,version})=>{
    const product=products.get(sku);
    if(!product||product.version!==version||product.available<qty) fail(409,`Harga atau stok ${sku} berubah. Muat ulang katalog dan periksa pesanan.`);
    return {sku,qty,unitPrice:product.price};
  });
  try{
    const result=await createWholesaleOrder(db,{id:'distributor:'+customer.id,name:customer.name},{
      action:'orderCreate',operationId:crypto.randomUUID(),customerId:customer.id,items,saleType:'cash',site:'印尼',businessDate:indonesiaDate()
    },customer,{tokenHash,sessionHash,requestId:input.requestId,fingerprint,versions:new Map(lines.map(l=>[l.sku,l.version]))});
    const order=await db.prepare('SELECT order_no FROM wholesale_orders WHERE id=?').bind(result.id).first();
    return {orderNo:order.order_no,replayed:false};
  }catch(error){
    const saved=await previous();
    if(saved)return saved;
    throw error;
  }
}
