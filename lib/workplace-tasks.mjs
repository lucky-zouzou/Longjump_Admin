import {context,rows,has,manager} from './workplace-common.mjs';
export async function workplaceTasks(db,actor){
 if(!actor?.id)return [];if(!await db.prepare('SELECT user_id FROM workplace_profiles WHERE active=1 AND (user_id=? OR manager_id=?) UNION ALL SELECT user_id FROM workplace_grants WHERE user_id=? LIMIT 1').bind(actor.id,actor.id,actor.id).first())return [];const c=await context(db,actor),tasks=[];
 for(const r of await rows(db,"SELECT * FROM workplace_requests WHERE status IN('submitted','manager_approved','approved')")){
  let title='';if(r.status==='submitted'&&manager(c,r.user_id,r.unit_id))title=r.kind==='leave'?'审批团队请假':'审批团队费用申请';
  if(r.status==='manager_approved'&&r.user_id!==actor.id&&r.manager_actor!==actor.id&&has(c,r.kind==='leave'?'hr':'finance',r.unit_id))title=r.kind==='leave'?'复核请假申请':'复核费用来源与应付';
  if(r.kind==='expense'&&r.status==='approved'&&r.user_id!==actor.id&&r.manager_actor!==actor.id&&has(c,'finance',r.unit_id))title='跟进付款与银行核对';
  if(title)tasks.push({tab:r.kind==='leave'?'attendance':'finance-workbench',entity:r.id,title,detail:`${c.units.find(u=>u.id===r.unit_id)?.name||''} · ${r.business_date}`,level:'amber'});
 }
 return tasks;
}
