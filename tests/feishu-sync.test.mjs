import test from 'node:test';
import assert from 'node:assert/strict';
import {workplaceFixture} from './workplace-fixture.mjs';
import {feishuCredentialIdentity,feishuSyncDates,testFeishuConnection,runFeishuSync,startFeishuSync} from '../lib/feishu-sync.mjs';
import {getFeishuSettings,saveFeishuSettings,saveFeishuUserLink,readFeishuAttendance} from '../lib/feishu-store.mjs';
import {FeishuClientError} from '../lib/feishu-client.mjs';

const credentials={appId:'cli_TEST_ONLY',appSecret:'TEST_FAKE_PRIVATE_SECRET_887'};
const NOW=new Date('2026-11-24T08:00:00Z');
const punch=(extra={})=>({sourceId:'TEST-punch',externalUserId:'TEST-ID-OPS',workDate:'2026-11-23',status:'recorded',punchedAt:'2026-11-23T02:00:00.000Z',...extra});
const leave=(extra={})=>({sourceId:'TEST-future-leave',externalUserId:'TEST-ID-OPS',workDate:'2026-12-03',status:'approved',startAt:'2026-12-03T02:00:00.000Z',endAt:'2026-12-03T11:00:00.000Z',...extra});
const inWindow=(record,options)=>record.externalUserId===options.externalUserId&&record.workDate>=options.from&&record.workDate<=options.to;
function mockClient({attendance=[],leaves=[],scope='confirmed',onRead,onLeave,onTest}={}){
 const calls=[];
 const client={
  async testConnection(){calls.push({kind:'test'});await onTest?.();return {authenticated:true,attendanceScope:scope};},
  async readWindow(options){calls.push({kind:'window',...options});await onRead?.(options);return {attendance:attendance.filter(r=>inWindow(r,options)),leave:leaves.filter(r=>inWindow(r,options))};},
  async readLeaveWindow(options){calls.push({kind:'future',...options});await onLeave?.(options);return leaves.filter(r=>inWindow(r,options));},
 };
 return {calls,clientFactory:()=>client};
}
async function prepared({enabled=true,twoEmployees=false}={}){
 const f=await workplaceFixture(),identity=await feishuCredentialIdentity(credentials);
 await saveFeishuSettings(f.db,f.users.admin,{version:1,enabled:false,appId:credentials.appId,idType:'employee_id',reason:'TEST configuration'});
 f.link=await saveFeishuUserLink(f.db,f.users.admin,{userId:'id-ops',externalUserId:'TEST-ID-OPS',unitId:'ID',reason:'TEST mapped'});
 if(twoEmployees)f.second=await saveFeishuUserLink(f.db,f.users.admin,{userId:'my-ops',externalUserId:'TEST-MY-OPS',unitId:'MY',reason:'TEST mapped'});
 if(enabled){await testFeishuConnection(f.db,credentials,{...mockClient(),requireMappings:true});await saveFeishuSettings(f.db,f.users.admin,{version:2,enabled:true,reason:'TEST enabled'},identity);}
 f.options=extra=>({actorId:f.users.admin.id,trigger:'manual',now:NOW,...extra});
 return f;
}

test('default window uses seven Shanghai business dates and rejects future/invalid intervals',()=>{
 assert.deepEqual(feishuSyncDates({},new Date('2026-11-23T17:00:00Z')),{from:'2026-11-18',to:'2026-11-24'});
 assert.deepEqual(feishuSyncDates({to:'2026-11-20'},NOW),{from:'2026-11-14',to:'2026-11-20'});
 for(const value of [{from:'2026-11-17',to:'2026-11-24'},{from:'2026-11-25',to:'2026-11-25'},{from:'2026-02-30',to:'2026-03-01'},{from:'2026-11-23',to:'2026-11-22'}])assert.throws(()=>feishuSyncDates(value,NOW));
});

test('credential fingerprint is deterministic, secret-sensitive and never contains the secret',async()=>{
 const first=await feishuCredentialIdentity(credentials),again=await feishuCredentialIdentity(credentials),changed=await feishuCredentialIdentity({...credentials,appSecret:'different-fake-secret'});
 assert.deepEqual(first,again);assert.match(first.configSource,/^[a-f0-9]{64}$/);assert.notEqual(changed.configSource,first.configSource);assert.equal(JSON.stringify(first).includes(credentials.appSecret),false);
 await assert.rejects(feishuCredentialIdentity(null),e=>e.status===503);
});

test('one sync commits past attendance and future 30-day leave, with no duplicate same-day facts on repeated sync',async()=>{
 const f=await prepared();try{
  const todayLeave=leave({sourceId:'TEST-today-leave',workDate:'2026-11-24',startAt:'2026-11-24T02:00:00Z',endAt:'2026-11-24T11:00:00Z'}),mock=mockClient({attendance:[punch()],leaves:[todayLeave,leave()]});
  const result=await runFeishuSync(f.db,credentials,{},f.options(mock));assert.equal(result.ok,true);assert.equal(result.windows,3);
  assert.deepEqual(mock.calls.map(c=>[c.kind,c.from,c.to]),[['window','2026-11-18','2026-11-24'],['future','2026-11-24','2026-12-23']]);
  assert.equal(mock.calls.every(c=>c.externalUserId==='TEST-ID-OPS'&&c.timezone==='Asia/Jakarta'),true);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM feishu_records').get().n,3);
  const future=await readFeishuAttendance(f.db,f.users.indonesia,{month:'2026-12'});assert.equal(future.records.length,1);assert.equal(future.records[0].status,'approved');
  await runFeishuSync(f.db,credentials,{},f.options(mock));
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM feishu_records').get().n,3);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM feishu_sync_runs WHERE status='succeeded'").get().n,2);
 }finally{f.sqlite.close();}
});

test('future leave withdrawal updates the same identity, and missing source remains historical rather than guessed revoked',async()=>{
 const f=await prepared();try{
  await runFeishuSync(f.db,credentials,{},f.options(mockClient({leaves:[leave()]})));
  await runFeishuSync(f.db,credentials,{},f.options(mockClient({leaves:[leave({status:'revoked'})]})));
  const view=await readFeishuAttendance(f.db,f.users.indonesia,{month:'2026-12'});assert.equal(view.records.length,1);assert.equal(view.records[0].revision,2);assert.equal(view.records[0].status,'revoked');
  await runFeishuSync(f.db,credentials,{},f.options(mockClient()));
  const missing=await readFeishuAttendance(f.db,f.users.indonesia,{month:'2026-12'});assert.equal(missing.records[0].sourceMissing,true);assert.equal(missing.records[0].status,'revoked');
 }finally{f.sqlite.close();}
});

test('failed future read leaves existing future facts untouched and does not advance last successful sync',async()=>{
 const f=await prepared();try{
  await runFeishuSync(f.db,credentials,{},f.options(mockClient({leaves:[leave()]})));
  const before=(await getFeishuSettings(f.db)).lastSuccessAt,done=[];
  await assert.rejects(runFeishuSync(f.db,credentials,{},f.options({...mockClient({attendance:[punch()],onLeave:()=>{throw new FeishuClientError('permission');}}),onFinished:r=>done.push(r)})),e=>e.code==='feishu_permission');
  assert.deepEqual(done,[{success:false}]);
  const status=await getFeishuSettings(f.db);assert.equal(status.lastSuccessAt,before);assert.equal(status.lastError,'feishu_permission');assert.equal(status.running,false);
  const rows=(await readFeishuAttendance(f.db,f.users.indonesia,{month:'2026-12'})).records;assert.equal(rows[0].status,'approved');assert.equal(rows[0].sourceMissing,false);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM feishu_sync_runs WHERE status='failed'").get().n,1);
 }finally{f.sqlite.close();}
});

test('initial read failure cannot commit an empty authoritative window',async()=>{
 const f=await prepared();try{
  await assert.rejects(runFeishuSync(f.db,credentials,{},f.options(mockClient({onRead:()=>{throw new FeishuClientError('incomplete');}}))),e=>e.code==='feishu_incomplete');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM feishu_sync_windows').get().n,0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM feishu_records').get().n,0);
 }finally{f.sqlite.close();}
});

test('persisted lease rejects overlapping sync jobs while accepted background job continues independently',async()=>{
 const f=await prepared();let release;const paused=new Promise(resolve=>{release=resolve;});let started;const entered=new Promise(resolve=>{started=resolve;});let done;
 try{
  const mock=mockClient({onRead:async()=>{started();await paused;}});
  const accepted=await startFeishuSync(f.db,credentials,{},f.options({...mock,waitUntil:p=>{done=p;}}));
  assert.equal(accepted.accepted,true);await entered;
  await assert.rejects(runFeishuSync(f.db,credentials,{},f.options(mockClient())),e=>e.status===409);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM feishu_sync_runs WHERE status='running'").get().n,1);
  release();await done;
  assert.equal(f.sqlite.prepare('SELECT status FROM feishu_sync_runs WHERE id=?').get(accepted.runId).status,'succeeded');
 }finally{release();if(done)await done;f.sqlite.close();}
});

test('scheduled sync revisits old imported dates once per day, including records previously missing upstream',async()=>{
 const f=await prepared();try{
  const historic={from:'2026-10-01',to:'2026-10-07'},old=punch({sourceId:'TEST-old',workDate:'2026-10-02',punchedAt:'2026-10-02T02:00:00Z'});
  await runFeishuSync(f.db,credentials,historic,f.options(mockClient({attendance:[old]})));
  f.sqlite.prepare("UPDATE feishu_sync_windows SET completed_at=? WHERE date_to<'2026-11-01'").run(new Date(Date.now()-2*86400000).toISOString());
  const first=mockClient();await runFeishuSync(f.db,credentials,{},f.options({...first,trigger:'scheduled'}));
  assert.ok(first.calls.some(c=>c.kind==='window'&&c.from==='2026-10-02'&&c.to==='2026-10-08'));
  let history=await readFeishuAttendance(f.db,f.users.indonesia,{month:'2026-10'});assert.equal(history.records[0].sourceMissing,true);
  const second=mockClient();await runFeishuSync(f.db,credentials,{},f.options({...second,trigger:'scheduled'}));
  assert.equal(second.calls.some(c=>c.from<'2026-11-01'),false);
  f.sqlite.prepare("UPDATE feishu_sync_windows SET completed_at=? WHERE date_to<'2026-11-01'").run(new Date(Date.now()-2*86400000).toISOString());
  const recovered=mockClient({attendance:[old]});await runFeishuSync(f.db,credentials,{},f.options({...recovered,trigger:'scheduled'}));
  assert.ok(recovered.calls.some(c=>c.from==='2026-10-02'));
  history=await readFeishuAttendance(f.db,f.users.indonesia,{month:'2026-10'});assert.equal(history.records[0].sourceMissing,false);
 }finally{f.sqlite.close();}
});

test('manual selected-window sync does not silently sweep unrelated historic facts',async()=>{
 const f=await prepared();try{
  await runFeishuSync(f.db,credentials,{from:'2026-10-01',to:'2026-10-07'},f.options(mockClient({attendance:[punch({workDate:'2026-10-02',punchedAt:'2026-10-02T02:00:00Z'})]})));
  f.sqlite.prepare("UPDATE feishu_sync_windows SET completed_at='2026-01-01T00:00:00Z'").run();
  const mock=mockClient();await runFeishuSync(f.db,credentials,{},f.options(mock));
  assert.equal(mock.calls.some(c=>c.from<'2026-11-01'),false);
 }finally{f.sqlite.close();}
});

test('enable probe reads every valid mapping even when token cannot prove scope; probe does not import facts',async()=>{
 const f=await prepared({enabled:false,twoEmployees:true});try{
  const mock=mockClient({scope:'unverified',attendance:[punch()],leaves:[leave()]});
  const result=await testFeishuConnection(f.db,credentials,{...mock,requireMappings:true});
  assert.equal(result.checkedEmployees,2);assert.equal(result.attendanceScope,'unverified');
  assert.deepEqual(mock.calls.filter(c=>c.kind==='window').map(c=>c.externalUserId).sort(),['TEST-ID-OPS','TEST-MY-OPS']);
  assert.equal(mock.calls.filter(c=>c.kind==='window').every(c=>c.from===c.to),true);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM feishu_records').get().n,0);
  assert.equal((await getFeishuSettings(f.db)).connectionStatus,'passed');
 }finally{f.sqlite.close();}
});

test('probe rejects missing mappings, incomplete employee visibility and concurrent mapping changes',async()=>{
 const f=await prepared({enabled:false,twoEmployees:true});try{
  await assert.rejects(testFeishuConnection(f.db,credentials,{...mockClient({onRead:options=>{if(options.externalUserId==='TEST-MY-OPS')throw new FeishuClientError('permission');}}),requireMappings:true}),e=>e.code==='feishu_permission');
  assert.equal((await getFeishuSettings(f.db)).connectionStatus,'failed');
  let changed=false;
  await assert.rejects(testFeishuConnection(f.db,credentials,{...mockClient({onRead:()=>{if(!changed){changed=true;f.sqlite.prepare('UPDATE feishu_user_links SET active=0,version=version+1 WHERE id=?').run(f.second.id);}}}),requireMappings:true}),e=>e.status===409);
  f.sqlite.prepare('UPDATE feishu_user_links SET active=0').run();
  await assert.rejects(testFeishuConnection(f.db,credentials,{...mockClient(),requireMappings:true}),e=>e.status===409);
  assert.equal((await getFeishuSettings(f.db)).connectionStatus,'failed');
 }finally{f.sqlite.close();}
});

test('missing required scope blocks connection; ordinary credential test has no false employee verification count',async()=>{
 const f=await prepared({enabled:false});try{
  await assert.rejects(testFeishuConnection(f.db,credentials,{...mockClient({scope:'missing'}),requireMappings:true}),e=>e.code==='attendance_scope_missing');
  const result=await testFeishuConnection(f.db,credentials,mockClient({scope:'unverified'}));assert.equal(result.checkedEmployees,0);assert.equal(result.attendanceScope,'unverified');
  await assert.rejects(testFeishuConnection(f.db,{...credentials,appId:'cli_OTHER'},mockClient()),e=>e.status===409);
 }finally{f.sqlite.close();}
});

test('manual sync requires current administrator, and all persisted run/config data exclude application secret',async()=>{
 const f=await prepared();try{
  await assert.rejects(runFeishuSync(f.db,credentials,{},f.options({...mockClient(),actorId:f.users.indonesia.id})),e=>e.status===403);
  await runFeishuSync(f.db,credentials,{},f.options(mockClient()));
  for(const table of ['feishu_settings','feishu_sync_runs','feishu_sync_state','feishu_sync_windows','feishu_records','audit_logs'])assert.equal(JSON.stringify(f.sqlite.prepare(`SELECT * FROM ${table}`).all()).includes(credentials.appSecret),false);
  assert.equal(JSON.stringify(await getFeishuSettings(f.db)).includes(credentials.appSecret),false);
 }finally{f.sqlite.close();}
});
