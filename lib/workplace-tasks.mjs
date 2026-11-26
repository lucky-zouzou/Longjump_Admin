import {context,rows,has,manager} from './workplace-common.mjs';
export async function workplaceTasks(db,actor){
 if(!actor?.id)return [];if(!await db.prepare('SELECT user_id FROM workplace_profiles WHERE active=1 AND (user_id=? OR manager_id=?) UNION ALL SELECT user_id FROM workplace_grants WHERE user_id=? LIMIT 1').bind(actor.id,actor.id,actor.id).first())return [];const c=await context(db,actor),tasks=[];
 for(const r of await rows(db,"SELECT * FROM workplace_requests WHERE status IN('submitted','manager_approved','approved') AND NOT EXISTS(SELECT 1 FROM workplace_request_cancellations z WHERE z.request_id=workplace_requests.id)")){
  const data=JSON.parse(r.data_json),ad=r.kind==='expense'&&data.category==='advertising';
  let title='';if(r.status==='submitted'&&manager(c,r.user_id,r.unit_id))title=r.kind==='leave'?'审批团队请假':ad?'审批广告预算申请':'审批团队费用申请';
  if(r.status==='manager_approved'&&r.user_id!==actor.id&&r.manager_actor!==actor.id&&has(c,r.kind==='leave'?'hr':'finance',r.unit_id))title=r.kind==='leave'?'复核请假申请':ad?(data.budget?.version===1?'核定广告预算':'退回旧广告意向补全期间'):'复核费用来源与应付';
  if(r.kind==='expense'&&!ad&&r.status==='approved'&&r.user_id!==actor.id&&r.manager_actor!==actor.id&&has(c,'finance',r.unit_id))title='跟进付款与银行核对';
  if(title)tasks.push({tab:r.kind==='leave'?'attendance':'finance-workbench',view:r.kind==='leave'?'approvals':ad?'advertising-approvals':'expenses',entity:r.id,title,detail:`${c.units.find(u=>u.id===r.unit_id)?.name||''} · ${r.business_date}`,level:'amber'});
 }
 for(const e of await rows(db,"SELECT e.*, (SELECT d.actor_id FROM workplace_all_payments p JOIN finance_documents d ON d.id=p.document_id WHERE p.id=json_extract(e.detail_json,'$.linkId')) payment_actor,r.unit_id,r.user_id,r.manager_actor,r.business_date FROM workplace_events e JOIN workplace_requests r ON r.id=e.entity_id WHERE e.action IN ('paymentCorrectionRequested','expenseCancellationRequested') AND NOT EXISTS(SELECT 1 FROM workplace_events x WHERE x.entity_id=e.entity_id AND x.action IN ('paymentCorrectionApproved','paymentCorrectionRejected','expenseCancellationApproved','expenseCancellationRejected') AND json_extract(x.detail_json,'$.requestEventId')=e.id)")){
  if(has(c,'finance',e.unit_id)&&actor.id!==e.actor_id&&actor.id!==e.user_id&&actor.id!==e.manager_actor&&actor.id!==e.payment_actor)tasks.push({tab:'finance-workbench',view:'expenses',entity:e.entity_id,title:e.action==='paymentCorrectionRequested'?'复核付款更正':'复核已批申请取消',detail:`${c.units.find(u=>u.id===e.unit_id)?.name||''} · ${e.business_date}`,level:'amber'});
 }
 return tasks;
}
