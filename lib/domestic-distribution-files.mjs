import {assertWritable} from './atomic.mjs';
import {DomesticError,domesticOrderFor,domesticCapabilities} from './domestic-distribution.mjs';
const fail=(s,m)=>{throw new DomesticError(s,m);};
export function canDomesticFile(actor,purpose){const c=domesticCapabilities(actor);return purpose==='finance'?actor.role==='财务'||actor.role==='管理员':['quote','contract'].includes(purpose)?c.manage||c.approve:c.execute||c.approve;}
export async function uploadDomesticFile(db,bucket,actor,{orderId,purpose,file,operationId}){
 const o=await domesticOrderFor(db,actor,orderId),active=await db.prepare('SELECT active,role FROM users WHERE id=?').bind(actor.id).first();if(!active?.active||active.role!==actor.role)fail(403,'账号已失效');
 if(!['quote','contract','source','packing','shipment','receipt','finance'].includes(purpose)||!canDomesticFile(actor,purpose))fail(403,'当前岗位不能上传此类型凭证');
 if(purpose==='finance'&&actor.role!=='财务')fail(403,'仅财务可上传银行核对凭证');
 if(!/^[A-Za-z0-9_-]{16,100}$/.test(String(operationId||'')))fail(400,'缺少有效操作编号');await assertWritable(db);
 if(!(file instanceof File)||file.size<=0||file.size>20*1024*1024)fail(400,'请选择不超过20MB的图片或PDF');
 if(!['image/jpeg','image/png','image/webp','application/pdf'].includes(file.type))fail(400,'凭证支持 JPG、PNG、WebP 或 PDF');
 const bytes=await file.arrayBuffer(),b=new Uint8Array(bytes),ascii=(a,z)=>String.fromCharCode(...b.slice(a,z));
 const valid=file.type==='application/pdf'?ascii(0,5)==='%PDF-':file.type==='image/jpeg'?b[0]===255&&b[1]===216&&b[2]===255:file.type==='image/png'?b[0]===137&&ascii(1,4)==='PNG':ascii(0,4)==='RIFF'&&ascii(8,12)==='WEBP';if(!valid)fail(400,'文件内容与声明格式不符');
 const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(n=>n.toString(16).padStart(2,'0')).join(''),name=file.name.replace(/[\r\n]/g,'').slice(0,180),request=JSON.stringify({orderId,purpose,name,size:file.size,digest});
 const old=await db.prepare('SELECT * FROM domestic_operations WHERE id=?').bind(operationId).first();if(old){if(old.actor_id!==actor.id||old.action!=='fileUpload'||old.request_json!==request)fail(409,'操作编号已经使用');const prior=await db.prepare('SELECT id,name,purpose,content_type,size FROM domestic_files WHERE id=?').bind(old.entity_id).first();return {ok:true,...prior,replayed:true};}
 const id='domfile_'+crypto.randomUUID(),key=`domestic-distribution/${o.id}/${id}`,now=new Date().toISOString();await bucket.put(key,bytes,{httpMetadata:{contentType:file.type}});
 try{await db.batch([
  db.prepare("INSERT INTO domestic_operations(id,entity_id,action,actor_id,request_json,guard,created_at) VALUES(?,?,'fileUpload',?,?,CASE WHEN EXISTS(SELECT 1 FROM domestic_orders WHERE id=? AND version=?) AND EXISTS(SELECT 1 FROM users WHERE id=? AND active=1 AND role=?) THEN 1 ELSE 0 END,?)").bind(operationId,id,actor.id,request,o.id,o.version,actor.id,actor.role,now),
  db.prepare('INSERT INTO domestic_files(id,order_id,purpose,object_key,name,content_type,size,actor_id,created_at,order_version) VALUES(?,?,?,?,?,?,?,?,?,?)').bind(id,o.id,purpose,key,name,file.type,file.size,actor.id,now,o.version),
  db.prepare('INSERT INTO audit_logs(id,action,entity_type,entity_id,detail_json,actor_id,actor_name,created_at) VALUES(?,?,?,?,?,?,?,?)').bind('audit_'+crypto.randomUUID(),'domesticFileUpload','国内线下分销',o.id,JSON.stringify({fileId:id,purpose,name}),actor.id,actor.name,now)
 ]);}catch(e){await bucket.delete(key);if(/CHECK|guard_|UNIQUE/i.test(String(e)))fail(409,'订单或备份状态已变化，请刷新后重新上传');throw e;}
 return {ok:true,id,name,purpose,content_type:file.type,size:file.size};
}
export async function readDomesticFile(db,bucket,actor,id){
 const f=await db.prepare('SELECT * FROM domestic_files WHERE id=?').bind(String(id).slice(0,100)).first();if(!f)fail(404,'凭证不存在');await domesticOrderFor(db,actor,f.order_id);if(!canDomesticFile(actor,f.purpose))fail(403,'当前岗位无权查看此凭证');const object=await bucket.get(f.object_key);if(!object)fail(404,'凭证原文件暂时无法读取');return {file:f,body:object.body};
}
