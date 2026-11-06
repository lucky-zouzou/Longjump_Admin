import {atomicBatch, assertWritable, guardStatement} from './atomic.mjs';
import {WholesaleError, indonesiaDate} from './wholesale.mjs';
import {evidenceType} from './after-sales-files.mjs';

const all = async(db, sql, args=[]) => (await db.prepare(sql).bind(...args).all()).results;
const fail = (status, message) => { throw new WholesaleError(status,message); };
const sha = async data => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',data)),b=>b.toString(16).padStart(2,'0')).join('');
const reasons = {quality:'商品质量问题',wrong:'仓库发错货',description:'与描述不符合',unwanted:'客户不想要 / 取消',other:'其他'};

const lineScope = `FROM wholesale_order_items i JOIN distributor_orders link ON link.order_id=i.order_id
 JOIN wholesale_orders o ON o.id=i.order_id AND o.customer_id=link.customer_id WHERE link.customer_id=?`;
const activeQty = `COALESCE((SELECT SUM(json_extract(a.data_json,'$.qty')) FROM after_sales a
 WHERE a.channel='线下分销' AND json_extract(a.data_json,'$.dist.item')=i.id
 AND (json_extract(a.data_json,'$.dist.state') IN ('submitted','approved') OR
 (json_extract(a.data_json,'$.dist.kind')='exchange' AND json_extract(a.data_json,'$.dist.state')='completed'))),0)`;
const available = `i.shipped_qty-i.returned_qty-${activeQty}`;
const credential = `EXISTS(SELECT 1 FROM distributor_links l JOIN wholesale_customers c ON c.id=l.customer_id JOIN users u ON u.id=c.sales_user_id
 WHERE l.customer_id=? AND l.token_hash=? AND c.active=1 AND c.sales_user_id=? AND u.active=1
 AND (u.role IN ('销售','管理员') OR (u.role='运营' AND u.site='印尼')))`;

export async function distributorServiceDesk(db,{customer}){
 const [lines,cases]=await Promise.all([
   all(db,`SELECT i.id,i.sku,i.name,o.order_no,${available} available ${lineScope} AND ${available}>0 ORDER BY o.business_date DESC,o.order_no,i.sku`,[customer.id]),
   all(db,`SELECT case_no,sku,business_date,data_json FROM after_sales WHERE channel='线下分销'
     AND json_extract(data_json,'$.dist.customer')=? ORDER BY created_at DESC`,[customer.id])
 ]);
 return {lines,cases:cases.map(r=>{
   const d=JSON.parse(r.data_json),x=d.dist;
   return {caseNo:r.case_no,sku:r.sku,date:r.business_date,orderNo:d.orderNo,qty:d.qty,kind:x.kind,state:x.state,
     message:x.message||'',refund:x.state==='completed'&&x.kind==='return'?d.refundCents/100:null,carrier:x.carrier||'',tracking:x.tracking||''};
 })};
}

const maxBody=20*1024*1024;
export async function serviceForm(request){
 if(Number(request.headers.get('content-length'))>maxBody)fail(413,'Total unggahan maksimal 20 MB.');
 const reader=request.body?.getReader();if(!reader)fail(400,'Formulir kosong.');
 let n=0;const chunks=[];
 for(;;){const {done,value}=await reader.read();if(done)break;n+=value.byteLength;
   if(n>maxBody){await reader.cancel();fail(413,'Total unggahan maksimal 20 MB.');}chunks.push(value);}
 try{return await new Response(new Blob(chunks),{headers:{'Content-Type':request.headers.get('content-type')}}).formData();}
 catch{fail(400,'Format unggahan tidak valid.');}
}
function mediaType(bytes){
 const image=evidenceType(bytes);
 if(image.startsWith('image/'))return image;
 const tag=(a,z)=>String.fromCharCode(...bytes.slice(a,z));
 if(bytes.length>=16 && tag(4,8)==='ftyp'){
   const brand=tag(8,12);
   if(brand==='qt  ')return 'video/quicktime';
   if(/^(isom|iso[2-9]|mp4[12]|avc1|M4V |MSNV)$/.test(brand))return 'video/mp4';
 }
 if(bytes[0]===0x1a&&bytes[1]===0x45&&bytes[2]===0xdf&&bytes[3]===0xa3&&tag(4,128).includes('webm'))return 'video/webm';
 return '';
}
export async function submitDistributorService(db,bucket,identity,form){
 const {customer,tokenHash}=identity;
 const item=form.get('item'),request=form.get('requestId'),kind=form.get('kind'),reason=form.get('reason');
 const description=String(form.get('description')||'').trim(),qty=Number(form.get('qty'));
 if(typeof item!=='string'||item.length>120||!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(request||'')||
    !['return','exchange'].includes(kind)||!Object.hasOwn(reasons,reason)||description.length<4||description.length>2000||!Number.isSafeInteger(qty)||qty<1)
   fail(400,'Periksa barang, jumlah, alasan, dan uraian masalah (4–2000 karakter).');
 const files=form.getAll('evidence');
 if(!files.length||files.length>3||files.some(f=>!f||typeof f.arrayBuffer!=='function'||!f.size||f.size>18*1024*1024)||files.reduce((sum,f)=>sum+f.size,0)>maxBody)
   fail(400,'Lampirkan 1–3 foto atau video. Maksimum 18 MB per berkas, total 20 MB.');
 await assertWritable(db);
 const line=await db.prepare(`SELECT i.id,i.sku,i.unit_price,o.id order_id,o.order_no,o.business_date,${available} available ${lineScope} AND i.id=?`).bind(customer.id,item).first();
 if(!line)fail(404,'Barang tidak ditemukan pada pesanan Anda.');
 const media=[];
 for(const file of files){
   const bytes=new Uint8Array(await file.arrayBuffer()),type=mediaType(bytes);
   if(!type)fail(400,'Gunakan JPG, PNG, WebP, MP4, MOV, atau WebM.');
   const hash=await sha(bytes);if(!media.some(f=>f.hash===hash))media.push({bytes,type,hash,name:String(file.name||'Bukti').replace(/[\r\n]/g,'').slice(0,160)});
 }
 const fingerprint=await sha(new TextEncoder().encode(JSON.stringify([item,kind,qty,reason,description,media.map(f=>f.hash).sort()])));
 const previous=async()=>{
   const r=await db.prepare("SELECT case_no,json_extract(data_json,'$.dist.fingerprint') fingerprint FROM after_sales WHERE channel='线下分销' AND json_extract(data_json,'$.dist.customer')=? AND json_extract(data_json,'$.dist.request')=?").bind(customer.id,request).first();
   if(r&&r.fingerprint!==fingerprint)fail(409,'Nomor pengajuan telah digunakan untuk data berbeda.');
   return r?{caseNo:r.case_no,replayed:true}:null;
 };
 const old=await previous();if(old)return old;
 if(qty>line.available)fail(409,'Jumlah melebihi unit terkirim yang masih bisa diajukan.');
 if(!bucket?.put||!bucket.delete)fail(503,'Penyimpanan bukti belum tersedia.');
 const id='as_'+crypto.randomUUID(),caseNo='DS-'+crypto.randomUUID().toUpperCase(),now=new Date().toISOString();
 const actor={id:'distributor:'+customer.id,name:customer.name};
 const data={qty,orderNo:line.order_no,reason:reasons[reason],description,currency:'IDR',refundCents:kind==='return'?null:0,payments:[],improvement:'',
   dist:{kind,state:'submitted',customer:customer.id,item,orderId:line.order_id,orderMonth:line.business_date.slice(0,7),request,fingerprint}};
 const stmts=[
   guardStatement(db,actor,'distributor.service.submit',credential+` AND EXISTS(SELECT 1 ${lineScope} AND i.id=? AND ${available}>=?)`,[customer.id,tokenHash,customer.sales_user_id,customer.id,item,qty]),
   db.prepare(`INSERT INTO after_sales(id,record_kind,owner_id,owner_name,site,channel,business_date,case_no,sku,status,data_json,created_at,updated_at)
     SELECT ?,'after_sale',u.id,u.name,'印尼','线下分销',?,?,?,'submitted',?,?,? FROM users u WHERE u.id=?`).bind(id,indonesiaDate(),caseNo,line.sku,JSON.stringify(data),now,now,customer.sales_user_id),
   db.prepare("INSERT INTO audit_logs(id,action,entity_type,entity_id,detail_json,actor_id,actor_name,created_at) VALUES(?,'after_sales.distributorSubmit','after_sales',?,?,?,?,?)")
     .bind(crypto.randomUUID(),id,JSON.stringify({kind,qty,orderNo:line.order_no}),actor.id,actor.name,now)
 ];
 const keys=[];
 try{
   for(const f of media){
     const fid='af_'+crypto.randomUUID(),key='after-sales/'+id+'/'+fid;
     keys.push(key);await bucket.put(key,f.bytes,{httpMetadata:{contentType:f.type}});
     stmts.push(db.prepare('INSERT INTO after_sales_files(id,record_id,object_key,name,content_type,size,sha256,actor_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
       .bind(fid,id,key,f.name,f.type,f.bytes.length,f.hash,actor.id,now));
   }
   await atomicBatch(db,stmts);
 }catch(error){
   // Resolve an uncertain commit before removing evidence. Competing attempts use distinct keys.
   const own=await db.prepare('SELECT id FROM after_sales WHERE id=?').bind(id).first();
   if(own)return {caseNo,replayed:true};
   await Promise.all(keys.map(key=>bucket.delete(key)));
   const saved=await previous();if(saved)return saved;throw error;
 }
 return {caseNo,replayed:false};
}
