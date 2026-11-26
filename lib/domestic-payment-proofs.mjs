import {assertWritable} from './atomic.mjs';
import {DomesticError,domesticOrderFor,domesticCapabilities,domesticToday,cnyMinor} from './domestic-distribution.mjs';

const fail=(status,message)=>{throw new DomesticError(status,message);};
// Store the customer's claim separately from bank-confirmed receipts.
export async function uploadDomesticPaymentProof(db,bucket,actor,{orderId,file,operationId,amount,claimedDate,customerReference='',note=''}){
 const o=await domesticOrderFor(db,actor,orderId),active=await db.prepare('SELECT active,role FROM users WHERE id=?').bind(actor.id).first();
 if(!active?.active||active.role!==actor.role||!domesticCapabilities(actor).manage)fail(403,'仅负责供应链或管理员可提交客户付款凭证');
 await assertWritable(db);
 if(!/^[A-Za-z0-9_-]{16,100}$/.test(String(operationId||'')))fail(400,'缺少有效操作编号');
 const amountMinor=cnyMinor(amount),when=String(claimedDate||''),reference=String(customerReference).trim(),memo=String(note).trim();
 if(!/^\d{4}-\d{2}-\d{2}$/.test(when)||!Number.isFinite(Date.parse(when))||new Date(when).toISOString().slice(0,10)!==when||when<o.business_date||when>domesticToday())fail(400,'客户付款日期须在订单日期与中国今天之间');
 if(!reference||reference.length>160||memo.length>600)fail(400,'请填写客户付款参考号（最多160字），说明最多600字');
 if(!(file instanceof File)||file.size<=0||file.size>20*1024*1024)fail(400,'请选择不超过20MB的付款图片或PDF');
 const bytes=await file.arrayBuffer(),b=new Uint8Array(bytes),ascii=(a,z)=>String.fromCharCode(...b.slice(a,z));
 const valid=file.type==='application/pdf'?ascii(0,5)==='%PDF-':file.type==='image/jpeg'?b[0]===255&&b[1]===216&&b[2]===255:file.type==='image/png'?b[0]===137&&ascii(1,4)==='PNG':file.type==='image/webp'&&ascii(0,4)==='RIFF'&&ascii(8,12)==='WEBP';
 if(!valid)fail(400,'凭证支持内容与格式一致的 JPG、PNG、WebP 或 PDF');
 const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join(''),name=file.name.replace(/[\r\n]/g,'').slice(0,180);
 const request=JSON.stringify({orderId,name,size:file.size,digest,amountMinor,claimedDate:when,customerReference:reference,note:memo});
 const old=await db.prepare('SELECT * FROM domestic_operations WHERE id=?').bind(operationId).first();
 if(old){if(old.actor_id!==actor.id||old.action!=='paymentProofSubmit'||old.request_json!==request)fail(409,'操作编号已经使用');return {ok:true,id:old.entity_id,replayed:true};}
 if(o.status==='cancelled')fail(409,'订单已取消，请联系财务核查款项');
 if(await db.prepare('SELECT id FROM domestic_payment_submissions WHERE order_id=? AND digest=? AND amount_minor=? AND claimed_date=? AND customer_reference=?').bind(o.id,digest,amountMinor,when,reference).first())fail(409,'这份付款凭证已提交，请查看原记录的核对结果');
 const id='dompay_'+crypto.randomUUID(),key=`domestic-distribution/${o.id}/${id}`,now=new Date().toISOString();
 await bucket.put(key,bytes,{httpMetadata:{contentType:file.type}});
 try{await db.batch([
  db.prepare("INSERT INTO domestic_operations(id,entity_id,action,actor_id,request_json,guard,created_at) VALUES(?,?,'paymentProofSubmit',?,?,CASE WHEN EXISTS(SELECT 1 FROM domestic_orders WHERE id=? AND version=? AND status<>'cancelled') AND EXISTS(SELECT 1 FROM users WHERE id=? AND active=1 AND role=?) THEN 1 ELSE 0 END,?)").bind(operationId,id,actor.id,request,o.id,o.version,actor.id,actor.role,now),
  db.prepare('INSERT INTO domestic_payment_submissions(id,order_id,amount_minor,claimed_date,customer_reference,note,digest,object_key,name,content_type,size,actor_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(id,o.id,amountMinor,when,reference,memo,digest,key,name,file.type,file.size,actor.id,now),
  db.prepare('INSERT INTO audit_logs(id,action,entity_type,entity_id,detail_json,actor_id,actor_name,created_at) VALUES(?,?,?,?,?,?,?,?)').bind('audit_'+crypto.randomUUID(),'paymentProofSubmit','国内线下分销',o.id,JSON.stringify({submissionId:id,amountMinor,claimedDate:when,customerReference:reference,status:'pending'}),actor.id,actor.name,now)
 ]);}catch(e){await bucket.delete(key);if(/CHECK|guard_|UNIQUE|immutable/i.test(String(e)))fail(409,'订单已变化或凭证重复，请刷新核对后重试');throw e;}
 return {ok:true,id,status:'pending'};
}
