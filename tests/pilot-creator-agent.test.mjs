import test from 'node:test';
import assert from 'node:assert/strict';
import {creatorPilotWeek,evaluateCreatorPilot,loadCreatorPilotData} from '../lib/pilot-creator-agent.mjs';
import {marketingSamplesFixture} from './marketing-samples-fixture.mjs';

const now = new Date('2026-11-26T03:00:00Z');
const config = {creatorScopeId:'store-1',shopId:'store-1',weekly:{start:'2026-11-16',end:'2026-11-22'}};
function data(){return {
 scope:{id:'store-1',site:'印尼',platform:'TikTok',shop:'Only shop',bd_id:'bd'},coverage:{complete:true,authoritative:true},
 rounds:[{id:'r1',round_no:'BD-1',creator_id:'c1',creator_name:'Rina',creator_state:'fulfilling',status:'executing',terms_json:'{"videos":1}',approved_at:'2026-11-01T00:00:00Z',effective_due_at:'2026-11-20T10:00:00Z'}],
 orders:[{id:'o1',order_no:'ID-1',round_id:'r1',scope_id:'store-1',status:'received'}],
 shipments:[{id:'s1',order_id:'o1',business_date:'2026-11-17',shipped_at:'2026-11-17T02:00:00Z'}],
 receipts:[{id:'receipt-1',order_id:'o1',shipment_id:'s1',received_at:'2026-11-18T03:00:00Z',proof_ref:'Signed receipt'}],
 contents:[],observations:[],costs:[],users:[{id:'bd',name:'负责 BD',role:'达人BD',active:1}],rateMap:{}};}
function video(extra={}){return {id:'v1',round_id:'r1',kind:'video',url:'https://www.tiktok.com/@creator/video/123456789',published_at:'2026-11-19T00:00:00Z',created_at:'2026-11-19T01:00:00Z',status:'pending',...extra};}
const run=(d=data(),cfg=config,at=now)=>evaluateCreatorPilot(d,cfg,at);

test('received overdue sample creates one stable finding and an unsent Indonesian draft',()=>{
 const d=data(),result=run(d),finding=result.findings[0];
 assert.equal(result.findings.length,1);assert.equal(finding.key,'creator:r1');assert.equal(finding.state,'active');assert.equal(finding.ownerId,'bd');assert.equal(finding.reviewDate,'2026-11-27');
 assert.equal(new URL(finding.sourceUrl,'https://admin.example.test').searchParams.get('entity'),'o1');
 assert.equal(finding.draft.language,'id');assert.equal(finding.draft.reviewRequired,true);assert.match(finding.draft.text,/Halo Kak Rina/);assert.match(finding.draft.text,/WIB/);assert.doesNotMatch(finding.draft.text,/[\u3400-\u9fff]/);
 assert.equal(run(d,config,new Date('2026-11-27T03:00:00Z')).findings[0].key,finding.key);
 assert.deepEqual(d,data());assert.equal(result.metrics.deliveryRate.denominator,1);assert.equal(result.metrics.deliveryRate.value,0);
});

test('one associated pending video stops reminders immediately while unaccepted delivery stays distinct',()=>{
 const d=data();d.contents.push(video());const r=run(d);assert.equal(r.findings[0].state,'clear');assert.equal(r.findings[0].closedReason,'video_linked');assert.equal(r.findings[0].draft,undefined);
 assert.ok(r.findings[0].evidence.some(e=>e.url===d.contents[0].url));assert.equal(r.metrics.deliveryRate.value,1);assert.equal(r.metrics.acceptedDeliveryRate.value,0);
 d.rounds[0].terms_json='{"videos":2}';assert.equal(run(d).findings[0].state,'clear');assert.equal(run(d).metrics.deliveryRate.value,0);
});

test('future or malformed video never silently resolves an overdue obligation',()=>{
 for(const overrides of [{url:'javascript:alert(1)'},{published_at:'2027-01-01T00:00:00Z'},{kind:'live'},{status:'deleted'}]){const d=data();d.contents=[video(overrides)];assert.equal(run(d).findings[0].state,'active');}
});

test('unreceived, partially received and future-dated receipts do not produce a draft',()=>{
 for(const prepare of [d=>d.receipts=[],d=>d.orders[0].status='partial',d=>d.receipts[0].received_at='2027-01-01T00:00:00Z',d=>d.receipts[0].received_at='2026-11-01T00:00:00Z',d=>d.shipments.push({id:'s2',order_id:'o1',shipped_at:'2026-11-18T00:00:00Z'})]){
  const d=data();prepare(d);const r=run(d);assert.equal(r.findings[0].state,'clear');assert.equal(r.findings[0].draft,undefined);assert.equal(r.metrics.deliveryRate.value,null);
 }
});

test('cancelled paused archived deleted and sample-only obligations stop without outreach',()=>{
 for(const prepare of [d=>d.rounds[0].status='cancelled',d=>d.rounds[0].creator_state='paused',d=>d.rounds[0].test_archived_at='2026-11-22',d=>d.rounds[0].deleted_at='2026-11-22',d=>d.orders[0].status='cancelled',d=>d.rounds[0].terms_json='{"sampleOnly":true,"videos":0}',d=>d.rounds[0].terms_json='{"lives":1,"videos":0}']){
  const d=data();prepare(d);const r=run(d);assert.equal(r.findings[0].state,'clear');assert.equal(r.findings[0].draft,undefined);assert.equal(r.metrics.deliveryRate.denominator,0);
 }
});

test('missing dates and inactive owners remain unknown, never claimed overdue',()=>{
 for(const due of ['',null,'bad','2026-11-20']){const d=data();d.rounds[0].effective_due_at=due;const f=run(d).findings[0];assert.equal(f.state,'unknown');assert.equal(f.draft,undefined);}
 const d=data();d.users[0].active=0;assert.equal(run(d).findings[0].state,'unknown');assert.equal(run(d).findings[0].ownerId,null);
});

test('approved extension and precise deadline stop the old reminder without resetting its key',()=>{
 const d=data();d.rounds[0].original_due_at='2026-11-10T03:00:00Z';d.rounds[0].effective_due_at=now.toISOString();assert.equal(run(d).findings[0].state,'clear');assert.equal(run(d,config,new Date(+now+1)).findings[0].state,'active');
 d.rounds[0].effective_due_at='2026-12-01T03:00:00Z';assert.equal(run(d).findings[0].closedReason,'not_due');assert.equal(run(d).findings[0].key,'creator:r1');
});

test('single store isolation excludes other-store orders and invalid coverage cannot clear old tasks',()=>{
 const d=data();d.orders[0].scope_id='other';assert.equal(run(d).findings.length,0);
 for(const changed of [{scope:null},{scope:{...data().scope,site:'泰国'}},{coverage:{complete:false,authoritative:false,reason:'read failed'}}]){const r=run({...data(),...changed});assert.equal(r.coverage.authoritative,false);assert.deepEqual(r.findings,[]);assert.equal(r.metrics,null);}
 assert.equal(run(data(),{...config,creatorScopeId:'other'}).coverage.authoritative,false);
 assert.equal(run(data(),{...config,shopId:'other'}).coverage.authoritative,false);
});

test('weekly denominator uses Indonesian due date, excludes future cohorts and counts sufficient videos only',()=>{
 const d=data();d.contents=[video({status:'accepted'})];d.rounds[0].effective_due_at='2026-11-22T17:00:00Z';assert.equal(run(d).metrics.deliveryRate.denominator,0); // Monday in Jakarta.
 d.rounds[0].effective_due_at='2026-11-22T16:59:59Z';assert.equal(run(d).metrics.deliveryRate.value,1);
 d.contents[0].created_at='2026-11-23T00:00:00Z';assert.equal(run(d).metrics.deliveryRate.value,0);
 d.receipts[0].received_at='2026-11-23T00:00:00Z';assert.equal(run(d).metrics.deliveryRate.denominator,0);
});

test('week selection follows Jakarta calendar and validates supplied ranges',()=>{
 assert.deepEqual(creatorPilotWeek({},new Date('2026-11-22T17:05:00Z')),{start:'2026-11-16',end:'2026-11-22'});
 assert.deepEqual(creatorPilotWeek({},now),{start:'2026-11-16',end:'2026-11-22'});
 assert.throws(()=>creatorPilotWeek({weekly:{start:'2026-02-30',end:'2026-03-01'}}),/有效/);
 assert.throws(()=>creatorPilotWeek({weekly:{start:'2026-11-01',end:'2026-11-22'}}),/七日/);
});

test('video attribution selects latest longest mature window once, missing is not zero and cross-week is not weekly sales',()=>{
 const d=data();d.contents=[video({published_at:'2026-10-01T00:00:00Z'})];
 d.observations=[
  {id:'7a',content_id:'v1',window_days:7,revision:1,observed_at:'2026-10-08T00:00:00Z',data_json:'{"orders":10}'},
  {id:'30a',content_id:'v1',window_days:30,revision:1,observed_at:'2026-10-31T00:00:00Z',data_json:'{"orders":40}'},
  {id:'30b',content_id:'v1',window_days:30,revision:2,observed_at:'2026-11-01T00:00:00Z',data_json:'{"orders":35}'}];
 let m=run(d).metrics;assert.equal(m.orders.knownTotal,35);assert.equal(m.orders.lines.length,1);assert.equal(m.weeklyOrders.knownTotal,null);
 d.observations.at(-1).data_json='{"orders":null}';m=run(d).metrics;assert.equal(m.orders.knownTotal,null);assert.equal(m.orders.missingVideos,1);
 d.observations.at(-1).data_json='{"orders":0}';assert.equal(run(d).metrics.orders.knownTotal,0);
});

test('unmature observations are not sold as results',()=>{
 const d=data();d.contents=[video()];d.observations=[{id:'unmature',content_id:'v1',window_days:30,revision:1,observed_at:now.toISOString(),data_json:'{"orders":100}'}];assert.equal(run(d).metrics.orders.knownTotal,null);
});

test('sample and freight are separate confirmed original-currency costs, no invented exchange rate',()=>{
 const d=data();d.costs=[{id:'cost1',order_id:'o1',shipment_id:'s1',kind:'sample',revision:1,business_date:'2026-11-18',currency:'IDR',amount_minor:100000,source_ref:'invoice1'},
 {id:'cost2',order_id:'o1',shipment_id:'s1',kind:'freight',revision:1,business_date:'2026-11-18',currency:'CNY',amount_minor:300,source_ref:'invoice2'}];
 let m=run(d).metrics;assert.equal(m.sampleCosts.knownCnyMinor,null);assert.equal(m.sampleCosts.missingRateCount,1);assert.equal(m.sampleCosts.currencies.IDR,100000);assert.equal(m.freightCosts.knownCnyMinor,300);
 d.rateMap={'2026-11':{IDR:{rate:0.0004,id:'finance-rate'}}};m=run(d).metrics;assert.equal(m.sampleCosts.knownCnyMinor,40);assert.equal(m.sampleCosts.lines[0].rateId,'finance-rate');assert.equal(m.sampleCosts.pendingShipmentCount,0);
});

test('cost revisions moved outside a week do not revive obsolete values or collapse unknown to zero',()=>{
 const d=data();d.costs=[{id:'c1',order_id:'o1',shipment_id:'s1',kind:'sample',revision:1,business_date:'2026-11-18',currency:'CNY',amount_minor:100},
 {id:'c2',order_id:'o1',shipment_id:'s1',kind:'sample',revision:2,business_date:'2026-11-24',currency:'CNY',amount_minor:300}];
 const m=run(d).metrics;assert.equal(m.sampleCosts.lines.length,0);assert.equal(m.sampleCosts.pendingShipmentCount,1);assert.equal(m.sampleCosts.knownCnyMinor,null);assert.equal(m.freightCosts.pendingShipmentCount,1);
});

test('real adapter reads only one scoped shop and excludes recipient private fields',async t=>{
 t.mock.timers.enable({apis:['Date'],now});const f=marketingSamplesFixture();try{
  const {id}=await f.create();await f.approve(id);await f.assign(id);await f.ship(id);
  await f.change(f.users.bd,id,'receipt',{shipmentId:f.shipment(id).id,receivedAt:now.toISOString(),receiver:'PRIVATE RECEIVER',proofRef:'Signed receipt'});
  f.sqlite.prepare("UPDATE creator_rounds SET effective_due_at='2026-11-26T02:00:00Z' WHERE id='sample-round'").run();
  const cfg={creatorScopeId:'sample-scope',shopId:'sample-scope'},loaded=await loadCreatorPilotData(f.db,cfg,now);assert.equal(loaded.coverage.complete,true);assert.equal(loaded.orders.length,1);assert.doesNotMatch(JSON.stringify(loaded),/PRIVATE RECEIVER|Test address|628120000/);
  assert.equal(evaluateCreatorPilot(loaded,cfg,now).findings[0].state,'active');
  const other=await loadCreatorPilotData(f.db,{creatorScopeId:'nonexistent'},now);assert.equal(other.coverage.authoritative,false);
  assert.equal((await loadCreatorPilotData(f.db,{...cfg,shopId:'other'},now)).coverage.authoritative,false);
 }finally{f.sqlite.close();}
});

test('database read failure rejects instead of authoritatively clearing pending reminders',async()=>{
 const broken={prepare:()=>{throw new Error('offline');}};await assert.rejects(()=>loadCreatorPilotData(broken,{creatorScopeId:'store-1'},now),/offline/);
 const missing=await loadCreatorPilotData(broken,{},now);assert.equal(missing.coverage.complete,false);
});
