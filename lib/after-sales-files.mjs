import {canSupplement,canonicalFactory} from './quality-closure.mjs';
import {AfterSalesError,afterRecord,auditAfter,canCreate} from './after-sales.mjs';
import {assertWritable,atomicBatch,guardStatement} from './atomic.mjs';
export function evidenceType(b){const s=(a,z)=>String.fromCharCode(...b.slice(a,z));return b[0]===255&&b[1]===216&&b[2]===255?'image/jpeg':b[0]===137&&s(1,8)==='PNG\r\n\x1a\n'?'image/png':s(0,4)==='RIFF'&&s(8,12)==='WEBP'?'image/webp':s(0,5)==='%PDF-'?'application/pdf':'';}
export async function uploadAfterEvidence(db,bucket,actor,id,file){
 await assertWritable(db);const r=await afterRecord(db,actor,id);
 if(!await canSupplement(db,actor,r))throw new AfterSalesError('无权为该记录追加证据',403);
 if(!file||typeof file.arrayBuffer!=='function'||file.size<=0||file.size>10*1024*1024)throw new AfterSalesError('请选择不超过10MB的图片或PDF');
 const b=new Uint8Array(await file.arrayBuffer()),type=evidenceType(b);if(!type)throw new AfterSalesError('仅支持 JPG、PNG、WebP 或 PDF 凭据');
 const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',b)),v=>v.toString(16).padStart(2,'0')).join('');
 const old=await db.prepare('SELECT id FROM after_sales_files WHERE record_id=? AND sha256=?').bind(r.id,hash).first();if(old)return {ok:true,id:old.id,replayed:true};
 const fid='af_'+crypto.randomUUID(),key=`after-sales/${r.id}/${fid}`,now=new Date().toISOString();await bucket.put(key,b.buffer,{httpMetadata:{contentType:type}});
 const factory=actor.role==='工厂'?await canonicalFactory(db,r):null;
 try{await atomicBatch(db,[...(actor.role==='工厂'?[guardStatement(db,actor,'after_sales.factory-evidence',"EXISTS(SELECT 1 FROM business_partners WHERE id=? AND assigned_user_id=? AND active=1)",[factory?.id||'',actor.id])]:[]),guardStatement(db,actor,'after_sales.upload',"EXISTS(SELECT 1 FROM after_sales WHERE id=? AND version=? AND status<>'void') AND EXISTS(SELECT 1 FROM users WHERE id=? AND active=1 AND role=?) AND (SELECT COUNT(*) FROM after_sales_files WHERE record_id=?)<30",[r.id,r.version,actor.id,actor.role,r.id]),db.prepare('INSERT INTO after_sales_files(id,record_id,object_key,name,content_type,size,sha256,actor_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)').bind(fid,r.id,key,String(file.name||'evidence').replace(/[\r\n]/g,'').slice(0,180),type,file.size,hash,actor.id,now),db.prepare('UPDATE after_sales SET version=version+1,updated_at=? WHERE id=?').bind(now,r.id),auditAfter(db,actor,r.id,'upload',{fileId:fid,sha256:hash})]);}catch(e){await bucket.delete(key);throw e;}
 return {ok:true,id:fid};
}
