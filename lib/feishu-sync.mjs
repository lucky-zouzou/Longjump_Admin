import {createFeishuClient} from './feishu-client.mjs';
import {getFeishuSettings,claimFeishuSyncRun,renewFeishuSyncRun,completeFeishuWindow,finishFeishuSyncRun,recordFeishuConnectionCheck} from './feishu-store.mjs';
import {day,fail,rows,clock} from './workplace-common.mjs';

export async function feishuCredentialIdentity(credentials){
 if(!credentials?.appId||!credentials?.appSecret)fail('飞书应用凭据尚未配置',503);
 const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([credentials.appId,credentials.appSecret])));
 return {appId:credentials.appId,configSource:[...new Uint8Array(bytes)].map(n=>n.toString(16).padStart(2,'0')).join('')};
}
const safeCode=e=>/^[a-zA-Z0-9_.-]{1,80}$/.test(String(e?.code||''))?String(e.code):e?.status===409?'sync_conflict':'sync_failed';
export function feishuSyncDates(input={},now=new Date()){
 const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(now);
 const to=day(input.to||today),from=day(input.from||new Date(Date.parse(to+'T00:00:00Z')-6*86400000).toISOString().slice(0,10));
 if(from>to||Date.parse(to)-Date.parse(from)>6*86400000)fail('每次同步请选择连续最多7天');
 if(from>today||to>today)fail('同步日期不能晚于今天');
 return {from,to};
}
export async function testFeishuConnection(db,credentials,{clientFactory=createFeishuClient,requireMappings=false}={}){
 const identity=await feishuCredentialIdentity(credentials),settings=await getFeishuSettings(db);
 if(settings.appId!==identity.appId)fail('私密凭据的 App ID 与后台配置不一致',409);
 try{
  const client=clientFactory(credentials),result=await client.testConnection();
  if(result.attendanceScope==='missing')throw Object.assign(Error('飞书应用缺少导出考勤数据权限'),{code:'attendance_scope_missing'});
  let checkedEmployees=0;
  if(requireMappings){
   const version=await clock(db),links=await rows(db,`SELECT l.*,w.timezone FROM feishu_user_links l JOIN users u ON u.id=l.user_id JOIN workplace_profiles p ON p.user_id=l.user_id JOIN workplace_units w ON w.id=l.unit_id WHERE l.active=1 AND l.app_id=? AND l.id_type=? AND u.active=1 AND p.active=1 AND w.active=1 AND p.unit_id=l.unit_id AND (u.site IS NULL OR u.site='' OR u.site=w.site)`,[settings.appId,settings.idType]);
   if(!links.length||links.length!==Number((await db.prepare('SELECT COUNT(*) n FROM feishu_user_links WHERE active=1').first()).n))fail('请先完成有效员工映射，再启用同步',409);
   const {to}=feishuSyncDates();
   for(const link of links){await client.readWindow({externalUserId:link.external_user_id,idType:link.id_type,timezone:link.timezone,from:to,to});checkedEmployees++;}
   if(await clock(db)!==version)fail('员工映射或权限已变化，请重新检查',409);
  }
  await recordFeishuConnectionCheck(db,{version:settings.version,...identity,ok:true});
  return {ok:true,authenticated:true,checkedEmployees,attendanceScope:result.attendanceScope||'unverified',message:checkedEmployees?'应用及已绑定员工的考勤接口已验证。':'应用凭据已验证；启用时还会逐一检查已绑定员工的数据读取权限。'};
 }catch(error){
  await recordFeishuConnectionCheck(db,{version:settings.version,...identity,ok:false,errorCode:safeCode(error)});
  throw error;
 }
}
async function prepare(db,credentials,input,options){
 const identity=await feishuCredentialIdentity(credentials),settings=await getFeishuSettings(db),dates=feishuSyncDates(input,options.now);
 const run=await claimFeishuSyncRun(db,{settingsVersion:settings.version,...identity,trigger:options.trigger||'manual',actorId:options.actorId||null,leaseSeconds:300});
 return {run,dates,settings,identity,trigger:options.trigger||'manual',today:feishuSyncDates({},options.now).to};
}
const addDays=(date,n)=>new Date(Date.parse(date+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);
// Previously imported older facts are revisited in bounded batches, including disappeared facts.
async function reconciliationWindow(db,link,before){
 const oldest=await db.prepare(`SELECT r.work_date,MAX(w.completed_at) checked_at FROM feishu_records r LEFT JOIN feishu_sync_windows w ON w.link_id=r.link_id AND w.kind=r.kind AND w.date_from<=r.work_date AND w.date_to>=r.work_date WHERE r.link_id=? AND r.work_date<? GROUP BY r.work_date HAVING MAX(w.completed_at)<? ORDER BY checked_at,r.work_date LIMIT 1`).bind(link.id,before,new Date(Date.now()-86400000).toISOString()).first();
 if(!oldest)return null;const from=link.syncFrom&&link.syncFrom>oldest.work_date?link.syncFrom:oldest.work_date,to=[addDays(from,6),addDays(before,-1)].sort()[0];
 return from<=to?{from,to}:null;
}
async function execute(db,credentials,job,{clientFactory=createFeishuClient,onFinished}={}){
 const {run,dates,today,trigger}=job,guard={runId:run.runId,leaseToken:run.leaseToken,settingsVersion:run.settingsVersion};
 let windows=0;
 try{
  const client=clientFactory(credentials);
  for(const link of run.links){
   await renewFeishuSyncRun(db,{...guard,leaseSeconds:300});
   const from=link.syncFrom&&link.syncFrom>dates.from?link.syncFrom:dates.from;
   if(from>dates.to)throw Object.assign(Error('所选期间早于该员工飞书映射生效日期'),{code:'before_mapping_effective_date'});
   const result=await client.readWindow({externalUserId:link.externalUserId,idType:link.idType,timezone:link.timezone,from,to:dates.to});
   // Both upstream queries finish before either fact stream is committed. No raw upstream payload is stored.
   for(const kind of ['attendance','leave']){
    await completeFeishuWindow(db,{...guard,linkId:link.id,linkVersion:link.version,kind,from,to:dates.to,complete:true,records:result[kind]});windows++;
   }
   await renewFeishuSyncRun(db,{...guard,leaseSeconds:300});
   const futureFrom=link.syncFrom&&link.syncFrom>today?link.syncFrom:today,futureTo=addDays(today,29);
   const leave=await client.readLeaveWindow({externalUserId:link.externalUserId,idType:link.idType,timezone:link.timezone,from:futureFrom,to:futureTo});
   await completeFeishuWindow(db,{...guard,linkId:link.id,linkVersion:link.version,kind:'leave',from:futureFrom,to:futureTo,complete:true,records:leave});windows++;
   const history=trigger==='scheduled'?await reconciliationWindow(db,link,dates.from):null;
   if(history){
    await renewFeishuSyncRun(db,{...guard,leaseSeconds:300});
    const old=await client.readWindow({externalUserId:link.externalUserId,idType:link.idType,timezone:link.timezone,...history});
    for(const kind of ['attendance','leave']){await completeFeishuWindow(db,{...guard,linkId:link.id,linkVersion:link.version,kind,...history,complete:true,records:old[kind]});windows++;}
   }
  }
  await finishFeishuSyncRun(db,{...guard,success:true});
  onFinished?.({success:true});return {ok:true,runId:run.runId,windows};
 }catch(error){
  try{await finishFeishuSyncRun(db,{...guard,success:false,errorCode:safeCode(error)});}catch{/* A configuration change or lease expiry already prevents further writes. */}
  onFinished?.({success:false});throw error;
 }
}
export async function runFeishuSync(db,credentials,input={},options={}){return execute(db,credentials,await prepare(db,credentials,input,options),options);}

// Node owns this background job. The persisted lease survives browser closes and prevents overlap.
export async function startFeishuSync(db,credentials,input={},options={}){
 const job=await prepare(db,credentials,input,options);
 const done=execute(db,credentials,job,options).catch(()=>{});
 options.waitUntil?.(done);
 return {ok:true,accepted:true,runId:job.run.runId,...job.dates};
}
