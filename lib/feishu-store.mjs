import {rows,fail,text,day,context,clock,has,manager,write,event} from './workplace-common.mjs';
import {atomicBatch,assertWritable,guardStatement} from './atomic.mjs';

const types=['employee_id','employee_no'];
const kinds=['attendance','leave'];
const at=(now=new Date())=>new Date(now).toISOString();
const digest=async value=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))].map(x=>x.toString(16).padStart(2,'0')).join('');
const errorCode=value=>String(value||'sync_failed').replace(/[^a-zA-Z0-9_.-]/g,'_').slice(0,80);
const mapping=r=>({id:r.id,version:r.version,userId:r.user_id,externalUserId:r.external_user_id,idType:r.id_type,unitId:r.unit_id,appId:r.app_id,active:Boolean(r.active),activatedAt:r.activated_at,name:r.name,unitName:r.unit_name});
const latest='NOT EXISTS(SELECT 1 FROM feishu_records newer WHERE newer.link_id=r.link_id AND newer.kind=r.kind AND newer.source_id=r.source_id AND newer.revision>r.revision)';
const settingsRow=db=>db.prepare("SELECT * FROM feishu_settings WHERE id='global'").first();
const stateRow=db=>db.prepare("SELECT * FROM feishu_sync_state WHERE id='global'").first();
function settings(r,s={}){return {enabled:Boolean(r.enabled),version:r.version,appId:r.app_id,idType:r.id_type,connectionStatus:r.connection_status,connectionCheckedAt:r.connection_checked_at,connectionVersion:r.connection_version,enabledAt:r.enabled_at,lastSuccessAt:s.last_success_at||null,lastAttemptAt:s.last_attempt_at||null,lastError:s.last_error||r.connection_error||'',running:Boolean(s.run_id&&s.lease_until>at())};}
export async function getFeishuSettings(db){return settings(await settingsRow(db),await stateRow(db));}
async function adminContext(db,actor){const c=await context(db,actor);if(c.a.role!=='管理员')fail('仅管理员配置飞书同步',403);return c;}
async function workerWrite(db,condition,args,statements){await assertWritable(db);try{return await atomicBatch(db,[guardStatement(db,{id:'feishu-sync'},'feishu.sync',condition,args),...statements]);}catch(e){if(/UNIQUE constraint|FOREIGN KEY constraint/i.test(String(e)))fail('同步记录或映射已变化，请重新同步',409);throw e;}}

export async function saveFeishuSettings(db,actor,p,credentials={}){
 const c=await adminContext(db,actor),old=await settingsRow(db);if(Number(p.version)!==old.version)fail('飞书配置版本已变化',409);
 const appId=text(p.appId??old.app_id,'飞书 App ID',120),idType=p.idType??old.id_type,enabled=p.enabled===true,reason=text(p.reason,'配置依据',500);
 if(!types.includes(idType))fail('飞书员工编号类型无效');
 if(appId!==old.app_id&&await db.prepare('SELECT id FROM feishu_user_links LIMIT 1').first())fail('已有飞书身份映射，不可切换应用或企业',409);
 if(idType!==old.id_type&&await db.prepare('SELECT id FROM feishu_user_links LIMIT 1').first())fail('已有历史飞书身份映射，本期不支持更换编号类型，请核对迁移方案',409);
 const verified=old.connection_status==='passed'&&old.connection_version===old.version&&old.connection_app_id===appId&&old.id_type===idType;
 if(enabled&&(!verified||credentials.appId!==appId||!credentials.configSource||credentials.configSource!==old.config_source))fail('请先用当前应用和凭据完成连接测试',409);
 const version=old.version+1,keep=verified&&appId===old.app_id&&idType===old.id_type,now=at();
 await write(c,[db.prepare("UPDATE feishu_settings SET enabled=?,version=?,app_id=?,id_type=?,connection_status=?,connection_version=?,connection_app_id=?,config_source=?,connection_checked_at=?,connection_error='',enabled_at=? WHERE id='global'").bind(enabled?1:0,version,appId,idType,keep?'passed':'untested',keep?version:null,keep?appId:null,keep?old.config_source:null,keep?old.connection_checked_at:null,enabled?(old.enabled?old.enabled_at:now):old.enabled_at),
  db.prepare("UPDATE feishu_sync_runs SET status='failed',finished_at=?,error_code='configuration_changed' WHERE id=(SELECT run_id FROM feishu_sync_state WHERE id='global') AND status='running'").bind(now),
  db.prepare("UPDATE feishu_sync_state SET run_id=NULL,lease_token_hash=NULL,lease_until=NULL WHERE id='global'"),...event(db,c.a,'feishu','feishuSettings',{enabled,version,appId,idType,reason})]);
 return {ok:true,settings:await getFeishuSettings(db)};
}

// Server-only: the API must supply an actual credential fingerprint, never the secret or private path.
export async function recordFeishuConnectionCheck(db,{version,appId,configSource,ok,errorCode:code,now}){
 ok=ok===true;const old=await settingsRow(db),stamp=at(now);if(Number(version)!==old.version||appId!==old.app_id)fail('飞书应用或配置已变化',409);
 const fingerprint=text(configSource,'凭据指纹',160);if(!/^[a-zA-Z0-9:_.-]+$/.test(fingerprint))fail('凭据指纹格式无效');
 await workerWrite(db,"EXISTS(SELECT 1 FROM feishu_settings WHERE id='global' AND version=? AND app_id=?)",[old.version,appId],[db.prepare("UPDATE feishu_settings SET connection_status=?,connection_version=?,connection_app_id=?,config_source=?,connection_checked_at=?,connection_error=? WHERE id='global'").bind(ok?'passed':'failed',ok?old.version:null,appId,fingerprint,stamp,ok?'':errorCode(code))]);
 return {ok:true,settings:await getFeishuSettings(db)};
}

export async function saveFeishuUserLink(db,actor,p){
 const c=await adminContext(db,actor),s=await settingsRow(db),old=p.id?await db.prepare('SELECT * FROM feishu_user_links WHERE id=?').bind(p.id).first():null;
 if(p.id&&!old)fail('飞书映射不存在',404);if(Number(p.version||0)!==(old?.version||0))fail('员工映射已变化',409);
 if(!s.app_id)fail('请先配置飞书应用');if(p.active!=null&&typeof p.active!=='boolean')fail('映射启用状态无效');
 const userId=text(p.userId,'员工账号'),externalUserId=text(p.externalUserId,'飞书员工编号',160),unitId=text(p.unitId,'组织'),idType=p.idType||s.id_type,active=p.active!==false,reason=text(p.reason,'映射依据',500);
 if(!types.includes(idType)||idType!==s.id_type)fail('员工编号类型与飞书配置不一致');
 if(old&&(old.user_id!==userId||old.external_user_id!==externalUserId||old.unit_id!==unitId||old.id_type!==idType||old.app_id!==s.app_id))fail('不可重绑旧映射到其他人或组织，请停用后新建',409);
 const u=await db.prepare('SELECT id,name,site,active FROM users WHERE id=?').bind(userId).first(),profile=c.profiles.find(x=>x.user_id===userId),unit=c.units.find(x=>x.id===unitId);
 if(active&&(!u?.active||!profile?.active||profile.unit_id!==unitId||!unit?.active||u.site&&u.site!==unit.site))fail('员工须绑定当前有效组织，不需要本地班次');
 if(await db.prepare('SELECT id FROM feishu_user_links WHERE app_id=? AND id_type=? AND external_user_id=? AND user_id<>? LIMIT 1').bind(s.app_id,idType,externalUserId,userId).first())fail('该飞书编号已归属另一员工，不能重绑历史',409);
 if(!old&&await db.prepare('SELECT id FROM feishu_user_links WHERE app_id=? AND id_type=? AND external_user_id=? AND user_id=? AND unit_id=? LIMIT 1').bind(s.app_id,idType,externalUserId,userId,unitId).first())fail('该身份和组织已有历史映射，请重新启用原映射，不可重复建档',409);
 if(active&&await db.prepare('SELECT id FROM feishu_user_links WHERE active=1 AND id<>? AND (user_id=? OR (app_id=? AND id_type=? AND external_user_id=?)) LIMIT 1').bind(old?.id||'',userId,s.app_id,idType,externalUserId).first())fail('本地员工或飞书编号已有启用映射',409);
 const id=old?.id||crypto.randomUUID(),stamp=at(),version=(old?.version||0)+1;
 await write(c,[old?db.prepare('UPDATE feishu_user_links SET active=?,version=?,activated_at=?,updated_at=? WHERE id=?').bind(active?1:0,version,active&&!old.active?stamp:old.activated_at,stamp,id):db.prepare('INSERT INTO feishu_user_links VALUES(?,?,?,?,?,?,?,?,?,?,?)').bind(id,userId,externalUserId,idType,unitId,s.app_id,active?1:0,version,stamp,stamp,stamp),...event(db,c.a,id,'feishuMapping',{userId,externalUserId,idType,unitId,active,version,reason})]);
 return {ok:true,id,version};
}

export async function getFeishuSource(db,userId){
 const s=await settingsRow(db),link=await db.prepare('SELECT l.*,u.active user_active,u.site,p.active profile_active,p.unit_id current_unit,w.active unit_active,w.site unit_site FROM feishu_user_links l LEFT JOIN users u ON u.id=l.user_id LEFT JOIN workplace_profiles p ON p.user_id=l.user_id LEFT JOIN workplace_units w ON w.id=l.unit_id WHERE l.user_id=? AND l.active=1').bind(userId).first(),isManaged=Boolean(s.enabled&&link);
 const mappingReady=Boolean(link&&link.user_active&&link.profile_active&&link.unit_active&&link.current_unit===link.unit_id&&(!link.site||link.site===link.unit_site)&&link.app_id===s.app_id&&link.id_type===s.id_type);
 return {source:isManaged?'feishu':'local',isManaged,mappingReady,sourceIssue:isManaged&&!mappingReady?'mapping_scope':null,managedSince:isManaged?[s.enabled_at,link.activated_at].filter(Boolean).sort().at(-1):null};
}

export async function claimFeishuSyncRun(db,{settingsVersion,appId,configSource,trigger='scheduled',actorId=null,leaseSeconds=180,now}){
 const s=await settingsRow(db),state=await stateRow(db),stamp=at(now);
 if(!s.enabled||s.version!==Number(settingsVersion)||s.app_id!==appId||s.connection_status!=='passed'||s.connection_version!==s.version||s.connection_app_id!==appId||s.config_source!==configSource)fail('飞书同步未启用或当前凭据未验证',409);
 if(!['manual','scheduled'].includes(trigger))fail('同步触发方式无效');
 if(trigger==='manual'&&!await db.prepare("SELECT id FROM users WHERE id=? AND active=1 AND role='管理员'").bind(actorId||'').first())fail('仅管理员手动同步',403);
 if(state.run_id&&state.lease_until>stamp)fail('飞书同步正在执行',409);
 if(!Number.isInteger(leaseSeconds)||leaseSeconds<30||leaseSeconds>900)fail('同步租约时长无效');
 const links=(await rows(db,"SELECT l.*,u.name,w.name unit_name,w.timezone,EXISTS(SELECT 1 FROM feishu_user_links historical WHERE historical.app_id=l.app_id AND historical.id_type=l.id_type AND historical.external_user_id=l.external_user_id AND historical.unit_id<>l.unit_id) transferred FROM feishu_user_links l JOIN users u ON u.id=l.user_id JOIN workplace_profiles p ON p.user_id=l.user_id JOIN workplace_units w ON w.id=l.unit_id WHERE l.active=1 AND l.app_id=? AND l.id_type=? AND u.active=1 AND p.active=1 AND p.unit_id=l.unit_id AND w.active=1 AND (u.site IS NULL OR u.site='' OR u.site=w.site)",[s.app_id,s.id_type])).map(r=>({...mapping(r),timezone:r.timezone,syncFrom:r.transferred?localDate(r.activated_at,r.timezone):null}));
 if(!links.length)fail('尚无可同步的有效员工映射');
 if(links.length!==Number((await db.prepare('SELECT COUNT(*) n FROM feishu_user_links WHERE active=1').first()).n))fail('存在失效或跨组织映射，请先由管理员核对',409);
 const runId=crypto.randomUUID(),leaseToken=crypto.randomUUID(),leaseHash=await digest(leaseToken),leaseUntil=at(new Date(stamp).getTime()+leaseSeconds*1000);
 await workerWrite(db,"EXISTS(SELECT 1 FROM feishu_settings WHERE id='global' AND version=? AND enabled=1 AND config_source=?) AND EXISTS(SELECT 1 FROM feishu_sync_state WHERE id='global' AND (run_id IS NULL OR lease_until<=?))",[s.version,configSource,stamp],[
  db.prepare("UPDATE feishu_sync_runs SET status='failed',finished_at=?,error_code='lease_expired' WHERE id=(SELECT run_id FROM feishu_sync_state WHERE id='global') AND status='running'").bind(stamp),
  db.prepare("INSERT INTO feishu_sync_runs(id,settings_version,trigger,actor_id,status,started_at,scope_json) VALUES(?,?,?,?,'running',?,?)").bind(runId,s.version,trigger,trigger==='manual'?actorId:null,stamp,JSON.stringify(links)),
  db.prepare("UPDATE feishu_sync_state SET run_id=?,lease_token_hash=?,lease_until=?,last_attempt_at=?,last_error='' WHERE id='global'").bind(runId,leaseHash,leaseUntil,stamp)]);
 return {runId,leaseToken,settingsVersion:s.version,links,leaseUntil};
}

async function runGuard(db,p){
 const stamp=at(p.now),hash=await digest(text(p.leaseToken,'同步租约')),run=await db.prepare('SELECT * FROM feishu_sync_runs WHERE id=?').bind(p.runId).first(),s=await settingsRow(db),state=await stateRow(db);
 if(!run||run.status!=='running'||run.settings_version!==s.version||!s.enabled||state.run_id!==p.runId||state.lease_token_hash!==hash||state.lease_until<=stamp||p.settingsVersion!=null&&Number(p.settingsVersion)!==s.version)fail('同步租约或配置已变化',409);
 return {run,stamp,hash,condition:"EXISTS(SELECT 1 FROM feishu_sync_state WHERE id='global' AND run_id=? AND lease_token_hash=? AND lease_until>?) AND EXISTS(SELECT 1 FROM feishu_settings WHERE id='global' AND version=? AND enabled=1)",args:[p.runId,hash,stamp,s.version]};
}
export async function renewFeishuSyncRun(db,p){const g=await runGuard(db,p),seconds=p.leaseSeconds??180;if(!Number.isInteger(seconds)||seconds<30||seconds>900)fail('同步租约时长无效');const leaseUntil=at(new Date(g.stamp).getTime()+seconds*1000);await workerWrite(db,g.condition,g.args,[db.prepare("UPDATE feishu_sync_state SET lease_until=? WHERE id='global'").bind(leaseUntil)]);return {ok:true,leaseUntil};}

function time(value,label){if(value==null||value==='')return null;if(typeof value!=='string'||!/(Z|[+-]\d{2}:\d{2})$/.test(value)||!Number.isFinite(Date.parse(value)))fail(`${label}须为明确时区的时间`);return at(value);}
const localDate=(value,tz)=>new Intl.DateTimeFormat('en-CA',{timeZone:tz}).format(new Date(value));
function normalize(record,kind,link,from,to){
 if(!record||record.externalUserId!==link.externalUserId)fail('飞书返回的员工编号不匹配',409);
 const sourceId=text(record.sourceId,'飞书来源编号',240),workDate=day(record.workDate),status=record.status||'unknown';
 if(!(kind==='attendance'?['recorded','unknown']:['approved','revoked','unknown']).includes(status))fail('飞书事实状态无效');
 const data={sourceId,workDate,status};if(record.weakIdentity===true)data.weakIdentity=true;
 for(const key of ['punchedAt','checkInAt','checkOutAt','startAt','endAt','sourceUpdatedAt'])if(record[key]!=null)data[key]=time(record[key],key);
 if(data.startAt&&data.endAt&&data.startAt>data.endAt)fail('请假结束时间早于开始时间');
 for(const key of ['durationMinutes','durationValue'])if(record[key]!=null){if(typeof record[key]!=='number'||!Number.isFinite(record[key])||record[key]<0||record[key]>1e8)fail('请假时长无效');data[key]=record[key];}
 if(record.durationUnit!=null){if(!['minute','minutes','hour','hours','day','days','unknown'].includes(record.durationUnit))fail('请假时长单位无效');data.durationUnit=record.durationUnit;}
 if(record.leaveType!=null)data.leaveType=text(record.leaveType,'假别',100);
 // Native attendance returns daily rows. An interval spanning a day is not proof that day's row was returned.
 if(data.workDate<from||data.workDate>to)fail('飞书事实不在本次同步窗口内');
 return data; // No upstream form, medical reason, address, coordinates or unrecognized fields are retained.
}

export async function completeFeishuWindow(db,p){
 const g=await runGuard(db,p),from=day(p.from),to=day(p.to);if(!kinds.includes(p.kind)||from>to||Date.parse(to)-Date.parse(from)>93*86400000||p.complete!==true||!Array.isArray(p.records)||p.records.length>10000)fail('必须提交完整的员工同步窗口');
 const link=JSON.parse(g.run.scope_json).find(x=>x.id===p.linkId&&x.version===Number(p.linkVersion));if(!link)fail('员工不在本次同步范围',409);
 const live=await db.prepare('SELECT l.*,u.active user_active,u.name,u.site,p.active profile_active,p.unit_id current_unit,w.active unit_active,w.name unit_name,w.site unit_site,w.timezone FROM feishu_user_links l JOIN users u ON u.id=l.user_id JOIN workplace_profiles p ON p.user_id=l.user_id JOIN workplace_units w ON w.id=l.unit_id WHERE l.id=?').bind(link.id).first();
 if(!live?.active||live.version!==link.version||!live.user_active||!live.profile_active||!live.unit_active||live.current_unit!==link.unitId||live.site&&live.site!==live.unit_site)fail('员工或组织映射已变化',409);
 if(link.syncFrom&&from<link.syncFrom)fail('同步窗口跨越调岗生效日期，请从新组织映射生效日开始同步',409);
 const prior=await db.prepare('SELECT counts_json,content_hash FROM feishu_sync_windows WHERE run_id=? AND link_id=? AND kind=? AND date_from=? AND date_to=?').bind(p.runId,link.id,p.kind,from,to).first();
 const normalized=new Map();for(const record of p.records){const data=normalize(record,p.kind,link,from,to);if(normalized.has(data.sourceId))fail('完整窗口包含重复来源编号');normalized.set(data.sourceId,data);}
 // A transfer starts a new scope, never a reassignment of historical external facts.
 if(link.syncFrom){const history=await rows(db,'SELECT DISTINCT r.source_id FROM feishu_records r JOIN feishu_user_links l ON l.id=r.link_id WHERE l.app_id=? AND l.id_type=? AND l.external_user_id=? AND l.unit_id<>? AND r.kind=?',[link.appId,link.idType,link.externalUserId,link.unitId,p.kind]),otherScope=new Set(history.map(r=>r.source_id));for(const data of normalized.values()){if(otherScope.has(data.sourceId))fail('该来源记录已归属原组织，跨调岗记录请由管理员核对，不自动转移',409);if(data.workDate<link.syncFrom||data.startAt&&localDate(data.startAt,live.timezone)<link.syncFrom)fail('新组织不可接收调岗生效前的事实，请核对原组织记录',409);}}
 const windowHash=await digest(JSON.stringify([...normalized.values()].sort((a,b)=>a.sourceId.localeCompare(b.sourceId))));if(prior){if(prior.content_hash!==windowHash)fail('已完成窗口不可替换，请开启新的同步',409);return {ok:true,...JSON.parse(prior.counts_json),replayed:true};}
 const previous=await rows(db,`SELECT r.* FROM feishu_records r WHERE link_id=? AND kind=? AND ${latest}`,[link.id,p.kind]),byId=new Map(previous.map(r=>[r.source_id,r])),statements=[],counts={accepted:normalized.size,changed:0,unchanged:0,sourceMissing:0};
 const append=async(data,old,missing)=>{const json=JSON.stringify(data),hash=await digest(json);if(old&&old.content_hash===hash&&Boolean(old.source_missing)===missing){counts.unchanged++;return;}counts.changed++;statements.push(db.prepare('INSERT INTO feishu_records VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(crypto.randomUUID(),link.id,p.kind,data.sourceId,(old?.revision||0)+1,link.userId,link.unitId,live.name,live.unit_name,data.workDate,json,hash,missing?1:0,p.runId,g.stamp));};
 for(const data of normalized.values())await append(data,byId.get(data.sourceId),false);
 for(const old of previous){const data=JSON.parse(old.data_json);if(!normalized.has(old.source_id)&&data.workDate>=from&&data.workDate<=to&&!old.source_missing){counts.sourceMissing++;await append(data,old,true);}}
 statements.push(db.prepare('INSERT INTO feishu_sync_windows VALUES(?,?,?,?,?,?,?,?,?,?)').bind(crypto.randomUUID(),p.runId,link.id,link.version,p.kind,from,to,g.stamp,JSON.stringify(counts),windowHash),db.prepare('UPDATE feishu_sync_runs SET committed_windows=committed_windows+1 WHERE id=?').bind(p.runId));
 await workerWrite(db,g.condition+" AND EXISTS(SELECT 1 FROM feishu_user_links l JOIN users u ON u.id=l.user_id JOIN workplace_profiles pr ON pr.user_id=l.user_id JOIN workplace_units w ON w.id=l.unit_id WHERE l.id=? AND l.version=? AND l.active=1 AND u.active=1 AND pr.active=1 AND pr.unit_id=l.unit_id AND w.active=1 AND (u.site IS NULL OR u.site='' OR u.site=w.site))",[...g.args,link.id,link.version],statements);
 return {ok:true,...counts,replayed:false};
}

export async function finishFeishuSyncRun(db,p){
 const g=await runGuard(db,p),version=await clock(db);if(p.success===true){for(const link of JSON.parse(g.run.scope_json)){const valid=await db.prepare("SELECT l.id FROM feishu_user_links l JOIN users u ON u.id=l.user_id JOIN workplace_profiles pr ON pr.user_id=l.user_id JOIN workplace_units w ON w.id=l.unit_id WHERE l.id=? AND l.version=? AND l.active=1 AND u.active=1 AND pr.active=1 AND pr.unit_id=l.unit_id AND w.active=1 AND (u.site IS NULL OR u.site='' OR u.site=w.site)").bind(link.id,link.version).first();if(!valid)fail('同步期间员工或映射已变化',409);}const windows=await rows(db,'SELECT link_id,kind FROM feishu_sync_windows WHERE run_id=?',[p.runId]);if(JSON.parse(g.run.scope_json).some(link=>kinds.some(kind=>!windows.some(w=>w.link_id===link.id&&w.kind===kind))))fail('员工考勤或请假窗口尚未完成，不能标记同步成功',409);}
 const success=p.success===true,code=success?'':errorCode(p.errorCode);
 await workerWrite(db,g.condition+" AND (SELECT version FROM workplace_clock WHERE id='global')=?",[...g.args,version],[db.prepare('UPDATE feishu_sync_runs SET status=?,finished_at=?,error_code=? WHERE id=?').bind(success?'succeeded':'failed',g.stamp,code,p.runId),db.prepare("UPDATE feishu_sync_state SET run_id=NULL,lease_token_hash=NULL,lease_until=NULL,last_success_at=CASE WHEN ? THEN ? ELSE last_success_at END,last_error=? WHERE id='global'").bind(success?1:0,g.stamp,code)]);
 return {ok:true,success};
}

export async function readFeishuAttendance(db,actor,{month,scope}={},existingContext){
 const c=existingContext||await context(db,actor),s=await settingsRow(db),state=await stateRow(db),source=await getFeishuSource(db,c.a.id),selected=month||at().slice(0,7);
 if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(selected))fail('月份无效');
 const from=selected+'-01',to=new Date(Date.UTC(Number(selected.slice(0,4)),Number(selected.slice(5,7)),0)).toISOString().slice(0,10);
 // Native approvals are source daily rows, not leave instances. Keep list and counts in the same business month.
 const candidates=await rows(db,`SELECT r.* FROM feishu_records r WHERE ${latest} AND work_date BETWEEN ? AND ? ORDER BY work_date DESC,imported_at DESC`,[from,to]);
 const records=[],summary=new Map();
 for(const r of candidates){if(scope==='mine'&&r.user_id!==c.a.id)continue;const data=JSON.parse(r.data_json),unit=c.units.find(u=>u.id===r.unit_id);if(!unit)continue;const detail=c.a.role==='管理员'||r.user_id===c.a.id||manager(c,r.user_id,r.unit_id)||has(c,'hr',r.unit_id),aggregate=detail||has(c,'executive',r.unit_id);if(!aggregate)continue;
  if(detail)records.push({id:r.id,kind:r.kind,userId:r.user_id,name:r.user_name,unitId:r.unit_id,unitName:r.unit_name,revision:r.revision,sourceMissing:Boolean(r.source_missing),importedAt:r.imported_at,...data});
  const key=JSON.stringify([r.unit_id,r.kind,data.status]),x=summary.get(key)||{unitId:r.unit_id,unitName:r.unit_name,kind:r.kind,status:data.status,count:0,sourceMissingCount:0,totalDurationMinutes:0,unknownDurationCount:0};x.count++;if(r.source_missing)x.sourceMissingCount++;if(r.kind==='leave'){if(data.durationMinutes==null||r.source_missing)x.unknownDurationCount++;else x.totalDurationMinutes+=data.durationMinutes;}summary.set(key,x);
 }
 const result={...source,status:{enabled:Boolean(s.enabled),connectionStatus:s.connection_status,connectionCheckedAt:s.connection_checked_at,lastSuccessAt:state.last_success_at,lastAttemptAt:state.last_attempt_at,lastError:state.last_error||s.connection_error||'',running:Boolean(state.run_id&&state.lease_until>at())},records,summary:[...summary.values()]};
 if(c.a.role==='管理员'&&scope!=='mine'){const people=await rows(db,'SELECT id,name,role,site FROM users WHERE active=1');result.configuration={settings:settings(s,state),links:(await rows(db,'SELECT l.*,u.name,w.name unit_name FROM feishu_user_links l JOIN users u ON u.id=l.user_id JOIN workplace_units w ON w.id=l.unit_id ORDER BY u.name')).map(mapping),users:people.map(u=>{const p=c.profiles.find(p=>p.user_id===u.id&&p.active),unit=c.units.find(x=>x.id===p?.unit_id&&x.active);return {...u,unitId:unit?.id||null,unitName:unit?.name||null,profileReady:Boolean(unit&&(!u.site||u.site===unit.site))};}),units:c.units.filter(u=>u.active).map(u=>({id:u.id,name:u.name,site:u.site})),canConfigure:true};}
 for(const row of result.summary)if(row.kind==='leave'&&row.count===row.unknownDurationCount)row.totalDurationMinutes=null;
 if(await clock(db)!==c.version)fail('资料已变化，请刷新',409);
 return result;
}
