import {practiceFile} from './creator-practice-file.mjs';
import {atomicBatch,assertWritable,guardStatement} from './atomic.mjs';
import {fail,required,txt,link,instant,integer,minor} from './creator-model.mjs';
import {creatorActor,canCreatorScope,canCreatorProfile,canManageBd,canReviewExperience,canDeliverCreator} from './creator-policy.mjs';
import {bdGrades,experienceCategories,intakeDate} from './creator-intake-model.mjs';
const all=async(db,sql,args=[])=>(await db.prepare(sql).bind(...args).all()).results;
export const managementActions=['bdName','practiceUse','leadAssignment','bdMaintain','roundResult','practiceCreate','practiceRevise','practiceReview','practiceArchive'];
export async function readCreatorManagement(db,actor,out){
 const profileIds=new Set(out.profiles.map(p=>p.id)),roundIds=new Set(out.rounds.map(r=>r.id)),scopeIds=new Set(out.scopes.map(s=>s.id));
 const practices=(await all(db,'SELECT p.*,s.site,s.platform,u.name AS author_name FROM creator_practices p JOIN creator_scopes s ON s.id=p.scope_id JOIN users u ON u.id=p.author_id ORDER BY p.updated_at DESC')).filter(r=>r.status==='approved'||canReviewExperience(actor)||r.author_id===actor.id&&scopeIds.has(r.scope_id)).map(r=>({...r,data:JSON.parse(r.data_json)}));
 const practiceIds=new Set(practices.filter(r=>scopeIds.has(r.scope_id)||canReviewExperience(actor)||r.author_id===actor.id).map(r=>r.id));
 const practiceUses=(await all(db,'SELECT m.practice_id,m.revision,m.kind,s.site FROM creator_practice_uses m JOIN creator_scopes s ON s.id=m.scope_id')).filter(m=>practices.some(r=>r.id===m.practice_id));
 return {practiceUses,dossierLinks:(await all(db,'SELECT * FROM creator_dossier_links')).filter(l=>profileIds.has(l.profile_id)),
 results:(await all(db,'SELECT * FROM creator_round_results ORDER BY revision DESC')).filter(r=>roundIds.has(r.round_id)).map(r=>({...r,data:JSON.parse(r.data_json)})),
 practices,practiceHistory:(await all(db,'SELECT * FROM creator_practice_history ORDER BY created_at DESC,revision DESC')).filter(r=>practiceIds.has(r.practice_id)).map(r=>({...r,snapshot:JSON.parse(r.snapshot_json)})),
 assignmentEvents:canManageBd(actor)?(await all(db,"SELECT * FROM creator_events WHERE creator_id IS NULL AND action IN ('scope','leadAssignment') ORDER BY created_at DESC LIMIT 100")).map(r=>({...r,detail:JSON.parse(r.detail_json)})):[],
 leads:canManageBd(actor)?await all(db,'SELECT * FROM creator_leads'):[]};
}
export async function mutateCreatorManagement(db,actor,p){
 actor=await creatorActor(db,actor);await assertWritable(db);
 const clock=await db.prepare("SELECT version FROM creator_clock WHERE id='global'").first(),now=new Date().toISOString(),statements=[];
 const users=await all(db,'SELECT id,name,role,active FROM users');
 if(!users.some(u=>u.id===actor.id&&u.active&&u.role===actor.role))fail('账号岗位已变化，请重新登录',403);
 const put=(table,v)=>statements.push(db.prepare(`INSERT INTO ${table} (${Object.keys(v).join(',')}) VALUES (${Object.keys(v).map(()=>'?').join(',')})`).bind(...Object.values(v)));
 const update=(table,id,v)=>statements.push(db.prepare(`UPDATE ${table} SET ${Object.keys(v).map(k=>k+'=?').join(',')},version=version+1,updated_at=? WHERE id=?`).bind(...Object.values(v),now,id));
 const event=(creatorId,detail)=>put('creator_events',{id:crypto.randomUUID(),creator_id:creatorId,action:p.action,actor_id:actor.id,actor_name:actor.name,detail_json:JSON.stringify(detail),created_at:now});
 const validBd=id=>users.some(u=>u.id===id&&u.active&&u.role==='达人BD');let result={ok:true};
 if(p.action==='bdName'){
  if(actor.role!=='管理员')fail('仅管理员可校正BD显示姓名',403);
  let userId=p.userId;
  if(p.loginEmail!==undefined){
   const email=required(p.loginEmail,'后台登录邮箱',254).toLowerCase();
   const matches=await all(db,'SELECT id FROM users WHERE lower(trim(email))=?',[email]);
   if(matches.length!==1||(userId&&userId!==matches[0].id))fail('登录邮箱未唯一匹配选定账号，请核对',409);
   userId=matches[0].id;
  }
  if(!validBd(userId))fail('请选择已启用的达人BD账号',403);
  const name=required(p.displayName,'正确姓名',80);
  const previous=await db.prepare('SELECT display_name FROM creator_bd_names WHERE user_id=?').bind(userId).first();
  if(previous?.display_name===name)return {ok:true};
  statements.push(db.prepare('INSERT INTO creator_bd_names(user_id,display_name) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET display_name=excluded.display_name').bind(userId,name));
  event(null,{userId,name});
 }else if(p.action==='practiceUse'){
  const row=await db.prepare("SELECT id,version,status FROM creator_practices WHERE id=?").bind(txt(p.practiceId)).first();
  const scope=await db.prepare("SELECT * FROM creator_scopes WHERE id=?").bind(txt(p.scopeId)).first();
  if(!canCreatorScope(actor,scope)||!['运营','达人BD','管理员'].includes(actor.role))fail('没有该店铺使用权限',403);
  if(row?.status!=='approved'||row.version!==Number(p.version)||!['read','used'].includes(p.kind))fail('请核对已审核经验版本与使用方式',409);
  statements.push(db.prepare("INSERT INTO creator_practice_uses(practice_id,scope_id,actor_id,revision,kind,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(practice_id,scope_id,actor_id,revision) DO UPDATE SET kind=CASE WHEN kind='used' THEN kind ELSE excluded.kind END,updated_at=excluded.updated_at").bind(row.id,scope.id,actor.id,row.version,p.kind,now));
 }else if(p.action==='leadAssignment'){
  if(actor.role!=='管理员')fail('仅管理员可设置BD组长',403);
  if(!validBd(p.userId)||typeof p.active!=='boolean')fail('请选择有效BD账号及组长状态');
  const note=required(p.note,'设置依据');statements.push(db.prepare('INSERT INTO creator_leads(user_id,active,updated_at) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET active=excluded.active,updated_at=excluded.updated_at').bind(p.userId,p.active?1:0,now));event(null,{userId:p.userId,active:p.active,note});
 }else if(['bdMaintain','roundResult'].includes(p.action)){
  const profile=await db.prepare('SELECT * FROM creator_profiles WHERE id=?').bind(txt(p.creatorId)).first();if(!profile)fail('达人档案不存在',404);
  const scope=await db.prepare('SELECT * FROM creator_scopes WHERE id=?').bind(profile.scope_id).first();
  if(!canCreatorProfile(actor,profile,scope))fail('没有该达人权限',403);
  if(p.action==='bdMaintain'){
   if(!canManageBd(actor)&&!(actor.role==='达人BD'&&(profile.owner_bd_id||scope.bd_id)===actor.id))fail('仅组长或负责BD可维护',403);
   if(Number(p.version)!==profile.version)fail('档案已更新，请刷新',409);
   if(!bdGrades[p.grade])fail('请选择BD评级');const owner=p.ownerId||profile.owner_bd_id||scope.bd_id;
   if(!validBd(owner)||!canManageBd(actor)&&owner!==(profile.owner_bd_id||scope.bd_id))fail('仅组长或管理员可调整BD负责人',403);
   const note=txt(p.note),intent=txt(p.intent),values={bd_grade:p.grade,owner_bd_id:owner,last_follow_at:now,...(note||intent?{data_json:JSON.stringify({...JSON.parse(profile.data_json),...(intent?{bdIntent:intent}:{}),...(note?{bdNote:note}:{})})}:{})};
   if(p.stage){if(!profile.accepted_at||!['deep_ready','communicating'].includes(p.stage))fail('仅已接收达人可调整沟通阶段');values.bd_stage=p.stage;}
   if(p.accept===true){if(p.qualified!==true)fail('请确认已合作出单及移交依据');if(profile.accepted_at)fail('达人已经接收');values.accepted_at=now;values.state='negotiating';values.bd_stage='deep_ready';}
   if(p.nextAt||owner!==(profile.owner_bd_id||scope.bd_id)){values.next_at=instant(p.nextAt,'下次跟进时间');if(values.next_at<=now)fail('下次跟进须晚于现在');values.next_owner_id=owner;values.next_action=required(p.nextAction,'下一步行动');}
   update('creator_profiles',profile.id,values);event(profile.id,{grade:p.grade,owner,intent,note,accepted:p.accept===true,stage:values.bd_stage||profile.bd_stage,nextAt:values.next_at});
  }else{
   if(!canDeliverCreator(actor,profile))fail('仅运营或负责BD可登记合作效果',403);
   const round=await db.prepare('SELECT * FROM creator_rounds WHERE id=? AND creator_id=?').bind(txt(p.roundId),profile.id).first();if(!round||round.status!=='completed')fail('本轮完成履约后登记效果');if(Number(p.version)!==round.version)fail('合作已更新，请刷新',409);
   const from=intakeDate(p.from,'统计起始日'),to=intakeDate(p.to,'统计结束日');if(to<from||to>now.slice(0,10))fail('统计日期范围无效');
   if(!['CNY','IDR','MYR','THB','VND','PHP','USD'].includes(p.currency))fail('请选择原币种');
   const data={from,to,currency:p.currency,orders:p.orders==null||p.orders===''?null:integer(p.orders,'订单量'),gmvMinor:p.gmv==null||p.gmv===''?null:minor(p.gmv,'销售额'),costMinor:p.cost==null||p.cost===''?null:minor(p.cost,'合作成本'),evaluation:required(p.evaluation,'合作评价'),nextPlan:required(p.nextPlan,'后续计划'),evidence:link(p.evidence),basis:'BD/运营自报，非财务核验贡献'};
   const prior=await db.prepare('SELECT MAX(revision) n FROM creator_round_results WHERE round_id=?').bind(round.id).first();
   if(Number(p.resultRevision||0)!==Number(prior?.n||0))fail('效果已修订，请刷新后再保存',409);
   put('creator_round_results',{id:crypto.randomUUID(),round_id:round.id,revision:(prior?.n||0)+1,data_json:JSON.stringify(data),actor_id:actor.id,actor_name:actor.name,created_at:now});event(profile.id,{roundId:round.id,revision:(prior?.n||0)+1,...data});
  }
 }else{
  let row=null;if(p.action!=='practiceCreate'){row=await db.prepare('SELECT * FROM creator_practices WHERE id=?').bind(txt(p.practiceId)).first();if(!row)fail('经验不存在',404);if(Number(p.version)!==row.version)fail('经验已更新，请刷新',409);}
  const scopeId=row?.scope_id||p.scopeId,scope=await db.prepare('SELECT * FROM creator_scopes WHERE id=?').bind(txt(scopeId)).first();
  let values,action=p.action;
  if(['practiceCreate','practiceRevise'].includes(action)){
   if(!['运营','达人BD','管理员'].includes(actor.role)||!canCreatorScope(actor,scope))fail('没有经验录入权限',403);
   if(row&&(row.author_id!==actor.id||!['pending','returned','approved'].includes(row.status)))fail('仅作者可修订有效经验',403);
   if(!experienceCategories[p.category]||p.shareConfirmed!==true)fail('请选择分类并确认可共享');
   const file=practiceFile(p.file),attachment=file?{id:file.id,name:file.filename}:row&&JSON.parse(row.data_json).attachment||null;
   values={title:required(p.title,'经验标题',160),category:p.category,status:'pending',reviewer_id:null,data_json:JSON.stringify({scene:required(p.scene,'适用场景'),method:required(p.method,'可复制做法'),effect:txt(p.effect),limits:txt(p.limits),evidence:p.evidence?link(p.evidence):'',attachment,shareConfirmed:true})};
   if(!row){row={id:crypto.randomUUID(),version:0};put('creator_practices',{id:row.id,scope_id:scopeId,...values,author_id:actor.id,created_at:now,updated_at:now});}else update('creator_practices',row.id,values);
   if(file)put('creator_practice_files',{...file,practice_id:row.id});
  }else{
   if(!canReviewExperience(actor))fail('仅BD组长或管理员、运营主管可审核经验',403);
   if(row.author_id===actor.id)fail('本人经验须由其他审核人审核',403);
   if(action==='practiceReview'&&!['pending','returned'].includes(row.status)||action==='practiceArchive'&&row.status!=='approved')fail('当前经验状态不可执行该操作');
   if(action==='practiceReview'&&!['approve','return'].includes(p.decision))fail('请选择审核决定');
   values={status:action==='practiceArchive'?'archived':p.decision==='approve'?'approved':'returned',reviewer_id:actor.id,data_json:JSON.stringify({...JSON.parse(row.data_json),reviewNote:required(p.note,'审核说明')})};update('creator_practices',row.id,values);
  }
  put('creator_practice_history',{id:crypto.randomUUID(),practice_id:row.id,revision:row.version+1,action,actor_id:actor.id,actor_name:actor.name,snapshot_json:JSON.stringify({...values,data:JSON.parse(values.data_json)}),created_at:now});result.id=row.id;
 }
 await atomicBatch(db,[guardStatement(db,actor,'creator.'+p.action,"COALESCE((SELECT version FROM creator_clock WHERE id='global'),0)=?",[clock?.version||0]),...statements]);return result;
}
