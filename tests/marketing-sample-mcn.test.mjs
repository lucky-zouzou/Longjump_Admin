import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {marketingSamplesFixture} from './marketing-samples-fixture.mjs';
import {readMarketingSamples,marketingSampleTasks,marketingSampleCostSummary,readMarketingSampleFile} from '../lib/marketing-samples.mjs';
import {mutateSampleAllocationBasis} from '../lib/marketing-sample-allocation.mjs';
import {sampleImportItems} from '../lib/marketing-sample-import.mjs';
import {marketingSampleCostCsv} from '../lib/marketing-samples-export.mjs';
import {createBackup,restoreBackup} from '../server/backup.mjs';
import {openDatabase,fileBucket} from '../server/storage.mjs';
const setup=t=>{const f=marketingSamplesFixture();t.after(()=>f.sqlite.close());return f;};
const now=()=>new Date().toISOString(),day=()=>new Date(Date.now()+7*3600000).toISOString().slice(0,10);
const payload=()=>({scopeId:'sample-scope',mcn:{name:'TEST MCN',contactName:'TEST CONTACT',contactMethod:'TEST ONLY',cooperationRef:'PROJECT-1',purpose:'TEST PRODUCT REVIEW'},signedOn:day(),agreementRef:'TEST SIGNED AGREEMENT',items:[{sku:'BAG-A',sampleQty:2}],recipient:{name:'TEST RECEIVER',phone:'TEST ONLY',city:'Jakarta',address:'TEST ADDRESS'},fulfillment:'content',requirement:'TEST 1 approved product video',dueDate:'2099-12-01',confirmed:true});
const create=(f,extra={})=>f.call(f.users.bd,'createMcn',{...payload(),...extra});

test('MCN with no creator follows independent review, stock, receipt, content and finance through backup restore',async t=>{
 const f=setup(t),before=f.sqlite.prepare('SELECT COUNT(*) n FROM creator_profiles').get().n,rounds=f.sqlite.prepare('SELECT COUNT(*) n FROM creator_rounds').get().n;
 const {id}=await create(f,{items:sampleImportItems([{sku:'BAG-A',qty:2}],[{sku:'BAG-A'}])});assert.equal(f.row(id).creator_id,null);assert.equal(f.row(id).round_id,null);assert.equal(f.row(id).party_type,'mcn');assert.deepEqual({...f.stock()},{qty:10,reserved_qty:0});
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM creator_profiles').get().n,before);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM creator_rounds').get().n,rounds);
 assert.ok((await marketingSampleTasks(f.db,f.users.supply)).some(x=>x.entity===id&&x.kind==='review'));
 await assert.rejects(()=>f.ship(id,2),/派定/);
 await f.approve(id);assert.equal(f.stock().reserved_qty,2);await f.assign(id);await f.ship(id,2);assert.deepEqual({...f.stock()},{qty:8,reserved_qty:0});
 const s=f.shipment(id);await f.change(f.users.bd,id,'receipt',{shipmentId:s.id,receivedAt:now(),receiver:'TEST RECEIVER',proofRef:'TEST RECEIPT'});
 let data=await readMarketingSamples(f.db,f.users.bd),order=data.orders.find(o=>o.id===id);assert.equal(order.contentStatus,'executing');assert.equal(order.receiptStatus,'received');assert.equal(order.shop,'TEST');
 assert.ok((await marketingSampleTasks(f.db,f.users.bd)).some(x=>x.entity===id&&x.kind==='content'&&x.tab==='marketing-samples'));
 await f.change(f.users.bd,id,'mcnContent',{completedAt:now(),evidence:'TEST CONTENT PROOF',reason:'TEST REQUIREMENT VERIFIED'});
 assert.ok(!(await marketingSampleTasks(f.db,f.users.bd)).some(x=>x.entity===id&&x.kind==='content'));
 await f.cost(id);await f.cost(id,'freight');const summary=await marketingSampleCostSummary(f.db);assert.equal(summary.totals.sample.confirmedCnyMinor,500);assert.equal(summary.totals.freight.confirmedCnyMinor,300);assert.equal(summary.lines[0].counterparty,'TEST MCN');assert.match(marketingSampleCostCsv(summary),/MCN.*TEST MCN/);
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM creator_profiles').get().n,before);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM creator_rounds').get().n,rounds);assert.deepEqual(f.sqlite.prepare('PRAGMA foreign_key_check').all(),[]);
 await mutateSampleAllocationBasis(f.db,f.users.finance,{month:day().slice(0,7),revision:0,throughDate:day(),confirmed:true,reason:'TEST ONLY MCN allocation',items:[{scopeId:'sample-scope',revenue:'100',currency:'CNY',evidence:'TEST ONLY shop report'}]});
 const allocated=(await marketingSampleCostSummary(f.db)).allocations;
 const dir=mkdtempSync(join(tmpdir(),'mcn-backup-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const backup=join(dir,'mcn.tar');await createBackup({DB:f.db,WHOLESALE_FILES:fileBucket(join(dir,'files'))},backup);await restoreBackup(backup,join(dir,'restored'));const restored=openDatabase(join(dir,'restored/business.sqlite'));t.after(()=>restored.sqlite.close());
 const result=(await readMarketingSamples(restored,f.users.bd)).orders.find(o=>o.id===id);assert.equal(result.mcn.name,'TEST MCN');assert.equal(result.contentStatus,'completed');assert.equal(result.shipments[0].receipt.proof_ref,'TEST RECEIPT');assert.equal(result.shipments[0].files.length,1);assert.equal((await marketingSampleCostSummary(restored)).totals.sample.confirmedCnyMinor,500);assert.deepEqual((await marketingSampleCostSummary(restored)).allocations,allocated);assert.throws(()=>restored.sqlite.prepare('DELETE FROM marketing_sample_revenue_bases').run(),/immutable/);assert.throws(()=>restored.sqlite.prepare('DELETE FROM marketing_sample_costs').run(),/immutable/);
});

test('MCN API rejects unauthorized, unconfirmed, invalid and duplicate applications without consuming stock',async t=>{
 const f=setup(t),p=payload();
 for(const who of [f.users.finance,f.users.supply,f.users.indonesia,f.users.other])await assert.rejects(()=>f.call(who,'createMcn',p),/仅负责|店铺范围/);
 for(const extra of [{confirmed:false},{scopeId:'wrong'},{mcn:{...p.mcn,name:''}},{items:[]},{items:[{sku:'BAG-A',sampleQty:1},{sku:'BAG-A',sampleQty:2}]},{items:[{sku:'BAG-A',sampleQty:-1}]},{items:[{sku:'MISSING',sampleQty:1}]},{fulfillment:''},{dueDate:'2026-02-30'}])await assert.rejects(()=>create(f,extra));
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM marketing_sample_orders').get().n,0);
 const operationId=crypto.randomUUID(),first=await create(f,{operationId}),again=await create(f,{operationId});assert.equal(first.id,again.id);assert.equal(again.replayed,true);
 await assert.rejects(()=>create(f,{mcn:{...p.mcn,name:' test mcn '}}),/已有寄样单/);assert.equal(f.stock().reserved_qty,0);
 assert.equal((await readMarketingSamples(f.db,f.users.other)).orders.length,0);await assert.rejects(()=>f.change(f.users.other,first.id,'cancel',{reason:'TEST'}),/无权/);
 await f.change(f.users.bd,first.id,'cancel',{reason:'TEST CANCEL WRONG DETAILS'});const corrected=await create(f);assert.notEqual(corrected.id,first.id);
});

test('MCN sample-only has no content task; partial cancellation releases only unshipped stock',async t=>{
 const f=setup(t),{id}=await create(f,{fulfillment:'sample_only',requirement:'TEST AGREEMENT: ONLY SAMPLES',dueDate:''});
 await f.approve(id);await f.assign(id);await f.ship(id,1);
 await f.change(f.users.supply,id,'cancel',{reason:'TEST RELEASE REMAINING'});assert.deepEqual({...f.stock()},{qty:9,reserved_qty:0});assert.equal(f.row(id).status,'closed');
 const data=await readMarketingSamples(f.db,f.users.bd);assert.equal(data.orders[0].contentStatus,'not_required');assert.ok(!(await marketingSampleTasks(f.db,f.users.bd)).some(x=>x.kind==='content'));
 await assert.rejects(()=>f.change(f.users.bd,id,'mcnContent',{completedAt:now(),evidence:'TEST',reason:'TEST'}),/仅负责/);
 const file=f.sqlite.prepare('SELECT id FROM marketing_sample_files WHERE order_id=?').get(id).id;await assert.rejects(()=>readMarketingSampleFile(f.db,f.users.other,file),/无权/);
});

test('MCN inventory shortage is atomic and a stale review cannot reserve twice',async t=>{
 const f=setup(t),{id}=await create(f,{items:[{sku:'BAG-A',sampleQty:20}]});await assert.rejects(()=>f.approve(id),/不足/);assert.deepEqual({...f.stock()},{qty:10,reserved_qty:0});assert.equal(f.row(id).status,'pending');
 const second=(await create(f,{mcn:{...payload().mcn,cooperationRef:'PROJECT-2'}})).id,version=f.row(second).version;await f.approve(second);await assert.rejects(()=>f.call(f.users.supply,'review',{orderId:second,version,decision:'approve',logisticsUserId:f.users.supply.id,reason:'TEST'}),/已更新/);assert.equal(f.stock().reserved_qty,2);
});

test('schema upgrade retains legacy orders, descendants, inventory and immutable history with foreign keys enabled',async t=>{
 const f=setup(t),{id}=await f.create();await f.approve(id);await f.assign(id);await f.ship(id);await f.cost(id);await f.cost(id,'freight');
 const tables=['marketing_sample_orders','marketing_sample_items','marketing_sample_shipments','marketing_sample_receipts','marketing_sample_costs','marketing_sample_cost_sources','marketing_sample_files','marketing_sample_events'];
 const snapshot=()=>Object.fromEntries(tables.map(name=>[name,f.sqlite.prepare('SELECT * FROM '+name+' ORDER BY rowid').all().map(r=>JSON.parse(JSON.stringify(r)))]));
 const before=snapshot(),stock={...f.stock()},clock=f.sqlite.prepare("SELECT version FROM creator_clock WHERE id='global'").get().version;
 f.sqlite.exec('BEGIN IMMEDIATE');try{f.sqlite.exec(readFileSync(new URL('../drizzle/0079_mcn_marketing_samples.sql',import.meta.url),'utf8'));f.sqlite.exec('COMMIT');}catch(e){f.sqlite.exec('ROLLBACK');throw e;}
 assert.deepEqual(snapshot(),before);assert.deepEqual({...f.stock()},stock);assert.equal(f.sqlite.prepare("SELECT version FROM creator_clock WHERE id='global'").get().version,clock);assert.deepEqual(f.sqlite.prepare('PRAGMA foreign_key_check').all(),[]);assert.equal(f.sqlite.prepare('PRAGMA foreign_keys').get().foreign_keys,1);
 assert.throws(()=>f.sqlite.prepare('DELETE FROM marketing_sample_shipments').run(),/immutable/);assert.throws(()=>f.sqlite.prepare("UPDATE marketing_sample_orders SET creator_id=NULL WHERE id=?").run(id),/CHECK/);
});
