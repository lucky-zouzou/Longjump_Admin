import {assertWritable,atomicBatch,guardStatement} from './atomic.mjs';
import {canCreatorProfile} from './creator-policy.mjs';
import {fail,instant,integer,required,txt} from './creator-model.mjs';
import {validatePlaybookReference} from './creator-assets.mjs';

export const requestActions=['requestCreate','requestEdit','requestAccept','requestConfirm','requestCancel'];
const currencyBySite={印尼:'IDR',越南:'VND',菲律宾:'PHP',泰国:'THB',马来西亚:'MYR'};

async function requestTerms(db,p,now,site,profile){
 if(!Array.isArray(p.items)||!p.items.length||p.items.length>100)fail('请选择1至100个合作SKU');
 const items=[],seen=new Set();
 for(const item of p.items){
  const sku=required(item?.sku,'合作SKU',150);
  if(seen.has(sku)||!await db.prepare('SELECT sku FROM sku_settings WHERE sku=?').bind(sku).first())fail('合作SKU重复或不存在');
  seen.add(sku);items.push({sku,sampleQty:integer(item.sampleQty,'约定样品数量',0,10000)});
 }
 const dueAt=instant(p.dueAt,'交付期限');
 if(dueAt<=now)fail('请填写未来的交付期限');
 if(!['commission','paid','mixed'].includes(p.method))fail('请选择合作方式');
 const commission=required(p.commission,'佣金比例',16);
 if(!/^\d{1,3}(\.\d{1,2})?$/.test(commission)||Number(commission)>100)fail('佣金比例应在0至100之间，最多两位小数');
 const videos=integer(p.videos,'视频数',0,1000),lives=integer(p.lives,'直播场次',0,1000);
 if(!videos&&!lives)fail('请至少约定一项交付');
 return {items,sku:items.map(i=>i.sku).join(' / '),sampleQty:items.reduce((n,i)=>n+i.sampleQty,0),dueAt,method:p.method,commission,contact:required(JSON.parse(profile.data_json||'{}').contact,'达人档案联系方式，请先到档案补全'),videos,lives,currency:currencyBySite[site],budgetMinor:null,requirements:txt(p.requirements),promotion:txt(p.promotion),cooperationNote:txt(p.cooperationNote),...await validatePlaybookReference(db,p)};
}

export async function readRequests(db,profiles){
 const ids=new Set(profiles.map(p=>p.id));
 const rows=(await db.prepare('SELECT q.*,r.status AS round_status FROM creator_requests q LEFT JOIN creator_rounds r ON r.id=q.round_id ORDER BY q.updated_at DESC,q.id').all()).results;
 return rows.filter(q=>ids.has(q.creator_id)).map(({terms_json,round_status,...q})=>({...q,state:['completed','cancelled'].includes(round_status)?round_status:q.state,terms:JSON.parse(terms_json)}));
}
export function requestTasks(requests,profiles,actor){
 if(!['管理员','达人BD'].includes(actor.role))return [];
 const people=new Map(profiles.map(p=>[p.id,p]));
 return requests.filter(q=>['pending','following'].includes(q.state)).map(q=>{
  const p=people.get(q.creator_id);
  return {kind:'request',id:p.id,requestId:q.id,title:q.state==='pending'?'接收合作需求':'联系达人确认条件',name:p.name,site:p.site,dueAt:q.terms.dueAt,overdue:Date.parse(q.terms.dueAt)<Date.now()};
 });
}
export async function mutateRequest(db,actor,p){
 await assertWritable(db);
 const user=await db.prepare('SELECT active,role FROM users WHERE id=?').bind(actor.id).first();
 if(!user?.active||user.role!==actor.role)fail('账号岗位已变化',403);
 const clock=await db.prepare("SELECT version FROM creator_clock WHERE id='global'").first();
 const now=new Date().toISOString(),statements=[];
 const sql=(s,...args)=>statements.push(db.prepare(s).bind(...args));
 const event=(q,detail)=>sql('INSERT INTO creator_events(id,creator_id,action,actor_id,actor_name,detail_json,created_at) VALUES(?,?,?,?,?,?,?)',crypto.randomUUID(),q.creator_id,p.action,actor.id,actor.name,JSON.stringify({requestId:q.id,...detail}),now);
 const selection=p.action==='requestAccept'&&p.selection?p.selection:[p];
 if(!Array.isArray(selection)||!selection.length||selection.length>50||new Set(selection.map(x=>x?.requestId)).size!==selection.length)fail('每次接收1至50条不同需求');
 let resultId;
 for(const item of selection){
  const id=required(item.requestId,'需求编号',80),q=await db.prepare('SELECT * FROM creator_requests WHERE id=?').bind(id).first();
  const creatorId=p.action==='requestCreate'?required(p.creatorId,'达人档案'):q?.creator_id;
  if(!creatorId)fail('需求不存在',404);
  const profile=await db.prepare('SELECT * FROM creator_profiles WHERE id=?').bind(creatorId).first();
  const scope=profile&&await db.prepare('SELECT * FROM creator_scopes WHERE id=?').bind(profile.scope_id).first();
  if(!profile||!canCreatorProfile(actor,profile,scope))fail('没有该达人的处理权限',403);
  if(['requestCreate','requestEdit'].includes(p.action)&&!['运营','达人BD'].includes(actor.role))fail('仅负责运营或BD可发起或修改需求',403);
  if(['requestAccept','requestConfirm'].includes(p.action)&&actor.role!=='达人BD')fail('仅BD可接收或确认合作',403);
  if(profile.state==='paused'&&p.action!=='requestCancel')fail('达人档案已暂停');
  if(p.action!=='requestCreate'&&Number(item.version)!==q.version)fail('需求已更新，请刷新后核对最新条件',409);
  if(p.action==='requestCreate'){
   const terms=await requestTerms(db,p,now,scope.site,profile);
   if(p.submissionId){
    if(!await db.prepare("SELECT id FROM creator_submissions WHERE id=? AND creator_id=? AND status='accepted'").bind(p.submissionId,creatorId).first())fail('来源移交与达人不匹配');
    terms.submissionId=p.submissionId;
   }
   if(q){if(q.creator_id===creatorId&&q.author_id===actor.id&&JSON.stringify(terms)===q.terms_json)return {ok:true,id};fail('需求编号已使用',409);}
   sql("INSERT INTO creator_requests(id,creator_id,author_id,state,terms_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",id,creatorId,actor.id,actor.role==='达人BD'?'following':'pending',JSON.stringify(terms),now,now);
   event({id,creator_id:creatorId},{terms});resultId=id;continue;
  }
  const terms=JSON.parse(q.terms_json);
  let state=q.state,newTerms=terms,roundId=q.round_id,detail={};
  if(p.action==='requestEdit'){
   if(q.author_id!==actor.id||!['pending','following'].includes(state))fail('仅发起人可修改尚未确认执行的需求',403);
   newTerms=await requestTerms(db,p,now,scope.site,profile);
   if(terms.submissionId)newTerms.submissionId=terms.submissionId;
   detail={before:terms,after:newTerms};
  }else if(p.action==='requestAccept'){
   if(state!=='pending')fail('需求已处理，请刷新',409);state='following';
   sql('UPDATE creator_profiles SET last_follow_at=?,updated_at=?,version=version+1 WHERE id=?',now,now,creatorId);
  }else if(p.action==='requestConfirm'){
   if(state!=='following'||q.round_id)fail('请先接收需求；每条需求只生成一轮合作',409);
   if(terms.dueAt<=now)fail('交期已过，请运营先更新需求');
   if(p.confirmed!==true)fail('请确认已与达人核对本版条件');
   state='executing';roundId=crypto.randomUUID();
   const roundNo='BD-'+now.slice(0,10).replaceAll('-','')+'-'+roundId.slice(0,8).toUpperCase();
   sql("INSERT INTO creator_rounds(id,creator_id,round_no,status,terms_json,original_due_at,effective_due_at,author_id,approved_at,created_at,updated_at) VALUES(?,?,?,'executing',?,?,?,?,?,?,?)",roundId,creatorId,roundNo,JSON.stringify({...terms,requestId:id,confirmedBy:actor.id}),terms.dueAt,terms.dueAt,q.author_id,now,now,now);
   sql("UPDATE creator_profiles SET state='fulfilling',last_follow_at=?,updated_at=?,version=version+1 WHERE id=?",now,now,creatorId);detail={roundId,terms};
  }else if(p.action==='requestCancel'){
   if(!(state==='pending'&&actor.role==='运营'&&actor.id===q.author_id||['pending','following'].includes(state)&&actor.role==='达人BD'))fail('当前不能撤回或取消该需求',403);
   state='cancelled';detail={note:required(p.note,'取消原因')};
  }
  sql('UPDATE creator_requests SET state=?,terms_json=?,round_id=?,updated_at=?,version=version+1 WHERE id=?',state,JSON.stringify(newTerms),roundId,now,id);
  event(q,{...detail,state});resultId=id;
 }
 await atomicBatch(db,[guardStatement(db,actor,'creator.'+p.action,"COALESCE((SELECT version FROM creator_clock WHERE id='global'),0)=?",[clock?.version||0]),...statements]);
 return {ok:true,id:resultId};
}
