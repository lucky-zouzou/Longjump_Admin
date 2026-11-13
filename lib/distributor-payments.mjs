import {distFail,distHash,distHashBytes,distributorCredential} from './distributor-accounts.mjs';
import {atomicBatch,assertWritable,guardStatement} from './atomic.mjs';
import {indonesiaDate} from './wholesale.mjs';
import {evidenceType} from './after-sales-files.mjs';
const all=async(db,sql,args=[])=>(await db.prepare(sql).bind(...args).all()).results;
export async function distributorPayments(db,{customer}){
 const orders=await all(db,`SELECT o.order_no,o.total_amount,o.business_date FROM distributor_orders d JOIN wholesale_orders o ON o.id=d.order_id
 WHERE d.customer_id=? AND o.status IN ('approved','packing','partial','completed','closed') ORDER BY o.created_at DESC`,[customer.id]);
 const submissions=await all(db,`SELECT p.id,o.order_no,p.amount,p.reference,p.business_date,p.status,p.review_note,p.created_at,
 f.finance_entry_id,EXISTS(SELECT 1 FROM wholesale_finance_entries e WHERE e.reverses_id=f.finance_entry_id) reversed FROM distributor_payments p JOIN wholesale_orders o ON o.id=p.order_id JOIN wholesale_files f ON f.id=p.file_id WHERE p.customer_id=? ORDER BY p.created_at DESC`,[customer.id]);
 return {orders,submissions:submissions.map(p=>({...p,state:p.finance_entry_id?(p.reversed?'reversed':'verified'):p.status,finance_entry_id:undefined}))};
}
export async function submitDistributorPayment(db,bucket,identity,form){
 await assertWritable(db);
 const {customer}=identity,orderNo=String(form.get('orderNo')||''),amount=Number(form.get('amount')),reference=String(form.get('reference')||'').trim(),day=String(form.get('businessDate')||''),request=String(form.get('requestId')||''),file=form.get('evidence');
 if(!Number.isSafeInteger(amount)||amount<=0||amount>1e12||!reference||reference.length>160||!/^\d{4}-\d{2}-\d{2}$/.test(day)||!Number.isFinite(Date.parse(day))||new Date(day).toISOString().slice(0,10)!==day||day>indonesiaDate()||!/^[-a-f0-9]{36}$/.test(request))distFail(400,'Periksa jumlah IDR, tanggal, dan nomor transfer.');
 if(!file||typeof file.arrayBuffer!=='function'||!file.size||file.size>10*1024*1024)distFail(400,'Lampirkan foto atau PDF, maksimal 10 MB.');
 const bytes=new Uint8Array(await file.arrayBuffer()),type=evidenceType(bytes);
 if(!['image/jpeg','image/png','image/webp','application/pdf'].includes(type))distFail(400,'Gunakan foto JPG, PNG, WebP atau PDF.');
 const order=await db.prepare(`SELECT o.* FROM wholesale_orders o JOIN distributor_orders d ON d.order_id=o.id WHERE o.order_no=? AND d.customer_id=?`).bind(orderNo,customer.id).first();
 if(!order)distFail(404,'Pesanan tidak ditemukan.');
 const fingerprint=await distHash(JSON.stringify([order.id,amount,reference,day,await distHashBytes(bytes)]));
 const previous=async()=>{const r=await db.prepare('SELECT id,fingerprint FROM distributor_payments WHERE customer_id=? AND request_id=?').bind(customer.id,request).first();if(r&&r.fingerprint!==fingerprint)distFail(409,'Nomor pengajuan sudah digunakan untuk data berbeda.');return r?{id:r.id,replayed:true}:null;};
 const saved=await previous();if(saved)return saved;
 if(!['approved','packing','partial','completed','closed'].includes(order.status)||day<order.business_date)distFail(409,'Tunggu persetujuan pesanan dan periksa tanggal transfer.');
 if(!bucket?.put||!bucket.delete)distFail(503,'Penyimpanan bukti belum tersedia.');
 const id='dp_'+crypto.randomUUID(),fileId='whfile_'+crypto.randomUUID(),key='wholesale/'+order.id+'/'+fileId,at=new Date().toISOString(),actor={id:'distributor:'+customer.id,name:customer.name},auth=distributorCredential(identity);
 await bucket.put(key,bytes,{httpMetadata:{contentType:type}});
 try{await atomicBatch(db,[guardStatement(db,actor,'distributor.payment.submit',auth.sql+" AND EXISTS(SELECT 1 FROM wholesale_orders WHERE id=? AND version=? AND status IN ('approved','packing','partial','completed','closed'))",[...auth.args,order.id,order.version]),
 db.prepare("INSERT INTO wholesale_files(id,order_id,object_key,name,content_type,size,actor_id,created_at,purpose,actor_name) VALUES(?,?,?,?,?,?,?,?,'finance',?)").bind(fileId,order.id,key,String(file.name).replace(/[\r\n]/g,'').slice(0,160),type,bytes.length,actor.id,at,actor.name),
 db.prepare('INSERT INTO distributor_payments(id,customer_id,order_id,request_id,fingerprint,amount,reference,business_date,file_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').bind(id,customer.id,order.id,request,fingerprint,amount,reference,day,fileId,at),
 db.prepare("INSERT INTO audit_logs(id,action,entity_type,entity_id,detail_json,actor_id,actor_name,created_at) VALUES(?,'distributor.payment.submit','分销结算',?,?,?,?,?)").bind(crypto.randomUUID(),id,JSON.stringify({orderId:order.id,amount,reference}),actor.id,actor.name,at)]);
 }catch(e){if(await db.prepare('SELECT id FROM distributor_payments WHERE id=?').bind(id).first())return {id,replayed:true};await bucket.delete(key);const replay=await previous();if(replay)return replay;throw e;}
 return {id,replayed:false};
}
export async function rejectDistributorPayment(db,a,p){
 if(!['管理员','财务'].includes(a.role))distFail(403,'仅财务或管理员可核验结算凭证');
 await assertWritable(db);if(String(p.reason||'').trim().length<4)distFail(400,'请填写退回原因');
 await atomicBatch(db,[guardStatement(db,a,'distributor.payment.reject',"EXISTS(SELECT 1 FROM distributor_payments p JOIN wholesale_files f ON f.id=p.file_id WHERE p.id=? AND p.version=? AND p.status='submitted' AND f.finance_entry_id IS NULL)",[p.id,p.version]),
 db.prepare("UPDATE distributor_payments SET status='rejected',review_note=?,version=version+1 WHERE id=?").bind(String(p.reason).slice(0,1000),p.id),
 db.prepare("INSERT INTO audit_logs(id,action,entity_type,entity_id,detail_json,actor_id,actor_name,created_at) VALUES(?,'distributor.payment.reject','分销结算',?,?,?,?,?)").bind(crypto.randomUUID(),p.id,JSON.stringify({reason:p.reason}),a.id,a.name,new Date().toISOString())]);return {ok:true};
}
