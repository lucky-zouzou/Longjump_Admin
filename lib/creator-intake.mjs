import {atomicBatch,assertWritable,guardStatement} from './atomic.mjs';
import {fail,required,link,instant,creatorZones} from './creator-model.mjs';
import {normalizeIntake,intakeStatuses} from './creator-intake-model.mjs';

const all=async(db,sql,args=[])=> (await db.prepare(sql).bind(...args).all()).results;
const scopeAccess=(a,s)=>['管理员','财务','运营主管'].includes(a.role)||(a.role==='达人BD'&&s.bd_id===a.id)||(a.role==='运营'&&[s.operator_id,s.backup_id].includes(a.id));
const hash=async data=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(data))))).map(b=>b.toString(16).padStart(2,'0')).join('');
export const intakeActions=['intakePreview','intakeSubmit','intakeReview','intakeRevise'];
export async function readCreatorIntake(db,actor,scopes){
 const ids=new Set(scopes.map(s=>s.id));
 const rounds=(await all(db,"SELECT id,round_no,creator_id,status,terms_json FROM creator_rounds WHERE status<>'cancelled'")).map(r=>({...r,terms:JSON.parse(r.terms_json)}));
 const profiles=await all(db,'SELECT id,accepted_at FROM creator_profiles');
 const submissions=(await all(db,'SELECT * FROM creator_submissions ORDER BY updated_at DESC')).filter(r=>ids.has(r.scope_id)).map(r=>{const linked=rounds.find(v=>v.creator_id===r.creator_id&&v.terms.submissionId===r.id);return {...r,data:JSON.parse(r.data_json),review:JSON.parse(r.review_json),scope:scopes.find(s=>s.id===r.scope_id),linkedRound:linked?{id:linked.id,round_no:linked.round_no,status:linked.status}:null,bdAccepted:!!profiles.find(p=>p.id===r.creator_id)?.accepted_at};});
 const visible=new Set(submissions.map(r=>r.id));
 const submissionHistory=(await all(db,'SELECT * FROM creator_submission_history ORDER BY created_at DESC,revision DESC')).filter(r=>visible.has(r.submission_id)).map(r=>({...r,snapshot:JSON.parse(r.snapshot_json)}));
 return {submissions,submissionHistory};
}
export async function mutateCreatorIntake(db,actor,p){
 await assertWritable(db);
 const clock=await db.prepare("SELECT version FROM creator_clock WHERE id='global'").first();
 const users=await all(db,'SELECT id,name,role,active FROM users');
 if(!users.some(u=>u.id===actor.id&&u.role===actor.role&&u.active))fail('账号岗位已变化，请重新登录',403);
 const now=new Date().toISOString(),scopes=(await all(db,'SELECT * FROM creator_scopes')).filter(s=>scopeAccess(actor,s)),statements=[];
 const put=(table,values)=>{const keys=Object.keys(values);statements.push(db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(()=>'?').join(',')})`).bind(...Object.values(values)));};
 const scopeFor=id=>{const scope=scopes.find(s=>s.id===id);if(!scope)fail('没有该店铺的协作权限',403);return scope;};
 const normalize=(row,s)=>{if(row.site&&row.site!==s.site)fail('国家与所选店铺不一致');const today=new Date(Date.now()+Number(creatorZones[s.site].slice(1,3))*3600000).toISOString().slice(0,10);return normalizeIntake(row,today);};
 const history=(id,revision,action,snapshot)=>put('creator_submission_history',{id:crypto.randomUUID(),submission_id:id,revision,action,actor_id:actor.id,actor_name:actor.name,snapshot_json:JSON.stringify(snapshot),created_at:now});
 const update=(table,id,values)=>statements.push(db.prepare(`UPDATE ${table} SET ${Object.keys(values).map(k=>k+'=?').join(',')},version=version+1,updated_at=? WHERE id=?`).bind(...Object.values(values),now,id));
 let result;
 if(['intakePreview','intakeSubmit'].includes(p.action)){
  if(!['管理员','运营'].includes(actor.role))fail('仅运营或管理员可提交运营资料',403);
  if(!Array.isArray(p.rows)||!p.rows.length||p.rows.length>50)fail('每批提交1至50行，请分批导入');
  const checked=[],seen=new Map();
  for(const [index,row] of p.rows.entries()){
   try{
    const s=scopeFor(row.scopeId),data=normalize(row,s),fingerprint=await hash(data);
    const sourceId=actor.role==='运营'?actor.id:p.sourceUserId||s.operator_id;
    if(![s.operator_id,s.backup_id].includes(sourceId)||!users.some(u=>u.id===sourceId&&u.role==='运营'&&u.active))fail('来源运营须为店铺有效负责人');
    const duplicate=await db.prepare('SELECT id FROM creator_submissions WHERE scope_id=? AND fingerprint=?').bind(s.id,fingerprint).first();
    const batchKey=s.id+':'+fingerprint,duplicateId=duplicate?.id||seen.get(batchKey)||null;
    const creator=await db.prepare('SELECT id FROM creator_profiles WHERE scope_id=? AND platform_id=?').bind(s.id,data.platformId).first();
    const recordId=duplicateId||crypto.randomUUID();seen.set(batchKey,recordId);
    checked.push({row:index+1,id:recordId,scopeId:s.id,sourceId,data,fingerprint,creatorId:creator?.id||null,status:duplicateId?'duplicate':'ready',message:duplicateId?'相同资料已接收，跳过重复提交':creator?'关联现有达人，不覆盖档案':'新达人资料，接收时补齐档案'});
   }catch(e){checked.push({row:index+1,status:'error',message:e.message});}
  }
  if(p.action==='intakePreview')return {ok:true,rows:checked.map(({fingerprint,...r})=>r)};
  const bad=checked.filter(r=>r.status==='error');if(bad.length)fail(bad.map(r=>`第${r.row}行：${r.message}`).join('；'));
  for(const r of checked.filter(r=>r.status==='ready')){
   put('creator_submissions',{id:r.id,scope_id:r.scopeId,creator_id:r.creatorId,platform_id:r.data.platformId,submitted_on:r.data.submittedOn,request_kind:r.data.requestKind,submitter_id:r.sourceId,submitted_by:actor.id,status:'pending',data_json:JSON.stringify(r.data),review_json:'{}',fingerprint:r.fingerprint,created_at:now,updated_at:now});
   history(r.id,1,'submitted',{data:r.data,sourceUserId:r.sourceId});
  }
  result={ok:true,created:checked.filter(r=>r.status==='ready').length,duplicates:checked.filter(r=>r.status==='duplicate').length};
 }else{
  const row=await db.prepare('SELECT * FROM creator_submissions WHERE id=?').bind(required(p.submissionId,'提交记录')).first();if(!row)fail('提交记录不存在',404);
  const scope=scopeFor(row.scope_id);if(Number(p.version)!==row.version)fail('提交已更新，请刷新后重试',409);
  const data=JSON.parse(row.data_json);
  if(p.action==='intakeRevise'){
   if(!['管理员','运营'].includes(actor.role)||row.status!=='returned')fail('仅待补充记录可由运营修订',403);
   const updated=normalize({...p.data,scopeId:row.scope_id},scope);
   if(updated.platformId!==row.platform_id||updated.submittedOn!==row.submitted_on||updated.requestKind!==row.request_kind)fail('修订不能改变达人、创建日期或需求类型');
   const reason=required(p.note,'补充说明');update('creator_submissions',row.id,{status:'pending',data_json:JSON.stringify(updated),review_json:'{}'});history(row.id,row.version+1,'revised',{data:updated,reason});
  }else if(p.action==='intakeReview'){
   if(!['管理员','达人BD'].includes(actor.role))fail('仅负责BD或管理员可处理提交',403);
   if(!['pending','queued'].includes(row.status))fail('当前记录不在待处理队列');
   if(!['accepted','returned','queued'].includes(p.decision))fail('请选择接收、退回或安排跟进');
   const reason=required(p.note,'处理意见'),nextAt=instant(p.nextAt,'下次跟进时间');if(nextAt<=now)fail('下次跟进须晚于现在');
   const owner=p.decision==='returned'?scope.operator_id:scope.bd_id;
   if(!users.some(u=>u.id===owner&&u.active))fail('店铺负责人已停用，请先调整分工');
   const review={reason,nextAt,nextOwner:owner,nextAction:required(p.nextAction,'下一步行动'),actorId:actor.id,actorName:actor.name,at:now};
   let creator=await db.prepare('SELECT * FROM creator_profiles WHERE scope_id=? AND platform_id=?').bind(scope.id,row.platform_id).first();
   if(p.decision==='accepted'&&!creator){
    // Incomplete imported rows are retained in the queue until genuinely completed.
    const detail={profileUrl:data.profileUrl,contact:required(p.contact||data.contact,'联系方式'),language:required(p.language||data.language,'沟通语言'),fit:required(p.fit||data.reason,'匹配依据'),evidence:link(p.evidence||data.evidence,'档案佐证')};
    const name=required(p.name||data.name,'达人名称',120),kind=p.kind||data.kind;if(!['video','live','both'].includes(kind))fail('请补齐达人类型');
    const asset=await db.prepare('SELECT id FROM creator_assets WHERE site=? AND platform=? AND platform_id=?').bind(scope.site,scope.platform,row.platform_id).first();
    if(!asset)put('creator_assets',{id:crypto.randomUUID(),site:scope.site,platform:scope.platform,platform_id:row.platform_id,data_json:'{}',created_at:now,updated_at:now});
    creator={id:crypto.randomUUID()};put('creator_profiles',{id:creator.id,scope_id:scope.id,platform_id:row.platform_id,name,kind,source_user_id:row.submitter_id,next_at:nextAt,next_owner_id:scope.operator_id,next_action:'核实合作意向，再提交合作条件或交接BD',data_json:JSON.stringify(detail),created_at:now,updated_at:now});
    put('creator_events',{id:crypto.randomUUID(),creator_id:creator.id,action:'intakeCreate',actor_id:actor.id,actor_name:actor.name,detail_json:JSON.stringify({submissionId:row.id,note:'运营提交补齐资料后建档，原始来源运营保留'}),created_at:now});
   }
   update('creator_submissions',row.id,{status:p.decision,creator_id:creator?.id||row.creator_id,review_json:JSON.stringify(review)});
   history(row.id,row.version+1,p.decision,{data,review,creatorId:creator?.id||row.creator_id});
  }else fail('无效提交操作');
  result={ok:true,id:row.id};
 }
 if(statements.length){const guard=guardStatement(db,actor,'creator.'+p.action,"COALESCE((SELECT version FROM creator_clock WHERE id='global'),0)=?",[clock?.version||0]);try{await atomicBatch(db,[guard,...statements]);}catch(e){if(/UNIQUE constraint/.test(String(e)))fail('相同提交或达人已存在，请刷新核对',409);throw e;}}
 return result;
}

export function intakeTasks(submissions,actor){return submissions.filter(r=>(r.status!=='accepted'||r.request_kind!=='profile'&&!r.linkedRound&&!(r.request_kind==='maintenance'&&r.bdAccepted))&&(actor.role==='管理员'||(r.status==='returned'?[r.scope.operator_id,r.scope.backup_id].includes(actor.id):r.scope.bd_id===actor.id))).map(r=>({id:r.creator_id||'',submissionId:r.id,title:intakeStatuses[r.status]+' · @'+r.platform_id,name:r.data.name||r.platform_id,site:r.scope.site,dueAt:r.review.nextAt||r.created_at,overdue:!!r.review.nextAt&&Date.parse(r.review.nextAt)<Date.now()}));}
