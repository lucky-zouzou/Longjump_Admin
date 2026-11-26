import {context,rows,has,fail,text,event,write} from './workplace-common.mjs';
import {financeMode} from './finance-scope.mjs';
const digest=async data=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(data)))),x=>x.toString(16).padStart(2,'0')).join('');
async function sources(db,unit,month){
 const [days,punches,leave,feishu,people,links,status]=await Promise.all([
 rows(db,'SELECT * FROM attendance_days WHERE unit_id=? AND substr(work_date,1,7)=? ORDER BY id',[unit,month]),
 rows(db,'SELECT p.* FROM attendance_punches p JOIN attendance_days d ON d.id=p.day_id WHERE d.unit_id=? AND substr(d.work_date,1,7)=? ORDER BY p.id',[unit,month]),
 rows(db,"SELECT id,version,status,business_date FROM workplace_requests WHERE kind='leave' AND unit_id=? AND substr(business_date,1,7)=? ORDER BY id",[unit,month]),
 rows(db,'SELECT r.* FROM feishu_records r WHERE unit_id=? AND substr(work_date,1,7)=? AND revision=(SELECT MAX(x.revision) FROM feishu_records x WHERE x.kind=r.kind AND x.source_id=r.source_id AND x.link_id=r.link_id) ORDER BY r.id',[unit,month]),
 rows(db,'SELECT user_id FROM workplace_profiles WHERE unit_id=? AND active=1 ORDER BY user_id',[unit]),
 rows(db,'SELECT user_id FROM feishu_user_links WHERE unit_id=? AND active=1 ORDER BY user_id',[unit]),
 db.prepare("SELECT * FROM feishu_sync_state WHERE id='global'").first()
 ]);
 const feishuGroups={};for(const r of feishu){const d=JSON.parse(r.data_json),k=r.kind+':'+(d.status||'unknown'),g=feishuGroups[k]||={kind:r.kind,status:d.status||'unknown',count:0,sourceMissing:0,durationMinutes:0,unknownDuration:0};g.count++;if(r.source_missing)g.sourceMissing++;if(r.kind==='leave'){if(d.durationMinutes==null||r.source_missing)g.unknownDuration++;else g.durationMinutes+=d.durationMinutes;}}
 const summary={localSavedDays:days.length,localPunches:punches.length,localLeaveApproved:leave.filter(l=>l.status==='approved').length,localLeavePending:leave.filter(l=>['submitted','manager_approved'].includes(l.status)).length,feishuGroups:Object.values(feishuGroups),currentConfiguredEmployees:people.length,currentFeishuMappings:links.length,lastSyncSuccess:status?.last_success_at||null,lastSyncError:status?.last_error||null,coverage:'只统计已保存来源；缺记录不等于旷工，不计算扣薪或应发工资。'};
 return {summary,fingerprint:await digest({days,punches,leave,feishu,people,links})};
}
export async function readHrHandoffs(db,a,month){
 const c=await context(db,a),mode=await financeMode(db,a),all=await rows(db,'SELECT h.* FROM hr_finance_handoffs h WHERE month=? AND version=(SELECT MAX(x.version) FROM hr_finance_handoffs x WHERE x.unit_id=h.unit_id AND x.month=h.month)',[month]);
 return {units:c.units.filter(u=>u.active&&has(c,'hr',u.id)),rows:all.filter(h=>a.role==='管理员'||mode==='headquarters'||has(c,'hr',h.unit_id)||has(c,'finance',h.unit_id)).map(h=>({...h,snapshot:JSON.parse(h.snapshot_json),unitName:c.units.find(u=>u.id===h.unit_id)?.name,canAcknowledge:a.role==='财务'&&has(c,'finance',h.unit_id)&&h.issued_by!==a.id&&!h.acknowledged_by}))};
}
export async function mutateHrHandoff(db,a,p){
 const c=await context(db,a),now=new Date().toISOString();
 if(p.action==='hrHandoffAcknowledge'){
  const h=await db.prepare('SELECT * FROM hr_finance_handoffs WHERE id=?').bind(p.id||'').first();if(!h||!has(c,'finance',h.unit_id)||a.id===h.issued_by)fail('需另一位授权财务签收',403);
  const latest=await db.prepare('SELECT MAX(version) version FROM hr_finance_handoffs WHERE unit_id=? AND month=?').bind(h.unit_id,h.month).first();if(h.acknowledged_by||latest.version!==h.version)fail('摘要已签收或有更新版本',409);
  if((await sources(db,h.unit_id,h.month)).fingerprint!==h.fingerprint)fail('来源已更新，请人事重签摘要后再接收',409);
  await write(c,[db.prepare('UPDATE hr_finance_handoffs SET acknowledged_by=?,acknowledged_at=? WHERE id=?').bind(a.id,now,h.id),...event(db,a,h.id,p.action,{reason:text(p.reason,'签收说明',500)})]);return {ok:true};
 }
 const unit=c.units.find(u=>u.id===p.unitId&&u.active);if(!unit||!has(c,'hr',unit.id))fail('仅授权人事可签发该组织摘要',403);const month=p.month;if(!/^20\d{2}-(0[1-9]|1[0-2])$/.test(month)||month>=now.slice(0,7))fail('月度摘要只能签发已结束月份');
 const source=await sources(db,unit.id,month),reason=text(p.reason,'人事核定与缺口说明',1000),previous=await db.prepare('SELECT MAX(version) version FROM hr_finance_handoffs WHERE unit_id=? AND month=?').bind(unit.id,month).first(),id=crypto.randomUUID();
 await write(c,[db.prepare('INSERT INTO hr_finance_handoffs VALUES(?,?,?,?,?,?,?,?,?,?,NULL,NULL)').bind(id,unit.id,month,(previous.version||0)+1,JSON.stringify(source.summary),source.fingerprint,reason,a.id,now,unit.legal_entity),...event(db,a,id,'hrHandoffIssue',{unitId:unit.id,month,reason})]);return {ok:true,id};
}
