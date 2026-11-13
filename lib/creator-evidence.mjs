import {practiceFile} from './creator-practice-file.mjs';
import {creatorActor,canCreatorProfile} from './creator-policy.mjs';
import {fail} from './creator-model.mjs';

// Files and their business event commit together. Only references are returned in snapshots.
export function creatorEvidence(input,put,{profile,round,actor,now},imagesOnly=false){
 if(input==null)return [];
 if(!Array.isArray(input)||input.length>8)fail('每次最多上传8份附件，每份最多1 MB');
 return input.map(source=>{
  const file=practiceFile(source);
  if(!file||imagesOnly&&!file.mime.startsWith('image/'))fail('请上传 PNG 或 JPEG 图片');
  put('creator_evidence_files',{...file,creator_id:profile.id,round_id:round.id,actor_id:actor.id,created_at:now});
  return {id:file.id,name:file.filename,mime:file.mime};
 });
}
export async function readCreatorEvidence(db,identity,id){
 const actor=await creatorActor(db,identity);
 if(!['管理员','财务','运营主管','达人BD','运营'].includes(actor.role))fail('没有附件查看权限',403);
 const f=await db.prepare('SELECT creator_id FROM creator_evidence_files WHERE id=?').bind(id).first();
 const p=f&&await db.prepare('SELECT * FROM creator_profiles WHERE id=?').bind(f.creator_id).first();
 const s=p&&await db.prepare('SELECT * FROM creator_scopes WHERE id=?').bind(p.scope_id).first();
 if(!p||!canCreatorProfile(actor,p,s))fail('附件不存在或无权查看',404);
 return db.prepare('SELECT filename,mime,payload FROM creator_evidence_files WHERE id=?').bind(id).first();
}
