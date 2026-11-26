import test from 'node:test';
import assert from 'node:assert/strict';
import {workplaceFixture} from './workplace-fixture.mjs';
import {scheduleFeishuAttendance} from '../server/feishu-attendance-monitor.mjs';
import {getFeishuSettings,saveFeishuSettings,recordFeishuConnectionCheck} from '../lib/feishu-store.mjs';
import {feishuCredentialIdentity} from '../lib/feishu-sync.mjs';

const credentials={appId:'cli_TEST_ONLY',appSecret:'FAKE_MONITOR_PRIVATE_SECRET_587'};
async function enabledFixture(){
 const f=await workplaceFixture(),identity=await feishuCredentialIdentity(credentials);
 await saveFeishuSettings(f.db,f.users.admin,{version:1,enabled:false,appId:credentials.appId,idType:'employee_id',reason:'TEST setup'});
 await recordFeishuConnectionCheck(f.db,{version:2,...identity,ok:true});
 await saveFeishuSettings(f.db,f.users.admin,{version:2,enabled:true,reason:'TEST enabled'},identity);
 return f;
}
const noFetch=t=>{let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;throw Error('TEST network must not be reached');});return()=>calls;};

test('default-disabled monitor never reads the private credentials and never invokes a network request',async t=>{
 const f=await workplaceFixture(),networkCalls=noFetch(t);let credentialReads=0;
 const monitor=scheduleFeishuAttendance({DB:f.db,readFeishuCredentials(){credentialReads++;throw Error(credentials.appSecret);}});
 try{await monitor.run();assert.equal(credentialReads,0);assert.equal(networkCalls(),0);assert.equal((await getFeishuSettings(f.db)).connectionStatus,'untested');assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM feishu_sync_runs').get().n,0);}
 finally{monitor.stop();f.sqlite.close();}
});

test('enabled monitor records unavailable credentials as failed without exposing file content or making API calls',async t=>{
 const networkCalls=noFetch(t);
 for(const readFeishuCredentials of [()=>null,()=>{throw Error(`/private/secret-file ${credentials.appSecret}`); }]){
  const f=await enabledFixture(),monitor=scheduleFeishuAttendance({DB:f.db,readFeishuCredentials});
  try{
   const previousSuccess='2026-11-20T01:00:00.000Z';f.sqlite.prepare("UPDATE feishu_sync_state SET last_success_at=? WHERE id='global'").run(previousSuccess);
   await monitor.run();const state=await getFeishuSettings(f.db);
   assert.equal(state.connectionStatus,'failed');assert.equal(state.lastError,'credentials_unavailable');assert.equal(state.lastSuccessAt,previousSuccess);assert.equal(networkCalls(),0);
   assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM feishu_sync_runs').get().n,0);
   assert.equal(JSON.stringify(state).includes(credentials.appSecret),false);assert.equal(JSON.stringify(state).includes('/private/'),false);
   const once=state.connectionCheckedAt;await monitor.run();assert.equal((await getFeishuSettings(f.db)).connectionCheckedAt,once);
  }finally{monitor.stop();f.sqlite.close();}
 }
});

test('changed App ID and changed Secret invalidate prior connection verification without fetching',async t=>{
 const networkCalls=noFetch(t);
 for(const changed of [{...credentials,appId:'cli_OTHER_TEST'},{...credentials,appSecret:'FAKE_ROTATED_MONITOR_SECRET'}]){
  const f=await enabledFixture(),monitor=scheduleFeishuAttendance({DB:f.db,readFeishuCredentials:()=>changed});
  try{
   await monitor.run();const state=await getFeishuSettings(f.db),stored=f.sqlite.prepare("SELECT * FROM feishu_settings WHERE id='global'").get();
   assert.equal(state.connectionStatus,'failed');assert.equal(state.lastError,'credentials_changed');assert.equal(state.appId,credentials.appId);assert.equal(stored.connection_version,null);
   assert.equal(networkCalls(),0);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM feishu_sync_runs').get().n,0);
   assert.equal(JSON.stringify(stored).includes(changed.appSecret),false);assert.equal(JSON.stringify(stored).includes(credentials.appSecret),false);
  }finally{monitor.stop();f.sqlite.close();}
 }
});

test('recent attempts defer scheduled work, so a monitor cycle never duplicates a recent manual run',async t=>{
 const f=await enabledFixture(),networkCalls=noFetch(t);let reads=0;
 const monitor=scheduleFeishuAttendance({DB:f.db,readFeishuCredentials:()=>{reads++;return credentials;}},{intervalMs:600000});
 try{
  f.sqlite.prepare("UPDATE feishu_sync_state SET last_attempt_at=? WHERE id='global'").run(new Date().toISOString());
  await monitor.run();assert.equal(reads,0);assert.equal(networkCalls(),0);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM feishu_sync_runs').get().n,0);
 }finally{monitor.stop();f.sqlite.close();}
});

test('stop clears initial and recurring timers and can be called more than once',async t=>{
 const f=await workplaceFixture();let reads=0;
 t.mock.timers.enable({apis:['setTimeout','setInterval']});
 const db={...f.db,prepare(sql){reads++;return f.db.prepare(sql);}},monitor=scheduleFeishuAttendance({DB:db,readFeishuCredentials:()=>{throw Error('Must not read');}},{intervalMs:600000});
 try{
  monitor.stop();monitor.stop();t.mock.timers.tick(1200000);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(reads,0);
 }finally{monitor.stop();t.mock.timers.reset();f.sqlite.close();}
});

test('concurrent run calls share the in-process running guard and do not start duplicate work',async t=>{
 const f=await workplaceFixture(),networkCalls=noFetch(t);let release,settingsReads=0;
 const gate=new Promise(resolve=>{release=resolve;});
 const db={...f.db,prepare(sql){const statement=f.db.prepare(sql);if(sql!=="SELECT * FROM feishu_settings WHERE id='global'")return statement;return {...statement,async first(){settingsReads++;await gate;return statement.first();}};}};
 const monitor=scheduleFeishuAttendance({DB:db,readFeishuCredentials:()=>{throw Error('Disabled');}});
 let first;
 try{
  first=monitor.run();await monitor.run();assert.equal(settingsReads,1);release();await first;
  assert.equal(networkCalls(),0);await monitor.run();assert.equal(settingsReads,2);
 }finally{release();if(first)await first;monitor.stop();f.sqlite.close();}
});
