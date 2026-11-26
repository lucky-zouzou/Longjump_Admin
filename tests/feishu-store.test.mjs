import test from 'node:test';
import assert from 'node:assert/strict';
import {workplaceFixture} from './workplace-fixture.mjs';
import {getFeishuSettings,getFeishuSource,saveFeishuSettings,recordFeishuConnectionCheck,saveFeishuUserLink,claimFeishuSyncRun,renewFeishuSyncRun,completeFeishuWindow,finishFeishuSyncRun,readFeishuAttendance} from '../lib/feishu-store.mjs';
import {punch,mutateLeave,readAttendance} from '../lib/attendance.mjs';
import {workplaceCsv} from '../lib/workplace-export.mjs';

const credential={appId:'cli_TEST_ONLY',configSource:'sha256:TESTONLY'},from='2026-11-01',to='2026-11-30';
const record=(extra={})=>({sourceId:'TEST-punch',externalUserId:'TEST-ID-OPS',workDate:'2026-11-23',status:'recorded',punchedAt:'2026-11-23T09:00:00+07:00',...extra});
const leave=(extra={})=>({sourceId:'TEST-leave',externalUserId:'TEST-ID-OPS',workDate:'2026-11-23',status:'approved',startAt:'2026-11-23T09:00:00+07:00',endAt:'2026-11-23T18:00:00+07:00',durationValue:1,durationUnit:'day',...extra});
async function prepared({enabled=true}={}){
 const f=await workplaceFixture();f.close=()=>f.sqlite.close();
 await saveFeishuSettings(f.db,f.users.admin,{version:1,enabled:false,appId:credential.appId,idType:'employee_id',reason:'TEST setup'});
 await recordFeishuConnectionCheck(f.db,{version:2,...credential,ok:true});
 f.link=await saveFeishuUserLink(f.db,f.users.admin,{userId:'id-ops',externalUserId:'TEST-ID-OPS',unitId:'ID',active:true,reason:'TEST verified identity'});
 f.enable=async()=>{const s=await getFeishuSettings(f.db);return saveFeishuSettings(f.db,f.users.admin,{version:s.version,enabled:true,reason:'TEST enabled'},credential);};
 if(enabled)await f.enable();
 f.claim=(extra={})=>getFeishuSettings(f.db).then(s=>claimFeishuSyncRun(f.db,{settingsVersion:s.version,...credential,...extra}));
 f.window=(run,kind,records,extra={})=>completeFeishuWindow(f.db,{...run,linkId:f.link.id,linkVersion:f.link.version,kind,from,to,complete:true,records,...extra});
 f.finish=run=>finishFeishuSyncRun(f.db,{...run,success:true});
 f.sync=async(attendance=[record()],leaves=[leave()])=>{const run=await f.claim();await f.window(run,'attendance',attendance);await f.window(run,'leave',leaves);await f.finish(run);return run;};
 return f;
}

test('默认关闭，开启须管理员同版本连接验证和当前AppID/凭据指纹',async()=>{
 const f=await workplaceFixture();try{
  assert.equal((await getFeishuSettings(f.db)).enabled,false);
  await assert.rejects(saveFeishuSettings(f.db,f.users.indonesia,{version:1,appId:credential.appId,enabled:false,reason:'TEST'}),e=>e.status===403);
  await assert.rejects(saveFeishuSettings(f.db,f.users.admin,{version:1,appId:credential.appId,enabled:true,reason:'TEST'},credential),/连接测试/);
  await saveFeishuSettings(f.db,f.users.admin,{version:1,appId:credential.appId,enabled:false,reason:'TEST'});
  await assert.rejects(recordFeishuConnectionCheck(f.db,{version:2,...credential,appId:'cli_OTHER',ok:true}),/应用/);
  await recordFeishuConnectionCheck(f.db,{version:2,...credential,ok:true});
  await assert.rejects(saveFeishuSettings(f.db,f.users.admin,{version:2,enabled:true,reason:'TEST'},{...credential,configSource:'sha256:CHANGED'}),/凭据/);
  await assert.rejects(saveFeishuSettings(f.db,f.users.admin,{version:1,enabled:true,reason:'TEST'},credential),/版本/);
  await saveFeishuSettings(f.db,f.users.admin,{version:2,enabled:true,reason:'TEST'},credential);
  assert.equal((await getFeishuSettings(f.db)).enabled,true);
 }finally{f.sqlite.close();}
});

test('映射要求真实组织但不要求本地班次；拒绝错人、重复编号、跨组织重绑与换应用',async()=>{
 const f=await prepared();try{
  await saveFeishuUserLink(f.db,f.users.admin,{userId:'my-ops',externalUserId:'TEST-MY',unitId:'MY',reason:'TEST no local shift'});
  await assert.rejects(saveFeishuUserLink(f.db,f.users.admin,{userId:'studio',externalUserId:'TEST-ID-OPS',unitId:'ID',reason:'TEST duplicate'}),/另一员工/);
  await assert.rejects(saveFeishuUserLink(f.db,f.users.admin,{userId:'id-ops',externalUserId:'OTHER',unitId:'MY',reason:'TEST wrong unit'}),/当前有效组织/);
  await assert.rejects(saveFeishuUserLink(f.db,f.users.admin,{id:f.link.id,version:1,userId:'studio',externalUserId:'TEST-ID-OPS',unitId:'ID',active:false,reason:'TEST rebind'}),/重绑/);
  const s=await getFeishuSettings(f.db);await assert.rejects(saveFeishuSettings(f.db,f.users.admin,{version:s.version,enabled:false,appId:'cli_OTHER',reason:'TEST changed'}),/企业/);
 }finally{f.close();}
});

test('启用飞书禁止本地新写，旧签到可签退且旧请假继续审批；不按本地排班推断外部旷工',async()=>{
 const f=await prepared({enabled:false});try{
  await punch(f.db,f.users.indonesia,{kind:'in'},new Date('2026-11-23T02:00:00Z'));
  const old=await mutateLeave(f.db,f.users.indonesia,{action:'leaveCreate',date:'2026-11-24',portion:'full',reason:'TEST handover',operationId:crypto.randomUUID()});
  await f.enable();
  await assert.rejects(punch(f.db,f.users.indonesia,{kind:'in'},new Date('2026-11-24T02:00:00Z')),/飞书/);
  await assert.rejects(mutateLeave(f.db,f.users.indonesia,{action:'leaveCreate',date:'2026-11-25'}),/飞书/);
  await punch(f.db,f.users.indonesia,{kind:'out'},new Date('2026-11-23T11:00:00Z'));
  await mutateLeave(f.db,f.users.manager,{action:'managerApprove',id:old.id,version:1,reason:'TEST old local request'});
  await mutateLeave(f.db,f.users.hr,{action:'hrApprove',id:old.id,version:2,reason:'TEST independent review'});
  const view=await readAttendance(f.db,f.users.indonesia,{month:'2026-11'},new Date('2026-11-25T12:00:00Z'));
  assert.equal(view.feishu.source,'feishu');assert.equal(view.readiness.canPunch,false);assert.equal(view.readiness.canLeave,false);
  assert.equal(view.days.some(d=>d.work_date==='2026-11-25'),false);assert.equal(view.requests[0].status,'approved');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM attendance_punches').get().n,2);
 }finally{f.close();}
});

test('租约跨任务互斥、超时可接管，旧租约不能提交；指纹变更不能启动同步',async()=>{
 const f=await prepared();try{
  const run=await f.claim({now:'2026-11-24T00:00:00Z',leaseSeconds:30});
  await assert.rejects(f.claim({now:'2026-11-24T00:00:01Z'}),/正在执行/);
  await assert.rejects(renewFeishuSyncRun(f.db,{...run,leaseToken:'wrong',now:'2026-11-24T00:00:05Z'}),/租约/);
  const next=await f.claim({now:'2026-11-24T00:00:31Z'});
  await assert.rejects(f.window(run,'attendance',[record()],{now:'2026-11-24T00:00:32Z'}),/租约/);
  await f.window(next,'attendance',[record()],{now:'2026-11-24T00:00:32Z'});
  await assert.rejects(f.claim({...credential,configSource:'sha256:CHANGED',now:'2026-11-24T00:10:00Z'}),/凭据/);
 }finally{f.close();}
});

test('完整窗口幂等、仅存白名单事实、单次流水不冒充签到，请假天数不猜分钟',async()=>{
 const f=await prepared();try{
  const run=await f.claim(),r=record({weakIdentity:true,reason:'PRIVATE MEDICAL',location:'PRIVATE LOCATION',form:{secret:'PRIVATE FORM'}});
  await f.window(run,'attendance',[r]);assert.equal((await f.window(run,'attendance',[r])).replayed,true);
  await assert.rejects(f.window(run,'attendance',[record({punchedAt:'2026-11-23T11:00:00Z'})]),/不可替换/);
  await f.window(run,'leave',[leave({reason:'PRIVATE MEDICAL'})]);await f.finish(run);
  const view=await readFeishuAttendance(f.db,f.users.indonesia,{month:'2026-11'}),p=view.records.find(r=>r.kind==='attendance'),l=view.records.find(r=>r.kind==='leave');
  assert.equal(p.punchedAt,'2026-11-23T02:00:00.000Z');assert.equal(p.checkInAt,undefined);assert.equal(p.weakIdentity,true);
  assert.equal(l.durationMinutes,undefined);assert.equal(l.durationValue,1);assert.equal(l.durationUnit,'day');
  assert.equal(view.summary.find(r=>r.kind==='leave').totalDurationMinutes,null);
  assert.ok(!JSON.stringify(f.sqlite.prepare('SELECT * FROM feishu_records').all()).includes('PRIVATE'));
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM attendance_punches').get().n,0);
  const before=f.sqlite.prepare('SELECT COUNT(*) n FROM feishu_records').get().n;await f.sync([r],[leave()]);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM feishu_records').get().n,before);
 }finally{f.close();}
});

test('不完整窗口和错误身份不落库；窗口消失只标待核对，显式撤销另留版本',async()=>{
 const f=await prepared();try{
  await f.sync();const run=await f.claim();
  await assert.rejects(f.window(run,'attendance',[],{complete:false}),/完整/);
  await assert.rejects(f.window(run,'attendance',[record({externalUserId:'OTHER'})]),/员工编号/);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM feishu_records').get().n,2);
  await f.window(run,'attendance',[]);await f.window(run,'leave',[]);await f.finish(run);
  let v=await readFeishuAttendance(f.db,f.users.indonesia,{month:'2026-11'});assert.equal(v.records.every(r=>r.sourceMissing),true);assert.equal(v.records.find(r=>r.kind==='leave').status,'approved');
  await f.sync([], [leave({status:'revoked'})]);v=await readFeishuAttendance(f.db,f.users.indonesia,{month:'2026-11'});
  assert.equal(v.records.find(r=>r.kind==='leave').sourceMissing,false);assert.equal(v.records.find(r=>r.kind==='leave').status,'revoked');
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM feishu_records WHERE kind='leave'").get().n,3);
 }finally{f.close();}
});

test('部分失败不推进最近成功时间；未完成两类员工窗口不能报整体成功',async()=>{
 const f=await prepared();try{
  await f.sync();const previous=(await getFeishuSettings(f.db)).lastSuccessAt,run=await f.claim();
  await f.window(run,'attendance',[record({sourceId:'TEST-second'})]);
  await assert.rejects(f.finish(run),/尚未完成/);
  await finishFeishuSyncRun(f.db,{...run,success:false,errorCode:'upstream_timeout'});
  const s=await getFeishuSettings(f.db);assert.equal(s.lastSuccessAt,previous);assert.equal(s.lastError,'upstream_timeout');
  const records=(await readFeishuAttendance(f.db,f.users.indonesia,{month:'2026-11'})).records;assert.equal(records.find(r=>r.kind==='leave').status,'approved');
 }finally{f.close();}
});

test('配置、映射、账号或组织变化使旧窗口失效；停用映射不重写历史所属',async()=>{
 const f=await prepared();try{
  await f.sync();let run=await f.claim();
  await saveFeishuUserLink(f.db,f.users.admin,{id:f.link.id,version:1,userId:'id-ops',externalUserId:'TEST-ID-OPS',unitId:'ID',active:false,reason:'TEST deactivate'});
  await assert.rejects(f.window(run,'attendance',[record()]),/映射已变化/);
  assert.equal((await readFeishuAttendance(f.db,f.users.indonesia,{month:'2026-11'})).records[0].unitId,'ID');
  await finishFeishuSyncRun(f.db,{...run,success:false,errorCode:'mapping_changed'});
  f.link=await saveFeishuUserLink(f.db,f.users.admin,{id:f.link.id,version:2,userId:'id-ops',externalUserId:'TEST-ID-OPS',unitId:'ID',active:true,reason:'TEST reactivate'});
  run=await f.claim();f.sqlite.prepare("UPDATE users SET site='泰国' WHERE id='id-ops'").run();
  await assert.rejects(f.window(run,'attendance',[record()]),/映射已变化/);
  await assert.rejects(f.finish(run),/映射已变化/);
 }finally{f.close();}
});

test('本人主管人事看授权明细，管理员全局；财务无新增可见性、管理层只见汇总',async()=>{
 const f=await prepared();try{
  await f.sync();
  for(const actor of [f.users.indonesia,f.users.manager,f.users.hr,f.users.admin])assert.equal((await readFeishuAttendance(f.db,actor,{month:'2026-11'})).records.length,2);
  for(const actor of [f.users.finance,f.users.malaysia]){const v=await readFeishuAttendance(f.db,actor,{month:'2026-11'});assert.equal(v.records.length,0);assert.equal(v.summary.length,0);assert.equal(v.configuration,undefined);}
  const boss=await readFeishuAttendance(f.db,f.users.boss,{month:'2026-11'});assert.equal(boss.records.length,0);assert.equal(boss.summary.length,2);assert.ok(!JSON.stringify(boss).includes('TEST-ID-OPS'));
  const exported=workplaceCsv({days:[],feishu:boss},'attendance');assert.ok(exported.includes('授权范围摘要'));assert.ok(!exported.includes('TEST-ONLY id-ops'));
  const admin=await readFeishuAttendance(f.db,f.users.admin,{month:'2026-11'});assert.equal(admin.configuration.links.length,1);assert.equal(admin.configuration.users.find(u=>u.id==='my-ops').profileReady,true);assert.ok(!JSON.stringify(admin).includes(credential.configSource));
 }finally{f.close();}
});

test('维护锁、错误状态与非明确时区时间拒绝，失败不写事实和审计',async()=>{
 const f=await prepared();try{
  const run=await f.claim();
  await assert.rejects(f.window(run,'attendance',[record({status:'late'})]),/状态/);
  await assert.rejects(f.window(run,'attendance',[record({punchedAt:'2026-11-23T09:00:00'})]),/时区/);
  f.sqlite.prepare("INSERT INTO system_maintenance(id,mode,token_hash,actor_id,expires_at,updated_at) VALUES('global','backup','TEST','admin-1','2099-01-01','2026-11-24')").run();
  await assert.rejects(f.window(run,'attendance',[record()]),/备份|迁移/);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM feishu_records').get().n,0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM feishu_sync_windows').get().n,0);
 }finally{f.close();}
});

test('原身份原组织须复用历史映射；调岗不转移旧事实且从新组织生效日同步',async()=>{
 const f=await prepared();try{
  await f.sync();
  await saveFeishuUserLink(f.db,f.users.admin,{id:f.link.id,version:1,userId:'id-ops',externalUserId:'TEST-ID-OPS',unitId:'ID',active:false,reason:'TEST transfer'});
  const settings=await getFeishuSettings(f.db);await assert.rejects(saveFeishuSettings(f.db,f.users.admin,{version:settings.version,enabled:false,idType:'employee_no',reason:'TEST change identity type'}),/编号类型/);
  await assert.rejects(saveFeishuUserLink(f.db,f.users.admin,{userId:'id-ops',externalUserId:'TEST-ID-OPS',unitId:'ID',active:true,reason:'TEST duplicate history'}),/历史映射/);
  f.link=await saveFeishuUserLink(f.db,f.users.admin,{id:f.link.id,version:2,userId:'id-ops',externalUserId:'TEST-ID-OPS',unitId:'ID',active:true,reason:'TEST use original'});
  f.sqlite.prepare("UPDATE users SET site='马来西亚' WHERE id='id-ops'").run();
  const issue=await getFeishuSource(f.db,'id-ops');assert.equal(issue.isManaged,true);assert.equal(issue.mappingReady,false);assert.equal(issue.sourceIssue,'mapping_scope');
  await assert.rejects(f.claim(),/有效|失效|跨组织/);
  await saveFeishuUserLink(f.db,f.users.admin,{id:f.link.id,version:3,userId:'id-ops',externalUserId:'TEST-ID-OPS',unitId:'ID',active:false,reason:'TEST move scopes'});
  await f.config({action:'profile',userId:'id-ops',unitId:'MY',jobTitle:'TEST transferred',managerId:'manager',version:1});
  f.link=await saveFeishuUserLink(f.db,f.users.admin,{userId:'id-ops',externalUserId:'TEST-ID-OPS',unitId:'MY',active:true,reason:'TEST new organization'});
  const run=await f.claim(),link=run.links[0],date=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kuala_Lumpur'}).format(new Date());
  assert.equal(link.timezone,'Asia/Kuala_Lumpur');assert.equal(link.syncFrom,date);
  const yesterday=new Date(Date.parse(date+'T00:00:00Z')-86400000).toISOString().slice(0,10),window={from:date,to:date};
  await assert.rejects(f.window(run,'attendance',[],{from:yesterday,to:date}),/调岗生效/);
  await assert.rejects(f.window(run,'attendance',[record({workDate:date,punchedAt:date+'T09:00:00+08:00'})],window),/原组织/);
  await assert.rejects(f.window(run,'leave',[leave({sourceId:'TEST-backdated',workDate:date,startAt:yesterday+'T09:00:00+08:00',endAt:date+'T18:00:00+08:00'})],window),/生效前/);
  await f.window(run,'attendance',[record({sourceId:'TEST-new-unit-punch',workDate:date,punchedAt:date+'T09:00:00+08:00'})],window);await f.window(run,'leave',[],window);await f.finish(run);
  assert.equal(f.sqlite.prepare("SELECT unit_id FROM feishu_records WHERE source_id='TEST-punch'").get().unit_id,'ID');
  assert.equal(f.sqlite.prepare("SELECT unit_id FROM feishu_records WHERE source_id='TEST-new-unit-punch'").get().unit_id,'MY');
  assert.equal((await getFeishuSource(f.db,'id-ops')).mappingReady,true);
 }finally{f.close();}
});

test('同一跨月假期按来源日行划分月列表与汇总，不把整段区间重复计入另一月',async()=>{
 const f=await prepared();try{
  const run=await f.claim(),r=leave({sourceId:'TEST-leave-Oct31',workDate:'2026-10-31',startAt:'2026-10-31T23:30:00+07:00',endAt:'2026-11-01T01:00:00+07:00'}),nextDay={...r,sourceId:'TEST-leave-Nov1',workDate:'2026-11-01'};
  await assert.rejects(f.window(run,'leave',[r]),/窗口内/);
  await f.window(run,'attendance',[]);await f.window(run,'leave',[r,nextDay],{from:'2026-10-31',to:'2026-11-01'});await f.finish(run);
  for(const month of ['2026-10','2026-11']){const v=await readFeishuAttendance(f.db,f.users.indonesia,{month});assert.equal(v.records.length,1);assert.equal(v.records[0].workDate.slice(0,7),month);assert.equal(v.records[0].status,'approved');assert.equal(v.summary[0].count,1);assert.equal(v.records[0].startAt,'2026-10-31T16:30:00.000Z');assert.equal(v.records[0].endAt,'2026-10-31T18:00:00.000Z');assert.match(workplaceCsv({days:[],feishu:v},'attendance'),/日行记录数/);}
  await f.sync([],[]);
  let rows=(await readFeishuAttendance(f.db,f.users.indonesia,{month:'2026-11'})).records;assert.equal(rows.length,1);assert.equal(rows[0].sourceMissing,true);assert.equal(rows[0].status,'approved');
  rows=(await readFeishuAttendance(f.db,f.users.indonesia,{month:'2026-10'})).records;assert.equal(rows.length,1);assert.equal(rows[0].sourceMissing,false);
  const next=await f.claim();await f.window(next,'attendance',[]);await f.window(next,'leave',[],{from:'2026-10-31',to:'2026-10-31'});await f.finish(next);
  rows=(await readFeishuAttendance(f.db,f.users.indonesia,{month:'2026-10'})).records;assert.equal(rows[0].sourceMissing,true);assert.equal(rows[0].status,'approved');
 }finally{f.close();}
});

test('同步记录、映射和来源待核对状态随完整备份恢复，修订不可覆盖',async()=>{
 const {mkdtempSync,rmSync}=await import('node:fs'),{tmpdir}=await import('node:os'),{join}=await import('node:path'),{fileBucket,openDatabase}=await import('../server/storage.mjs'),{createBackup,restoreBackup}=await import('../server/backup.mjs');
 const root=mkdtempSync(join(tmpdir(),'TEST-feishu-backup-')),f=await prepared();let restored;
 try{
  await f.sync();await f.sync([],[leave({status:'revoked'})]);
  const before=f.sqlite.prepare('SELECT COUNT(*) n FROM feishu_records').get().n,path=join(root,'TEST-backup.tar');
  await createBackup({DB:f.db,WHOLESALE_FILES:fileBucket(join(root,'files'))},path);await restoreBackup(path,join(root,'restored'));
  restored=openDatabase(join(root,'restored','business.sqlite'));
  assert.equal(restored.sqlite.prepare('SELECT COUNT(*) n FROM feishu_records').get().n,before);
  assert.equal(restored.sqlite.prepare('SELECT COUNT(*) n FROM feishu_settings').get().n,1);assert.equal(restored.sqlite.prepare('SELECT COUNT(*) n FROM feishu_sync_state').get().n,1);
  assert.equal(restored.sqlite.prepare('PRAGMA foreign_key_check').all().length,0);
  const v=await readFeishuAttendance(restored,f.users.indonesia,{month:'2026-11'});assert.equal(v.isManaged,true);assert.equal(v.records.find(r=>r.kind==='leave').status,'revoked');assert.equal(v.records.find(r=>r.kind==='attendance').sourceMissing,true);
  assert.throws(()=>restored.sqlite.prepare("UPDATE feishu_records SET unit_id='MY'").run(),/immutable/);
 }finally{restored?.sqlite.close();f.close();rmSync(root,{recursive:true,force:true});}
});

test('读取期间人事授权被撤回，不返回旧授权下的员工明细',async()=>{
 const f=await prepared();try{
  await f.sync();let revoked=false;
  const db={...f.db,prepare(sql){const statement=f.db.prepare(sql);if(!sql.startsWith('SELECT r.* FROM feishu_records r'))return statement;return {bind(...args){const bound=statement.bind(...args);return {async all(){const result=await bound.all();if(!revoked){revoked=true;f.sqlite.prepare("DELETE FROM workplace_grants WHERE user_id='hr' AND capability='hr'").run();}return result;}};}};}};
  await assert.rejects(readFeishuAttendance(db,f.users.hr,{month:'2026-11'}),e=>e.status===409);
  assert.equal((await readFeishuAttendance(f.db,f.users.hr,{month:'2026-11'})).records.length,0);
 }finally{f.close();}
});
