import {context,clock,canRead,has,fail,text,event,write} from './workplace-common.mjs';
import {expenseRequest} from './finance-workbench.mjs';
import {assertFinanceOpen} from './finance-periods.mjs';
export async function uploadWorkplaceProof(db,bucket,a,id,file){
 const c=await context(db,a),r=await expenseRequest(db,id);if(!r||!canRead(c,r)||!(r.user_id===a.id||has(c,'finance',r.unit_id)))fail('无权上传该申请凭证',403);
 if(!['submitted','manager_approved','approved'].includes(r.status))fail('该申请不接受新凭证',409);await assertFinanceOpen(db,r.business_date);if(!bucket)fail('私有凭证存储未配置',503);
 if(!file||typeof file.arrayBuffer!=='function'||!file.size||file.size>10*1024*1024)fail('请上传不超过10MB的PDF、PNG或JPEG',413);
 const bytes=new Uint8Array(await file.arrayBuffer()),mime=file.type,valid=mime==='application/pdf'&&String.fromCharCode(...bytes.slice(0,5))==='%PDF-'||mime==='image/png'&&[137,80,78,71,13,10,26,10].every((v,i)=>bytes[i]===v)||mime==='image/jpeg'&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255;
 if(!valid)fail('文件内容与允许的类型不符');const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');
 if(await db.prepare('SELECT id FROM workplace_proofs WHERE sha256=?').bind(hash).first())fail('该文件已登记，请使用原凭证，避免重复付款',409);
 const proofId=crypto.randomUUID(),key=`workplace/${r.id}/${proofId}`,filename=text(file.name,'文件名',180).replace(/[\r\n\/\\]/g,'_');
 await bucket.put(key,bytes,{httpMetadata:{contentType:mime}});
 try{await write(c,[db.prepare('INSERT INTO workplace_proofs VALUES(?,?,?,?,?,?,?,?,?)').bind(proofId,r.id,key,filename,mime,bytes.length,hash,a.id,new Date().toISOString()),...event(db,c.a,r.id,'proofUpload',{proofId,filename,sha256:hash})]);}catch(e){await bucket.delete(key);throw e;}
 return {ok:true,id:proofId};
}
export async function readWorkplaceProof(db,bucket,a,id){const c=await context(db,a),f=await db.prepare('SELECT * FROM workplace_proofs WHERE id=?').bind(id||'').first(),r=f?await expenseRequest(db,f.request_id):null;if(!r||!canRead(c,r)||has(c,'executive',r.unit_id)&&r.user_id!==a.id&&!has(c,'finance',r.unit_id)&&!managerProof(c,r))fail('凭证不存在或无权访问',404);if(!bucket)fail('私有存储未配置',503);const object=await bucket.get(f.object_key);if(!object)fail('凭证文件不存在',404);if(await clock(db)!==c.version)fail('凭证权限或资料已变化，请刷新',409);return {file:f,object};}
const managerProof=(c,r)=>c.profiles.some(p=>p.user_id===r.user_id&&p.manager_id===c.a.id&&p.unit_id===r.unit_id)||has(c,'manager',r.unit_id);
