import {atomicBatch,assertWritable,guardStatement} from './atomic.mjs';
import {readSalesDashboard} from './sales-dashboard.mjs';
import {SITE_CURRENCIES} from './sales-data.mjs';
import {ReviewError,reviewToday,addDays,reviewPeriod,reviewAccess,isReviewWriter,reviewReaders,normalizeReviewData,validReviewDate} from './business-review-model.mjs';
const rows=async(db,sql,args=[]) =>(await db.prepare(sql).bind(...args).all()).results||[];
const fail=(message,status=400)=>{throw new ReviewError(message,status);};
const parse=r=>({...r,data:JSON.parse(r.data_json),snapshot:JSON.parse(r.snapshot_json)});
const stamp=()=>new Date().toISOString();
const text=(v,n=2000)=>String(v??'').trim().slice(0,n);
const audit=(db,actor,id,action,detail)=>db.prepare('INSERT INTO audit_logs(id,action,entity_type,entity_id,detail_json,actor_id,actor_name,created_at) VALUES(?,?,?,?,?,?,?,?)').bind(crypto.randomUUID(),'review.'+action,'business_review',id,JSON.stringify(detail),actor.id,actor.name,stamp());
const canRead=(actor,r)=>r.owner_id===actor.id||reviewReaders.includes(actor.role)&&r.status!=='draft';
async function reportRecord(db,actor,id){const r=await db.prepare('SELECT * FROM business_reviews WHERE id=?').bind(text(id,100)).first();if(!r||!canRead(actor,r))fail('报告不存在或无权访问',404);return r;}
export async function reviewSnapshot(db,owner,period){
 const asOf=period.asOf,channel=owner.channel,from=period.start,to=asOf;
 if(!asOf)return {asOf:null,partial:true,currencies:[],quantity:null,coverage:0,expectedDays:0,source:'尚无已结束的统计日'};
 if(channel!=='线下分销'){
  const actor={...owner,role:'运营'};const current=await readSalesDashboard(db,actor,{from,to,site:owner.site,channel},reviewToday());
  const length=Math.round((Date.parse(to)-Date.parse(from))/86400000)+1;
  // Compare equal-length windows, never an unfinished month against a full month.
  const previousStart=period.kind==='weekly'?addDays(from,-7):new Date(Date.UTC(Number(from.slice(0,4)),Number(from.slice(5,7))-2,1)).toISOString().slice(0,10);
  const previousEnd=period.kind==='weekly'?addDays(to,-7):[addDays(previousStart,length-1),addDays(from,-1)].sort()[0];
  const previous=await readSalesDashboard(db,actor,{from:previousStart,to:previousEnd,site:owner.site,channel},reviewToday());
  return {asOf,partial:period.partial,quantity:current.totalQty,currencies:current.currencies.map(c=>({...c,roas:new Set(current.daily.filter(r=>r.salesComplete).map(r=>r.date)).size===length?c.roas:null})),coverage:new Set(current.daily.filter(r=>r.salesComplete).map(r=>r.date)).size,expectedDays:length,skuRanking:current.skuRanking.slice(0,10),daily:current.daily,previous:{from:previousStart,to:previousEnd,quantity:previous.totalQty,currencies:previous.currencies},source:'系统已导入销售和渠道广告费用；缺失日期不当作零，销量不是订单量',generatedAt:stamp()};
 }
 throw new ReviewError('首轮仅支持 TikTok / Shopee 运营',403);
}

export async function readReviews(db,actor,input={}){
 reviewAccess(actor);const period=reviewPeriod(input.kind||'weekly',input.date||reviewToday());
 const all=await rows(db,'SELECT * FROM business_reviews WHERE kind=? AND period_start=? ORDER BY site,channel,owner_name',[period.kind,period.start]);
 const reports=all.filter(r=>canRead(actor,r)).map(parse);
 for(const report of reports){const previous=await db.prepare("SELECT data_json,period_start,period_end FROM business_reviews WHERE owner_id=? AND kind=? AND period_start<? AND status IN ('submitted','reviewed') ORDER BY period_start DESC LIMIT 1").bind(report.owner_id,report.kind,report.period_start).first();report.previous=previous?{...previous,data:JSON.parse(previous.data_json)}:null;}
 const users=await rows(db,"SELECT id,name,role,site,channel,created_at FROM users WHERE active=1 AND role IN ('管理员','运营主管','运营','供应链','财务') ORDER BY name");
 const expected=users.filter(u=>isReviewWriter(u)&&u.created_at.slice(0,10)<=period.end&&(reviewReaders.includes(actor.role)||u.id===actor.id));
 const obligations=expected.map(u=>{const r=all.find(r=>r.owner_id===u.id);return {id:u.id,name:u.name,site:u.site,channel:u.role==='销售'?'线下分销':u.channel,status:r?.status||'missing',reportId:reports.find(r=>r.owner_id===u.id)?.id||null,late:(!r||!['submitted','reviewed'].includes(r.status))&&stamp()>period.dueAt};});
 const actions=await rows(db,"SELECT a.*,r.owner_id report_owner,r.owner_name report_owner_name,r.site,r.channel,r.status report_status,r.version report_version,r.kind,r.period_start FROM review_actions a JOIN business_reviews r ON r.id=a.report_id WHERE (r.status<>'draft' AND (a.owner_id=? OR ?=1)) OR r.owner_id=? ORDER BY CASE a.status WHEN 'open' THEN 0 WHEN 'done' THEN 1 ELSE 2 END,a.due_date",[actor.id,reviewReaders.includes(actor.role)?1:0,actor.id]);
 const ids=new Set(reports.map(r=>r.id));const history=ids.size?(await rows(db,"SELECT entity_id,action,actor_name,created_at,detail_json FROM audit_logs WHERE entity_type='business_review' ORDER BY created_at DESC")).filter(r=>ids.has(r.entity_id)).map(r=>({...r,detail:JSON.parse(r.detail_json)})):[];
 return {actor:{id:actor.id,role:actor.role,name:actor.name},period,reports,obligations,actions,users:users.map(({id,name,role,site,channel})=>({id,name,role,site,channel})),history,canWrite:Boolean(isReviewWriter(actor)),canReview:actor.role==='管理员',currency:SITE_CURRENCIES[actor.site]||'IDR',generatedAt:stamp()};
}
export async function mutateReview(db,actor,p){
 reviewAccess(actor);await assertWritable(db);const action=text(p.action,30),now=stamp();
 if(action==='create'){
  if(!isReviewWriter(actor))fail('仅 TikTok / Shopee 运营可建立本人报告',403);
  const period=reviewPeriod(p.kind,p.date);const old=await db.prepare('SELECT id FROM business_reviews WHERE owner_id=? AND kind=? AND period_start=?').bind(actor.id,period.kind,period.start).first();if(old)return {ok:true,id:old.id};
  const id=crypto.randomUUID(),channel=actor.role==='销售'?'线下分销':actor.channel;
  await atomicBatch(db,[guardStatement(db,actor,'review.create','NOT EXISTS(SELECT 1 FROM business_reviews WHERE owner_id=? AND kind=? AND period_start=?)',[actor.id,period.kind,period.start]),db.prepare('INSERT INTO business_reviews(id,owner_id,owner_name,site,channel,kind,period_start,period_end,due_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').bind(id,actor.id,actor.name,actor.site,channel,period.kind,period.start,period.end,period.dueAt,now,now),audit(db,actor,id,action,{period})]);return {ok:true,id};
 }
 const r=action==='actionUpdate'?await db.prepare("SELECT r.* FROM business_reviews r JOIN review_actions a ON a.report_id=r.id WHERE r.id=? AND a.id=? AND (a.owner_id=? OR ?=1)").bind(text(p.id,100),text(p.actionId,100),actor.id,actor.role==='管理员'?1:0).first():await reportRecord(db,actor,p.id);if(!r)fail('报告或行动不存在或无权处理',404);if(Number(p.version)!==r.version)fail('报告版本已变化，请刷新核对后重试',409);
 const own=r.owner_id===actor.id,editable=own&&['draft','returned'].includes(r.status);
 const guard=guardStatement(db,actor,'review.'+action,'EXISTS(SELECT 1 FROM business_reviews WHERE id=? AND version=? AND status=?)',[r.id,r.version,r.status]);
 if(['save','submit'].includes(action)){
  if(!editable)fail('只能修改本人草稿或退回的报告',403);const data=normalizeReviewData(p.data||{},r.channel,action==='submit');
  let snap=JSON.parse(r.snapshot_json);if(action==='submit'){
   if(!await db.prepare("SELECT id FROM review_actions WHERE report_id=? AND status<>'cancelled' LIMIT 1").bind(r.id).first())fail('至少建立一项有量化目标、负责人和截止日期的行动');
   snap=await reviewSnapshot(db,{id:r.owner_id,site:r.site,channel:r.channel},{kind:r.kind,start:r.period_start,end:r.period_end,asOf:[r.period_end,addDays(reviewToday(),-1)].sort()[0]<r.period_start?null:[r.period_end,addDays(reviewToday(),-1)].sort()[0],partial:addDays(reviewToday(),-1)<r.period_end});
  }
  const status=action==='submit'?'submitted':r.status;
  await atomicBatch(db,[guard,db.prepare('UPDATE business_reviews SET data_json=?,snapshot_json=?,status=?,submitted_at=?,version=version+1,updated_at=? WHERE id=?').bind(JSON.stringify(data),JSON.stringify(snap),status,action==='submit'?now:r.submitted_at,now,r.id),audit(db,actor,r.id,action,{version:r.version+1,status,data,snapshot:snap})]);return {ok:true,id:r.id};
 }
 if(action==='refreshSnapshot'){
  if(!editable)fail('提交后的数据快照已锁定；请撤回或由管理员退回后更新',403);
  const snapshot=await reviewSnapshot(db,{id:r.owner_id,site:r.site,channel:r.channel},{kind:r.kind,start:r.period_start,end:r.period_end,asOf:[r.period_end,addDays(reviewToday(),-1)].sort()[0]<r.period_start?null:[r.period_end,addDays(reviewToday(),-1)].sort()[0],partial:addDays(reviewToday(),-1)<r.period_end});
  await atomicBatch(db,[guard,db.prepare('UPDATE business_reviews SET snapshot_json=?,version=version+1,updated_at=? WHERE id=?').bind(JSON.stringify(snapshot),now,r.id),audit(db,actor,r.id,action,{version:r.version+1,snapshot})]);return {ok:true};
 }
 if(['withdraw','return','review'].includes(action)){
  const note=text(p.note);if(note.length<4)fail('请填写至少4字的处理意见');
  if(action==='withdraw'?(!own||r.status!=='submitted'):(actor.role!=='管理员'||own||!['submitted',...(action==='return'?['reviewed']:[])].includes(r.status)))fail('当前账号或状态不能执行此处理',403);
  const status=action==='review'?'reviewed':'returned';
  await atomicBatch(db,[guard,db.prepare('UPDATE business_reviews SET status=?,review_note=?,version=version+1,updated_at=? WHERE id=?').bind(status,note,now,r.id),audit(db,actor,r.id,action,{version:r.version+1,note,status})]);return {ok:true};
 }
 if(action==='addAction'){
  if(!editable&&actor.role!=='管理员')fail('不能添加本报告行动项',403);
  const owner=await db.prepare("SELECT id FROM users WHERE id=? AND active=1 AND role IN ('管理员','运营主管','运营','供应链','财务')").bind(text(p.ownerId,100)).first();
  const title=text(p.title,300),target=text(p.target,500),due=text(p.dueDate,10),priority=p.priority==='high'?'high':'normal';if(!owner||title.length<4||target.length<4||!validReviewDate(due)||due<reviewToday())fail('请填写行动、可核对的量化结果、有效负责人和不早于今天的截止日期');
  const id=crypto.randomUUID();await atomicBatch(db,[guard,db.prepare('INSERT INTO review_actions(id,report_id,owner_id,title,target,due_date,priority,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').bind(id,r.id,owner.id,title,target,due,priority,now,now),db.prepare('UPDATE business_reviews SET version=version+1,updated_at=? WHERE id=?').bind(now,r.id),audit(db,actor,r.id,action,{id,title,target,ownerId:owner.id,dueDate:due,version:r.version+1})]);return {ok:true};
 }
 if(action==='actionUpdate'){
  const a=await db.prepare('SELECT * FROM review_actions WHERE id=? AND report_id=?').bind(text(p.actionId,100),r.id).first();if(!a||Number(p.actionVersion)!==a.version)fail('行动项已更新，请刷新',409);
  const note=text(p.note),status=p.status;if(note.length<4)fail('请填写完成证据或处理原因（至少4字）');
  const valid=status==='done'&&a.status==='open'&&a.owner_id===actor.id||actor.role==='管理员'&&((status==='closed'||status==='open')&&a.status==='done'||status==='cancelled'&&['open','done'].includes(a.status));
  if(!valid||r.status==='draft')fail('当前账号或状态不能更新行动项',403);
  await atomicBatch(db,[guard,guardStatement(db,actor,'review.actionUpdate','EXISTS(SELECT 1 FROM review_actions WHERE id=? AND version=?)',[a.id,a.version]),db.prepare('UPDATE review_actions SET status=?,evidence=?,review_note=?,version=version+1,updated_at=? WHERE id=?').bind(status,status==='done'?note:a.evidence,status==='done'?a.review_note:note,now,a.id),audit(db,actor,r.id,action,{actionId:a.id,status,note,actionVersion:a.version+1})]);return {ok:true};
 }
 fail('不支持的报告操作');
}
export async function reviewTasks(db,actor){
 if(!['管理员','运营主管','财务','供应链','运营'].includes(actor.role))return [];
 const tasks=[],today=reviewToday();
 if(isReviewWriter(actor))for(const [kind,date] of [['weekly',today],['monthly',today]]){
  const period=reviewPeriod(kind,date),r=await db.prepare('SELECT status FROM business_reviews WHERE owner_id=? AND kind=? AND period_start=?').bind(actor.id,kind,period.start).first();
  if(!r||!['submitted','reviewed'].includes(r.status))tasks.push({tab:'reviews',level:'red',title:kind==='weekly'?'提交本期经营周报':'准备28日月度复盘',detail:`${period.start} · ${stamp()>period.dueAt?'已到提交时间':'待准备'}`});
 }
 if(actor.role==='管理员'){const pending=await db.prepare("SELECT COUNT(*) n FROM business_reviews WHERE status='submitted'").first();if(pending.n)tasks.push({tab:'reviews',level:'red',title:'复核经营报告',detail:`${pending.n}份报告待复核`});}
 const due=await db.prepare("SELECT COUNT(*) n FROM review_actions a JOIN business_reviews r ON r.id=a.report_id WHERE r.status<>'draft' AND a.status='open' AND a.due_date<=? AND (a.owner_id=? OR ?=1)").bind(today,actor.id,actor.role==='管理员'?1:0).first();if(due.n)tasks.push({tab:'reviews',level:'red',title:'跟进行动到期事项',detail:`${due.n}项行动已到截止日`});return tasks;
}
