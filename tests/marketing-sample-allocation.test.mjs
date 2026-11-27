import test from 'node:test';
import assert from 'node:assert/strict';
import {marketingSamplesFixture} from './marketing-samples-fixture.mjs';
import {costFixture} from './cost-fixture.mjs';
import {mutateSampleAllocationBasis as basis} from '../lib/marketing-sample-allocation.mjs';
import {marketingSampleCostSummary as summary} from '../lib/marketing-samples.mjs';
import {readFinanceLedger,mutateFinanceLedger} from '../lib/finance-ledger.mjs';
import {readFinanceHub} from '../lib/finance-hub.mjs';
import {sampleAllocationCsv} from '../lib/marketing-samples-export.mjs';
const day=()=>new Date(Date.now()+7*3600000).toISOString().slice(0,10),now=()=>new Date().toISOString();
function setup(base){const f=marketingSamplesFixture(base);f.sqlite.prepare("INSERT INTO creator_scopes(id,site,platform,shop,operator_id,bd_id,updated_at) VALUES('sample-scope-b','印尼','TikTok','TEST B',?,?,?)").run(f.users.indonesia.id,f.users.bd.id,now());f.payload=(extra={})=>({month:day().slice(0,7),revision:0,throughDate:day(),confirmed:true,reason:'TEST ONLY 同期店铺报表核对',items:[{scopeId:'sample-scope',revenue:'300',currency:'CNY',evidence:'TEST SHOP A REPORT'},{scopeId:'sample-scope-b',revenue:'100',currency:'CNY',evidence:'TEST SHOP B REPORT'}],...extra});f.read=async()=>{const d=day();return (await summary(f.db,{from:d.slice(0,7)+'-01',to:d})).allocations.months[0];};f.sent=async()=>{const {id}=await f.create();await f.approve(id);await f.assign(id);await f.ship(id,2);return id;};return f;}
test('75/25 revenue allocates actual sample and freight once, cents conserved and zero-sales shop gets zero',async()=>{
 const f=setup();try{const id=await f.sent(),stock={...f.stock()};await f.cost(id);await f.cost(id,'freight');await basis(f.db,f.users.finance,f.payload());const v=await f.read();assert.deepEqual(v.rows.map(r=>r.share),[.75,.25]);assert.deepEqual(v.rows.map(r=>r.sampleCnyMinor),[375,125]);assert.deepEqual(v.rows.map(r=>r.freightCnyMinor),[225,75]);assert.equal(v.lines.reduce((n,l)=>n+l.cnyMinor,0),800);assert.deepEqual({...f.stock()},stock);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM finance_documents').get().n,0);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM sales_records').get().n,0);
  await f.cost(id,'freight',{revision:1,amount:'0.01'});let revised=await f.read();assert.equal(revised.rows.reduce((n,r)=>n+r.freightCnyMinor,0),1);assert.equal(revised.lines.filter(l=>l.kind==='freight').length,2);assert.equal(revised.lines.find(l=>l.kind==='freight').sourceRevision,2);
  const p=f.payload({revision:1});p.items[1].revenue='0';await basis(f.db,f.users.finance,p);revised=await f.read();assert.equal(revised.rows[1].share,0);assert.equal(revised.rows[1].totalCnyMinor,0);assert.equal(revised.rows[0].totalCnyMinor,501);assert.throws(()=>f.sqlite.prepare("UPDATE marketing_sample_revenue_bases SET through_date='2020-01-01'").run(),/immutable/);
  const csv=sampleAllocationCsv({...revised,rows:revised.rows.map(r=>({...r,evidence:'=TEST'}))});assert.match(csv,/'=TEST/);assert.match(csv,/成本版本/);
 }finally{f.sqlite.close();}
});
test('missing sales, missing FX, zero denominator and pending actual costs stay unknown instead of zero',async()=>{
 const f=setup();try{const id=await f.sent();let v=await f.read();assert.equal(v.status,'pending');assert.ok(v.rows.every(r=>r.share===null&&r.totalCnyMinor===null));
  const p=f.payload();p.items[1].currency='IDR';p.items[1].revenue='1000000';await basis(f.db,f.users.finance,p);assert.match((await f.read()).issues.join(),/财务汇率/);
  f.sqlite.prepare('INSERT INTO finance_rates VALUES(?,?,?,?,?,?,?,?)').run('TEST-FX',p.month,'IDR',1,.0001,'TEST ONLY',f.users.finance.id,now());v=await f.read();assert.deepEqual(v.rows.map(r=>r.share),[.75,.25]);assert.equal(v.status,'partial');assert.ok(v.rows.every(r=>r.sampleCnyMinor===null&&r.freightCnyMinor===null));await f.cost(id);v=await f.read();assert.equal(v.rows[0].sampleCnyMinor,375);assert.equal(v.rows[0].freightCnyMinor,null);
  await f.cost(id,'freight',{currency:'PHP'});v=await f.read();assert.equal(v.status,'partial');assert.ok(v.rows.every(r=>r.freightCnyMinor===null));
  await basis(f.db,f.users.finance,f.payload({revision:1,items:p.items.map(r=>({...r,revenue:'0'}))}));v=await f.read();assert.match(v.issues.join(),/合计为零/);assert.ok(v.rows.every(r=>r.share===null));
 }finally{f.sqlite.close();}
});
test('basis requires complete source rows, real finance identity, same period and optimistic version',async()=>{
 const f=setup();try{
  for(const actor of [f.users.admin,f.users.bd,f.users.indonesia,{...f.users.bd,role:'财务'}])await assert.rejects(basis(f.db,actor,f.payload()),e=>e.status===403);
  for(const p of [f.payload({confirmed:false}),f.payload({items:f.payload().items.slice(0,1)}),f.payload({items:[f.payload().items[0],f.payload().items[0]]}),f.payload({throughDate:'2026-02-30'}),f.payload({month:'2099-01'}),f.payload({reason:''})])await assert.rejects(basis(f.db,f.users.finance,p));
  for(const revenue of ['',null,-1,true,'bad']){const p=f.payload();p.items[0].revenue=revenue;await assert.rejects(basis(f.db,f.users.finance,p));}
  const unknown=f.payload();unknown.items[1].scopeId='forged';await assert.rejects(basis(f.db,f.users.finance,unknown),/范围/);
  await basis(f.db,f.users.finance,f.payload());await assert.rejects(basis(f.db,f.users.finance,f.payload()),e=>e.status===409);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM marketing_sample_revenue_bases').get().n,1);
  f.sqlite.prepare('INSERT INTO finance_access_modes(user_id,mode,actor_id,reason,updated_at) VALUES(?,?,?,?,?)').run(f.users.finance.id,'scoped',f.users.admin.id,'TEST',now());await assert.rejects(basis(f.db,f.users.finance,f.payload({revision:1})),e=>e.status===403);
 }finally{f.sqlite.close();}
});
test('cost/period races and scope changes invalidate the basis, not partial writes',async()=>{
 const f=setup();try{
  const batch=f.db.batch;f.db.batch=async statements=>{f.sqlite.prepare("INSERT INTO finance_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1").run();return batch(statements);};await assert.rejects(basis(f.db,f.users.finance,f.payload()),/记录|库存|刷新/);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM marketing_sample_revenue_bases').get().n,0);f.db.batch=batch;
  await basis(f.db,f.users.finance,f.payload());f.sqlite.prepare("UPDATE creator_scopes SET shop='TEST RENAMED',version=version+1 WHERE id='sample-scope-b'").run();assert.match((await f.read()).issues.join(),/店铺或负责运营已变化/);
  f.sqlite.prepare("INSERT INTO finance_period_events(id,month,revision,status,snapshot_json,evidence,actor_id,created_at) VALUES(?,?,1,'closed','{}','TEST',?,?)").run('TEST-CLOSED',day().slice(0,7),f.users.admin.id,now());await assert.rejects(basis(f.db,f.users.finance,f.payload({revision:1})),/关账/);
 }finally{f.sqlite.close();}
});
test('sales cutoff must cover current costs; source evidence and monthly totals freeze in central finance',async t=>{
 t.mock.timers.enable({apis:['Date'],now:new Date('2026-01-10T04:00:00Z')});const f=setup(costFixture());try{
  const id=await f.sent();await f.cost(id);await f.cost(id,'freight');await basis(f.db,f.users.finance,f.payload());
  let hub=await readFinanceHub(f.db,f.users.finance,{month:'2026-01'});assert.equal(hub.sampleCosts.allocations.months[0].rows[0].sampleCnyMinor,375);
  t.mock.timers.setTime(Date.parse('2026-02-02T04:00:00Z'));let r=await readFinanceLedger(f.db,f.users.admin,{month:'2026-01',view:'period'});assert.match(r.preview.sampleCosts.allocations.months[0].issues.join(),/截止日期/);assert.equal(r.preview.quality.checks.find(c=>c.key==='寄样销售额分摊待核').count,1);
  await basis(f.db,f.users.finance,f.payload({month:'2026-01',revision:1,throughDate:'2026-01-31'}));r=await readFinanceLedger(f.db,f.users.admin,{month:'2026-01',view:'period'});assert.equal(r.preview.sampleCosts.allocations.months[0].status,'ready');
  await mutateFinanceLedger(f.db,f.users.admin,{action:'close',month:'2026-01',revision:0,evidence:'TEST ONLY snapshot',reviewVersion:r.version,exceptionKeys:r.preview.quality.checks.filter(c=>c.blocking&&c.count).map(c=>c.key),exceptionReason:'TEST ONLY fixture gaps'});
  const saved=(await readFinanceLedger(f.db,f.users.finance,{month:'2026-01'})).sampleCosts;f.sqlite.prepare("UPDATE creator_scopes SET shop='TEST CHANGED' WHERE id='sample-scope-b'").run();hub=await readFinanceHub(f.db,f.users.finance,{month:'2026-01'});assert.deepEqual(hub.sampleCosts,saved);assert.equal(hub.sampleCosts.allocations.months[0].rows[1].shop,'TEST B');await assert.rejects(basis(f.db,f.users.finance,f.payload({month:'2026-01',revision:2,throughDate:'2026-01-31'})),/关账/);
 }finally{f.sqlite.close();}
});
