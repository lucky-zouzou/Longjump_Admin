import {assertWritable,atomicBatch,guardStatement} from './atomic.mjs';
import {guidesFor,publicGuide} from './employee-guides.mjs';

const digest=async text=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))),b=>b.toString(16).padStart(2,'0')).join('');
export const normalizeQuestion=q=>q.normalize('NFKC').toLowerCase().replace(/[？?！!。，,、\s]+/gu,' ').trim();
export async function knowledgeKey(mode,q,previous,page,guideId){
  return digest(JSON.stringify([mode,normalizeQuestion(q),previous||'',page||'',guideId||'']));
}
const revision=g=>digest(JSON.stringify(publicGuide(g)));
export async function recall(db,actor,scope,key,now){
  const row=await db.prepare('SELECT * FROM employee_knowledge WHERE role=? AND scope=? AND question_key=?').bind(actor.role,scope,key).first();
  if(!row||row.expires_at&&row.expires_at<=now)return null;
  const guide=scope==='internal'?guidesFor(actor).find(g=>g.id===row.guide_id):null;
  if(scope==='internal'&&(!guide||await revision(guide)!==row.revision))return null;
  const answer=JSON.parse(row.answer_json);
  return {...answer,guide:guide?publicGuide(guide):null,source:'knowledge',origin:answer.source,topic:{scope,key,title:row.title},verifiedAt:row.verified_at,notice:''};
}
export async function remember(db,actor,scope,key,question,reply,now){
  const guide=guidesFor(actor).find(g=>g.id===reply.guide?.id);
  if(scope==='internal'?!guide:!reply.citations?.length)return;
  const stamp=guide?await revision(guide):'public-v1';
  const expires=scope==='public'?new Date(Date.parse(now)+86400000).toISOString():null;
  const title=guide?guide.title:question.trim();
  const saved={answer:reply.answer,intent:reply.intent,source:reply.source,citations:reply.citations||[]};
  // Fail closed during a backup. A previously answered topic stays usable.
  await assertWritable(db);
  const statement=db.prepare(`INSERT INTO employee_knowledge(role,scope,question_key,title,guide_id,revision,answer_json,verified_at,expires_at)
    VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(role,scope,question_key) DO UPDATE SET title=excluded.title,guide_id=excluded.guide_id,
    revision=excluded.revision,answer_json=excluded.answer_json,verified_at=excluded.verified_at,expires_at=excluded.expires_at
    WHERE excluded.verified_at>=employee_knowledge.verified_at`).bind(actor.role,scope,key,title,guide?.id||'',stamp,JSON.stringify(saved),now,expires);
  await atomicBatch(db,[guardStatement(db,actor,'employee.knowledge', "NOT EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))",[]),statement]);
}
export async function recentKnowledge(db,actor,now){
  const allowed=new Set(guidesFor(actor).map(g=>g.id));
  const rows=(await db.prepare('SELECT scope,question_key,title,guide_id,MAX(verified_at) verified_at FROM employee_knowledge WHERE role=? AND (expires_at IS NULL OR expires_at>?) GROUP BY scope,title,guide_id ORDER BY verified_at DESC LIMIT 24').bind(actor.role,now).all()).results;
  return rows.filter(r=>r.scope==='public'||allowed.has(r.guide_id)).slice(0,10).map(({scope,question_key,title})=>({scope,key:question_key,title}));
}
