import {financialRates,financeClock,financeGuardSql} from './finance-periods.mjs';
import {hasPermission} from './permissions.mjs';

export class CatalogError extends Error { constructor(message,status=400){super(message);this.status=status;} }
const fail=(message,status=400)=>{throw new CatalogError(message,status);};
const all=async(db,sql,args=[]) => {const r=await db.prepare(sql).bind(...args).all();if(r.success===false)throw Error('Catalog query failed');return r.results||[];};
const day=()=>new Date(Date.now()+7*3600000).toISOString().slice(0,10);
export const canManagePrices=actor=>['管理员','财务'].includes(actor.role);
export const latestPrices=db=>all(db,'SELECT p.* FROM wholesale_prices p WHERE p.version=(SELECT MAX(x.version) FROM wholesale_prices x WHERE x.sku=p.sku)');
const minor=(value,label)=>{
 if(!/^\d+(\.\d{1,2})?$/.test(String(value??'')))fail(`${label}：请输入金额，未发生请明确填0`);
 const n=Math.round(Number(value)*100);if(!Number.isSafeInteger(n)||n<0||n>1e12)fail('成本或加成率超出允许范围');return n;
};
const money=value=>{const n=Number(value);if(!Number.isSafeInteger(n)||n<=0||n>1e12)fail('报价须为有效的正整数IDR');return n;};
const clean=(value,max)=>String(value??'').trim().slice(0,max);
import {markedPrice} from './wholesale-price-model.mjs';
export {markedPrice} from './wholesale-price-model.mjs';
export function publicPrice(p,today=day()){
 if(!p)return {version:0,status:'unpriced',standardPrice:null,minimumPrice:null,validUntil:null};
 const status=p.status==='withdrawn'?'withdrawn':p.valid_until<today?'expired':'published';
 return {version:p.version,status,standardPrice:status==='published'?p.standard_price:null,minimumPrice:status==='published'?p.minimum_price:null,validUntil:p.valid_until,updatedAt:p.created_at};
}
export function stockForSku(stock,sku){
 const channels=['TikTok','Shopee'].map(channel=>stock.find(r=>r.site==='印尼'&&r.channel===channel&&r.sku===sku));
 const known=channels.every(Boolean),bad=channels.some(r=>r&&(!Number.isSafeInteger(r.qty)||!Number.isSafeInteger(r.reserved_qty)||r.qty<0||r.reserved_qty<0||r.reserved_qty>r.qty));
 const sum=key=>channels.reduce((n,r)=>n+(r?Number(r[key]||0):0),0);
 return {stockStatus:!known?'unknown':bad?'anomaly':'ready',onHand:known?sum('qty'):null,reserved:known?sum('reserved_qty'):null,available:known&&!bad?sum('qty')-sum('reserved_qty'):null,pending:known?sum('pending_shelf_qty'):null,quarantine:known?sum('quarantine_qty'):null};
}
async function quoteCostSources(db){
 const [products,tickets,rates]=await Promise.all([
  all(db,"SELECT * FROM product_cost_versions WHERE site='印尼' AND effective_date<=? ORDER BY version DESC",[day()]),
  all(db,"SELECT id,revision,data_json FROM cost_records c WHERE kind='ticket' AND site='印尼' AND business_date<=? AND revision=(SELECT MAX(x.revision) FROM cost_records x WHERE x.kind=c.kind AND x.business_key=c.business_key)",[day()]),
  financialRates(db,day().slice(0,7))
 ]);
 return {products,tickets:tickets.map(t=>({...t,skus:new Set(JSON.parse(t.data_json).lines.map(l=>l.sku))})),rate:rates.IDR};
}
function quoteCostBasis(sources,sku){
 const p=sources.products.find(p=>p.sku===sku),rate=sources.rate,tickets=sources.tickets.filter(t=>t.skus.has(sku));
 return {productId:p?.id||null,productVersion:p?.version||null,basis:p?.basis||null,unitCny:p?.total==null?null:p.total/10000,fxId:rate?.id||null,idrPerCny:rate?1/rate.rate:null,referenceUnitIdr:p?.total!=null&&rate?Math.round(p.total/10000/rate.rate):null,tickets:tickets.map(t=>({id:t.id,revision:t.revision})).sort((a,b)=>a.id.localeCompare(b.id))};
}
export async function readCatalog(db,actor,stock){
 if(!hasPermission(actor.role,'wholesale.read')||(actor.role==='运营'&&actor.site!=='印尼'))fail('当前账号无权查看印尼批发目录',403);
 const [skus,prices]=await Promise.all([all(db,'SELECT sku,name FROM sku_settings ORDER BY sku'),latestPrices(db)]);
 stock??=await all(db,"SELECT site,channel,sku,qty,reserved_qty,pending_shelf_qty,quarantine_qty,updated_at FROM inventory_balances WHERE site='印尼' AND channel IN ('TikTok','Shopee')");
 const incoming=await all(db,"SELECT i.sku,SUM(MAX(0,i.qty-i.received_qty)) qty FROM transport_leg_items i JOIN transport_legs l ON l.id=i.leg_id WHERE l.site='印尼' AND l.channel IN ('TikTok','Shopee') AND l.stage IN ('sea_freight','port_arrived','customs_clearance','last_mile_delivery','awaiting_receipt') GROUP BY i.sku");
 const sources=canManagePrices(actor)?await quoteCostSources(db):null;const costBases=sources?Object.fromEntries(skus.map(s=>[s.sku,quoteCostBasis(sources,s.sku)])):null;
 const products=skus.map(s=>({...s,...stockForSku(stock,s.sku),incoming:incoming.find(i=>i.sku===s.sku)?.qty||0,price:publicPrice(prices.find(p=>p.sku===s.sku))}));
 const totals=products.reduce((a,p)=>{if(p.stockStatus==='ready'){a.available+=p.available;a.stocked+=Number(p.available>0);}else a.unverified++;if(p.price.status==='published')a.priced++;a.incoming+=p.incoming;return a;},{available:0,stocked:0,unverified:0,priced:0,incoming:0});
 return {products,totals,canManage:canManagePrices(actor),asOf:new Date().toISOString(),...(canManagePrices(actor)?{costBases,priceHistory:(await all(db,'SELECT * FROM wholesale_prices ORDER BY sku,version DESC')).map(p=>({...p,costBasis:JSON.parse(p.cost_basis_json||'{}'),costNeedsReview:JSON.stringify(JSON.parse(p.cost_basis_json||'{}'))!==JSON.stringify(costBases[p.sku])}))}:{})};
}
export async function managePrice(db,actor,p,commit){
 if(!canManagePrices(actor))fail('仅管理员和财务可维护批发报价',403);
 const sku=clean(p.sku,100).toUpperCase(),setting=await db.prepare('SELECT sku FROM sku_settings WHERE sku=?').bind(sku).first();
 if(!setting)fail('请先建立有效SKU档案');
 const sourceVersion=await financeClock(db);const basis=quoteCostBasis(await quoteCostSources(db),sku);
 const previous=(await latestPrices(db)).find(r=>r.sku===sku),version=previous?.version||0;
 if(Number(p.priceVersion)!==version)fail('报价版本已变化，请刷新后核对',409);
 const reason=clean(p.reason,600);if(reason.length<4)fail('请填写核价或调整依据，至少4个字');
 let next;
 if(p.action==='priceWithdraw'){
  if(!previous||previous.status==='withdrawn')fail('没有可停用的报价');
  next={...previous,status:'withdrawn'};
 }else{
  if(p.costConfirmed!==true)fail('请确认成本已核实且各项费用没有遗漏');
  const purchase_minor=minor(p.purchaseCost,'采购成本'),freight_minor=minor(p.freightCost,'海运成本'),tax_minor=minor(p.taxCost,'税费'),inbound_minor=minor(p.inboundCost,'入仓费用');
  const cost=purchase_minor+freight_minor+tax_minor+inbound_minor;if(cost<=0||cost>1e12)fail('到仓单位成本须大于0');
  const standard_markup_bp=minor(p.standardMarkup,'标准加成率'),minimum_markup_bp=minor(p.minimumMarkup,'最低加成率'),rounding=Number(p.rounding);
  if(standard_markup_bp>100000||minimum_markup_bp>standard_markup_bp||![1,100,500,1000].includes(rounding))fail('请核对加成率与报价取整规则');
  const standard_price=p.standardPrice===''||p.standardPrice==null?markedPrice(cost,standard_markup_bp,rounding):money(p.standardPrice),minimum_price=p.minimumPrice===''||p.minimumPrice==null?markedPrice(cost,minimum_markup_bp,rounding):money(p.minimumPrice);
  if(minimum_price>standard_price)fail('最低报价不能高于标准报价');
  const valid_until=clean(p.validUntil,10);if(!/^\d{4}-\d{2}-\d{2}$/.test(valid_until)||!Number.isFinite(Date.parse(valid_until))||new Date(valid_until).toISOString().slice(0,10)!==valid_until||valid_until<day())fail('请选择有效的报价截止日期');
  const cost_reference=clean(p.costReference,600);if(cost_reference.length<4)fail('请填写成本凭据或核价单编号');
  next={status:'published',purchase_minor,freight_minor,tax_minor,inbound_minor,standard_markup_bp,minimum_markup_bp,rounding,standard_price,minimum_price,valid_until,cost_reference};
 }
 next.cost_basis_json=p.action==='priceWithdraw'?previous.cost_basis_json:JSON.stringify(basis);
 const id='whprice_'+crypto.randomUUID(),created_at=new Date().toISOString(),fields=['status','purchase_minor','freight_minor','tax_minor','inbound_minor','standard_markup_bp','minimum_markup_bp','rounding','standard_price','minimum_price','valid_until','cost_reference','cost_basis_json'];
 const statement=db.prepare(`INSERT INTO wholesale_prices(id,sku,version,${fields.join(',')},reason,actor_id,actor_name,created_at) VALUES (${Array(20).fill('?').join(',')})`).bind(id,sku,version+1,...fields.map(k=>next[k]),reason,actor.id,actor.name,created_at);
 const g=financeGuardSql(sourceVersion);return commit(db,actor,p,id,[statement],'COALESCE((SELECT MAX(version) FROM wholesale_prices WHERE sku=?),0)=? AND '+g.sql,[sku,version,...g.args]);
}
export function priceAssessment(item,p,today=day()){
 const price=publicPrice(p,today),unitPrice=Number(item.unit_price??item.price);
 return {sku:item.sku,...price,unitPrice,exception:price.status!=='published'||unitPrice<price.minimumPrice};
}
export function priceSnapshot(db,actor,orderId,item,phase,p,reason='',special=false){
 const a=priceAssessment(item,p);
 return db.prepare('INSERT INTO wholesale_price_snapshots(id,order_id,item_id,phase,sku,price_version,standard_price,minimum_price,unit_price,status,reason,actor_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').bind('whps_'+crypto.randomUUID(),orderId,item.id,phase,item.sku,a.version,a.standardPrice,a.minimumPrice,a.unitPrice,special?'special_approved':a.exception?'exception':'within_range',reason,actor.id,new Date().toISOString());
}

export async function readPriceRequests(db,actor){
 const manager=canManagePrices(actor);
 if(!manager&&!hasPermission(actor.role,'wholesale.create'))return [];
 return all(db,`SELECT r.*,c.name customer_name,u.name sales_name,s.name product_name FROM wholesale_price_requests r JOIN wholesale_customers c ON c.id=r.customer_id JOIN users u ON u.id=r.sales_user_id JOIN sku_settings s ON s.sku=r.sku ${manager?'':'WHERE r.sales_user_id=?'} ORDER BY r.created_at DESC`,manager?[]:[actor.id]);
}
export async function managePriceRequest(db,actor,p,commit){
 const now=new Date().toISOString();
 if(p.action==='priceRequestCreate'){
  if(!hasPermission(actor.role,'wholesale.create'))fail('当前账号无权申请特批价格',403);
  const customer=await db.prepare('SELECT * FROM wholesale_customers WHERE id=? AND active=1').bind(p.customerId||'').first();
  if(!customer||(actor.role!=='管理员'&&customer.sales_user_id!==actor.id))fail('请选择本人负责的有效客户',403);
  const sku=clean(p.sku,100).toUpperCase(),setting=await db.prepare('SELECT sku FROM sku_settings WHERE sku=?').bind(sku).first();if(!setting)fail('请先建立有效SKU档案');
  const qty=money(p.qty),price=money(p.unitPrice),reason=clean(p.reason,600);if(reason.length<4)fail('请填写申请依据，至少4个字');
  const quote=(await latestPrices(db)).find(q=>q.sku===sku),id='whpr_'+crypto.randomUUID();
  return commit(db,actor,p,id,[db.prepare('INSERT INTO wholesale_price_requests(id,customer_id,sales_user_id,sku,qty,requested_price,requested_reason,source_version,created_at) VALUES (?,?,?,?,?,?,?,?,?)').bind(id,customer.id,actor.id,sku,qty,price,reason,quote?.version||0,now)],'EXISTS (SELECT 1 FROM wholesale_customers WHERE id=? AND active=1 AND version=?)',[customer.id,customer.version]);
 }
 if(actor.role!=='管理员')fail('特批价格申请仅由管理员审批',403);
 const r=await db.prepare('SELECT * FROM wholesale_price_requests WHERE id=?').bind(p.requestId||'').first();
 if(!r)fail('价格申请不存在',404);
 if(r.sales_user_id===actor.id)fail('不能审批本人提交的价格申请',403);
 if(r.status!=='pending'||Number(p.version)!==r.version)fail('价格申请已变化，请刷新后核对',409);
 const reason=clean(p.reason,600);if(reason.length<4)fail('请填写审批依据，至少4个字');
 if(!['approve','reject'].includes(p.decision))fail('请选择批准或驳回');
 const quote=(await latestPrices(db)).find(q=>q.sku===r.sku),version=quote?.version||0;
 if(Number(p.priceVersion)!==version)fail('报价版本已变化，请刷新后核对',409);
 const price=p.decision==='approve'?money(p.unitPrice):null,valid=clean(p.validUntil,10);
 if(price&&priceAssessment({sku:r.sku,price},quote).exception&&p.priceExceptionConfirmed!==true)fail('报价待核实、已过期或低于最低价，请确认价格例外并填写审批依据');
 if(price&&(!/^\d{4}-\d{2}-\d{2}$/.test(valid)||!Number.isFinite(Date.parse(valid))||new Date(valid).toISOString().slice(0,10)!==valid||valid<day()))fail('请选择有效的报价截止日期');
 return commit(db,actor,p,r.id,[db.prepare('UPDATE wholesale_price_requests SET status=?,approved_price=?,valid_until=?,decision_reason=?,decided_by=?,decided_at=?,version=version+1 WHERE id=?').bind(price?'approved':'rejected',price,price?valid:null,reason,actor.id,now,r.id)],"EXISTS(SELECT 1 FROM wholesale_price_requests WHERE id=? AND status='pending' AND version=?) AND COALESCE((SELECT MAX(version) FROM wholesale_prices WHERE sku=?),0)=?",[r.id,r.version,r.sku,version]);
}
