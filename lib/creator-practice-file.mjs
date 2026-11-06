import {fail,required} from './creator-model.mjs';
import {creatorActor,canCreatorScope,canReviewExperience} from './creator-policy.mjs';
export function practiceFile(input){
 if(!input)return null;
 const filename=required(input.name,'文件名',180);
 if(typeof input.base64!=='string'||input.base64.length>1398104)fail('附件最多1 MB');
 let bytes;try{bytes=atob(input.base64);}catch{fail('附件编码无效');}
 if(!bytes.length||bytes.length>1048576)fail('附件最多1 MB');
 const mime=bytes.startsWith('%PDF-')?'application/pdf':bytes.startsWith('\x89PNG\r\n\x1a\n')?'image/png':bytes.startsWith('\xff\xd8\xff')?'image/jpeg':'';
 if(!mime)fail('请选择 PDF、PNG 或 JPEG 文件');
 return {id:crypto.randomUUID(),filename,mime,payload:input.base64};
}
export async function readPracticeFile(db,actor,id){
 if(!['管理员','财务','运营主管','达人BD','运营'].includes(actor.role))fail('没有经验附件权限',403);
 actor=await creatorActor(db,actor);
 const row=await db.prepare('SELECT f.id,f.practice_id,p.author_id,p.scope_id,p.status,p.data_json FROM creator_practice_files f JOIN creator_practices p ON p.id=f.practice_id WHERE f.id=?').bind(id).first();
 if(!row)fail('附件不存在',404);
 const scope=await db.prepare('SELECT * FROM creator_scopes WHERE id=?').bind(row.scope_id).first();
 const personal=row.author_id===actor.id&&canCreatorScope(actor,scope);
 if(!personal&&!canReviewExperience(actor)&&!(row.status==='approved'&&JSON.parse(row.data_json).attachment?.id===id))fail('附件尚未开放共享',403);
 return db.prepare('SELECT filename,mime,payload FROM creator_practice_files WHERE id=?').bind(id).first();
}
