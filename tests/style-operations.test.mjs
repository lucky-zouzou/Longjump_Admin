import test from 'node:test';
import assert from 'node:assert/strict';
import {mutateFinanceLedger,readFinanceLedger} from '../lib/finance-ledger.mjs';
import {fixture} from './fixtures.mjs';
import {readStyleOperations} from '../lib/style-operations.mjs';

const now=new Date('2026-11-15T04:00:00Z');
function setup(t){
 const f=fixture();t.after(()=>f.sqlite.close());
 f.sqlite.prepare("UPDATE sku_settings SET product_series=CASE sku WHEN 'BAG-A' THEN 'H001' ELSE 'H0010' END").run();
 return f;
}
test('系列按商品主档精确关联，日报按当地完整日，库存缺口与估值独立呈现',async t=>{
 const f=setup(t),{sqlite}=f;
 const sale=(id,date,qty,kind)=>{
  sqlite.prepare("INSERT INTO sales_imports(id,import_key,business_date,site,channel,row_count,total_qty,actor_id,created_at,report_kind) VALUES(?,?,?,'印尼','TikTok',1,?,'id-ops',?,?)").run(id,id,date,qty,date,kind);
  sqlite.prepare("INSERT INTO sales_records(id,import_id,business_date,site,channel,sku,qty,currency,actor_id,created_at) VALUES(?,?,?,'印尼','TikTok','BAG-A',?,'IDR','id-ops',?)").run('s'+id,id,date,qty,date);
 };
 sale('complete','2026-11-14',8,'complete');sale('half','2026-11-13',9,'partial');sale('today','2026-11-15',7,'complete');
 sqlite.prepare("DELETE FROM inventory_balances WHERE site='印尼' AND channel='Shopee' AND sku='BAG-A'").run();
 const result=await readStyleOperations(f.db,f.users.admin,{},now),id=result.sites.find(s=>s.site==='印尼');
 assert.equal(result.series,'H001');assert.deepEqual(result.profiles.map(p=>p.sku),['BAG-A']);assert.equal(result.sites.length,5);
 assert.equal(id.cutoff,'2026-11-14');assert.equal(id.available,10);assert.equal(id.missingStock,1);assert.equal(id.inventoryValueCny,null);assert.equal(id.missingCost,1);
 assert.deepEqual(id.channels[0].week,{days:7,completeDays:1,qty:8});assert.equal(id.channels[1].week.qty,null);
 assert.deepEqual((await readStyleOperations(f.db,f.users.finance,{series:'H0010'},now)).profiles.map(r=>r.sku),['BAG-B']);
 await assert.rejects(readStyleOperations(f.db,f.users.admin,{series:'H00%'},now),e=>e.status===404);
 sqlite.exec("DROP TRIGGER sales_summary_overlap_insert");
 for(const k of ['duplicate1','duplicate2'])sqlite.prepare("INSERT INTO sales_records(id,import_id,business_date,site,channel,sku,qty,currency,actor_id,created_at) VALUES(?,?,'2026-11-14','印尼','TikTok','BAG-B',1,'IDR','id-ops','2026-11-14')").run(k,k);
 const invalid=await readStyleOperations(f.db,f.users.admin,{},now);
 assert.equal(invalid.sites.find(r=>r.site==='印尼').channels[0].week.qty,null);
});
test('当前角色和在用账号控制跨站明细与财务，两种视图均受限',async t=>{
 const f=setup(t);
 for(const actor of [f.users.indonesia,f.users.supply,f.users.sales,{...f.users.sales,role:'管理员'}])for(const view of ['operations','finance','finance-history'])
  await assert.rejects(readStyleOperations(f.db,actor,{series:'H001',view},now),e=>e.status===403);
 f.sqlite.prepare("UPDATE users SET active=0 WHERE id=?").run(f.users.finance.id);
 await assert.rejects(readStyleOperations(f.db,f.users.finance,{},now),e=>e.status===403);
});
test('财务用已实现业务，应收按累计、净回款按当月，混款订单单列，款式销量按行',async t=>{
 const f=setup(t);
 const pure=await f.create({qty:3}),mix=await f.create({items:[{sku:'BAG-A',qty:2,unitPrice:100000},{sku:'BAG-B',qty:2,unitPrice:100000}]});
 for(const [order,qty] of [[pure,3],[mix,2]]){await f.approve(order);await f.ship(order,qty,'2026-11-10');}
 f.sqlite.prepare("INSERT INTO wholesale_finance_entries(id,order_id,kind,amount,business_date,reference,note,actor_id,created_at) VALUES('test-cash',?,'receipt',20000,'2026-11-12','STYLE-TEST','TEST-ONLY','admin-1','2026-11-12')").run(pure);
 const result=await readStyleOperations(f.db,f.users.finance,{view:'finance'},now);
 assert.equal(result.netReceiptsIdr,20000);assert.equal(result.receivableIdr,280000);assert.equal(result.orders,1);assert.equal(result.mixed,1);
 assert.deepEqual(result.mixedRefs,[f.sqlite.prepare('SELECT order_no FROM wholesale_orders WHERE id=?').get(mix).order_no]);
 const operating=await readStyleOperations(f.db,f.users.admin,{},now);
 assert.equal(operating.offline.week,5);
});

test('同款不同规格销量与站点总计相符，缺报与零件分开',async t=>{
 const f=setup(t);
 f.sqlite.exec("UPDATE sku_settings SET product_series='H001'; UPDATE inventory_balances SET qty=24 WHERE sku='BAG-B' AND site='印尼' AND channel='TikTok'");
 f.sqlite.exec("INSERT INTO sales_imports(id,import_key,business_date,site,channel,row_count,total_qty,actor_id,created_at,report_kind) VALUES('variant','variant','2026-11-14','印尼','TikTok',1,9,'id-ops','2026-11-14','complete')");
 f.sqlite.exec("INSERT INTO sales_records(id,import_id,business_date,site,channel,sku,qty,currency,actor_id,created_at) VALUES('sale','variant','2026-11-14','印尼','TikTok','BAG-A',9,'IDR','id-ops','2026-11-14')");
 const {sites}=await readStyleOperations(f.db,f.users.admin,{},now),site=sites.find(s=>s.site==='印尼');
 assert.deepEqual(site.variants.map(v=>[v.sku,v.week,v.fourWeeks]),[['BAG-A',9,9],['BAG-B',0,0]]);
 assert.equal(site.channels[1].week.qty,null);
 assert.equal(site.variants.reduce((s,v)=>s+v.available,0),site.available);
 assert.ok(site.variants[1].available>=24);
 f.sqlite.exec("UPDATE sales_imports SET report_kind='partial' WHERE id='variant'");
 const partial=await readStyleOperations(f.db,f.users.finance,{},now);
 assert.ok(partial.sites.find(s=>s.site==='印尼').variants.every(v=>v.week===null&&v.fourWeeks===null));
});

test('月结后改系列仍能核对原系列应收与回款；反关账撤下原版本，旧快照不补造',async t=>{
 t.mock.timers.enable({apis:['Date'],now});
 const f=setup(t),month='2026-10',history={view:'finance-history',month};
 const id=await f.create({qty:2});await f.approve(id);await f.ship(id,2,'2026-10-12');
 f.sqlite.prepare("INSERT INTO wholesale_finance_entries(id,order_id,kind,amount,business_date,reference,note,actor_id,created_at) VALUES('cash',?,'receipt',50000,'2026-10-17','TEST-ONLY','TEST-ONLY','admin-1','2026-10-17')").run(id);
 await mutateFinanceLedger(f.db,f.users.finance,{action:'rate',month,currency:'IDR',rate:0.00045,revision:0,evidence:'TEST-ONLY FX'});
 const view=await readFinanceLedger(f.db,f.users.admin,{month,view:'period'});
 const settings={month,revision:0,evidence:'TEST-ONLY',reviewVersion:view.version,exceptionKeys:view.preview.quality.checks.filter(c=>c.blocking&&c.count).map(c=>c.key),exceptionReason:'TEST-ONLY local fixture'};
 await mutateFinanceLedger(f.db,f.users.admin,{...settings,action:'close'});
 f.sqlite.exec("UPDATE sku_settings SET product_series='NEW' WHERE sku='BAG-A'");
 const {books}=await readStyleOperations(f.db,f.users.finance,history,now),old=books.find(b=>b.series==='H001');
 assert.deepEqual(old.skus,['BAG-A']);assert.equal(old.receivableIdr,150000);assert.equal(old.netReceiptsIdr,50000);assert.equal(books.some(b=>b.series==='NEW'),false);
 await mutateFinanceLedger(f.db,f.users.admin,{month,action:'reopen',revision:1,evidence:'TEST-ONLY reopen'});
 await assert.rejects(readStyleOperations(f.db,f.users.finance,history,now),/已关账月份/);
 f.sqlite.prepare("INSERT INTO finance_period_events VALUES('legacy',?,3,'closed','{}','TEST-ONLY','admin-1','2026-11-01')").run(month);
 assert.equal((await readStyleOperations(f.db,f.users.finance,history,now)).books,null);
});
