import {atomicBatch,guardStatement,assertWritable} from './atomic.mjs';
import {canReadNotice} from './factory-documents.mjs';
import {fail,text} from './purchase-documents.mjs';
export async function uploadFactoryFile(db,bucket,actor,{noticeId,file}){
 const n=await db.prepare('SELECT * FROM factory_dispatch_notices WHERE id=?').bind(noticeId).first();
 if(!n||actor.role!=='工厂'||n.factory_user_id!==actor.id)fail(403,'仅对应工厂可上传装箱凭证');
 if(n.status!=='issued')fail(409,'请在提交装箱清单前上传凭证');await assertWritable(db);
 const count=await db.prepare('SELECT COUNT(*) n FROM factory_document_files WHERE notice_id=?').bind(n.id).first();if(count.n>=20)fail(400,'每张通知最多20份附件');
 if(!(file instanceof File)||file.size<=0||file.size>20*1024*1024)fail(400,'附件须为不超过20MB的图片、PDF或Excel');
 const types=['image/jpeg','image/png','image/webp','application/pdf','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','application/vnd.ms-excel'];if(!types.includes(file.type))fail(400,'附件支持 JPG、PNG、WebP、PDF、XLSX、XLS');
 const bytes=await file.arrayBuffer(),b=new Uint8Array(bytes),ascii=(a,z)=>String.fromCharCode(...b.slice(a,z));
 const valid=file.type==='image/jpeg'?b[0]===255&&b[1]===216&&b[2]===255:file.type==='image/png'?b[0]===137&&ascii(1,4)==='PNG':file.type==='image/webp'?ascii(0,4)==='RIFF'&&ascii(8,12)==='WEBP':file.type==='application/pdf'?ascii(0,5)==='%PDF-':file.type.endsWith('sheet')?ascii(0,2)==='PK':b[0]===208&&b[1]===207&&b[2]===17&&b[3]===224;
 if(!valid)fail(400,'文件内容与格式不符');
 const id='fdoc_'+crypto.randomUUID(),key=`factory-documents/${n.id}/${id}`,stamp=new Date().toISOString(),name=text(file.name.replace(/[\r\n]/g,''),180);
 await bucket.put(key,bytes,{httpMetadata:{contentType:file.type}});
 try{await atomicBatch(db,[guardStatement(db,actor,'uploadFactoryFile',"EXISTS(SELECT 1 FROM factory_dispatch_notices WHERE id=? AND status='issued' AND version=?) AND (SELECT COUNT(*) FROM factory_document_files WHERE notice_id=?)<20",[n.id,n.version,n.id]),db.prepare('INSERT INTO factory_document_files(id,notice_id,object_key,name,content_type,size,actor_id,actor_name,created_at) VALUES(?,?,?,?,?,?,?,?,?)').bind(id,n.id,key,name,file.type,file.size,actor.id,actor.name,stamp),db.prepare('INSERT INTO audit_logs(id,action,entity_type,entity_id,detail_json,actor_id,actor_name,created_at) VALUES(?,?,?,?,?,?,?,?)').bind('audit_'+crypto.randomUUID(),'上传装箱附件','factory_document',n.id,JSON.stringify({fileId:id,name}),actor.id,actor.name,stamp)]);}catch(e){await bucket.delete(key);throw e;}
 return {ok:true,id,name};
}
export async function readFactoryFile(db,actor,id){const file=await db.prepare('SELECT * FROM factory_document_files WHERE id=?').bind(id).first();if(!file)fail(404,'附件不存在');const n=await db.prepare('SELECT * FROM factory_dispatch_notices WHERE id=?').bind(file.notice_id).first();if(!n||!canReadNotice(actor,n))fail(403,'无权查看该附件');return file;}
