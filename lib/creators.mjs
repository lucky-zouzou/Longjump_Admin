import {atomicBatch,assertWritable,guardStatement} from './atomic.mjs';
import {assertFinanceOpen} from './finance-periods.mjs';
import {creatorSites,creatorFees,creatorMetrics,creatorTasks,financeValue,fail,txt,required,link,contentLink,instant,integer,minor,canonicalId} from './creator-model.mjs';

const roles=['管理员','达人BD','运营','运营主管','财务'];
const all=async(db,sql,args=[]) => (await db.prepare(sql).bind(...args).all()).results;
const json=(v)=>JSON.parse(v||'{}');
const id=()=>crypto.randomUUID();
const editable=['管理员','达人BD','运营'];
export function creatorAccess(actor){if(!actor||!roles.includes(actor.role))fail('当前岗位没有达人工作台权限',403);}
function canScope(actor,s){return ['管理员','运营主管','财务'].includes(actor.role)||(actor.role==='达人BD'&&s.bd_id===actor.id)||(actor.role==='运营'&&[s.operator_id,s.backup_id].includes(actor.id));}
function requireRole(actor,allowed){if(!allowed.includes(actor.role))fail('当前岗位不能执行此操作',403);}
function checkVersion(row,p){if(!row||Number(p.version)!==row.version)fail('记录已更新，请刷新后重试',409);}
function past(value,label,now){const v=instant(value,label);if(v>now)fail(label+'不能晚于当前时间');return v;}
function next(p,s,users){const owner=required(p.nextOwner,'下一步负责人');if(![s.operator_id,s.backup_id,s.bd_id].includes(owner)||!users.some(u=>u.id===owner&&u.active))fail('请选择当前店铺已分配的有效负责人');return {next_at:instant(p.nextAt,'下次跟进时间'),next_owner_id:owner,next_action:required(p.nextAction,'下一步行动',500)};}
function parseRow(r){return {...r,...(r.data_json?{data:json(r.data_json)}:{}),...(r.terms_json?{terms:json(r.terms_json),logistics:json(r.logistics_json)}:{})};}

export async function readCreators(db,actor){
 creatorAccess(actor);
 const scopes=(await all(db,'SELECT * FROM creator_scopes ORDER BY site,shop')).filter(s=>canScope(actor,s));
 const scopeIds=new Set(scopes.map(s=>s.id));
 const profiles=(await all(db,'SELECT * FROM creator_profiles ORDER BY updated_at DESC')).filter(p=>scopeIds.has(p.scope_id)).map(p=>({...parseRow(p),...Object.fromEntries(['site','platform','shop','operator_id','backup_id','bd_id'].map(k=>[k,scopes.find(s=>s.id===p.scope_id)[k]]))}));
 const ids=new Set(profiles.map(p=>p.id)),rounds=(await all(db,'SELECT * FROM creator_rounds ORDER BY created_at DESC')).filter(r=>ids.has(r.creator_id)).map(parseRow),roundIds=new Set(rounds.map(r=>r.id));
 const contents=(await all(db,'SELECT * FROM creator_contents ORDER BY published_at DESC')).filter(c=>roundIds.has(c.round_id)).map(parseRow),contentIds=new Set(contents.map(c=>c.id));
 const finances=(await all(db,'SELECT * FROM creator_finance ORDER BY revision DESC')).filter(f=>roundIds.has(f.round_id)).map(parseRow);
 const observations=(await all(db,'SELECT * FROM creator_observations ORDER BY revision DESC')).filter(o=>contentIds.has(o.content_id)).map(parseRow);
 const events=(await all(db,'SELECT * FROM creator_events ORDER BY created_at DESC')).filter(e=>ids.has(e.creator_id)).map(e=>({...e,detail:json(e.detail_json)}));
 const userIds=new Set(scopes.flatMap(s=>[s.operator_id,s.backup_id,s.bd_id]).concat(profiles.map(p=>p.source_user_id)));
 const users=(await all(db,'SELECT id,name,role,active FROM users')).filter(u=>actor.role==='管理员'?['运营','达人BD'].includes(u.role):userIds.has(u.id));
 const skus=await all(db,'SELECT sku,name FROM sku_settings ORDER BY sku');
 const balances=(await all(db,'SELECT site,channel,sku,qty,reserved_qty FROM inventory_balances')).filter(b=>scopes.some(s=>s.site===b.site&&s.platform===b.channel));
 const out={actor:{id:actor.id,name:actor.name,role:actor.role},scopes,profiles,rounds,contents,finances,observations,events,users,skus,balances};
 return {...out,metrics:creatorMetrics(profiles,rounds,contents,finances),tasks:creatorTasks(out)};
}

export async function creatorWorkspaceTasks(db,actor){
 if(!roles.includes(actor.role))return [];
 const scopes=(await all(db,'SELECT * FROM creator_scopes')).filter(s=>canScope(actor,s));
 const profiles=(await all(db,'SELECT * FROM creator_profiles')).filter(p=>scopes.some(s=>s.id===p.scope_id)).map(p=>({...p,...Object.fromEntries(['site','operator_id','backup_id','bd_id'].map(k=>[k,scopes.find(s=>s.id===p.scope_id)[k]]))}));
 const rounds=(await all(db,"SELECT * FROM creator_rounds WHERE status IN ('pending','approved','executing')")).filter(r=>profiles.some(p=>p.id===r.creator_id));
 return creatorTasks({actor,profiles,rounds}).map(t=>({tab:'creators',entity:t.id,title:t.title,detail:t.site+' · '+t.name,level:t.overdue?'red':'amber'}));
}

// Every write compares the collaboration clock, including assignment and account changes.
// One transaction appends an immutable event with the state change; no sales/stock/payment posting.
export async function mutateCreator(db,actor,p){
 creatorAccess(actor);await assertWritable(db);
 const clock=await db.prepare("SELECT version FROM creator_clock WHERE id='global'").first();
 const users=await all(db,'SELECT id,name,role,active FROM users');
 if(!users.some(u=>u.id===actor.id&&u.active&&u.role===actor.role))fail('账号岗位已变化，请重新登录',403);
 const now=new Date().toISOString(),statements=[],action=required(p.action,'操作',50);let profile=null,round=null,scope=null,eventDetail={},resultId=null;
 const put=(table,values)=>{const keys=Object.keys(values);statements.push(db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(()=>'?').join(',')})`).bind(...keys.map(k=>values[k])));};
 const update=(table,key,values)=>{const keys=Object.keys(values);statements.push(db.prepare(`UPDATE ${table} SET ${keys.map(k=>k+'=?').join(',')},version=version+1,updated_at=? WHERE id=?`).bind(...keys.map(k=>values[k]),now,key));};
 if(action==='scope'){
  requireRole(actor,['管理员']);
  if(!creatorSites.includes(p.site)||!['TikTok','Shopee'].includes(p.platform))fail('请选择五站及有效平台');
  const valid=(value,role)=>users.some(u=>u.id===value&&u.role===role&&u.active);
  if(!valid(p.operatorId,'运营')||!valid(p.bdId,'达人BD')||(p.backupId&&!valid(p.backupId,'运营')))fail('主责和备份须为有效运营，BD须为有效达人BD账号');
  if(p.operatorId===p.backupId)fail('主责与备份运营不能相同');
  const shop=required(p.shop,'店铺名称',100),existing=await db.prepare('SELECT * FROM creator_scopes WHERE site=? AND platform=? AND shop=?').bind(p.site,p.platform,shop).first();
  const values={operator_id:p.operatorId,backup_id:p.backupId||null,bd_id:p.bdId};
  if(existing){checkVersion(existing,p);update('creator_scopes',existing.id,values);resultId=existing.id;
   for(const row of await all(db,'SELECT id,next_owner_id FROM creator_profiles WHERE scope_id=?',[existing.id])){
    const replacement=row.next_owner_id===existing.operator_id?p.operatorId:row.next_owner_id===existing.bd_id?p.bdId:row.next_owner_id===existing.backup_id?(p.backupId||p.operatorId):null;
    if(replacement&&replacement!==row.next_owner_id)update('creator_profiles',row.id,{next_owner_id:replacement});
   }
  }
  else{resultId=id();put('creator_scopes',{id:resultId,site:p.site,platform:p.platform,shop,...values,updated_at:now});}
  eventDetail={site:p.site,platform:p.platform,shop,...values};
 }else if(action==='create'){
  requireRole(actor,['管理员','运营','达人BD']);
  scope=await db.prepare('SELECT * FROM creator_scopes WHERE id=?').bind(txt(p.scopeId)).first();if(!scope||!canScope(actor,scope))fail('没有该店铺录入权限',403);
  const platformId=canonicalId(p.platformId);if(await db.prepare('SELECT id FROM creator_profiles WHERE scope_id=? AND platform_id=?').bind(scope.id,platformId).first())fail('该店铺已登记此达人，请继续维护原档案',409);
  if(!['video','live','both'].includes(p.kind))fail('请选择视频达人或直播主');
  const source=p.sourceUserId||(actor.role==='运营'?actor.id:scope.operator_id);if(![scope.operator_id,scope.backup_id].includes(source))fail('来源运营须为该店铺主责或备份');
  resultId=id();profile={id:resultId};
  put('creator_profiles',{id:resultId,scope_id:scope.id,platform_id:platformId,name:required(p.name,'达人名称',120),kind:p.kind,source_user_id:source,data_json:JSON.stringify({profileUrl:link(p.profileUrl,'主页链接'),contact:required(p.contact,'联系方式',500),language:required(p.language,'沟通语言',100),fit:required(p.fit,'产品与受众匹配依据'),evidence:link(p.evidence)}),...next(p,scope,users),created_at:now,updated_at:now});eventDetail={platformId,name:p.name};
 }else{
  profile=await db.prepare('SELECT * FROM creator_profiles WHERE id=?').bind(txt(p.creatorId)).first();
  if(!profile)fail('达人档案不存在',404);
  scope=await db.prepare('SELECT * FROM creator_scopes WHERE id=?').bind(profile.scope_id).first();if(!canScope(actor,scope))fail('不能查看或修改其他店铺达人',403);
  const data=json(profile.data_json);
  const roundAction=['approve','reject','extension','extensionApprove','cancel','dispatch','receipt','content','contentReview','complete','observe','finance'].includes(action);
  if(Boolean(p.roundId)!==roundAction)fail('操作与合作轮次不匹配');
  if(p.roundId){round=await db.prepare('SELECT * FROM creator_rounds WHERE id=? AND creator_id=?').bind(txt(p.roundId),profile.id).first();if(!round)fail('合作轮次不存在',404);}
  checkVersion(round||profile,p);resultId=profile.id;
  const activeProfile=()=>{if(profile.state==='paused')fail('达人已暂停，请先恢复跟进');};
  const workingRound=()=>{if(!round||!['approved','executing'].includes(round.status))fail('请先完成合作审批，已结束轮次不能新增交付');};
  const remainingState=async()=>{if(profile.state==='paused')return 'paused';const others=await all(db,"SELECT status FROM creator_rounds WHERE creator_id=? AND id<>? AND status IN ('pending','approved','executing')",[profile.id,round.id]);return others.some(r=>r.status!=='pending')?'fulfilling':others.length?'negotiating':'maintaining';};
  const evidence=()=>link(p.evidence);
  switch(action){
   case 'edit':{
    requireRole(actor,editable);if(!['video','live','both'].includes(p.kind))fail('合作类型无效');
    const updated={...data,profileUrl:link(p.profileUrl,'主页链接'),contact:required(p.contact,'联系方式',500),language:required(p.language,'沟通语言',100),fit:required(p.fit,'匹配依据'),evidence:evidence()};
    update('creator_profiles',profile.id,{name:required(p.name,'达人名称',120),kind:p.kind,data_json:JSON.stringify(updated)});eventDetail={name:p.name,contact:updated.contact,language:updated.language,note:required(p.note,'资料修订原因'),evidence:updated.evidence};break;
   }
   case 'contact':case 'reply':{
    requireRole(actor,['运营','达人BD']);activeProfile();const at=past(p.at,'触达／回复时间',now);
    if(action==='reply'&&(!profile.first_contact_at||at<profile.first_contact_at))fail('请先记录触达，回复时间不能早于首次触达');
    if(action==='contact'&&profile.first_reply_at&&at>profile.first_reply_at)fail('触达时间不能晚于已登记回复');
    const values={...next(p,scope,users)};
    if(action==='contact'&&!profile.first_contact_at)values.first_contact_at=at;
    if(action==='reply'&&!profile.first_reply_at)values.first_reply_at=at;
    if(['candidate','contacted','replied'].includes(profile.state))values.state=action==='reply'?'replied':profile.state==='candidate'?'contacted':profile.state;
    update('creator_profiles',profile.id,values);eventDetail={at,note:required(p.note,'沟通结果'),evidence:evidence(),...values};break;
   }
   case 'handoff':{
    requireRole(actor,['运营']);activeProfile();if(!['replied','maintaining'].includes(profile.state))fail('有明确回复意向后才能交接');
    const sku=required(p.sku,'意向SKU',150);if(!await db.prepare('SELECT sku FROM sku_settings WHERE sku=?').bind(sku).first())fail('意向SKU不存在');
    const handoff={fit:required(p.fit,'匹配依据'),intent:required(p.intent,'明确合作意向'),sku,proposal:required(p.proposal,'形式、数量与排期'),quote:required(p.quote,'费用／佣金诉求'),openIssues:required(p.openIssues,'待解决问题，无则填写无'),evidence:evidence(),evidenceAt:past(p.at,'证据时间',now),trial:p.trial===true};
    const n=next({...p,nextOwner:scope.bd_id},scope,users);update('creator_profiles',profile.id,{state:'handoff',data_json:JSON.stringify({...data,handoff}),...n});eventDetail=handoff;break;
   }
   case 'accept':case 'return':case 'queue':{
    requireRole(actor,['达人BD']);if(profile.state!=='handoff')fail('当前不是待承接交接');
    const n=next(p,scope,users);if(action==='accept'&&n.next_owner_id!==scope.bd_id)fail('承接后的唯一跟进人须为负责BD');
    update('creator_profiles',profile.id,{...n,state:action==='accept'?'negotiating':action==='return'?'replied':'handoff',...(action==='accept'&&!profile.accepted_at?{accepted_at:now}:{})});eventDetail={reason:required(p.note,'承接／退回／排队原因'),...n};break;
   }
   case 'follow':case 'pause':case 'resume':{
    requireRole(actor,editable);const n=next(p,scope,users);const values={...n};
    if(action==='pause'){values.state='paused';values.data_json=JSON.stringify({...data,resumeState:profile.state==='paused'?data.resumeState:profile.state});}
    if(action==='resume'){if(profile.state!=='paused')fail('当前未暂停');values.state=data.resumeState&&data.resumeState!=='paused'?data.resumeState:'candidate';if(profile.tier==='paused')values.tier=data.resumeTier||'trial';}
    update('creator_profiles',profile.id,values);eventDetail={note:required(p.note,'问题、约定或暂停原因'),hours:p.hours===''||p.hours==null?null:integer(p.hours,'投入分钟',0,1440),...n};break;
   }
   case 'round':{
    requireRole(actor,['达人BD']);activeProfile();if(!profile.accepted_at)fail('BD承接交接后才能制定合作条件');
    const input=p.items||[{sku:p.sku,sampleQty:p.sampleQty}];if(!Array.isArray(input)||!input.length||input.length>100)fail('请逐项选择合作SKU，最多100项');
    const items=[];for(const item of input){const sku=required(item.sku,'合作SKU',150);if(!await db.prepare('SELECT sku FROM sku_settings WHERE sku=?').bind(sku).first())fail('合作SKU不存在');if(items.some(i=>i.sku===sku))fail('合作SKU不能重复');items.push({sku,sampleQty:integer(item.sampleQty,'样品数量',0,10000)});}
    const due=instant(p.dueAt,'原交付期限');if(due<=now)fail('新合作期限须晚于现在');
    const terms={items,sku:items.map(i=>i.sku).join(' / '),sampleQty:items.reduce((s,i)=>s+i.sampleQty,0),videos:integer(p.videos,'视频数量',0,1000),lives:integer(p.lives,'直播场次',0,1000),currency:required(p.currency,'币种',3),budgetMinor:minor(p.budget,'合作预算上限'),commission:required(p.commission,'佣金条件'),requirements:required(p.requirements,'内容／直播验收条件'),rights:required(p.rights,'素材使用范围与到期时间，无授权须注明'),stockCheck:required(p.stockCheck,'库存与促销核对'),evidence:evidence(),zone:required(p.zone,'约定时区',50)};
    if(!['CNY','IDR','MYR','THB','VND','PHP','USD'].includes(terms.currency)||terms.videos+terms.lives===0)fail('请核对币种和交付数量');
    const roundId=id();put('creator_rounds',{id:roundId,creator_id:profile.id,round_no:'BD-'+now.slice(0,10).replaceAll('-','')+'-'+roundId.slice(0,8).toUpperCase(),status:'pending',terms_json:JSON.stringify(terms),original_due_at:due,effective_due_at:due,author_id:actor.id,created_at:now,updated_at:now});update('creator_profiles',profile.id,{state:profile.state});round={id:roundId};eventDetail={terms,due};break;
   }
   case 'approve':case 'reject':{
    requireRole(actor,['管理员']);if(!round||round.status!=='pending')fail('当前不是待审批合作');if(round.author_id===actor.id)fail('申请人与审批人须独立');
    if(action==='approve')activeProfile();
    const reason=required(p.note,'审批意见');update('creator_rounds',round.id,{status:action==='approve'?'approved':'cancelled',approver_id:actor.id,...(action==='approve'?{approved_at:now}:{})});
    if(action==='approve')update('creator_profiles',profile.id,{state:'fulfilling',next_owner_id:scope.operator_id,next_at:round.original_due_at,next_action:'按批准条件寄样并跟进交付'});eventDetail={reason};break;
   }
   case 'extension':case 'extensionApprove':{
    workingRound();const terms=json(round.terms_json);
    if(action==='extension'){requireRole(actor,['达人BD']);const due=instant(p.dueAt,'延期时间');if(due<=round.effective_due_at||due<=now)fail('延期须晚于当前期限及现在');if(terms.extension)fail('已有延期申请待审批');terms.extension={due,reason:required(p.note,'延期原因'),evidence:evidence(),author:actor.id,requestedAt:now};}
    else{requireRole(actor,['管理员']);if(!terms.extension||terms.extension.author===actor.id)fail('缺少独立的延期申请');eventDetail={...terms.extension,decision:required(p.note,'延期审批意见')};const due=terms.extension.due;delete terms.extension;update('creator_rounds',round.id,{terms_json:JSON.stringify(terms),...(p.accept===true?{effective_due_at:due}:{})});break;}
    update('creator_rounds',round.id,{terms_json:JSON.stringify(terms)});eventDetail=terms.extension;break;
   }
   case 'cancel':{
    requireRole(actor,['管理员']);if(!round||['completed','cancelled'].includes(round.status))fail('当前轮次不可终止');
    update('creator_rounds',round.id,{status:'cancelled'});update('creator_profiles',profile.id,{state:await remainingState()});eventDetail={reason:required(p.note,'终止原因与后续费用处理'),evidence:evidence()};break;
   }
   case 'dispatch':case 'receipt':{
    requireRole(actor,['运营']);workingRound();const terms=json(round.terms_json),logistics=json(round.logistics_json);if(!terms.sampleQty)fail('该轮次不需寄样');
    if(action==='dispatch'){if(logistics.dispatch)fail('已登记寄样，禁止重复登记');if(Number(p.qty)!==terms.sampleQty)fail('请待本轮约定样品全部发出后登记，数量须与已批准SKU清单一致');logistics.dispatch={at:past(p.at,'寄出时间',now),warehouseRef:required(p.warehouseRef,'真实出库单号',200),carrier:required(p.carrier,'承运商',100),tracking:required(p.tracking,'物流单号',150),qty:integer(p.qty,'实际样品数量',1,terms.sampleQty),items:terms.items,evidence:evidence()};if(logistics.dispatch.at<round.approved_at)fail('寄样时间不能早于审批');}
    else{if(!logistics.dispatch||logistics.receipt)fail('请先登记寄样，收货只能登记一次');logistics.receipt={at:past(p.at,'签收时间',now),evidence:evidence()};if(logistics.receipt.at<logistics.dispatch.at)fail('签收不能早于寄出');}
    update('creator_rounds',round.id,{status:'executing',logistics_json:JSON.stringify(logistics)});eventDetail=logistics[action==='dispatch'?'dispatch':'receipt'];break;
   }
   case 'content':{
    requireRole(actor,['运营']);workingRound();const terms=json(round.terms_json);if(!['video','live'].includes(p.kind))fail('请选择视频或直播');
    if(!terms[p.kind==='video'?'videos':'lives'])fail('本轮未约定该形式交付');
    const url=contentLink(p.url);if(await db.prepare('SELECT id FROM creator_contents WHERE url=?').bind(url).first())fail('该内容已登记，不能重复计算交付',409);
    const published=past(p.at,'发布时间',now);if(published<round.approved_at)fail('交付内容不能早于合作批准');
    const accepted=p.linkValid===true&&p.skuCorrect===true&&p.accurate===true&&p.agreed===true;
    const sku=p.sku||(terms.items.length===1?terms.items[0].sku:'');if(!terms.items.some(i=>i.sku===sku))fail('内容SKU须属于本轮已批准清单');
    const detail={sku,linkValid:p.linkValid===true,skuCorrect:p.skuCorrect===true,accurate:p.accurate===true,agreed:p.agreed===true,note:required(p.note,'验收说明'),evidence:evidence(),durationMinutes:p.kind==='live'?integer(p.duration,'直播时长（分钟）',1,1440):null};
    put('creator_contents',{id:id(),round_id:round.id,kind:p.kind,url,published_at:published,status:accepted?'accepted':'pending',data_json:JSON.stringify(detail),created_at:now,updated_at:now});update('creator_rounds',round.id,{status:'executing'});eventDetail={url,...detail};break;
   }
   case 'contentReview':{
    requireRole(actor,['运营']);workingRound();const c=await db.prepare('SELECT * FROM creator_contents WHERE id=? AND round_id=?').bind(txt(p.contentId),round.id).first();if(!c)fail('内容不存在');
    const accepted=p.linkValid===true&&p.skuCorrect===true&&p.accurate===true&&p.agreed===true;
    const detail={...json(c.data_json),linkValid:p.linkValid===true,skuCorrect:p.skuCorrect===true,accurate:p.accurate===true,agreed:p.agreed===true,note:required(p.note,'复验说明'),evidence:evidence()};update('creator_contents',c.id,{status:accepted?'accepted':'pending',data_json:JSON.stringify(detail)});update('creator_rounds',round.id,{status:'executing'});eventDetail={contentId:c.id,...detail};break;
   }
   case 'complete':{
    requireRole(actor,['运营']);workingRound();const terms=json(round.terms_json),contents=await all(db,"SELECT kind FROM creator_contents WHERE round_id=? AND status='accepted'",[round.id]);
    if(terms.sampleQty&&!json(round.logistics_json).receipt)fail('请先核对样品签收');
    if(contents.filter(c=>c.kind==='video').length<terms.videos||contents.filter(c=>c.kind==='live').length<terms.lives)fail('约定视频／直播尚未全部验收');
    update('creator_rounds',round.id,{status:'completed',completed_at:now});update('creator_profiles',profile.id,{state:await remainingState(),...next(p,scope,users)});eventDetail={note:required(p.note,'复盘与后续计划'),evidence:evidence()};break;
   }
   case 'observe':{
    requireRole(actor,['运营','达人BD']);if(!round||!round.approved_at)fail('合作未批准');
    const c=await db.prepare('SELECT * FROM creator_contents WHERE id=? AND round_id=?').bind(txt(p.contentId),round.id).first();if(!c)fail('内容不存在');
    const window=integer(p.window,'观察窗口',7,30);if(![7,30].includes(window))fail('观察窗口仅支持7天或30天');
    const at=past(p.at,'取数时间',now);if(Date.parse(at)<Date.parse(c.published_at)+window*86400000)fail('观察窗口尚未成熟，不可作为完整结果录入');
    const metrics={};for(const k of ['views','clicks','orders','refundOrders'])metrics[k]=p[k]==null||p[k]===''?null:integer(p[k],k);
    if(metrics.refundOrders!=null&&metrics.orders!=null&&metrics.refundOrders>metrics.orders)fail('退款订单不能大于归属订单');
    const previous=await db.prepare('SELECT MAX(revision) AS n FROM creator_observations WHERE content_id=? AND window_days=?').bind(c.id,window).first();
    const detail={...metrics,evidence:evidence(),note:required(p.note,'数据口径／修订原因'),currency:required(p.currency,'币种',3),revenueMinor:p.revenue==null||p.revenue===''?null:minor(p.revenue,'销售金额')};
    put('creator_observations',{id:id(),content_id:c.id,window_days:window,revision:(previous.n||0)+1,observed_at:at,data_json:JSON.stringify(detail),actor_id:actor.id,created_at:now});update('creator_rounds',round.id,{status:round.status});eventDetail={contentId:c.id,window,...detail};break;
   }
   case 'finance':{
    requireRole(actor,['财务']);if(!round||!round.approved_at)fail('只可核算已批准合作');
    const date=required(p.date,'核算日期',10);if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date))||new Date(date).toISOString().slice(0,10)!==date||date>now.slice(0,10))fail('核算日期无效');await assertFinanceOpen(db,date);
    const currency=required(p.currency,'币种',3);if(!['CNY','IDR','MYR','THB','VND','PHP','USD'].includes(currency))fail('币种无效');
    const rate=Number(p.rate);if(!Number.isFinite(rate)||rate<=0||rate>10000||(currency==='CNY'&&rate!==1))fail('请填写每单位原币折合人民币的有效汇率；人民币为1');
    const source=required(p.sourceRef,'本轮唯一结算明细引用',200),existing=await db.prepare('SELECT round_id FROM creator_finance_sources WHERE source_ref=?').bind(source).first();if(existing&&existing.round_id!==round.id)fail('此结算明细已归属其他合作，不能重复记入',409);
    if(p.confirmed!==true)fail('请确认净收入已扣退款、各费用没有重复扣除');
    const costs={};for(const [k,label] of Object.entries(creatorFees)){const entry=p.costs?.[k];if(!entry||!['separate','included'].includes(entry.mode))fail(label+'未核实');const value=minor(entry.amount,label);if(entry.mode==='included'&&value!==0)fail(label+'已计入净收入时，额外扣除须为0');costs[k]={mode:entry.mode,minor:value,evidence:required(entry.evidence,label+'依据',1000)};}
    const net=minor(p.netRevenue,'本轮累计净收入'),profit=net-Object.values(costs).reduce((s,c)=>s+c.minor,0),profitCnyMinor=Math.round(profit*rate);if(!Number.isSafeInteger(profitCnyMinor))fail('折算金额超出范围');
    const previous=await db.prepare('SELECT revision AS n,business_date FROM creator_finance WHERE round_id=? ORDER BY revision DESC LIMIT 1').bind(round.id).first();if(previous)await assertFinanceOpen(db,previous.business_date);
    const ordersAsOf=past(p.ordersAsOf,'订单统计截止时间',now),ordersFrom=past(p.ordersFrom,'订单统计起始时间',now);if(ordersFrom>ordersAsOf||Date.parse(ordersFrom)<Date.parse(ordersAsOf)-60*86400000)fail('核心分层依据仅接受最多60天窗口的有效订单；累计收入另行核算');
    const detail={currency,rate,rateBasis:required(p.rateBasis,'汇率日期与依据'),netRevenueMinor:net,profitMinor:profit,profitCnyMinor,costs,verifiedOrders:integer(p.orders,'窗口内核验有效订单'),ordersFrom,ordersAsOf,evidence:evidence(),reason:required(p.note,'核算口径／修订原因')};
    if(!existing)put('creator_finance_sources',{source_ref:source,round_id:round.id});
    put('creator_finance',{id:id(),round_id:round.id,revision:(previous?.n||0)+1,basis_version:round.version,business_date:date,source_ref:source,data_json:JSON.stringify(detail),actor_id:actor.id,created_at:now});eventDetail={revision:(previous?.n||0)+1,source,date};break;
   }
   case 'tier':{
    requireRole(actor,['达人BD']);if(!['trial','growing','core','paused'].includes(p.tier))fail('分层无效');
    const rounds=(await all(db,'SELECT * FROM creator_rounds WHERE creator_id=?',[profile.id])).map(parseRow),finances=(await all(db,'SELECT f.* FROM creator_finance f JOIN creator_rounds r ON r.id=f.round_id WHERE r.creator_id=?',[profile.id])).map(parseRow),completed=rounds.filter(r=>r.status==='completed');
    if(p.tier==='growing'&&!completed.length)fail('成长层至少需要一轮完整交付');
    if(p.tier==='core'){const values=rounds.map(r=>financeValue(r,finances)).filter(Boolean);if(completed.length<2||values.length!==rounds.filter(r=>r.approved_at).length||values.reduce((s,f)=>s+f.data.profitCnyMinor,0)<=0||!values.some(f=>f.data.verifiedOrders>0&&Date.parse(f.data.ordersFrom)>=Date.parse(now)-60*86400000)||p.willing!==true)fail('核心层需两轮完整合作、完整核算且累计贡献为正、近60天有核验订单及明确复合作意愿');}
    update('creator_profiles',profile.id,{tier:p.tier,...next(p,scope,users),...(p.tier==='paused'?{state:'paused',data_json:JSON.stringify({...data,resumeState:profile.state==='paused'?data.resumeState:profile.state,resumeTier:profile.tier==='paused'?data.resumeTier:profile.tier})}:{})});eventDetail={tier:p.tier,note:required(p.note,'分层依据'),evidence:evidence()};break;
   }
   default:fail('不支持的达人操作');
  }
 }
 put('creator_events',{id:id(),creator_id:profile?.id||null,round_id:round?.id||null,action,actor_id:actor.id,actor_name:actor.name,detail_json:JSON.stringify(eventDetail),created_at:now});
 const guard=guardStatement(db,actor,'creator.'+action,"COALESCE((SELECT version FROM creator_clock WHERE id='global'),0)=?",[clock?.version||0]);
 try{await atomicBatch(db,[guard,...statements]);}catch(e){if(/UNIQUE constraint/.test(String(e)))fail('达人、内容或凭据已登记，请刷新核对',409);throw e;}
 return {ok:true,id:resultId};
}
