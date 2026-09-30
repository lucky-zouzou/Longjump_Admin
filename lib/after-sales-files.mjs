import {AfterSalesError,afterRecord,auditAfter,canCreate} from './after-sales.mjs';
import {assertWritable,atomicBatch,guardStatement} from './atomic.mjs';
export function evidenceType(b){const s=(a,z)=>String.fromCharCode(...b.slice(a,z));return b[0]===255&&b[1]===216&&b[2]===255?'image/jpeg':b[0]===137&&s(1,8)==='PNG\r\n\x1a\n'?'image/png':s(0,4)==='RIFF'&&s(8,12)==='WEBP'?'image/webp':'';}
export async function uploadAfterEvidence(db,bucket,actor,id,file){
 await assertWritable(db);const r=await afterRecord(db,actor,id);
 if(!canCreate(actor)||r.owner_id!==actor.id||r.status!=='draft')throw new AfterSalesError('仅本人售后草稿可上传图片',403);
 if(!file||typeof file.arrayBuffer!=='function'||file.size<=0||file.size>10*1024*1024)throw new AfterSalesError('请选择不超过10MB的图片');
 const b=new Uint8Array(await file.arrayBuffer()),type=evidenceType(b);if(!type)throw new AfterSalesError('仅支持 JPG、PNG、WebP 截图或照片');
 const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',b)),v=>v.toString(16).padStart(2,'0')).join('');
 const old=await db.prepare('SELECT id FROM after_sales_files WHERE record_id=? AND sha256=?').bind(r.id,hash).first();if(old)return {ok:true,id:old.id,replayed:true};
 const fid='af_'+crypto.randomUUID(),key=`after-sales/${r.id}/${fid}`,now=new Date().toISOString();await bucket.put(key,b.buffer,{httpMetadata:{contentType:type}});
 try{await atomicBatch(db,[guardStatement(db,actor,'after_sales.upload',"EXISTS(SELECT 1 FROM after_sales WHERE id=? AND version=? AND status='draft') AND (SELECT COUNT(*) FROM after_sales_files WHERE record_id=?)<6",[r.id,r.version,r.id]),db.prepare('INSERT INTO after_sales_files(id,record_id,object_key,name,content_type,size,sha256,actor_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)').bind(fid,r.id,key,String(file.name||'evidence').replace(/[\r\n]/g,'').slice(0,180),type,file.size,hash,actor.id,now),db.prepare('UPDATE after_sales SET version=version+1,updated_at=? WHERE id=?').bind(now,r.id),auditAfter(db,actor,r.id,'upload',{fileId:fid,sha256:hash})]);}catch(e){await bucket.delete(key);throw e;}
 return {ok:true,id:fid};
}
