import {promotionRecord,auditPromotion,canApply} from './promotions.mjs';
import {fail,text} from './promotion-model.mjs';
import {evidenceType} from './after-sales-files.mjs';
import {assertWritable,atomicBatch,guardStatement} from './atomic.mjs';
export async function uploadPromotionFile(db,bucket,actor,id,purpose,file){
 await assertWritable(db);const r=await promotionRecord(db,actor,id),states={proposal:['draft'],execution:['approved'],stop:['active','stop_required']};
 if(!canApply(actor)||r.owner_id!==actor.id||!states[purpose]?.includes(r.status))fail('当前步骤不可上传此类凭证，仅申请运营可上传',403);
 if(!file||typeof file.arrayBuffer!=='function'||file.size<=0||file.size>10*1024*1024)fail('请选择10MB以内图片');
 const bytes=new Uint8Array(await file.arrayBuffer()),type=evidenceType(bytes);if(!type)fail('只支持 JPG、PNG、WebP 图片');
 const sha=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),v=>v.toString(16).padStart(2,'0')).join('');
 const old=await db.prepare('SELECT id FROM promotion_files WHERE record_id=? AND revision=? AND purpose=? AND sha256=?').bind(r.id,r.revision,purpose,sha).first();if(old)return {ok:true,id:old.id};
 const idFile='pf_'+crypto.randomUUID(),key=`promotions/${r.id}/${idFile}`,at=new Date().toISOString();await bucket.put(key,bytes.buffer,{httpMetadata:{contentType:type}});
 try{await atomicBatch(db,[guardStatement(db,actor,'promotion.upload','EXISTS(SELECT 1 FROM promotions WHERE id=? AND version=? AND status=?) AND (SELECT COUNT(*) FROM promotion_files WHERE record_id=? AND revision=? AND purpose=?)<6',[r.id,r.version,r.status,r.id,r.revision,purpose]),db.prepare('INSERT INTO promotion_files VALUES(?,?,?,?,?,?,?,?,?,?,?)').bind(idFile,r.id,r.revision,purpose,key,text(file.name,180),type,bytes.length,sha,actor.id,at),db.prepare('UPDATE promotions SET version=version+1,updated_at=? WHERE id=?').bind(at,r.id),auditPromotion(db,actor,r.id,'upload',{purpose,revision:r.revision,fileId:idFile})]);}catch(e){await bucket.delete(key);throw e;}
 return {ok:true,id:idFile};
}
