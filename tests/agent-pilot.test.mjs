import test from 'node:test';
import assert from 'node:assert/strict';
import {marketingSamplesFixture} from './marketing-samples-fixture.mjs';
import {configurePilot,pilotSettings,pilotWeek,readPilot,runPilot,mutatePilot,pilotWorkspaceTasks} from '../lib/agent-pilot.mjs';
import {workspaceTasks} from '../lib/workspace-tasks.mjs';
import {tickAgentPilot} from '../server/agent-pilot-monitor.mjs';
const now=new Date('2026-11-26T03:00:00Z');
async function prepared(enabled=true){
 const f=marketingSamplesFixture();
 f.configure=(more={})=>pilotSettings(f.db).then(s=>configurePilot(f.db,f.users.admin,{version:s.version,creatorScopeId:'sample-scope',supplyOwnerId:f.users.supply.id,prioritySkus:['BAG-A'],dailyTime:'10:00',scopeVerified:true,exclusiveConfirmed:true,enabled,reason:'TEST verified single store',...more},now));
 await f.configure();return f;
}
const finding=(overrides={})=>({key:'test-stock',kind:'stockout',title:'TEST 主推款待核对',state:'active',priority:'high',ownerId:'supply-1',ownerName:'供应链甲',ownerRole:'供应链',reviewDate:'2026-11-27',evidence:[{label:'原始证据',value:'库存3件、日销1件',source:'TEST'}],impact:'核对下一批实际到仓，不自动补货',...overrides});
const evaluator=(findings,extra={})=>async()=>({findings,metrics:{sampleCosts:{secret:'TEST-COST'},freightCosts:{secret:'TEST-FREIGHT'}},coverage:{complete:true,authoritative:true},...extra});
test('single-store setup defaults disabled and requires active owners, SKU and explicit aggregate attestation',async()=>{
 const f=marketingSamplesFixture();try{
  assert.equal((await pilotSettings(f.db)).enabled,false);
  await assert.rejects(configurePilot(f.db,f.users.indonesia,{}),e=>e.status===403);
  const p={version:1,creatorScopeId:'sample-scope',supplyOwnerId:'supply-1',prioritySkus:['BAG-A'],scopeVerified:true,enabled:true,reason:'TEST setup'};
  await assert.rejects(configurePilot(f.db,f.users.admin,p),/确认/);
  await assert.rejects(configurePilot(f.db,f.users.admin,{...p,exclusiveConfirmed:true,prioritySkus:['missing']}),/SKU/);
  await configurePilot(f.db,f.users.admin,{...p,exclusiveConfirmed:true},now);
  assert.equal((await pilotSettings(f.db)).config.scopeVersion,1);
  await assert.rejects(configurePilot(f.db,f.users.admin,{...p,exclusiveConfirmed:true}),e=>e.status===409);
 }finally{f.sqlite.close();}
});
test('repeat runs keep one task, preserve owner followup dates and only explicit clear closes',async()=>{
 const f=await prepared();try{
  await runPilot(f.db,{now,agents:['operating'],evaluator:evaluator([finding()])});
  const t=f.sqlite.prepare('SELECT * FROM agent_pilot_tasks').get();
  await mutatePilot(f.db,f.users.supply,{action:'acknowledge',id:t.id,version:t.version,note:'TEST核对到仓凭据',reviewDate:'2026-11-29'},now);
  const next=new Date('2026-11-27T03:00:00Z');
  await runPilot(f.db,{now:next,agents:['operating'],evaluator:evaluator([finding({reviewDate:'2026-11-28'})]),saveWeekly:true});
  let current=f.sqlite.prepare('SELECT * FROM agent_pilot_tasks').get();assert.equal(current.id,t.id);assert.equal(current.status,'acknowledged');assert.equal(current.review_date,'2026-11-29');
  const weekly=JSON.parse(f.sqlite.prepare("SELECT result_json FROM agent_pilot_runs WHERE period_type='weekly'").get().result_json);assert.equal(weekly.decisions[0].reviewDate,'2026-11-29');
  await runPilot(f.db,{now:next,agents:['operating'],evaluator:evaluator([])});assert.equal(f.sqlite.prepare('SELECT status FROM agent_pilot_tasks').get().status,'acknowledged');
  await runPilot(f.db,{now:next,agents:['operating'],evaluator:evaluator([finding({state:'clear'})])});assert.equal(f.sqlite.prepare('SELECT status FROM agent_pilot_tasks').get().status,'resolved');
  await runPilot(f.db,{now:next,agents:['operating'],evaluator:evaluator([finding()])});assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM agent_pilot_tasks').get().n,1);assert.equal(f.sqlite.prepare('SELECT status FROM agent_pilot_tasks').get().status,'open');
 }finally{f.sqlite.close();}
});
test('busy, source mutation and unreadable creator data cannot publish a false successful run',async()=>{
 const f=await prepared();try{
  f.sqlite.prepare("INSERT INTO agent_pilot_lock VALUES('global','OTHER',?)").run('2026-11-27T03:00:00Z');assert.equal((await runPilot(f.db,{now})).skipped,'busy');f.sqlite.exec('DELETE FROM agent_pilot_lock');
  await assert.rejects(runPilot(f.db,{now,agents:['creator'],evaluator:evaluator([],{coverage:{authoritative:false}})}),/未完整/);
  await assert.rejects(runPilot(f.db,{now,agents:['operating'],evaluator:async()=>{f.sqlite.prepare("UPDATE creator_scopes SET version=version+1 WHERE id='sample-scope'").run();return evaluator([finding()])();}}),e=>e.status===409);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM agent_pilot_runs').get().n,0);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM agent_pilot_tasks').get().n,0);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM agent_pilot_lock').get().n,0);
 }finally{f.sqlite.close();}
});
test('weekly decisions capped at three and finance costs absent from operator responses',async()=>{
 const f=await prepared();try{
  await runPilot(f.db,{now,agents:['creator'],saveWeekly:true,evaluator:evaluator(Array.from({length:5},(_,i)=>finding({key:'test-'+i,ownerId:f.users.bd.id,ownerRole:'达人BD'})))});
  const admin=await readPilot(f.db,f.users.admin,now),ops=await readPilot(f.db,f.users.indonesia,now);
  const a=admin.reports.find(r=>r.period_type==='weekly'),o=ops.reports.find(r=>r.period_type==='weekly');assert.equal(a.result.decisions.length,3);assert.equal(a.result.metrics.sampleCosts.secret,'TEST-COST');assert.equal(o.result.metrics.sampleCosts,undefined);assert.equal(o.result.metrics.freightCosts,undefined);
  await assert.rejects(readPilot(f.db,f.users.malaysia,now),e=>e.status===403);await assert.rejects(readPilot(f.db,f.users.other,now),e=>e.status===403);
 }finally{f.sqlite.close();}
});
test('source evidence tasks do not modify sales inventory ads sample orders or contacts',async()=>{
 const f=await prepared();try{
  const tables=['inventory_balances','sales_records','sales_ad_spend','marketing_sample_orders','creator_contents'];
  const snap=()=>JSON.stringify(tables.map(t=>f.sqlite.prepare('SELECT * FROM '+t).all()));const before=snap();
  await runPilot(f.db,{now});assert.equal(snap(),before);assert.ok((await pilotWorkspaceTasks(f.db,f.users.indonesia,now)).every(t=>t.tab==='agent-pilot'));
 }finally{f.sqlite.close();}
});
test('disabled pilot does not run and scheduler catches up once after Shanghai time',async()=>{
 const f=await prepared(false);try{
  assert.equal((await tickAgentPilot(f.db,now)).skipped,'disabled');await f.configure({enabled:true});
  await tickAgentPilot(f.db,new Date('2026-11-26T01:59:00Z'));assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM agent_pilot_runs').get().n,0);
  await tickAgentPilot(f.db,now);const before=f.sqlite.prepare('SELECT COUNT(*) n FROM agent_pilot_runs').get().n;assert.equal(before,4);
  await tickAgentPilot(f.db,new Date(+now+60000));assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM agent_pilot_runs').get().n,before);
  await f.configure({prioritySkus:['BAG-B']});await tickAgentPilot(f.db,now);assert.ok(f.sqlite.prepare("SELECT result_json FROM agent_pilot_runs WHERE period_type='daily'").all().every(r=>JSON.parse(r.result_json).configVersion===3));
  assert.deepEqual(pilotWeek(new Date('2026-11-23T03:00:00Z')),{start:'2026-11-16',end:'2026-11-22'});
 }finally{f.sqlite.close();}
});
test('real received sample: BD reviews and copies unsent draft; video association immediately revokes it',async()=>{
 const f=await prepared();try{
  const id=(await f.create()).id;await f.approve(id);await f.assign(id);await f.ship(id);
  await f.change(f.users.bd,id,'receipt',{shipmentId:f.shipment(id).id,receivedAt:new Date().toISOString(),receiver:'TEST recipient',proofRef:'TEST signed'});
  const at=new Date(Date.now()+1000);f.sqlite.prepare("UPDATE creator_rounds SET effective_due_at=? WHERE id='sample-round'").run(new Date(+at-3600000).toISOString());
  await runPilot(f.db,{now:at,agents:['creator']});let t=(await readPilot(f.db,f.users.bd,at)).tasks[0];assert.equal(t.finding.state,'active');
  const work=await workspaceTasks(f.db,f.users.bd);assert.equal(work.filter(t=>t.tab==='agent-pilot').length,1);assert.equal(work.filter(t=>t.taskKey==='marketing-sample:'+id+':content').length,0);
  await assert.rejects(mutatePilot(f.db,f.users.indonesia,{action:'reviewDraft',id:t.id,version:t.version,confirmed:true},at),e=>e.status===403||e.status===404);
  await mutatePilot(f.db,f.users.bd,{action:'reviewDraft',id:t.id,version:t.version,confirmed:true},at);t=(await readPilot(f.db,f.users.bd,at)).tasks[0];
  const draft=await mutatePilot(f.db,f.users.bd,{action:'copyDraft',id:t.id,version:t.version},at);assert.equal(draft.sent,false);assert.match(draft.text,/Halo Kak/);
  f.sqlite.prepare("INSERT INTO creator_contents(id,round_id,kind,url,published_at,status,data_json,created_at,updated_at) VALUES('TEST-VIDEO','sample-round','video','https://www.tiktok.com/@test/video/123456789',?,'pending','{}',?,?)").run(at.toISOString(),at.toISOString(),at.toISOString());
  await assert.rejects(mutatePilot(f.db,f.users.bd,{action:'copyDraft',id:t.id,version:t.version},at),e=>e.status===409);
  const done=(await readPilot(f.db,f.users.bd,at)).tasks[0];assert.equal(done.status,'resolved');assert.equal(done.finding.draft,undefined);
 }finally{f.sqlite.close();}
});
test('reassignment resets responsibility and a published weekly snapshot is not overwritten',async()=>{
 const f=await prepared();try{
  await runPilot(f.db,{now,agents:['creator'],saveWeekly:true,evaluator:evaluator([finding({ownerId:f.users.bd.id,draft:{text:'TEST draft'}})])});
  let t=f.sqlite.prepare('SELECT * FROM agent_pilot_tasks').get();
  await mutatePilot(f.db,f.users.bd,{action:'acknowledge',id:t.id,version:t.version,note:'TEST 已核对等回复',reviewDate:'2026-11-29'},now);
  const archive=f.sqlite.prepare("SELECT result_json FROM agent_pilot_runs WHERE period_type='weekly'").get().result_json;
  await runPilot(f.db,{now:new Date('2026-11-27T03:00:00Z'),agents:['creator'],saveWeekly:true,evaluator:evaluator([finding({ownerId:f.users.other.id,reviewDate:'2026-11-28',draft:{text:'TEST draft'}})])});
  t=f.sqlite.prepare('SELECT * FROM agent_pilot_tasks').get();assert.equal(t.status,'open');assert.equal(t.note,'');assert.equal(t.review_date,'2026-11-28');assert.equal(t.draft_review_json,null);
  const e=f.sqlite.prepare("SELECT detail_json FROM agent_pilot_events WHERE event='reassigned'").get();assert.equal(JSON.parse(e.detail_json).previousNote,'TEST 已核对等回复');
  assert.equal(f.sqlite.prepare("SELECT result_json FROM agent_pilot_runs WHERE period_type='weekly'").get().result_json,archive);
 }finally{f.sqlite.close();}
});
test('BD weekly report includes only owned cohorts and never exposes finance costs or other owners',async()=>{
 const f=await prepared();try{
  const own={metrics:{deliveryRate:{numerator:1,denominator:2},sampleCosts:{secret:'OWN-COST'},freightCosts:{secret:'OWN-FREIGHT'}},coverage:{authoritative:true}};
  const foreign={metrics:{secret:'OTHER-OWNER'},coverage:{authoritative:true}};
  await runPilot(f.db,{now,agents:['creator'],saveWeekly:true,evaluator:evaluator([finding({key:'own',ownerId:f.users.bd.id}),finding({key:'foreign',ownerId:f.users.other.id})],{ownerReports:{[f.users.bd.id]:own,[f.users.other.id]:foreign}})});
  const d=await readPilot(f.db,f.users.bd,now),r=d.reports.find(r=>r.period_type==='weekly');
  assert.equal(r.result.metrics.deliveryRate.denominator,2);assert.equal(r.result.decisions.length,1);assert.equal(r.result.decisions[0].ownerId,f.users.bd.id);
  assert.doesNotMatch(JSON.stringify(d),/OWN-COST|OWN-FREIGHT|OTHER-OWNER/);assert.equal(r.result.ownerReports,undefined);
 }finally{f.sqlite.close();}
});

test('unverified shop evidence is assigned to the active operator without treating business data as single-store facts',async()=>{
 const f=await prepared();try{
  await f.configure({scopeVerified:false});await runPilot(f.db,{now,agents:['operating']});
  const task=f.sqlite.prepare("SELECT * FROM agent_pilot_tasks WHERE agent='operating'").get();assert.equal(task.owner_id,f.users.indonesia.id);assert.equal(JSON.parse(task.finding_json).state,'unknown');
 }finally{f.sqlite.close();}
});
