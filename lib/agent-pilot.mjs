import {atomicBatch,assertWritable,guardStatement} from './atomic.mjs';
import {creatorActor,canCreatorScope} from './creator-policy.mjs';
import {financeMode} from './finance-scope.mjs';
import {loadOperatingPilotData,evaluateOperatingPilot} from './pilot-operating-agent.mjs';
import {loadCreatorPilotData,evaluateCreatorPilot} from './pilot-creator-agent.mjs';

const SYSTEM={id:'agent-pilot',name:'单店试点 Agent',role:'管理员'};
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
const rows=async(db,sql,args=[])=>(await db.prepare(sql).bind(...args).all()).results||[];
const parse=s=>JSON.parse(s||'{}');
const clean=(s,max=1000)=>String(s??'').trim().slice(0,max);
export const pilotDay=(now=new Date(),zone='Asia/Jakarta')=>new Intl.DateTimeFormat('en-CA',{timeZone:zone}).format(now);
const shift=(date,days)=>new Date(Date.parse(date+'T00:00:00Z')+days*86400000).toISOString().slice(0,10);
export function pilotWeek(now=new Date()){
 const day=pilotDay(now),n=new Date(day+'T00:00:00Z').getUTCDay(),thisMonday=shift(day,-((n+6)%7));
 return {start:shift(thisMonday,-7),end:shift(thisMonday,-1)};
}
export async function pilotSettings(db){
 const r=await db.prepare("SELECT * FROM agent_pilot_settings WHERE id='indonesia-tiktok'").first();
 return {...r,enabled:!!r.enabled,config:parse(r.config_json)};
}
async function scopeRecord(db,id){return id?db.prepare('SELECT * FROM creator_scopes WHERE id=?').bind(id).first():null;}
async function access(db,identity,settings){
 const user=await db.prepare('SELECT id,name,role,site,channel,active FROM users WHERE id=?').bind(identity.id).first();
 if(!user?.active||await financeMode(db,user)==='scoped')fail('当前账号没有单店 Agent 试点权限',403);
 const actor=await creatorActor(db,user),scope=await scopeRecord(db,settings.scope_id);
 if(actor.role==='管理员')return {actor,scope};
 if(!scope||actor.role==='供应链'&&settings.config.supplyOwnerId!==actor.id||actor.role!=='供应链'&&!canCreatorScope(actor,scope))fail('当前账号未参与该试点店铺',403);
 return {actor,scope};
}
function visibleTask(actor,task){
 if(['管理员','运营主管','财务'].includes(actor.role))return true;
 if(actor.role==='供应链'||actor.role==='达人BD')return task.owner_id===actor.id;
 return actor.role==='运营'&&task.agent==='operating';
}
const event=(db,scopeId,taskId,eventName,actor,detail,at)=>db.prepare('INSERT INTO agent_pilot_events VALUES(?,?,?,?,?,?,?)').bind(crypto.randomUUID(),scopeId,taskId,eventName,actor.id,JSON.stringify(detail),at);
const settingsGuard=(db,s)=>guardStatement(db,SYSTEM,'agent-pilot.configuration',"EXISTS(SELECT 1 FROM agent_pilot_settings WHERE id='indonesia-tiktok' AND version=? AND scope_id=?)",[s.version,s.scope_id]);
export async function configurePilot(db,identity,p,now=new Date()){
 await assertWritable(db);const s=await pilotSettings(db),{actor}=await access(db,identity,s);
 if(actor.role!=='管理员')fail('仅管理员配置试点店铺及负责人',403);
 if(p.version!==s.version)fail('试点配置已变化，请刷新',409);
 const scope=await scopeRecord(db,p.creatorScopeId);
 if(!scope||scope.site!=='印尼'||scope.platform!=='TikTok')fail('请选择已建档的印尼 TikTok 单家店铺');
 for(const [id,role] of [[scope.operator_id,'运营'],[scope.bd_id,'达人BD']]){
  const u=await db.prepare('SELECT * FROM users WHERE id=? AND active=1').bind(id).first();
  if(!u||u.role!==role||role==='运营'&&(u.site!=='印尼'||u.channel!=='TikTok'))fail('店铺运营或 BD 负责人失效，请先核对店铺分工');
 }
 const supply=await db.prepare("SELECT id FROM users WHERE id=? AND active=1 AND role='供应链'").bind(clean(p.supplyOwnerId,100)).first();
 if(!supply)fail('请选择有效的供应链复查负责人');
 if(typeof p.enabled!=='boolean'||typeof p.scopeVerified!=='boolean')fail('请明确试运行开关与数据归属');
 const prioritySkus=[...new Set((Array.isArray(p.prioritySkus)?p.prioritySkus:[]).map(v=>clean(v,100)))];
 if(prioritySkus.length>30||!prioritySkus.length)fail('请指定1至30个重点 SKU');
 for(const sku of prioritySkus)if(!await db.prepare('SELECT 1 FROM sku_settings WHERE sku=?').bind(sku).first())fail('重点 SKU 不存在：'+sku);
 const dailyTime=clean(p.dailyTime,5)||'10:00';if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(dailyTime))fail('巡检时间格式应为 HH:MM');
 const thresholds={stockCoverDays:Number(p.thresholds?.stockCoverDays??3),adIncreasePct:Number(p.thresholds?.adIncreasePct??50),refundCaseCount:Number(p.thresholds?.refundCaseCount??3)};
 if(!Number.isInteger(thresholds.stockCoverDays)||thresholds.stockCoverDays<1||thresholds.stockCoverDays>30||!Number.isFinite(thresholds.adIncreasePct)||thresholds.adIncreasePct<10||thresholds.adIncreasePct>500||!Number.isInteger(thresholds.refundCaseCount)||thresholds.refundCaseCount<1||thresholds.refundCaseCount>100)fail('提醒阈值超出可用范围');
 const reason=clean(p.reason);if(reason.length<4)fail('请填写配置依据');
 if(p.scopeVerified&&p.exclusiveConfirmed!==true)fail('请确认旧表中的印尼 TikTok 销售、库存、广告及售后数据仅属于这一家店');
 const config={creatorScopeId:scope.id,shopId:scope.id,shopName:scope.shop,site:'印尼',channel:'TikTok',scopeMode:'exclusive_site_channel',scopeVersion:scope.version,scopeVerified:p.scopeVerified,operatorId:scope.operator_id,supplyOwnerId:supply.id,prioritySkus,thresholds,dailyTime,scheduleTimezone:'Asia/Shanghai',businessTimezone:'Asia/Jakarta',weeklyDay:1,scopeBasis:p.scopeVerified?{confirmedBy:actor.id,confirmedAt:now.toISOString(),reason}:null};
 await atomicBatch(db,[guardStatement(db,actor,'agent-pilot.configure',"EXISTS(SELECT 1 FROM agent_pilot_settings WHERE id='indonesia-tiktok' AND version=?)",[s.version]),db.prepare("UPDATE agent_pilot_settings SET scope_id=?,enabled=?,config_json=?,version=version+1,updated_by=?,updated_at=? WHERE id='indonesia-tiktok'").bind(scope.id,p.enabled?1:0,JSON.stringify(config),actor.id,now.toISOString()),event(db,scope.id,null,'configuration',actor,{enabled:p.enabled,config,reason},now.toISOString())]);
 return {ok:true};
}
async function sourceClock(db,agent){
 const creator=Number((await db.prepare("SELECT version FROM creator_clock WHERE id='global'").first())?.version||0);
 const business=agent==='operating'?Number((await db.prepare("SELECT version FROM business_action_source_clock WHERE id='global'").first())?.version||0):0;
 return {creator,business};
}
const clockGuard=(db,agent,c)=>guardStatement(db,SYSTEM,'agent-pilot.evidence',"COALESCE((SELECT version FROM creator_clock WHERE id='global'),0)=?"+(agent==='operating'?" AND COALESCE((SELECT version FROM business_action_source_clock WHERE id='global'),0)=?":''),agent==='operating'?[c.creator,c.business]:[c.creator]);
async function evaluated(db,s,agent,now){
 const scope=await scopeRecord(db,s.scope_id);
 if(!scope||scope.site!=='印尼'||scope.platform!=='TikTok')fail('试点店铺归属已变化，请管理员复核',409);
 const config={...s.config,creatorScopeId:scope.id,shopId:scope.id,shopName:scope.shop,operatorId:scope.operator_id,weekly:pilotWeek(now)};
 if(s.config.operatorId!==scope.operator_id)config.scopeVerified=false;
 const loader=agent==='creator'?loadCreatorPilotData:loadOperatingPilotData,evaluate=agent==='creator'?evaluateCreatorPilot:evaluateOperatingPilot;
 const data=await loader(db,config,now);
 // Scope verification still needs a real person, without opening unverified business tables.
 if(agent==='operating'&&!data.scopeVerified)data.users=await rows(db,'SELECT id,name,role,active,site,channel FROM users WHERE id IN (?,?)',[scope.operator_id,config.supplyOwnerId]);
 const result=evaluate(data,config,now);
 if(agent==='creator'&&result.coverage.authoritative){
  result.ownerReports={};
  for(const ownerId of new Set((data.rounds||[]).map(r=>r.owner_bd_id||data.scope.bd_id).filter(Boolean))){
   const rounds=data.rounds.filter(r=>(r.owner_bd_id||data.scope.bd_id)===ownerId),ids=new Set(rounds.map(r=>r.id));
   const own=evaluate({...data,rounds,orders:data.orders.filter(o=>ids.has(o.round_id))},config,now);
   result.ownerReports[ownerId]={metrics:own.metrics,coverage:own.coverage};
  }
 }
 return result;
}
async function persistEvaluation(db,s,agent,result,clock,token,now,{saveDaily=false,saveWeekly=false}={}){
 if(agent==='creator'&&result.coverage?.authoritative!==true)fail('达人来源未完整读取，已有待办保留，本轮不记成功',409);
 const at=now.toISOString(),existing=await rows(db,'SELECT * FROM agent_pilot_tasks WHERE scope_id=? AND agent=?',[s.scope_id,agent]),byKey=new Map(existing.map(t=>[t.finding_key,t]));
 const lockGuard=()=>guardStatement(db,SYSTEM,'agent-pilot.lease',"EXISTS(SELECT 1 FROM agent_pilot_lock WHERE id='global' AND token=? AND expires_at>?)",[token,at]);
 const changes=[];
 for(const f of result.findings||[]){
  if(!f.key||!['active','unknown','clear'].includes(f.state)||!/^\d{4}-\d{2}-\d{2}$/.test(f.reviewDate))throw Error('Agent 返回了无效证据');
  const old=byKey.get(f.key),serialized=JSON.stringify(f);if(!old&&f.state==='clear')continue;
  const ownerChanged=!!old&&old.owner_id!==(f.ownerId||null);
  const status=f.state==='clear'?'resolved':!ownerChanged&&old?.status==='acknowledged'?'acknowledged':'open';
  if(old&&old.finding_json===serialized&&old.status===status)continue;
  const id=old?.id||crypto.randomUUID(),reopen=old?.status==='resolved'&&status!=='resolved';
  const draftSame=old&&old.owner_id===(f.ownerId||null)&&JSON.stringify(parse(old.finding_json).draft)===JSON.stringify(f.draft)&&!reopen;
  const statements=[settingsGuard(db,s),clockGuard(db,agent,clock),lockGuard()];
  if(old)statements.push(guardStatement(db,SYSTEM,'agent-pilot.task-version','EXISTS(SELECT 1 FROM agent_pilot_tasks WHERE id=? AND version=?)',[old.id,old.version]),db.prepare('UPDATE agent_pilot_tasks SET status=?,finding_json=?,owner_id=?,updated_at=?,review_date=?,resolved_at=?,draft_review_json=?,note=?,version=version+1 WHERE id=?').bind(status,serialized,f.ownerId||null,at,!reopen&&!ownerChanged?old.review_date:f.reviewDate,status==='resolved'?(old.resolved_at||at):null,draftSame?old.draft_review_json:null,ownerChanged?'':old.note,id));
  else statements.push(db.prepare('INSERT INTO agent_pilot_tasks(id,scope_id,agent,finding_key,status,finding_json,owner_id,opened_at,updated_at,review_date) VALUES(?,?,?,?,?,?,?,?,?,?)').bind(id,s.scope_id,agent,f.key,status,serialized,f.ownerId||null,at,at,f.reviewDate));
  if(ownerChanged)statements.push(event(db,s.scope_id,id,'reassigned',SYSTEM,{title:f.title,previousOwnerId:old.owner_id,ownerId:f.ownerId,previousNote:old.note,previousReviewDate:old.review_date},at));
  if(!old||reopen||old.status!==status)statements.push(event(db,s.scope_id,id,status==='resolved'?'resolved':reopen?'reopened':'opened',SYSTEM,{title:f.title,evidence:f.evidence,impact:f.impact,ownerId:f.ownerId,reviewDate:f.reviewDate},at));
  await atomicBatch(db,statements);changes.push(id);
 }
 // Missing findings never imply resolution. Only an authoritative clear finding closes a task.
 for(const periodType of [...(saveDaily?['daily']:[]),...(saveWeekly?['weekly']:[])]){
  const week=pilotWeek(now),periodKey=periodType==='weekly'?week.start:pilotDay(now,'Asia/Shanghai');
  const current=await rows(db,'SELECT * FROM agent_pilot_tasks WHERE scope_id=? AND agent=?',[s.scope_id,agent]);
  const relevant=current.filter(t=>t.status!=='resolved').sort((a,b)=>({high:0,medium:1,low:2}[parse(a.finding_json).priority]??3)-({high:0,medium:1,low:2}[parse(b.finding_json).priority]??3)||a.review_date.localeCompare(b.review_date));
  const previous=periodType==='weekly'?await rows(db,"SELECT e.event,e.created_at,e.detail_json,t.agent,t.owner_id FROM agent_pilot_events e JOIN agent_pilot_tasks t ON t.id=e.task_id WHERE e.scope_id=? AND t.agent=? AND e.created_at>=? AND e.created_at<? AND e.event IN ('resolved','acknowledged','reopened') ORDER BY e.created_at DESC",[s.scope_id,agent,new Date(week.start+'T00:00:00+07:00').toISOString(),new Date(shift(week.end,1)+'T00:00:00+07:00').toISOString()]):[];
  const record={configVersion:s.version,decisionAsOf:at,ownerReports:result.ownerReports,metrics:result.metrics,coverage:result.coverage,week:periodType==='weekly'?week:null,decisions:relevant.slice(0,3).map(t=>({id:t.id,status:t.status,...parse(t.finding_json),reviewDate:t.review_date})),rectifications:previous.map(e=>({event:e.event,at:e.created_at,...parse(e.detail_json),ownerId:e.owner_id})),sourceClock:clock,summaryOnlyThree:true};
  await atomicBatch(db,[settingsGuard(db,s),clockGuard(db,agent,clock),lockGuard(),db.prepare('INSERT INTO agent_pilot_runs VALUES(?,?,?,?,?,?,?) ON CONFLICT(scope_id,agent,period_type,period_key) '+(periodType==='weekly'?'DO NOTHING':'DO UPDATE SET result_json=excluded.result_json,generated_at=excluded.generated_at')).bind(crypto.randomUUID(),s.scope_id,agent,periodType,periodKey,JSON.stringify(record),at)]);
 }
 return changes.length;
}
export async function runPilot(db,{now=new Date(),agents=['operating','creator'],saveDaily=true,saveWeekly=false,manual=false,evaluator=evaluated}={}){
 await assertWritable(db);const s=await pilotSettings(db);if(!s.enabled||!s.scope_id)return {skipped:'disabled'};
 const token=crypto.randomUUID(),at=now.toISOString(),expires=new Date(+now+120000).toISOString();
 const claimed=await db.prepare("INSERT INTO agent_pilot_lock VALUES('global',?,?) ON CONFLICT(id) DO UPDATE SET token=excluded.token,expires_at=excluded.expires_at WHERE agent_pilot_lock.expires_at<=?").bind(token,expires,at).run();
 if(!claimed.meta.changes)return {skipped:'busy'};
 try{
  const outputs={};for(const agent of agents){
   if(!['operating','creator'].includes(agent))throw Error('Unknown pilot agent');
   const clock=await sourceClock(db,agent),result=await evaluator(db,s,agent,now);
   await persistEvaluation(db,s,agent,result,clock,token,now,{saveDaily,saveWeekly});outputs[agent]={count:result.findings?.length||0,coverage:result.coverage};
  }return {ok:true,outputs,manual};
 }finally{await db.prepare("DELETE FROM agent_pilot_lock WHERE id='global' AND token=?").bind(token).run();}
}
async function refreshCreator(db,s,now){
 if(s.enabled){const r=await runPilot(db,{now,agents:['creator'],saveDaily:false});if(r.skipped==='busy')fail('正在核对最新视频关联，请稍后刷新',409);}
}
export async function readPilot(db,identity,now=new Date()){
 const s=await pilotSettings(db),{actor,scope}=await access(db,identity,s);
 await refreshCreator(db,s,now);
 const tasks=(await rows(db,'SELECT * FROM agent_pilot_tasks WHERE scope_id=? ORDER BY updated_at DESC',[s.scope_id||''])).filter(t=>visibleTask(actor,t)).map(t=>({id:t.id,agent:t.agent,status:t.status,version:t.version,reviewDate:t.review_date,note:t.note,draftReview:parse(t.draft_review_json),finding:parse(t.finding_json)}));
 const canManage=actor.role==='管理员',canSummary=['管理员','运营主管','财务','达人BD','运营'].includes(actor.role);
 const reports=canSummary?await rows(db,'SELECT agent,period_type,period_key,result_json,generated_at FROM agent_pilot_runs WHERE scope_id=? ORDER BY generated_at DESC LIMIT 16',[s.scope_id||'']):[];
 let configuration;
 if(canManage){configuration={scopes:await rows(db,"SELECT id,shop,operator_id,bd_id FROM creator_scopes WHERE site='印尼' AND platform='TikTok' ORDER BY shop"),supplyUsers:await rows(db,"SELECT id,name FROM users WHERE active=1 AND role='供应链'"),skus:await rows(db,'SELECT sku,name FROM sku_settings ORDER BY sku')};}
 return {actor:{id:actor.id,role:actor.role},settings:{enabled:s.enabled,version:s.version,config:s.config},scope:scope?{id:scope.id,shop:scope.shop}:null,canManage,configuration,tasks,reports:reports.filter(r=>actor.role!=='达人BD'||r.agent==='creator').map(r=>{
  const result=parse(r.result_json);
  if(actor.role==='达人BD'){
   const own=result.ownerReports?.[actor.id];
   result.metrics=own?.metrics||null;result.coverage=own?.coverage||{authoritative:false,reason:'这份归档中没有本人负责轮次的统计'};
   result.decisions=result.decisions.filter(f=>f.ownerId===actor.id);result.rectifications=result.rectifications.filter(f=>f.ownerId===actor.id);
  }
  delete result.ownerReports;
  if(r.agent==='creator'&&!['管理员','财务'].includes(actor.role)&&result.metrics){delete result.metrics.sampleCosts;delete result.metrics.freightCosts;result.metrics.costsRestricted=true;}
  return {...r,result,result_json:undefined};
 }),serverTime:now.toISOString()};
}
export async function mutatePilot(db,identity,p,now=new Date()){
 if(p.action==='configure')return configurePilot(db,identity,p,now);
 const s=await pilotSettings(db),{actor}=await access(db,identity,s);await assertWritable(db);
 if(p.action==='run'){
  if(!['管理员','运营主管'].includes(actor.role))fail('仅管理员或运营主管启动试运行',403);
  return runPilot(db,{now,saveDaily:true,saveWeekly:true,manual:true});
 }
 await refreshCreator(db,s,now);
 const task=await db.prepare('SELECT * FROM agent_pilot_tasks WHERE id=? AND scope_id=?').bind(clean(p.id,100),s.scope_id||'').first();
 if(!task||!visibleTask(actor,task))fail('待办不存在或没有查看权限',404);
 if(task.version!==p.version)fail('原单据或待办已更新，请刷新后再处理',409);
 if(task.status==='resolved')fail('关联证据已解除这条提醒，无需继续催办',409);
 const finding=parse(task.finding_json),at=now.toISOString();
 if(p.action==='acknowledge'){
  if(actor.id!==task.owner_id)fail('由这条待办的负责人填写跟进',403);
  const note=clean(p.note);if(note.length<4)fail('请写明处理依据或下一步');
  const reviewDate=clean(p.reviewDate,10),today=pilotDay(now);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(reviewDate)||reviewDate<today||reviewDate>shift(today,30)||new Date(reviewDate+'T00:00:00Z').toISOString().slice(0,10)!==reviewDate)fail('复查日期须在今天起30天内');
  await atomicBatch(db,[settingsGuard(db,s),guardStatement(db,actor,'agent-pilot.follow','EXISTS(SELECT 1 FROM agent_pilot_tasks WHERE id=? AND version=?)',[task.id,p.version]),db.prepare("UPDATE agent_pilot_tasks SET status='acknowledged',note=?,review_date=?,updated_at=?,version=version+1 WHERE id=?").bind(note,reviewDate,at,task.id),event(db,s.scope_id,task.id,'acknowledged',actor,{title:finding.title,note,reviewDate},at)]);return {ok:true};
 }
 if(p.action==='reviewDraft'||p.action==='copyDraft'){
  if(!s.enabled)fail('试运行已暂停，不再确认或复制催拍草稿',409);
  if(actor.role!=='达人BD'||actor.id!==task.owner_id||!finding.draft||finding.state!=='active')fail('仅责任 BD 可确认当前仍需催拍的草稿',403);
  const clock=await sourceClock(db,'creator'),current=await evaluated(db,s,'creator',now),currentFinding=current.findings.find(f=>f.key===task.finding_key);
  if(!current.coverage?.authoritative||!currentFinding||currentFinding.state!=='active'||currentFinding.ownerId!==actor.id||JSON.stringify(currentFinding.draft)!==JSON.stringify(finding.draft))fail('视频、协议或负责人已更新，请刷新；当前草稿不可继续使用',409);
  if(p.action==='copyDraft'){
   const review=parse(task.draft_review_json);if(review.by!==actor.id||review.text!==finding.draft.text)fail('请先由责任 BD 核对当前草稿',409);
   await atomicBatch(db,[settingsGuard(db,s),clockGuard(db,'creator',clock),guardStatement(db,actor,'agent-pilot.copy','EXISTS(SELECT 1 FROM agent_pilot_tasks WHERE id=? AND version=?)',[task.id,p.version])]);
   return {ok:true,text:review.text,sent:false};
  }
  if(p.confirmed!==true)fail('请核对协议日期和视频关联后确认草稿');
  const reviewed={by:actor.id,at,text:finding.draft.text,language:'id'};
  await atomicBatch(db,[settingsGuard(db,s),clockGuard(db,'creator',clock),guardStatement(db,actor,'agent-pilot.draft','EXISTS(SELECT 1 FROM agent_pilot_tasks WHERE id=? AND version=?)',[task.id,p.version]),db.prepare('UPDATE agent_pilot_tasks SET draft_review_json=?,version=version+1 WHERE id=?').bind(JSON.stringify(reviewed),task.id),event(db,s.scope_id,task.id,'draft_reviewed',actor,{title:finding.title,language:'id',sent:false},at)]);
  return {ok:true,text:reviewed.text,sent:false};
 }
 fail('不支持的试点操作');
}
export async function pilotWorkspaceTasks(db,actor,now=new Date()){
 const s=await pilotSettings(db);if(!s.enabled)return [];
 try{await access(db,actor,s);}catch(e){if(e.status===403)return [];throw e;}
 try{await refreshCreator(db,s,now);}catch{ return []; } // Fail closed for prompts; the pilot page exposes the failed refresh.
 const all=await rows(db,"SELECT * FROM agent_pilot_tasks WHERE scope_id=? AND status<>'resolved' AND owner_id=?",[s.scope_id,actor.id]);
 return all.map(t=>{const f=parse(t.finding_json);return {replacesSampleOrderIds:f.sampleOrderIds||[],tab:'agent-pilot',entity:t.id,title:f.title,detail:`${f.impact} · 复查 ${t.review_date}`,level:f.priority==='high'?'red':'amber'};});
}
