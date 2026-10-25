import {atomicBatch,assertWritable,guardStatement} from './atomic.mjs';
import {actionCandidates,actionFinanceDay,rows} from './business-action-data.mjs';
import {actionKey,canReadActions,actionScope,compareActions,actionRoles,actionWindow,financeFields,diagnosisFields,round} from './business-action-model.mjs';
const fail=(message,status=400)=>{const e=new Error(message);e.status=status;throw e;};
const text=(v,max=2000)=>String(v??'').trim().slice(0,max);
const parse=s=>JSON.parse(s);
export function actionAccess(a){if(!canReadActions(a))fail('每日经营行动单仅开放五站运营、运营主管、财务、供应链和管理员',403);}
const note=p=>{const n=text(p.note);if(n.length<4)fail('请填写至少4字的依据或处理说明');return n;};
const iso=(v,label,now)=>{const n=Date.parse(v);if(!Number.isFinite(n)||n<+now||n>+now+90*86400000)fail(`${label}须为未来90天内的有效时间`);return new Date(n).toISOString();};
const scopeFilter=a=>a.role==='运营'?{sql:' WHERE site=? AND channel=?',args:[a.site,a.channel]}:{sql:'',args:[]};
export async function actionRecord(db,a,id){actionAccess(a);const r=await db.prepare('SELECT * FROM business_actions WHERE id=?').bind(text(id,100)).first();if(!r||!actionScope(a,r))fail('行动单不存在或无权查看',404);return {...r,snapshot:parse(r.snapshot_json),collaborators:parse(r.collaborators_json),diagnosis:parse(r.diagnosis_json)};}
function audit(db,a,id,action,detail,at){return db.prepare('INSERT INTO business_action_events(id,action_id,event,actor_id,actor_name,detail_json,created_at) VALUES(?,?,?,?,?,?,?)').bind(crypto.randomUUID(),id,action,a.id,a.name||'系统规则',JSON.stringify(detail),at);}
const publicSnapshot=(s,a)=>{if(a.role!=='供应链')return s;const {costs,financeSource,financeAt,financeFingerprint,financeDays,revenue,profit,unitContribution,delayCny,recoverableCny,delayAmount,recoverableAmount,...safe}=s;return {...safe,profitState:profit==null?'待核实':profit>0?'正贡献':profit<0?'负贡献':'持平'};};
export function publicAction(r,a){const {snapshot_json,collaborators_json,diagnosis_json,...safe}=r;return {...safe,snapshot:publicSnapshot(r.snapshot||parse(snapshot_json),a),collaborators:r.collaborators||parse(collaborators_json),diagnosis:r.diagnosis||parse(diagnosis_json)};}

// A single permanent key per SKU / country / platform / problem, including reopening.
export async function refreshBusinessActions(db,a,now=new Date()){
 actionAccess(a);await assertWritable(db);
 const candidates=await actionCandidates(db,a,now),filter=scopeFilter(a),existing=await rows(db,'SELECT * FROM business_actions'+filter.sql,filter.args),byKey=new Map(existing.map(r=>[actionKey(r),r])),at=now.toISOString();
 const statements=[],boundaries=[];
 for(const candidate of candidates){
  const {sourceVersion,...s}=candidate;
  const old=byKey.get(actionKey(s));
  const useful=s.condition==='active'||s.condition==='verify'&&(s.available>0||s.observedQty>0);
  if(!old&&!useful)continue;
  if(old&&old.snapshot_json===JSON.stringify(s))continue;
  if(!old){const id=crypto.randomUUID();statements.push(db.prepare("INSERT INTO business_actions(id,site,channel,sku,kind,status,snapshot_json,opened_at,updated_at,due_at,review_at,ever_active) VALUES(?,?,?,?,?,'open',?,?,?,?,?,?) ON CONFLICT(site,channel,sku,kind) DO NOTHING").bind(id,s.site,s.channel,s.sku,s.kind,JSON.stringify(s),at,at,new Date(+now+86400000).toISOString(),new Date(+now+3*86400000).toISOString(),s.condition==='active'?1:0),db.prepare("INSERT INTO business_action_events(id,action_id,event,actor_id,actor_name,detail_json,created_at) SELECT ?,?,'created',?,?,?,? WHERE EXISTS(SELECT 1 FROM business_actions WHERE id=?)").bind(crypto.randomUUID(),id,a.id,a.name||'系统规则',JSON.stringify({note:'规则首次识别，具体负责人待确认',snapshot:s}),at,id));}
  else{
   const reopen=old.status==='resolved'&&s.condition!=='clear';
   statements.push(db.prepare("UPDATE business_actions SET snapshot_json=?,updated_at=?,ever_active=MAX(ever_active,?),status=CASE WHEN ? THEN 'open' ELSE status END,resolved_at=CASE WHEN ? THEN NULL ELSE resolved_at END,reopen_count=reopen_count+?,due_at=CASE WHEN ? THEN ? ELSE due_at END,review_at=CASE WHEN ? THEN ? ELSE review_at END,version=version+1 WHERE id=? AND version=?").bind(JSON.stringify(s),at,s.condition==='active'?1:0,reopen?1:0,reopen?1:0,reopen?1:0,reopen?1:0,new Date(+now+86400000).toISOString(),reopen?1:0,new Date(+now+3*86400000).toISOString(),old.id,old.version));
   // Only meaningful lifecycle changes produce an event; daily data refreshes do not spam.
   if(reopen)statements.push(db.prepare("INSERT INTO business_action_events(id,action_id,event,actor_id,actor_name,detail_json,created_at) SELECT ?,?,'reopen',?,?,?,? WHERE EXISTS(SELECT 1 FROM business_actions WHERE id=? AND version=? AND status='open')").bind(crypto.randomUUID(),old.id,a.id,a.name||'系统规则',JSON.stringify({note:'复查关闭后，新证据再次触发或需重新核实',snapshot:s}),at,old.id,old.version+1));
  }
  boundaries.push(statements.length);
 }
 // Bound D1 batches; every row update has an optimistic version guard.
 for(let i=0;i<statements.length;){const end=boundaries.filter(n=>n>i&&n<=i+60).at(-1);await atomicBatch(db,[guardStatement(db,a,'business-action.refresh',"COALESCE((SELECT version FROM business_action_source_clock WHERE id='global'),0)=?",[candidates[0].sourceVersion]),...statements.slice(i,end)]);i=end;}
 return {ok:true,generatedAt:at};
}

export async function readBusinessActions(db,a,now=new Date()){
 actionAccess(a);const f=scopeFilter(a),rs=await rows(db,'SELECT * FROM business_actions'+f.sql,f.args);
 const users=await rows(db,"SELECT id,name,role,site,channel,active FROM users WHERE active=1 AND role IN ('运营','供应链','财务','管理员','运营主管')");
 const records=rs.map(r=>({...r,snapshot:parse(r.snapshot_json)})).sort(compareActions).map(r=>publicAction(r,a));
 // Operators see colleagues needed for their own scope; never return email or account credentials.
 const visibleUsers=users.filter(u=>u.role!=='运营'||a.role!=='运营'||u.site===a.site&&u.channel===a.channel);
 return {actor:{id:a.id,role:a.role,site:a.site,channel:a.channel},records,users:visibleUsers,generatedAt:now.toISOString(),latestEvidenceAt:rs.map(r=>r.updated_at).sort().at(-1)||null};
}
export async function actionHistory(db,a,id){await actionRecord(db,a,id);return (await rows(db,'SELECT event,actor_name,detail_json,created_at FROM business_action_events WHERE action_id=? ORDER BY created_at,id',[id])).map(r=>({event:r.event,actor_name:r.actor_name,created_at:r.created_at,detail:a.role==='供应链'&&r.event==='finance'?{note:'财务已更新成本核算'}:redactDetail(parse(r.detail_json),a)}));}
function redactDetail(d,a){if(a.role!=='供应链')return d;return {...d,snapshot:d.snapshot?publicSnapshot(d.snapshot,a):undefined,before:d.before?publicSnapshot(d.before,a):undefined,after:d.after?publicSnapshot(d.after,a):undefined};}
async function liveOwner(db,r){const u=r.owner_id?await db.prepare('SELECT * FROM users WHERE id=? AND active=1').bind(r.owner_id).first():null;return u&&eligibleOwner(u,r)?u:null;}
const eligibleOwner=(u,r)=>u.role===actionRoles(r.kind).primary&&(u.role!=='运营'||u.site===r.site&&u.channel===r.channel);
export async function mutateBusinessAction(db,a,p,now=new Date()){
 actionAccess(a);await assertWritable(db);if(p.action==='refresh')return refreshBusinessActions(db,a,now);
 const r=await actionRecord(db,a,p.id),at=now.toISOString();
 if(!Number.isSafeInteger(p.version)||p.version!==r.version)fail('记录或证据已更新，请刷新核对后再提交',409);
 const guard=guardStatement(db,a,'business-action.'+p.action,'EXISTS(SELECT 1 FROM business_actions WHERE id=? AND version=?)',[r.id,p.version]);
 let fields={},detail={note:note(p)},extra=[];
 if(p.action==='assign'){
  if(a.role!=='管理员')fail('仅管理员确认唯一负责人及协作人',403);
  const owner=await db.prepare('SELECT * FROM users WHERE id=? AND active=1').bind(text(p.ownerId,100)).first();
  if(!owner||!eligibleOwner(owner,r))fail(`负责人须为本岗位 ${actionRoles(r.kind).primary}，运营须匹配站点和渠道`);
  extra.push(guardStatement(db,a,'business-action.owner',"EXISTS(SELECT 1 FROM users WHERE id=? AND active=1 AND role=? AND COALESCE(site,'')=? AND COALESCE(channel,'')=?)",[owner.id,owner.role,owner.site||'',owner.channel||'']));
  if(!Array.isArray(p.collaborators)||p.collaborators.length>8)fail('协作人最多8人');
  const ids=[...new Set(p.collaborators)].filter(id=>id!==owner.id),people=[];
  for(const id of ids){const u=await db.prepare('SELECT id,name,role,site,channel FROM users WHERE id=? AND active=1').bind(text(id,100)).first();if(!u||!canReadActions(u)||!actionScope(u,r))fail('协作人须有当前行动单的查看权限');people.push({id:u.id,name:u.name,role:u.role});}
  const due=iso(p.dueAt,'截止时间',now),review=iso(p.reviewAt,'复查时间',now);if(review<=due)fail('复查时间须晚于行动截止时间');
  fields={owner_id:owner.id,collaborators_json:JSON.stringify(people),due_at:due,review_at:review};detail={...detail,owner:{id:owner.id,name:owner.name},collaborators:people,dueAt:due,reviewAt:review};
 }else if(p.action==='finance'){
  if(a.role!=='财务')fail('仅财务填写独立成本核算',403);
  const date=text(p.businessDate,10);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date))||new Date(date).toISOString().slice(0,10)!==date||date>=actionWindow(r.site,now).today)fail('请选择已经结束的有效经营日期');
  const sourceVersion=(await db.prepare("SELECT version FROM business_action_source_clock WHERE id='global'").first())?.version||0;
  const day=await actionFinanceDay(db,r,date);
  if(day.basisHash!==p.basisHash||day.status==='sales_pending')fail('当日销售、退款或费用依据已变化，或完整日报／原币金额尚未齐全，请刷新核对该日',409);
  if(!Number.isInteger(p.revision)||p.revision!==day.revision)fail('该日成本已有新修订，请刷新核对；不会覆盖原凭据',409);
  extra.push(guardStatement(db,a,'business-action.finance-basis',"COALESCE((SELECT version FROM business_action_source_clock WHERE id='global'),0)=?",[sourceVersion]));
  extra.push(guardStatement(db,a,'business-action.finance-revision',"COALESCE((SELECT MAX(revision) FROM business_action_finance_days WHERE site=? AND channel=? AND sku=? AND business_date=?),0)=?",[r.site,r.channel,r.sku,date,day.revision]));
  const costs={};for(const k of Object.keys(financeFields)){const v=p.costs?.[k];if(v===''||v==null||!/^\d+(\.\d{1,2})?$/.test(String(v))||!Number.isFinite(Number(v))||Number(v)>1e10)fail(`${financeFields[k]}须填写原币非负金额，未知不能填0`);costs[k]=round(Number(v));}
  const source=text(p.source,1000);if(source.length<4||p.confirmed!==true)fail('请提供核算凭据编号，并确认折扣、退款和整店广告费没有重复计入');
  extra.push(db.prepare('INSERT INTO business_action_finance_days(id,site,channel,sku,business_date,revision,currency,basis_hash,basis_json,data_json,source,note,actor_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(crypto.randomUUID(),r.site,r.channel,r.sku,date,day.revision+1,day.currency,day.basisHash,JSON.stringify(day.basis),JSON.stringify(costs),source,detail.note,a.id,at));
  detail={...detail,source,costs,businessDate:date,revision:day.revision+1,previousRevision:day.revision,previousCosts:day.costs,basis:day.basis};
 }else if(p.action==='diagnose'){
  if(r.kind!=='weakening'||a.role!=='管理员'&&!(a.role==='运营'&&actionScope(a,r)))fail('由本站渠道运营记录四类动销诊断',403);
  const d={};for(const k of Object.keys(diagnosisFields)){d[k]=text(p.diagnosis?.[k],1000);if(d[k].length<4)fail('请逐项写明流量、转化、价格、质量证据；缺失可明确填写待核实原因');}
  d.measure=text(p.measure,1000);d.source=text(p.source,1000);if(d.measure.length<4||d.source.length<4)fail('请填写拟采取的措施和诊断来源');
  fields={diagnosis_json:JSON.stringify(d)};detail={...detail,diagnosis:d};
 }else if(p.action==='start'||p.action==='execute'){
  const owner=await liveOwner(db,r);if(!owner||owner.id!==a.id)fail('请管理员先确认有效的唯一负责人，由负责人登记行动',403);
  extra.push(guardStatement(db,a,'business-action.executor',"EXISTS(SELECT 1 FROM users WHERE id=? AND active=1 AND role=? AND COALESCE(site,'')=? AND COALESCE(channel,'')=?)",[owner.id,owner.role,owner.site||'',owner.channel||'']));
  if(r.status==='resolved'||r.status==='review_pending')fail('当前状态不可重复执行');
  if(p.action==='execute'){
   if(text(p.source,1000).length<4)fail('请填写执行凭据／链接／记录编号');
   if(r.kind==='weakening'&&!r.diagnosis.measure)fail('先记录流量、转化、价格和质量诊断，再登记措施');
   const review=iso(p.reviewAt,'复查时间',now);if(Date.parse(review)<+now+86400000)fail('执行后至少观察24小时再复查');
   fields={status:'review_pending',executed_at:at,review_at:review,executed_cutoff:r.snapshot.window.cutoff};detail={...detail,source:text(p.source,1000),snapshot:r.snapshot,reviewAt:review};
  }else fields={status:'in_progress'};
 }else if(p.action==='dismiss'){
  const roles=r.kind==='loss'?['管理员','财务']:r.kind==='stockout'?['管理员','供应链']:['管理员','运营主管','运营'];
  if(!roles.includes(a.role)||r.ever_active||r.executed_at||r.status!=='open')fail('只可核实排除从未确认触发、且尚未执行的待核实记录',403);
  const current=(await actionCandidates(db,a,now)).find(s=>actionKey(s)===actionKey(r));
  if(!current||current.condition!=='clear'||current.coverage!==7||r.kind==='loss'&&current.profit==null)fail('尚无完整证据排除问题，请继续核实');
  if(text(p.source,1000).length<4)fail('请填写排除问题的证据来源');
  extra.push(guardStatement(db,a,'business-action.dismiss-basis',"COALESCE((SELECT version FROM business_action_source_clock WHERE id='global'),0)=?",[current.sourceVersion]));
  fields={snapshot_json:JSON.stringify(current),status:'resolved',resolved_at:at};detail={...detail,outcome:'verified_clear',source:text(p.source,1000),before:r.snapshot,after:current};
 }else if(p.action==='review'){
  if(r.status!=='review_pending')fail('执行登记后才能复查');
  const roles=r.kind==='loss'?['管理员','财务']:r.kind==='stockout'?['管理员','供应链']:['管理员','运营主管','运营'];
  if(!roles.includes(a.role))fail('当前岗位不能复查此类行动',403);
  if(+now<Date.parse(r.review_at))fail('尚未到复查时间，不能提前按执行结果结案');
  if(text(p.source,1000).length<4)fail('请填写复查证据来源');
  const current=(await actionCandidates(db,a,now)).find(s=>actionKey(s)===actionKey(r));
  if(!current||current.window.cutoff<=r.executed_cutoff)fail('尚无执行后的新完整日数据，请继续观察');
  extra.push(guardStatement(db,a,'business-action.review-basis',"COALESCE((SELECT version FROM business_action_source_clock WHERE id='global'),0)=?",[current.sourceVersion]));
  if(!['resolved','continue'].includes(p.outcome))fail('请选择复查结果');
  if(p.outcome==='resolved'&&(current.condition!=='clear'||current.coverage!==7||r.kind==='loss'&&current.profit==null||r.kind==='stockout'&&current.observedQty>0&&(current.profit==null||current.supply.unknownArrival>0)))fail('证据未齐或问题仍触发，不能标记已解决；请继续跟进');
  fields={snapshot_json:JSON.stringify(current),status:p.outcome==='resolved'?'resolved':'in_progress',resolved_at:p.outcome==='resolved'?at:null};
  if(p.outcome==='continue'){fields.due_at=iso(p.dueAt,'下一次行动截止时间',now);fields.review_at=iso(p.reviewAt,'下次复查时间',now);if(fields.review_at<=fields.due_at)fail('复查时间须晚于截止时间');}
  const execution=await db.prepare("SELECT detail_json FROM business_action_events WHERE action_id=? AND event='execute' ORDER BY created_at DESC,rowid DESC LIMIT 1").bind(r.id).first();
  detail={...detail,outcome:p.outcome,source:text(p.source,1000),before:execution?parse(execution.detail_json).snapshot:r.snapshot,after:current};
 }else if(p.action==='comment'){
  if(a.role!=='管理员'&&a.id!==r.owner_id&&!r.collaborators.some(u=>u.id===a.id)&&a.role!=='财务')fail('由负责人、协作人、财务或管理员补充跟进',403);
 }else fail('不支持的行动');
 fields.updated_at=at;
 const set=Object.keys(fields).map(k=>k+'=?').join(',');
 await atomicBatch(db,[guard,...extra,db.prepare(`UPDATE business_actions SET ${set},version=version+1 WHERE id=? AND version=?`).bind(...Object.values(fields),r.id,p.version),audit(db,a,r.id,p.action,detail,at)]);
 // Finance evidence is applied on the next refresh, so a saved ledger never appears to have failed.
 return {ok:true,id:r.id};
}

export async function businessActionTasks(db,a,now=new Date()){
 if(!canReadActions(a))return [];
 const f=scopeFilter(a),rs=await rows(db,"SELECT * FROM business_actions"+f.sql+(f.sql?' AND':' WHERE')+" status<>'resolved'",f.args);
 const relevant=rs.filter(r=>a.role==='管理员'&&!r.owner_id||r.owner_id===a.id||parse(r.collaborators_json).some(u=>u.id===a.id));
 if(!relevant.length)return [];
 const late=relevant.filter(r=>Date.parse(r.status==='review_pending'?r.review_at:r.due_at)<=+now).length;
 return [{tab:'business-actions',entity:'',title:'跟进每日经营行动',detail:`${relevant.length}条持续跟进${late?`，${late}条已到期`:''}；执行后仍需复查`,level:late?'red':'amber'}];
}

export async function readActionFinanceDay(db,a,id,date,now=new Date()){
 const r=await actionRecord(db,a,id);
 if(!['管理员','财务'].includes(a.role))fail('仅财务及管理员查看每日核算修订凭据',403);
 if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date))||new Date(date).toISOString().slice(0,10)!==date||date>=actionWindow(r.site,now).today)fail('请选择已结束的有效日期');
 return actionFinanceDay(db,r,date);
}
