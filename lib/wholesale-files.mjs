import {canReadWholesaleOrder,WholesaleError} from './wholesale.mjs';
import {hasPermission} from './permissions.mjs';
import {assertWritable} from './atomic.mjs';

const fail=(status,message)=>{throw new WholesaleError(status,message);};
export const canFinanceProof=actor=>hasPermission(actor.role,'wholesale.finance');
export const publicProof=f=>({id:f.id,name:f.name,content_type:f.content_type,size:f.size,created_at:f.created_at,actor_name:f.actor_name||'',finance_entry_id:f.finance_entry_id});

export async function uploadWholesaleFile(db,bucket,actor,{orderId,purpose='shipment',entryId='',file}){
 if(!['shipment','finance'].includes(purpose))fail(400,'请选择有效的凭证类型');
 const order=await db.prepare('SELECT * FROM wholesale_orders WHERE id=?').bind(orderId).first();
 if(!order||!canReadWholesaleOrder(actor,order))fail(403,'无权处理该订单凭证');
 const finance=purpose==='finance';
 if(finance){
  if(!canFinanceProof(actor))fail(403,'仅财务和管理员可上传或查看回款凭证');
  if(entryId&&!await db.prepare('SELECT id FROM wholesale_finance_entries WHERE id=? AND order_id=?').bind(entryId,order.id).first())fail(400,'财务记录不存在或不属于此订单');
  if(entryId&&Number((await db.prepare('SELECT COUNT(*) n FROM wholesale_files WHERE finance_entry_id=?').bind(entryId).first()).n)>=10)fail(400,'每条财务记录最多关联10份凭证');
 }else{
  if(entryId)fail(400,'发货凭证不能关联财务记录');
  if(!hasPermission(actor.role,'wholesale.ship'))fail(403,'仅该订单供应链负责人或管理员可上传发货凭证');
  if(!['approved','packing','partial'].includes(order.status))fail(409,'请在订单审批后、发货完成前上传凭证');
 }
 await assertWritable(db);
 const types=finance?['image/jpeg','image/png','image/webp','application/pdf']:['image/jpeg','image/png','image/webp','video/mp4','video/webm','video/quicktime'];
 if(!(file instanceof File)||file.size<=0||file.size>20*1024*1024)fail(400,finance?'请选择不超过20MB的图片或PDF':'请选择不超过20MB的照片或视频');
 if(!types.includes(file.type))fail(400,finance?'回款凭证支持 JPG、PNG、WebP、PDF':'支持 JPG、PNG、WebP、MP4、WebM、MOV');
 const bytes=await file.arrayBuffer(),b=new Uint8Array(bytes),ascii=(a,z)=>String.fromCharCode(...b.slice(a,z));
 const valid=file.type==='application/pdf'?ascii(0,5)==='%PDF-':file.type==='image/jpeg'?b[0]===255&&b[1]===216&&b[2]===255:file.type==='image/png'?b[0]===137&&ascii(1,4)==='PNG':file.type==='image/webp'?ascii(0,4)==='RIFF'&&ascii(8,12)==='WEBP':file.type==='video/webm'?b[0]===26&&b[1]===69&&b[2]===223&&b[3]===163:ascii(4,8)==='ftyp';
 if(!valid)fail(400,finance?'文件内容与图片／PDF格式不符':'文件内容与照片／视频格式不符');
 const id='whfile_'+crypto.randomUUID(),key=`wholesale/${order.id}/${id}`,name=file.name.replace(/[\r\n]/g,'').slice(0,180),now=new Date().toISOString();
 await bucket.put(key,bytes,{httpMetadata:{contentType:file.type}});
 try{
  await db.batch([
   db.prepare('INSERT INTO wholesale_files (id,order_id,object_key,name,content_type,size,actor_id,created_at,purpose,finance_entry_id,actor_name) VALUES (?,?,?,?,?,?,?,?,?,?,?)').bind(id,order.id,key,name,file.type,file.size,actor.id,now,purpose,entryId||null,actor.name),
   db.prepare('INSERT INTO audit_logs (id,action,entity_type,entity_id,detail_json,actor_id,actor_name,created_at) VALUES (?,?,?,?,?,?,?,?)').bind('audit_'+crypto.randomUUID(),'wholesaleFileUpload','印尼线下批发',order.id,JSON.stringify({fileId:id,purpose,entryId:entryId||null,name}),actor.id,actor.name,now)
  ]);
 }catch(error){
  await bucket.delete(key);
  if(/guard_finance_file/.test(String(error)))fail(409,'财务凭证关联已变化或超过10份，请刷新核对');
  if(/guard_maintenance/.test(String(error)))fail(409,'系统正在备份或迁移，暂时停止写入，请稍后重试');
  throw error;
 }
 return {ok:true,...publicProof({id,name,content_type:file.type,size:file.size,created_at:now,actor_name:actor.name,finance_entry_id:entryId||null})};
}
