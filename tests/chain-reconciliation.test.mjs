import {readSalesDashboard} from '../lib/sales-dashboard.mjs';
import {importRows,ticketRows,review,orderPayload} from './cost-fixture.mjs';
import {mutateCost,readCostProfit} from '../lib/cost-profit.mjs';
// All evidence synthetic: the production service is never contacted.
import test from 'node:test';
import assert from 'node:assert/strict';
import {systemFixture,svc} from './system-fixture.mjs';
import {loadForecast} from '../lib/forecast.ts';
import {refreshBusinessActions,mutateBusinessAction} from '../lib/business-actions.mjs';
import {actionFinanceDay} from '../lib/business-action-data.mjs';
import {mutateFinanceLedger,createFinanceSnapshot,readFinanceLedger} from '../lib/finance-ledger.mjs';
import {inventoryValuation} from '../lib/finance-inventory.mjs';
import {workspaceTasks} from '../lib/workspace-tasks.mjs';
import {monthEndStock,periodCutoff} from '../lib/month-end-stock.mjs';
const now=new Date('2026-11-04T05:00:00Z');
function day(f,date,qty=1,amount=1000000){
 f.sqlite.prepare("INSERT INTO sales_imports(id,import_key,business_date,site,channel,row_count,total_qty,actor_id,created_at,report_kind) VALUES(?,?,?,'印尼','TikTok',1,?,'id-ops',?,?)").run('i-'+date,'k-'+date,date,qty,date,date==='2026-11-04'?'partial':'complete');
 f.sqlite.prepare("INSERT INTO sales_records(id,import_id,business_date,site,channel,sku,qty,currency,reported_amount,actor_id,created_at) VALUES(?,?,?,'印尼','TikTok','BAG-A',?,'IDR',?,'id-ops',?)").run('s-'+date,'i-'+date,date,qty,amount,date);
}
test('站点昨日为止的7天与今天分列',async t=>{t.mock.timers.enable({apis:['Date'],now});
 const f=systemFixture();
 for(let i=0;i<7;i++)day(f,new Date(Date.parse('2026-10-28')+i*86400000).toISOString().slice(0,10));
 day(f,'2026-11-04',5);
 svc.setActor(f.users.admin);
 const response=await svc.GET(new Request('http://localhost/api/system?module=overview'));
 const body=await response.json();assert.equal(response.status,200,JSON.stringify(body));
 const metrics=body.metrics||body.data?.metrics;assert.ok(metrics,'metrics available: '+Object.keys(body));
 assert.equal(metrics.sales7Qty,7);assert.equal(metrics.salesToday,5);assert.equal(metrics.salesWindowFrom,'2026-10-28');assert.equal(metrics.salesWindowTo,'2026-11-03');f.sqlite.close();
});
test('逐日已核算金额进入月结，预结不锁账、例外不得绕过权限及新版本',async t=>{t.mock.timers.enable({apis:['Date'],now});
 const g=systemFixture();day(g,'2026-10-31');
 await mutateFinanceLedger(g.db,g.users.finance,{action:'rate',month:'2026-10',currency:'IDR',rate:0.00045,revision:0,evidence:'TEST-ONLY fixed monthly FX'});
 await refreshBusinessActions(g.db,g.users.admin,now);
 let action=g.sqlite.prepare("SELECT * FROM business_actions WHERE site='印尼' AND channel='TikTok' AND sku='BAG-A' AND kind='loss'").get();
 const before=await actionFinanceDay(g.db,action,'2026-10-31');
 await mutateBusinessAction(g.db,g.users.finance,{action:'finance',id:action.id,version:action.version,businessDate:'2026-10-31',basisHash:before.basisHash,revision:before.revision,costs:{landed:600000,ads:0,platform:100000,fulfillment:50000,returns:0},source:'TEST-ONLY audit voucher',confirmed:true,note:'Synthetic costs only'},now);
 const verified=await actionFinanceDay(g.db,action,'2026-10-31');assert.equal(verified.status,'confirmed');
 const dailyProfit=verified.revenue-Object.values(verified.costs).reduce((a,b)=>a+b,0);

 const month='2026-10',snap=await createFinanceSnapshot(g.db,g.users.admin,month);
 assert.equal(dailyProfit,250000);assert.equal(snap.profitSummary.confirmed,11250);assert.equal(snap.quality.uncoveredSales,0);
 assert.equal(snap.profitSummary.lines[0].dailyRevision,1);assert.deepEqual(snap.profitSummary.lines[0].saleIds,['s-2026-10-31']);
 const cmd={month,revision:0,evidence:'隔离测试：已核对日报证据'};
 await assert.rejects(mutateFinanceLedger(g.db,g.users.admin,{...cmd,action:'close'}),/未核对/);
 await mutateFinanceLedger(g.db,g.users.finance,{...cmd,action:'preclose'});
 let view=await readFinanceLedger(g.db,g.users.admin,{month,view:'period'});assert.equal(view.snapshot,null);assert.equal(view.preclose.profit.confirmed,11250);
 const exception={...cmd,revision:1,action:'close',reviewVersion:view.version,exceptionReason:'已记录具体待补项',exceptionKeys:view.preview.quality.checks.filter(c=>c.blocking&&c.count).map(c=>c.key)};
 await assert.rejects(mutateFinanceLedger(g.db,g.users.finance,exception),/管理员/);
 g.sqlite.prepare("UPDATE sales_records SET reported_amount=1100000 WHERE id='s-2026-10-31'").run();
 await assert.rejects(mutateFinanceLedger(g.db,g.users.admin,exception),/最新清单/);
 view=await readFinanceLedger(g.db,g.users.admin,{month,view:'period'});assert.equal(view.preview.profit.confirmed,0);assert.equal(view.preview.profit.pending,1);assert.equal(view.preclose.profit.confirmed,11250);assert.equal(view.preview.inventory.totals.qty,null);
 g.sqlite.close();
});
test('旧海运来源在驾驶舱与财务库存数量相同',async()=>{
 const h=systemFixture();
 h.sqlite.prepare("INSERT INTO production_batches(id,month,sku,name,qty,stage,stage_owner,allocations_json,creator_id,created_at,updated_at,estimated_arrival_date) VALUES('audit-legacy','2026-10','BAG-A','TEST-ONLY',20,'sea_freight','海运',?,'admin-1','2026-10-31','2026-10-31','2026-11-08')").run(JSON.stringify([{site:'印尼',channel:'TikTok',qty:20}]));
 const forecast=(await loadForecast(h.db,h.users.admin,'2026-11-04')).suggestions.find(r=>r.site==='印尼'&&r.channel==='TikTok'&&r.sku==='BAG-A');
 const valuation=(await inventoryValuation(h.db)).rows.find(r=>r.site==='印尼'&&r.channel==='TikTok'&&r.sku==='BAG-A');
 assert.equal(forecast.seaInTransit,20);assert.equal(valuation.transit,20);h.sqlite.close();
});
test('跨午夜时运营只被提醒已结束的本地日期',async t=>{t.mock.timers.enable({apis:['Date'],now:new Date('2026-11-03T16:30:00Z')});
 const j=systemFixture();day(j,'2026-11-02');
 const tasks=await workspaceTasks(j.db,j.users.indonesia);
 assert.ok(!tasks.some(t=>t.title==='导入昨日销售'));j.sqlite.close();
});
test('站点结账截点不同，月末只取截点之前的数量，后续变更不回写',async t=>{
 const f=systemFixture();const start=f.sqlite.prepare('SELECT started_at FROM finance_stock_baseline').get().started_at;
 const base=new Date(start),period=new Date(Date.UTC(base.getUTCFullYear(),base.getUTCMonth()+1,2)).toISOString().slice(0,7),id=periodCutoff(period,'印尼'),my=periodCutoff(period,'马来西亚');assert.ok(my<id);
 t.mock.timers.enable({apis:['Date'],now:new Date(Date.parse(id)+86400000)});
 const insert=f.sqlite.prepare("INSERT INTO finance_stock_history(at,source,entity,payload) VALUES(?,'inventory_balances',?,?)");
 for(const site of ['印尼','马来西亚'])for(const [at,qty] of [[new Date(Date.parse(my)-1000).toISOString(),100],[my,80],[id,20]]){
  const row={site,channel:'TikTok',sku:'HISTORY-TEST',qty,reserved_qty:5,pending_shelf_qty:2,quarantine_qty:1};insert.run(at,JSON.stringify([site,row.channel,row.sku]),JSON.stringify(row));}
 const inv=await monthEndStock(f.db,period,{products:[]},[]),row=site=>inv.rows.find(r=>r.site===site&&r.sku==='HISTORY-TEST');
 assert.equal(inv.status,'historical');assert.equal(row('印尼').available,75);assert.equal(row('马来西亚').available,95);assert.equal(row('印尼').actualValueCny,null);f.sqlite.close();
});

test('跨站看板与总览在时区交界仍同量，工厂报表不返回金额',async t=>{
 t.mock.timers.enable({apis:['Date'],now:new Date('2026-11-03T16:30:00Z')});const f=systemFixture();
 day(f,'2026-10-27',2);day(f,'2026-11-03',5);
 for(const [date,qty] of [['2026-10-27',3],['2026-11-03',7]])f.sqlite.prepare("INSERT INTO sales_records(id,import_id,site,channel,business_date,sku,qty,currency,reported_amount,actor_id,created_at) VALUES(?,?,'马来西亚','TikTok',?,'BAG-A',?,'MYR',30,'admin-1',?)").run('my'+date,'my'+date,date,qty,date);
 const report=await readSalesDashboard(f.db,f.users.admin,{range:'last7'});assert.equal(report.totalQty,9);
 svc.setActor(f.users.admin);const overview=await (await svc.GET(new Request('http://localhost/api/system?module=overview'))).json();assert.equal(overview.metrics.sales7Qty,report.totalQty);
 const factory=await readSalesDashboard(f.db,{role:'工厂'},{range:'last7'});assert.equal(factory.totalQty,9);assert.deepEqual(factory.currencies,[]);f.sqlite.close();
});
test('同一销售既有真实批次又有财务日核，月结只归集一次并保留差额',async t=>{
 t.mock.timers.enable({apis:['Date'],now});const f=systemFixture(),date='2026-10-31';
 for(const u of [f.users.finance,f.users.supply])f.sqlite.prepare('INSERT INTO cost_access VALUES(?,?,1,?)').run(u.id,1,u.role==='财务'?1:0);
 const {ids}=await importRows(f,ticketRows());await review(f,ids[0]);day(f,date,15,1000000);
 await mutateFinanceLedger(f.db,f.users.finance,{action:'rate',month:'2026-10',currency:'IDR',rate:0.00045,revision:0,evidence:'测试汇率'});
 const saleId='s-'+date;const order=orderPayload({businessDate:date,lines:[{ticketKey:'SHIP-TEST',lineKey:'A',salesRecordId:saleId,qty:15}]});
 await mutateCost(f.db,f.users.finance,order);const snap=()=>createFinanceSnapshot(f.db,f.users.admin,'2026-10');const batch=await snap();assert.notEqual(batch.profitSummary.confirmed,0);assert.equal(batch.profitSummary.lines[0].basis,'批次成本账');
 await refreshBusinessActions(f.db,f.users.admin,now);const action=f.sqlite.prepare("SELECT * FROM business_actions WHERE site='印尼' AND channel='TikTok' AND sku='BAG-A' AND kind='loss'").get();
 const input=await actionFinanceDay(f.db,action,date);await mutateBusinessAction(f.db,f.users.finance,{action:'finance',id:action.id,version:action.version,businessDate:date,basisHash:input.basisHash,revision:0,costs:{landed:600000,ads:0,platform:100000,fulfillment:50000,returns:0},source:'合成日核凭据',confirmed:true,note:'对照归集'},now);
 const final=await snap();assert.equal(final.profitSummary.confirmed,11250);assert.equal(final.profitSummary.lines.length,1);assert.equal(final.profitSummary.lines[0].batchIds.length,1);assert.match(final.profitSummary.lines[0].reason,/差额/);assert.equal(final.quality.uncoveredSales,0);assert.equal((await readCostProfit(f.db,f.users.admin,{from:date,to:date})).unified.confirmed,11250);f.sqlite.close();
});

test('关账重查结算区间：原单对平，跨月日报修订后显示差额，撤报后列缺报',async t=>{
 t.mock.timers.enable({apis:['Date'],now});const f=systemFixture();day(f,'2026-09-30',1,20000);day(f,'2026-10-01',1,30000);
 await mutateFinanceLedger(f.db,f.users.finance,{action:'document',kind:'platform_settlement',businessKey:'TEST-CROSS',revision:0,businessDate:'2026-10-01',counterparty:'测试平台',reference:'TEST-SETTLE',site:'印尼',channel:'TikTok',currency:'IDR',from:'2026-09-30',to:'2026-10-01',gross:50000,refunds:0,fees:0,adjustment:0,amount:50000,evidence:'测试账单',reason:'合成数据',reconciliationNote:'对账用例'});
 const issues=async()=>(await createFinanceSnapshot(f.db,f.users.admin,'2026-10')).quality.settlementIssues;
 assert.deepEqual(await issues(),[]);f.sqlite.prepare("UPDATE sales_records SET reported_amount=25000 WHERE id='s-2026-09-30'").run();
 const [changed]=await issues();assert.equal(changed.originalDifferenceMinor,0);assert.equal(changed.differenceMinor,-500000);
 f.sqlite.prepare("UPDATE sales_imports SET reversed_at='2026-11-01' WHERE business_date='2026-09-30'").run();
 const [missing]=await issues();assert.equal(missing.differenceMinor,null);assert.deepEqual(missing.missingDates,['2026-09-30']);f.sqlite.close();
});
