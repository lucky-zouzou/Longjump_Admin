import test from 'node:test';
import assert from 'node:assert/strict';
import {marketingSamplesFixture} from './marketing-samples-fixture.mjs';
import {readMarketingSamples} from '../lib/marketing-samples.mjs';
import {mutateCreator} from '../lib/creators.mjs';
import {sampleCreatorUrl,sampleRoundUrl} from '../lib/marketing-sample-application.mjs';
const setup=t=>{const f=marketingSamplesFixture();t.after(()=>f.sqlite.close());return f;};
const read=f=>readMarketingSamples(f.db,f.users.bd);
const terms={items:[{sku:'BAG-A',sampleQty:2}],method:'commission',commission:'8',videos:1,lives:0,dueAt:'2099-12-01T00:00:00Z'};

test('screenshot regression: historical dispatches explain the empty form and allow a separate new round',async t=>{
 const f=setup(t);f.sqlite.prepare("UPDATE creator_rounds SET logistics_json=?").run(JSON.stringify({dispatch:{orderNumber:'OLD-SAMPLE',qty:4}}));
 f.sqlite.prepare("UPDATE creator_profiles SET data_json=?").run(JSON.stringify({contact:'TEST ONLY'}));
 let data=await read(f);assert.equal(data.rounds.length,0);assert.equal(data.application.blocked[0].reason,'dispatched');assert.equal(data.application.profiles[0].creatorId,'sample-creator');
 await assert.rejects(()=>f.create(),/历史寄样/);
 await mutateCreator(f.db,f.users.bd,{action:'requestCreate',creatorId:'sample-creator',requestId:'new-request',...terms});
 data=await read(f);assert.equal(data.application.pending[0].reason,'confirm');assert.equal(data.rounds.length,0);
 await assert.rejects(()=>mutateCreator(f.db,f.users.bd,{action:'requestConfirm',requestId:'new-request',version:1}),/确认/);
 await mutateCreator(f.db,f.users.bd,{action:'requestConfirm',requestId:'new-request',version:1,confirmed:true});
 data=await read(f);assert.equal(data.application.pending.length,0);assert.equal(data.rounds.length,1);
 const id=(await f.create({roundId:data.rounds[0].id})).id;
 assert.equal(f.row(id).status,'pending');assert.equal(f.stock().reserved_qty,0);assert.equal(f.stock().qty,10);
 await f.approve(id);assert.equal(f.stock().reserved_qty,2);assert.equal(f.stock().qty,10);
 await assert.rejects(()=>f.create({roundId:data.rounds[0].id}),/已有寄样单/);
 assert.equal(JSON.parse(f.sqlite.prepare("SELECT logistics_json FROM creator_rounds WHERE id='sample-round'").get().logistics_json).dispatch.orderNumber,'OLD-SAMPLE');
});

test('eligibility uses SKU lines, never an absent cached total or a total without lines',async t=>{
 const f=setup(t);f.sqlite.prepare("UPDATE creator_rounds SET terms_json=?").run(JSON.stringify({items:[{sku:'BAG-A',sampleQty:2}]}));
 assert.equal((await read(f)).rounds.length,1);const {id}=await f.create();assert.equal(f.sqlite.prepare('SELECT qty FROM marketing_sample_items WHERE order_id=?').get(id).qty,2);
 f.round('empty-lines');f.sqlite.prepare('UPDATE creator_rounds SET terms_json=? WHERE id=?').run(JSON.stringify({sampleQty:4,items:[]}), 'empty-lines');
 assert.equal((await read(f)).application.blocked.find(r=>r.roundId==='empty-lines').reason,'items');
 await assert.rejects(()=>f.create({roundId:'empty-lines'}),/约定寄样 SKU/);
});

test('unconfirmed, paused and already accounted rounds give distinct reasons while writes stay blocked',async t=>{
 const f=setup(t);f.sqlite.prepare("UPDATE creator_rounds SET status='pending',approved_at=NULL").run();
 assert.equal((await read(f)).application.blocked[0].reason,'approval');await assert.rejects(()=>f.create(),/已确认/);
 f.sqlite.prepare("UPDATE creator_rounds SET status='executing',approved_at=?").run(new Date().toISOString());
 f.sqlite.prepare("UPDATE creator_profiles SET state='paused'").run();assert.equal((await read(f)).application.profiles.length,0);assert.equal((await read(f)).application.blocked[0].reason,'paused');await assert.rejects(()=>f.create(),/已确认/);
 f.sqlite.prepare("UPDATE creator_profiles SET state='fulfilling'").run();
 f.sqlite.prepare('INSERT INTO creator_finance(id,round_id,revision,basis_version,business_date,source_ref,data_json,actor_id,created_at) VALUES(?,?,1,1,?,?,?,?,?)').run('legacy','sample-round','2026-01-01','OLD',JSON.stringify({costs:{samples:{mode:'included',minor:0}}}),f.users.finance.id,new Date().toISOString());
 assert.equal((await read(f)).rounds.length,0);assert.equal((await read(f)).application.blocked[0].reason,'costed');await assert.rejects(()=>f.create(),/历史样品费用/);
});

test('application options, pending requests and blocked history are limited to the responsible BD and Indonesia TikTok',async t=>{
 const f=setup(t);f.sqlite.prepare("UPDATE creator_profiles SET data_json=?").run(JSON.stringify({contact:'TEST ONLY'}));
 await mutateCreator(f.db,f.users.indonesia,{action:'requestCreate',creatorId:'sample-creator',requestId:'ops-request',...terms});
 assert.equal((await read(f)).application.pending[0].reason,'accept');
 const other=await readMarketingSamples(f.db,f.users.other);assert.deepEqual(other.application,{scopeCount:0,profiles:[],pending:[],blocked:[]});assert.equal(other.rounds.length,0);
 await assert.rejects(()=>f.call(f.users.other,'create',{roundId:'sample-round'}),/权限范围/);
 for(const user of [f.users.finance,f.users.supply,f.users.indonesia]){const data=await readMarketingSamples(f.db,user);assert.equal(data.canCreate,false);assert.equal(data.application,null);assert.deepEqual(data.rounds,[]);}
 f.sqlite.prepare("UPDATE creator_scopes SET site='泰国'").run();assert.equal((await read(f)).application.scopeCount,0);assert.equal((await read(f)).application.pending.length,0);assert.equal((await read(f)).application.profiles.length,0);await assert.rejects(()=>f.create(),/已确认/);
});

test('existing active applications are linked while rejected or unshipped cancelled applications can be submitted again',async t=>{
 const f=setup(t),{id}=await f.create();let data=await read(f);
 assert.equal(data.application.blocked[0].reason,'existing');assert.equal(data.application.blocked[0].orderId,id);assert.equal(data.rounds.length,0);
 await f.change(f.users.supply,id,'review',{decision:'reject',reason:'TEST corrections needed'});assert.equal((await read(f)).rounds.length,1);
 const next=(await f.create()).id;await f.change(f.users.bd,next,'cancel',{reason:'TEST revise recipient'});assert.equal((await read(f)).rounds.length,1);
 f.sqlite.prepare("UPDATE creator_rounds SET test_archived_at=?").run(new Date().toISOString());data=await read(f);assert.equal(data.rounds.length,0);assert.equal(data.application.blocked.length,0);
});

test('entry URLs encode identifiers as one entity and preserve targeted return round',()=>{
 assert.equal(new URL(sampleCreatorUrl('creator','x&admin=1'),'http://test').searchParams.get('entity'),'sample:x&admin=1');
 assert.equal(new URL(sampleCreatorUrl('request','q1'),'http://test').searchParams.get('entity'),'sample-request:q1');
 assert.equal(new URL(sampleCreatorUrl('round','r1'),'http://test').searchParams.get('entity'),'sample-round:r1');
 assert.equal(new URL(sampleCreatorUrl('new'),'http://test').searchParams.get('entity'),'sample:new');
 assert.equal(new URL(sampleRoundUrl('r1'),'http://test').searchParams.get('entity'),'round:r1');
});
