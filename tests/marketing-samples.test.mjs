import test from 'node:test';
import assert from 'node:assert/strict';
import {marketingSamplesFixture as setup} from './marketing-samples-fixture.mjs';
import {mutateMarketingSample as mutate,readMarketingSamples,marketingSampleCostSummary,marketingSampleRoundCosts,readMarketingSampleFile,marketingSampleTasks} from '../lib/marketing-samples.mjs';
import {mutateCreator,readCreators} from '../lib/creators.mjs';
import {creatorFees,financeValue} from '../lib/creator-model.mjs';
import {marketingSampleCostCsv} from '../lib/marketing-samples-export.mjs';
import {marketingSampleError,marketingSampleStatus} from '../lib/marketing-samples-i18n.mjs';
const now=()=>new Date().toISOString(),day=()=>new Date(Date.now()+7*3600000).toISOString().slice(0,10),ago=()=>new Date(Date.now()-86400000).toISOString();
const photo={name:'package.png',base64:Buffer.from('\x89PNG\r\n\x1a\nTEST','binary').toString('base64')};

async function sent(f,qty=4){const {id}=await f.create();await f.approve(id);await f.assign(id);await f.ship(id,qty);return id;}
test('marketing sample applies agreement, reserves only Indonesia TikTok, dispatches with photos and receives independently of content',async()=>{
 const f=setup();await assert.rejects(()=>f.create({agreementRef:''}),/协议/);const {id}=await f.create();assert.match(f.row(id).order_no,/^ID-[A-Z0-9]{6}$/);assert.equal((await marketingSampleCostSummary(f.db)).shipmentCount,0);
 assert.equal(f.stock().qty,10);assert.equal(f.stock().reserved_qty,0);await f.approve(id);assert.equal(f.stock().reserved_qty,4);await f.assign(id);await f.ship(id,2);
 assert.equal(f.stock().qty,8);assert.equal(f.stock().reserved_qty,2);assert.equal(f.row(id).status,'partial');assert.equal(f.sqlite.prepare("SELECT qty FROM inventory_balances WHERE site='印尼' AND channel='Shopee' AND sku='BAG-A'").get().qty,10);
 const first=f.shipment(id);f.sqlite.prepare("UPDATE creator_rounds SET status='completed',completed_at=? WHERE id='sample-round'").run(now());
 await f.change(f.users.bd,id,'receipt',{shipmentId:first.id,receivedAt:now(),receiver:'客户',proofRef:'签收凭据'});assert.equal(f.row(id).status,'partial');assert.equal(f.sqlite.prepare("SELECT status FROM creator_rounds WHERE id='sample-round'").get().status,'completed');
 await f.ship(id,2,{trackingNo:'LALA-2'});await f.change(f.users.bd,id,'receipt',{shipmentId:f.shipment(id).id,receivedAt:now(),receiver:'客户',proofRef:'第二次签收'});assert.equal(f.row(id).status,'received');assert.equal(f.stock().qty,6);assert.equal(f.stock().reserved_qty,0);
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM sales_records').get().n,0);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM wholesale_orders').get().n,0);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM finance_documents').get().n,0);
 const d=await readMarketingSamples(f.db,f.users.bd);assert.equal(d.orders[0].contentStatus,'completed');assert.equal(d.orders[0].receiptStatus,'received');assert.equal(d.summary,null);assert.equal(d.orders[0].shipments[0].costs.length,0);
 const file=f.sqlite.prepare('SELECT id FROM marketing_sample_files LIMIT 1').get().id;assert.equal((await readMarketingSampleFile(f.db,f.users.bd,file)).mime,'image/png');await assert.rejects(()=>readMarketingSampleFile(f.db,f.users.other,file),/无权/);
});
test('assigned roles and scoped readers cannot skip inventory review, assignment or actual evidence',async()=>{
 const f=setup(),{id}=await f.create();await assert.rejects(()=>f.call(f.users.indonesia,'create',{roundId:'sample-round'}),/仅负责/);await assert.rejects(()=>f.ship(id),/派定/);
 await f.approve(id);await assert.rejects(()=>f.change(f.users.supply2,id,'assign',{warehouseId:'sample-wh',warehouseUserId:f.users.supply2.id,reason:'越权'}),/物流负责人|无权查看/);await f.assign(id);
 await assert.rejects(()=>f.change(f.users.bd,id,'ship',{}),/仓库执行/);await assert.rejects(()=>f.ship(id,4,{photos:[]}),/打包照片/);await assert.rejects(()=>f.ship(id,5),/超过/);await assert.rejects(()=>f.ship(id,4,{trackingNo:''}),/运单/);assert.equal(f.stock().qty,10);
 await f.ship(id);await assert.rejects(()=>f.change(f.users.supply2,id,'receipt',{shipmentId:f.shipment(id).id}),/负责 BD/);assert.equal((await readMarketingSamples(f.db,f.users.other)).orders.length,0);await assert.rejects(()=>f.create(),/历史寄样|已有寄样/);
});
test('a BD applicant cannot review their own sample after changing to supply or administrator, including tasks and capabilities',async()=>{
 for(const role of ['供应链','管理员']){
  const f=setup();try{
   const {id}=await f.create(),original=f.row(id),stock=f.stock(),events=f.sqlite.prepare('SELECT COUNT(*) n FROM marketing_sample_events WHERE order_id=?').get(id).n;
   f.sqlite.prepare('UPDATE users SET role=? WHERE id=?').run(role,f.users.bd.id);const applicant={...f.users.bd,role};
   const own=(await readMarketingSamples(f.db,applicant)).orders.find(o=>o.id===id);assert.ok(own);assert.equal(own.capabilities.review,false);
   assert.equal((await marketingSampleTasks(f.db,applicant)).some(t=>t.entity===id&&t.kind==='review'),false);
   for(const decision of ['approve','reject'])await assert.rejects(()=>f.change(applicant,id,'review',{decision,logisticsUserId:f.users.supply.id,reason:'TEST 申请人调岗后试图自审'}),e=>e.status===403&&/申请人不能审核/.test(e.message));
   assert.deepEqual(f.row(id),original);assert.deepEqual(f.stock(),stock);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM marketing_sample_events WHERE order_id=?').get(id).n,events);
   assert.equal((await readMarketingSamples(f.db,f.users.supply)).orders.find(o=>o.id===id).capabilities.review,true);assert.equal((await marketingSampleTasks(f.db,f.users.supply)).some(t=>t.entity===id&&t.kind==='review'),true);
   await f.approve(id);assert.equal(f.row(id).status,'approved');assert.equal(f.row(id).reviewer_id,f.users.supply.id);assert.equal(f.stock().reserved_qty,4);
  }finally{f.sqlite.close();}
 }
});
test('insufficient TikTok stock never borrows Shopee; rejection and cancellation preserve history and release only unshipped reservation',async()=>{
 const f=setup(),{id}=await f.create();f.sqlite.prepare("UPDATE inventory_balances SET qty=2 WHERE site='印尼' AND channel='TikTok' AND sku='BAG-A'").run();await assert.rejects(()=>f.approve(id),/库存不足/);assert.equal(f.stock().reserved_qty,0);await f.change(f.users.supply,id,'review',{decision:'reject',reason:'库存不足'});assert.equal(f.row(id).status,'rejected');
 f.sqlite.prepare("UPDATE inventory_balances SET qty=10 WHERE site='印尼' AND channel='TikTok' AND sku='BAG-A'").run();const newer=await f.create();await f.approve(newer.id);await f.assign(newer.id);await f.ship(newer.id,2);await f.change(f.users.supply,newer.id,'cancel',{reason:'客户确认不需要余下样品'});assert.equal(f.row(newer.id).status,'closed');assert.equal(f.stock().qty,8);assert.equal(f.stock().reserved_qty,0);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM marketing_sample_orders').get().n,2);
 await f.change(f.users.bd,newer.id,'receipt',{shipmentId:f.shipment(newer.id).id,receivedAt:now(),receiver:'客户',proofRef:'签收'});assert.equal(f.row(newer.id).status,'closed');assert.throws(()=>f.sqlite.prepare('DELETE FROM marketing_sample_events').run(),/immutable/);
});
test('costs require actual shipments, evidence and finance; latest revisions replace and preserve original currencies',async()=>{
 const f=setup(),id=await sent(f);await assert.rejects(()=>f.change(f.users.bd,id,'cost',{shipmentId:f.shipment(id).id,kind:'sample'}),/仅财务/);
 let summary=await marketingSampleCostSummary(f.db);assert.equal(summary.pending.length,2);await f.cost(id);await f.cost(id,'freight',{currency:'IDR',amount:'30000'});summary=await marketingSampleCostSummary(f.db);assert.equal(summary.totals.sample.confirmedCnyMinor,1000);assert.equal(summary.totals.freight.confirmedCnyMinor,0);assert.equal(summary.totals.freight.missingRateCount,1);assert.equal(summary.totals.freight.confirmedCount,0);assert.equal(summary.lines.find(l=>l.kind==='freight').cnyMinor,null);
 f.sqlite.prepare('INSERT INTO finance_rates VALUES(?,?,?,?,?,?,?,?)').run('sample-rate',day().slice(0,7),'IDR',1,.0004,'财务核定汇率',f.users.finance.id,now());summary=await marketingSampleCostSummary(f.db);assert.equal(summary.totals.freight.confirmedCnyMinor,1200);assert.equal(summary.pending.length,0);
 await f.cost(id,'sample',{revision:1,items:JSON.parse(f.shipment(id).items_json).map(i=>({itemId:i.itemId,unitCost:'2'}))});summary=await marketingSampleCostSummary(f.db);assert.equal(summary.totals.sample.confirmedCnyMinor,800);assert.equal(summary.lines.filter(l=>l.kind==='sample').length,1);assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM marketing_sample_costs WHERE kind='sample'").get().n,2);assert.equal((await marketingSampleRoundCosts(f.db,'sample-round')).complete,true);
 assert.match(marketingSampleCostCsv(summary,'id'),/Ongkos kirim sampel/);assert.equal(marketingSampleCostCsv({...summary,lines:[{...summary.lines[0],source_ref:'=1+1'}]}).includes("'=1+1"),true);
});
test('month-end pending costs respect the cutoff and a revision moved to a later month never revives the old cost',async t=>{
 t.mock.timers.enable({apis:['Date'],now:new Date('2026-01-31T04:00:00Z')});
 const f=setup();try{
  const id=await sent(f);await f.cost(id,'sample');
  const january={from:'2026-01-01',to:'2026-01-31',roundId:'sample-round'};
  let summary=await marketingSampleCostSummary(f.db,january);assert.equal(summary.lines.length,1);assert.equal(summary.totals.sample.confirmedCnyMinor,1000);assert.deepEqual(summary.pending.map(p=>p.kind),['freight']);
  t.mock.timers.setTime(Date.parse('2026-02-02T04:00:00Z'));
  await f.cost(id,'freight');summary=await marketingSampleCostSummary(f.db,january);assert.equal(summary.lines.length,1);assert.deepEqual(summary.pending.map(p=>p.kind),['freight']);
  await f.cost(id,'sample',{revision:1});summary=await marketingSampleCostSummary(f.db,january);assert.equal(summary.lines.length,0);assert.deepEqual(summary.pending.map(p=>p.kind).sort(),['freight','sample']);assert.equal(summary.totals.sample.pendingCount,1);assert.equal(summary.totals.freight.pendingCount,1);
  const february=await marketingSampleCostSummary(f.db,{from:'2026-02-01',to:'2026-02-28',roundId:'sample-round'});assert.equal(february.shipmentCount,0);assert.equal(february.lines.length,2);assert.equal(february.pending.length,0);assert.equal(february.totals.sample.confirmedCnyMinor,1000);assert.equal(february.totals.freight.confirmedCnyMinor,300);
  assert.equal((await marketingSampleCostSummary(f.db)).pending.length,0);assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM marketing_sample_costs WHERE kind='sample'").get().n,2);
 }finally{f.sqlite.close();}
});
test('legacy creator paths cannot double dispatch/receive new sample orders; linked finance reads actual costs once',async()=>{
 const f=setup(),id=await sent(f);let r=f.sqlite.prepare("SELECT * FROM creator_rounds WHERE id='sample-round'").get();await assert.rejects(()=>mutateCreator(f.db,f.users.bd,{action:'receipt',creatorId:'sample-creator',roundId:r.id,version:r.version,at:now(),evidence:'https://example.test/receipt'}),/营销寄样/);
 await f.cost(id);await f.cost(id,'freight');r=f.sqlite.prepare("SELECT * FROM creator_rounds WHERE id='sample-round'").get();const payload={action:'finance',creatorId:'sample-creator',roundId:r.id,version:r.version,date:day(),currency:'CNY',rate:1,rateBasis:'人民币',sourceRef:'CREATOR-SETTLEMENT',confirmed:true,netRevenue:'100',costs:Object.fromEntries(Object.keys(creatorFees).map(k=>[k,{mode:'separate',amount:'99',evidence:'其他费用依据'}])),orders:1,ordersFrom:ago(),ordersAsOf:now(),evidence:'https://example.test/settlement',note:'核对合作收益'};
 await mutateCreator(f.db,f.users.finance,payload);const result=JSON.parse(f.sqlite.prepare("SELECT data_json FROM creator_finance WHERE round_id='sample-round'").get().data_json);assert.equal(result.costs.samples.minor,1000);assert.equal(result.costs.sampleFreight.minor,300);assert.equal(result.costs.samples.sampleLedger,true);assert.equal((await readCreators(f.db,f.users.bd)).rounds[0].marketingSample.id,id);
 await assert.rejects(()=>f.cost(id,'freight',{revision:1,sourceRef:f.shipment(id).id+'-sample'}),/其他寄样费用/);
 const before=await readCreators(f.db,f.users.finance);assert.ok(financeValue(before.rounds[0],before.finances));await f.cost(id,'freight',{revision:1,amount:'4'});const after=await readCreators(f.db,f.users.finance);assert.equal(financeValue(after.rounds[0],after.finances),null);assert.equal(after.finances[0].data.profitCnyMinor,result.profitCnyMinor);
});
test('idempotent retry never repeats stock deduction and concurrent stock change aborts whole batch',async()=>{
 const f=setup(),{id}=await f.create();await f.approve(id);await f.assign(id);const item=f.sqlite.prepare('SELECT id FROM marketing_sample_items WHERE order_id=?').get(id),p={action:'ship',operationId:crypto.randomUUID(),orderId:id,version:f.row(id).version,shippedAt:now(),carrier:'Lala',trackingNo:'L1',photos:[photo],items:[{itemId:item.id,qty:4}]};await mutate(f.db,f.users.supply2,p);const again=await mutate(f.db,f.users.supply2,p);assert.equal(again.replayed,true);assert.equal(f.stock().qty,6);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM marketing_sample_shipments').get().n,1);
 const g=setup(),x=await g.create();const batch=g.db.batch;g.db.batch=async ss=>{g.sqlite.prepare("UPDATE inventory_balances SET qty=1 WHERE site='印尼' AND channel='TikTok' AND sku='BAG-A'").run();return batch(ss);};await assert.rejects(()=>g.approve(x.id),/记录、库存|库存/);assert.equal(g.row(x.id).status,'pending');assert.equal(g.stock().reserved_qty,0);
});
test('closed periods reject actual cost revisions and source dates cannot be moved backwards',async()=>{
 const f=setup(),id=await sent(f);await assert.rejects(()=>f.cost(id,'sample',{businessDate:new Date(Date.now()-86400000).toISOString().slice(0,10)}),/不能早于/);await f.cost(id);const month=day().slice(0,7);f.sqlite.prepare("INSERT INTO finance_period_events(id,month,revision,status,snapshot_json,evidence,actor_id,created_at) VALUES(?,?,1,'closed','{}','TEST',?,?)").run('sample-close',month,f.users.admin.id,now());await assert.rejects(()=>f.cost(id,'sample',{revision:1}),/关账/);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM marketing_sample_costs').get().n,1);
});
test('Indonesian statuses and safe error fallbacks do not emit Chinese system text',()=>{for(const key of ['pending','approved','assigned','partial','shipped','received','rejected','cancelled','closed'])assert.doesNotMatch(marketingSampleStatus('id',key),/[\u3400-\u9fff]/);for(const text of ['印尼 TikTok 可用库存不足，整单未锁库','请填写实际收件人','未知错误'])assert.doesNotMatch(marketingSampleError('id',text),/[\u3400-\u9fff]/);});

test('legacy unlinked sample receipts can follow completed content without reposting stock or reopening cooperation',async()=>{
 const f=setup();f.sqlite.prepare("UPDATE creator_rounds SET status='completed',logistics_json=? WHERE id='sample-round'").run(JSON.stringify({dispatch:{at:ago(),qty:4,orderNumber:'LEGACY'}}));const r=f.sqlite.prepare("SELECT * FROM creator_rounds WHERE id='sample-round'").get();await mutateCreator(f.db,f.users.bd,{action:'receipt',creatorId:'sample-creator',roundId:r.id,version:r.version,at:now(),evidence:'https://example.test/legacy-receipt'});assert.equal(f.sqlite.prepare("SELECT status FROM creator_rounds WHERE id='sample-round'").get().status,'completed');assert.equal(f.stock().qty,10);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM marketing_sample_shipments').get().n,0);
});
test('finance period close racing cost confirmation prevents partial source and cost posting',async()=>{
 const f=setup(),id=await sent(f);const batch=f.db.batch;let raced=false;f.db.batch=async ss=>{if(!raced){raced=true;f.sqlite.prepare("INSERT INTO finance_period_events(id,month,revision,status,snapshot_json,evidence,actor_id,created_at) VALUES(?,?,1,'closed','{}','TEST',?,?)").run('racing-close',day().slice(0,7),f.users.admin.id,now());}return batch(ss);};await assert.rejects(()=>f.cost(id),/记录、库存|关账/);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM marketing_sample_costs').get().n,0);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM marketing_sample_cost_sources').get().n,0);
});

test('next-action tasks follow only assigned actors and keep BD receipt separate from content and finance costs',async()=>{
 const f=setup(),{id}=await f.create();assert.equal((await marketingSampleTasks(f.db,f.users.supply)).filter(t=>t.kind==='review').length,1);assert.equal((await marketingSampleTasks(f.db,f.users.other)).length,0);await f.approve(id);assert.deepEqual((await marketingSampleTasks(f.db,f.users.supply)).map(t=>t.kind),['assign']);await f.assign(id);assert.deepEqual((await marketingSampleTasks(f.db,f.users.supply2)).map(t=>t.kind),['ship']);assert.equal((await marketingSampleTasks(f.db,f.users.supply)).length,0);await f.ship(id);assert.deepEqual((await marketingSampleTasks(f.db,f.users.bd)).map(t=>t.kind).sort(),['content','receipt']);assert.deepEqual((await marketingSampleTasks(f.db,f.users.finance)).map(t=>t.kind),['cost']);await f.change(f.users.bd,id,'receipt',{shipmentId:f.shipment(id).id,receivedAt:now(),receiver:'客户',proofRef:'签收'});assert.deepEqual((await marketingSampleTasks(f.db,f.users.bd)).map(t=>t.kind),['content']);await f.cost(id);await f.cost(id,'freight');assert.equal((await marketingSampleTasks(f.db,f.users.finance)).length,0);
});

test('sample-only requires explicit Indonesia TikTok agreement, reviewed conditions and cannot erase confirmed content',async()=>{
 const f=setup();f.sqlite.prepare("UPDATE creator_profiles SET data_json=? WHERE id='sample-creator'").run(JSON.stringify({contact:'TEST WhatsApp'}));
 const input={action:'requestCreate',creatorId:'sample-creator',requestId:crypto.randomUUID(),dueAt:new Date(Date.now()+14*86400000).toISOString(),items:[{sku:'BAG-A',sampleQty:4}],method:'commission',commission:'0',videos:0,lives:0};
 await assert.rejects(()=>mutateCreator(f.db,f.users.bd,input),/至少约定/);await assert.rejects(()=>mutateCreator(f.db,f.users.bd,{...input,sampleOnly:'true'}),/至少约定/);
 await assert.rejects(()=>mutateCreator(f.db,f.users.bd,{...input,sampleOnly:true,items:[{sku:'BAG-A',sampleQty:0}]}),/仅印尼/);
 await assert.rejects(()=>mutateCreator(f.db,f.users.bd,{...input,sampleOnly:true,videos:1}),/仅印尼/);
 for(const [site,platform] of [['泰国','TikTok'],['印尼','Shopee']]){f.sqlite.prepare("UPDATE creator_scopes SET site=?,platform=? WHERE id='sample-scope'").run(site,platform);await assert.rejects(()=>mutateCreator(f.db,f.users.bd,{...input,sampleOnly:true}),/仅印尼/);}
 f.sqlite.prepare("UPDATE creator_scopes SET site='印尼',platform='TikTok' WHERE id='sample-scope'").run();
 const promised={...input,requestId:crypto.randomUUID(),videos:1};await mutateCreator(f.db,f.users.bd,promised);await mutateCreator(f.db,f.users.bd,{action:'requestConfirm',requestId:promised.requestId,version:1,confirmed:true});await assert.rejects(()=>mutateCreator(f.db,f.users.bd,{...input,action:'requestEdit',requestId:promised.requestId,version:2,sampleOnly:true}),/尚未确认/);
 await mutateCreator(f.db,f.users.bd,{...input,sampleOnly:true});await assert.rejects(()=>mutateCreator(f.db,f.users.bd,{action:'requestConfirm',requestId:input.requestId,version:1}),/确认/);await mutateCreator(f.db,f.users.bd,{action:'requestConfirm',requestId:input.requestId,version:1,confirmed:true});
 const q=f.sqlite.prepare('SELECT round_id FROM creator_requests WHERE id=?').get(input.requestId),r=f.sqlite.prepare('SELECT * FROM creator_rounds WHERE id=?').get(q.round_id);assert.equal(JSON.parse(r.terms_json).sampleOnly,true);
 const {id}=await f.create({roundId:r.id});assert.equal((await readMarketingSamples(f.db,f.users.bd)).orders.find(o=>o.id===id).contentStatus,'not_required');assert.equal((await marketingSampleTasks(f.db,f.users.bd)).some(t=>t.kind==='content'),false);
 await f.approve(id);await f.assign(id);await f.ship(id);const complete=()=>mutateCreator(f.db,f.users.bd,{action:'complete',creatorId:'sample-creator',roundId:r.id,version:f.sqlite.prepare('SELECT version FROM creator_rounds WHERE id=?').get(r.id).version,evidence:'https://example.test/agreement-close',note:'按仅寄样协议结束合作'});await assert.rejects(complete,/实际签收/);
 await f.change(f.users.bd,id,'receipt',{shipmentId:f.shipment(id).id,receivedAt:now(),receiver:'客户',proofRef:'TEST 已签收'});assert.equal((await marketingSampleTasks(f.db,f.users.bd)).length,0);await complete();assert.equal(f.sqlite.prepare('SELECT status FROM creator_rounds WHERE id=?').get(r.id).status,'completed');assert.equal((await readMarketingSamples(f.db,f.users.bd)).orders.find(o=>o.id===id).contentStatus,'not_required');
});

test('historical sample costs included in net revenue cannot be silently counted again in the new ledger',async()=>{
 const f=setup();f.sqlite.prepare('INSERT INTO creator_finance(id,round_id,revision,basis_version,business_date,source_ref,data_json,actor_id,created_at) VALUES(?,?,1,1,?,?,?,?,?)').run('legacy-sample-finance','sample-round',day(),'OLD-SETTLEMENT',JSON.stringify({costs:{samples:{mode:'included',minor:0,evidence:'Included in net revenue'}}}),f.users.finance.id,now());await assert.rejects(()=>f.create(),/历史样品费用/);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM marketing_sample_orders').get().n,0);
});

test('new Indonesia TikTok samples cannot bypass reservations through the legacy dispatch API',async()=>{
 const f=setup(),r=f.sqlite.prepare("SELECT * FROM creator_rounds WHERE id='sample-round'").get();await assert.rejects(()=>mutateCreator(f.db,f.users.bd,{action:'dispatch',creatorId:'sample-creator',roundId:r.id,version:r.version,at:now(),qty:4,orderNumber:'BYPASS'}),/营销寄样流程/);assert.equal(JSON.parse(f.sqlite.prepare('SELECT logistics_json FROM creator_rounds WHERE id=?').get(r.id).logistics_json).dispatch,undefined);assert.equal(f.stock().qty,10);assert.equal(f.stock().reserved_qty,0);
});

test('sample stock facts, photos, independent costs and immutable audit survive a complete backup restore',async()=>{
 const {mkdtempSync,rmSync}=await import('node:fs'),{tmpdir}=await import('node:os'),{join}=await import('node:path'),{createBackup,restoreBackup}=await import('../server/backup.mjs'),{openDatabase,fileBucket}=await import('../server/storage.mjs');
 const f=setup(),id=await sent(f);await f.cost(id);await f.cost(id,'freight');const file=f.sqlite.prepare('SELECT id FROM marketing_sample_files WHERE order_id=?').get(id).id,dir=mkdtempSync(join(tmpdir(),'marketing-sample-backup-'));
 try{const backup=join(dir,'sample.tar');await createBackup({DB:f.db,WHOLESALE_FILES:fileBucket(join(dir,'files'))},backup);await restoreBackup(backup,join(dir,'restored'));const db=openDatabase(join(dir,'restored/business.sqlite'));try{const data=await readMarketingSamples(db,f.users.bd);assert.equal(data.orders.find(o=>o.id===id).shipments.length,1);assert.equal((await readMarketingSampleFile(db,f.users.bd,file)).payload,photo.base64);assert.equal((await marketingSampleCostSummary(db)).totals.sample.confirmedCnyMinor,1000);assert.equal(db.sqlite.prepare("SELECT qty FROM inventory_balances WHERE site='印尼' AND channel='TikTok' AND sku='BAG-A'").get().qty,6);assert.throws(()=>db.sqlite.prepare('DELETE FROM marketing_sample_costs').run(),/immutable/);}finally{db.sqlite.close();}}finally{f.sqlite.close();rmSync(dir,{recursive:true,force:true});}
});
