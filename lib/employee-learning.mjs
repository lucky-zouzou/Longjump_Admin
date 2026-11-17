import {assertWritable,atomicBatch,guardStatement} from './atomic.mjs';
import {guidesFor} from './employee-guides.mjs';
import {knowledgeKey} from './employee-knowledge.mjs';
import {privateQuestion,publicIntent} from './employee-public.mjs';
import {ledgerQuestion} from './employee-ledgers.mjs';
import {navigationForRole} from './permissions.mjs';
import {wakeQuestion} from './employee-wake.mjs';

function fail(message,status){throw Object.assign(Error(message),{status});}

// Only normalize phrasing. Preserve business nouns, negations, scope and ordering.
export function learningPhrase(question){
  if(typeof question!=='string'||question.length>600)return '';
  const q=(wakeQuestion(question)??question).normalize('NFKC').trim().toLowerCase();
  if(privateQuestion(q)||publicIntent(q)||ledgerQuestion(q))return '';
  const phrase=q.replace(/[\s，。？！、,.?!]+/gu,'')
    .replace(/^(?:你好|请问一下|请问|想问一下|我想问问)+/u,'')
    .replace(/(?:怎么个|咋个|怎样|如何|咋)/gu,'怎么')
    .replace(/哪(?:里|儿)/gu,'哪里').replace(/[呀呢啊嘛啦吗]+$/u,'');
  return phrase.length>=4&&phrase.length<=160?phrase:'';
}

export async function learnedGuide(db,actor,phrase,page,allowed){
  if(page&&!navigationForRole(actor.role).includes(page))return null;
  const key=await knowledgeKey('guide-example',phrase,'',page,'');
  const rows=(await db.prepare(`SELECT f.guide_id,COUNT(*) AS votes,MAX(f.actor_id=?) AS mine
    FROM employee_guide_feedback f JOIN users u ON u.id=f.actor_id AND u.active=1 AND u.role=f.role
    WHERE f.role=? AND f.page=? AND f.question_key=? GROUP BY f.guide_id`).bind(actor.id,actor.role,page,key).all()).results;
  const own=rows.find(row=>row.mine);
  // A personal correction works immediately. A shared match needs independent agreement.
  const chosen=own||(rows.length===1&&rows[0].votes>=2?rows[0]:null);
  const guide=chosen&&allowed.find(g=>g.id===chosen.guide_id);
  return guide?{guide,personal:!!own}:null;
}

export async function saveGuideFeedback(db,actor,input){
  const {question,page='',guideId,forget=false}=input||{};
  const phrase=learningPhrase(question);
  if(!phrase||typeof page!=='string'||page&&!navigationForRole(actor.role).includes(page)||typeof forget!=='boolean')
    fail('请选一个当前工作区的操作问题。',400);
  if(!forget&&!guidesFor(actor).some(g=>g.id===guideId))fail('这条指引不在你当前的岗位手册里。',403);
  const key=await knowledgeKey('guide-example',phrase,'',page,'');
  const identity=[actor.id,actor.role,page,key];
  const statement=forget?db.prepare('DELETE FROM employee_guide_feedback WHERE actor_id=? AND role=? AND page=? AND question_key=?').bind(...identity):
    db.prepare(`INSERT INTO employee_guide_feedback(actor_id,role,page,question_key,guide_id,updated_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(actor_id,role,page,question_key) DO UPDATE SET guide_id=excluded.guide_id,updated_at=excluded.updated_at
      WHERE employee_guide_feedback.guide_id<>excluded.guide_id`).bind(...identity,guideId,new Date().toISOString());
  await assertWritable(db);
  const guard="EXISTS(SELECT 1 FROM users WHERE id=? AND active=1 AND role=?) AND NOT EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))";
  await atomicBatch(db,[guardStatement(db,actor,'employee.guide-feedback',guard,[actor.id,actor.role]),statement]);
  return {remembered:!forget};
}
