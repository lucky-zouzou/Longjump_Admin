import {readHrHandoffs} from './hr-finance-handoff.mjs';
import {workplaceAccess} from './role-workplace.mjs';
import {rows,fail,text,day,context,clock,has,manager,canRead,event,write,profileRequired,requestVersion,configurationView} from './workplace-common.mjs';
import {getFeishuSource,readFeishuAttendance} from './feishu-store.mjs';
import {workplaceSetup} from './workplace-readiness.mjs';
export function localParts(at,tz){const p=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(at)).map(p=>[p.type,p.value]));return {date:`${p.year}-${p.month}-${p.day}`,minute:Number(p.hour)*60+Number(p.minute)};}
const plus=(d,n)=>new Date(Date.parse(d+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);
function zonedTime(d,minute,tz){
 const target=Date.parse(d+'T00:00:00Z')+minute*60000;let guess=target;
 for(let n=0;n<4;n++){const p=localParts(guess,tz),actual=Date.parse(p.date+'T00:00:00Z')+p.minute*60000;guess+=target-actual;}
 const p=localParts(guess,tz);if(p.date!==d||p.minute!==minute)fail('该班次时间在当地时区不存在，请由人事调整');
 // Ambiguous daylight-saving wall times require explicit rescheduling, not a guessed offset.
 if([-120,-60,-30,30,60,120].some(n=>{const x=localParts(guess+n*60000,tz);return x.date===d&&x.minute===minute;}))fail('班次跨夏令时重复时刻，请人事明确调整');
 return new Date(guess).toISOString();
}
export function shiftPlan(unit,shift,date){
 day(date);if(!unit||unit.active===0)fail('尚未配置有效组织');if(!shift||!shift.active)fail('尚未配置有效班次');if(shift.unit_id&&shift.unit_id!==unit.id)fail('班次与组织不一致，请联系管理员配置');const weekdays=JSON.parse(shift.weekdays_json);
 if(!weekdays.includes(new Date(date+'T00:00:00Z').getUTCDay()))return null;
 const endDate=shift.end_minute<shift.start_minute?plus(date,1):date;
 return {date,unitId:unit.id,shiftId:shift.id,shiftRevision:shift.version,name:shift.name,timezone:unit.timezone,start:zonedTime(date,shift.start_minute,unit.timezone),end:zonedTime(endDate,shift.end_minute,unit.timezone),graceIn:shift.grace_in,graceOut:shift.grace_out};
}
function ownPlan(c,date){const p=profileRequired(c),u=c.units.find(u=>u.id===p.unit_id),s=c.shifts.find(s=>s.id===p.shift_id);return shiftPlan(u,s,date);}
async function savedPlan(c,date){const d=await c.db.prepare('SELECT plan_json FROM attendance_days WHERE user_id=? AND work_date=?').bind(c.a.id,date).first();if(d)return JSON.parse(d.plan_json);const r=await c.db.prepare("SELECT data_json FROM workplace_requests WHERE kind='leave' AND user_id=? AND business_date=? AND status NOT IN('rejected','withdrawn') ORDER BY created_at LIMIT 1").bind(c.a.id,date).first();return r?JSON.parse(r.data_json).plan:ownPlan(c,date);}
export function attendanceStatus(plan,punches,leave,now){
 if(!plan)return {flags:['rest'],in:null,out:null};if(Array.isArray(leave))leave=leave.length>1?{data:{portion:'full'}}:leave[0];const start=Date.parse(plan.start),end=Date.parse(plan.end),mid=start+(end-start)/2,full=leave?.data.portion==='full';
 const effectiveStart=leave?.data.portion==='first'?mid:start,effectiveEnd=leave?.data.portion==='second'?mid:end,arrival=punches.find(p=>p.kind==='in'),departure=punches.find(p=>p.kind==='out'),flags=[];
 if(full){flags.push('leave');if(punches.length)flags.push('leave_punch_conflict');}
 else {if(arrival&&Date.parse(arrival.punched_at)>effectiveStart+plan.graceIn*60000)flags.push('late');if(departure&&Date.parse(departure.punched_at)<effectiveEnd-plan.graceOut*60000)flags.push('early');if(now>effectiveEnd&&(!arrival||!departure))flags.push('missing');if(leave)flags.push('half_leave');if(!arrival&&now<=effectiveEnd)flags.push('pending');}
 return {flags,in:arrival?.punched_at||null,out:departure?.punched_at||null};
}
export async function punch(db,a,p,now=new Date()){
 const c=await context(db,a),source=await getFeishuSource(db,c.a.id),kind=p.kind;if(!['in','out'].includes(kind))fail('打卡类型无效');if(source.isManaged&&kind==='in')fail('该员工由飞书记录考勤，请在飞书打卡',403);const profile=profileRequired(c),unit=c.units.find(u=>u.id===profile.unit_id);
 const today=localParts(now,unit.timezone).date;let date=today,existing;
 if(kind==='out'){
  existing=await db.prepare("SELECT d.* FROM attendance_days d WHERE user_id=? AND EXISTS(SELECT 1 FROM attendance_punches p WHERE p.day_id=d.id AND p.kind='in') AND NOT EXISTS(SELECT 1 FROM attendance_punches p WHERE p.day_id=d.id AND p.kind='out') ORDER BY work_date DESC LIMIT 1").bind(a.id).first();
  if(!existing)fail('请先签到');if(source.isManaged){const arrival=await db.prepare("SELECT punched_at FROM attendance_punches WHERE day_id=? AND kind='in'").bind(existing.id).first();if(!arrival||arrival.punched_at>=source.managedSince)fail('飞书接管后不可新建本地打卡',403);}date=existing.work_date;
 }else{
  const open=await db.prepare("SELECT d.* FROM attendance_days d WHERE user_id=? AND EXISTS(SELECT 1 FROM attendance_punches p WHERE p.day_id=d.id AND p.kind='in') AND NOT EXISTS(SELECT 1 FROM attendance_punches p WHERE p.day_id=d.id AND p.kind='out') ORDER BY work_date DESC LIMIT 1").bind(a.id).first();
  if(open&&Date.parse(JSON.parse(open.plan_json).end)+6*3600000>now.getTime())fail('上一班尚未签退，请先完成签退',409);
  const previous=await savedPlan(c,plus(today,-1));if(previous&&Date.parse(previous.end)>now.getTime()&&Date.parse(previous.start)<=now.getTime())date=plus(today,-1);
  existing=await db.prepare('SELECT * FROM attendance_days WHERE user_id=? AND work_date=?').bind(a.id,date).first();
 }
 const plan=existing?JSON.parse(existing.plan_json):await savedPlan(c,date);if(!plan)fail('今天是休息日，需人事先配置工作班次');if(!existing&&plan.unitId!==profile.unit_id)fail('该班次属于原组织，请联系人事核对，不转入现组织');
 if(now.getTime()<Date.parse(plan.start)-4*3600000||now.getTime()>Date.parse(plan.end)+6*3600000)fail('已超出本班打卡窗口，请联系人事核对，不补造时间');
 const dayId=existing?.id||crypto.randomUUID();if(await db.prepare('SELECT id FROM attendance_punches WHERE day_id=? AND kind=?').bind(dayId,kind).first())fail('本班已完成该次打卡',409);
 const statements=[];if(!existing)statements.push(db.prepare('INSERT INTO attendance_days VALUES(?,?,?,?,?)').bind(dayId,a.id,profile.unit_id,date,JSON.stringify(plan)));
 statements.push(db.prepare('INSERT INTO attendance_punches VALUES(?,?,?,?)').bind(crypto.randomUUID(),dayId,kind,now.toISOString()),...event(db,c.a,dayId,'punch',{kind,at:now.toISOString(),date,plan}));await write(c,statements);return {ok:true,date,at:now.toISOString()};
}
export async function mutateLeave(db,a,p){
 const c=await context(db,a),now=new Date().toISOString();
 if(p.action==='leaveCreate'){
  if((await getFeishuSource(db,c.a.id)).isManaged)fail('该员工请在飞书申请请假，本系统只同步结果',403);
  const profile=profileRequired(c),date=day(p.date),saved=await db.prepare('SELECT plan_json FROM attendance_days WHERE user_id=? AND work_date=?').bind(a.id,date).first(),earlier=await db.prepare("SELECT data_json FROM workplace_requests WHERE kind='leave' AND user_id=? AND business_date=? AND status NOT IN('rejected','withdrawn') ORDER BY created_at LIMIT 1").bind(a.id,date).first(),plan=saved?JSON.parse(saved.plan_json):earlier?JSON.parse(earlier.data_json).plan:ownPlan(c,date);if(!plan)fail('休息日无需请假');if(plan.unitId!==profile.unit_id)fail('该日期属于原组织班次，请联系人事核对，不转入现组织');if(!workplaceSetup(c,c.a,await rows(db,'SELECT id,active FROM users')).managerReady)fail('尚未配置有效主管，请先联系管理员');
  if(!['full','first','second'].includes(p.portion))fail('请选择全班或半班');const reason=text(p.reason,'请假交接说明',500),operation=text(p.operationId,'请求编号',100);
  const active=await rows(db,"SELECT data_json FROM workplace_requests WHERE kind='leave' AND user_id=? AND business_date=? AND status NOT IN('rejected','withdrawn')",[a.id,date]);
  if(active.some(r=>{const x=JSON.parse(r.data_json);return x.portion==='full'||p.portion==='full'||x.portion===p.portion;}))fail('该班次已有重叠请假申请',409);
  if(await db.prepare('SELECT id FROM workplace_requests WHERE operation_id=?').bind(operation).first())fail('申请已经提交，请刷新',409);
  const id=crypto.randomUUID(),data={portion:p.portion,reason,plan};await write(c,[db.prepare("INSERT INTO workplace_requests VALUES(?,?, 'leave',?,?,?,'submitted',1,?,NULL,NULL,?,?)").bind(id,operation,a.id,profile.unit_id,date,JSON.stringify(data),now,now),...event(db,c.a,id,'leaveCreate',data)]);return {ok:true,id};
 }
 const r=await db.prepare("SELECT * FROM workplace_requests WHERE id=? AND kind='leave'").bind(p.id||'').first();requestVersion(r,p);if(!canRead(c,r))fail('无权查看该申请',403);let status;
 if(p.action==='withdraw') {if(r.user_id!==a.id||!['submitted','manager_approved'].includes(r.status))fail('当前申请不能撤回',403);status='withdrawn';}
 else if(p.action==='managerApprove'||p.action==='managerReject'){if(!manager(c,r.user_id,r.unit_id)||r.status!=='submitted')fail('仅当前主管可处理，不能自审',403);status=p.action==='managerApprove'?'manager_approved':'rejected';}
 else if(p.action==='hrApprove'||p.action==='hrReject'){if(!has(c,'hr',r.unit_id)||r.user_id===a.id||r.manager_actor===a.id||r.status!=='manager_approved')fail('需独立人事复核，不能自审或复核自己的审批',403);status=p.action==='hrApprove'?'approved':'rejected';}
 else fail('请假动作无效');const reason=text(p.reason,'处理说明',500);
 await write(c,[db.prepare('UPDATE workplace_requests SET status=?,version=version+1,manager_actor=?,reviewer_actor=?,updated_at=? WHERE id=?').bind(status,p.action.startsWith('manager')?a.id:r.manager_actor,p.action.startsWith('hr')?a.id:r.reviewer_actor,now,r.id),...event(db,c.a,r.id,p.action,{from:r.status,to:status,reason,version:r.version+1})]);return {ok:true};
}
export async function readAttendance(db,a,q={},now=new Date()){
 const c=await context(db,a),configuration=await configurationView(c),month=q.month||now.toISOString().slice(0,7);if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))fail('月份无效');
 const requests=(await rows(db,"SELECT r.*,u.name FROM workplace_requests r JOIN users u ON u.id=r.user_id WHERE r.kind='leave' AND (substr(business_date,1,7)=? OR r.status IN('submitted','manager_approved')) ORDER BY created_at DESC",[month])).filter(r=>canRead(c,r)&&(q.scope!=='mine'||r.user_id===a.id)).map(r=>({...r,data:JSON.parse(r.data_json),canManager:manager(c,r.user_id,r.unit_id)&&r.status==='submitted',canHr:has(c,'hr',r.unit_id)&&r.user_id!==a.id&&r.manager_actor!==a.id&&r.status==='manager_approved'}));
 const names=await rows(db,'SELECT id,name,site,active FROM users');
 const readiness=workplaceSetup(c,c.a,names),feishu=await readFeishuAttendance(db,a,{month,scope:q.scope},c);
 if(feishu.isManaged){readiness.canPunch=false;readiness.canLeave=false;}
 const openDay=await db.prepare("SELECT d.* FROM attendance_days d WHERE user_id=? AND EXISTS(SELECT 1 FROM attendance_punches p WHERE p.day_id=d.id AND p.kind='in') AND NOT EXISTS(SELECT 1 FROM attendance_punches p WHERE p.day_id=d.id AND p.kind='out') ORDER BY work_date DESC LIMIT 1").bind(a.id).first();
 // An already-punched shift keeps its original plan even if the next shift is not assigned yet.
 const arrival=openDay?await db.prepare("SELECT punched_at FROM attendance_punches WHERE day_id=? AND kind='in'").bind(openDay.id).first():null;
 readiness.canPunchOut=Boolean(readiness.organizationReady&&openDay&&now.getTime()<=Date.parse(JSON.parse(openDay.plan_json).end)+6*3600000&&(!feishu.isManaged||arrival?.punched_at<feishu.managedSince));
 configuration.setupProfiles=(configuration.canConfigure?names.filter(u=>u.active):names.filter(u=>u.active&&configuration.profiles.some(p=>p.user_id===u.id))).map(u=>({userId:u.id,name:u.name,...workplaceSetup(c,u,names)}));
 const profiles=c.profiles.filter(p=>p.active&&names.some(u=>u.id===p.user_id&&u.active&&c.units.some(unit=>unit.id===p.unit_id&&unit.active&&(!u.site||u.site===unit.site)))&&(p.user_id===a.id||manager(c,p.user_id,p.unit_id)||has(c,'hr',p.unit_id))),days=(await rows(db,'SELECT * FROM attendance_days WHERE substr(work_date,1,7)=?',[month])).filter(d=>d.user_id===a.id||has(c,'hr',d.unit_id)||manager(c,d.user_id,d.unit_id));
 const punches=await rows(db,'SELECT p.* FROM attendance_punches p JOIN attendance_days d ON d.id=p.day_id WHERE substr(d.work_date,1,7)=?',[month]);
 const result=[],managedUsers=new Set((await rows(db,"SELECT user_id FROM feishu_user_links WHERE active=1 AND EXISTS(SELECT 1 FROM feishu_settings WHERE id='global' AND enabled=1)")).map(x=>x.user_id));
 // Historical missing punches are not invented before the profile existed. Saved plans are authoritative;
 // unsaved days are shown only for today under the current configuration.
 for(const p of profiles){if(managedUsers.has(p.user_id))continue;const unit=c.units.find(u=>u.id===p.unit_id),today=localParts(now,unit.timezone).date;if(today.startsWith(month)&&!days.some(d=>d.user_id===p.user_id&&d.work_date===today)){let plan=null,setupPending=false;try{plan=requests.find(r=>r.user_id===p.user_id&&r.business_date===today)?.data.plan||shiftPlan(unit,c.shifts.find(s=>s.id===p.shift_id),today);}catch{setupPending=true;}days.push({id:'',user_id:p.user_id,unit_id:p.unit_id,work_date:today,plan_json:JSON.stringify(plan),setupPending});}}
 for(const d of days){const plan=JSON.parse(d.plan_json),leave=requests.filter(r=>r.user_id===d.user_id&&r.business_date===d.work_date&&r.status==='approved');result.push({...d,plan,name:names.find(u=>u.id===d.user_id)?.name||d.user_id,...(d.setupPending?{flags:['configuration_missing'],in:null,out:null}:attendanceStatus(plan,punches.filter(p=>p.day_id===d.id),leave,now.getTime()))});}
 const visibleIds=new Set(requests.map(r=>r.id)),events=(await rows(db,'SELECT e.*,u.name actor_name FROM workplace_events e JOIN users u ON u.id=e.actor_id ORDER BY e.created_at DESC')).filter(e=>visibleIds.has(e.entity_id));
 if(await clock(db)!==c.version)fail('资料已变化，请刷新',409);
 if(q.scope==='mine'){
  configuration.units=configuration.units.filter(u=>u.id===c.profile?.unit_id);
  configuration.shifts=configuration.shifts.filter(s=>s.id===c.profile?.shift_id);
  configuration.profiles=configuration.profiles.filter(p=>p.user_id===a.id);
  configuration.setupProfiles=configuration.setupProfiles.filter(p=>p.userId===a.id);
  configuration.grants=[];configuration.users=[];configuration.canConfigure=false;
 }
 return {handoffs:q.scope==='mine'?null:await readHrHandoffs(db,a,month),actor:c.a,profile:c.profile||null,month,scope:q.scope==='mine'?'mine':'authorized',access:workplaceAccess(c),configuration,readiness,feishu,days:q.scope==='mine'?result.filter(d=>d.user_id===a.id):result,requests,events,serverTime:now.toISOString()};
}
