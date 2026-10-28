import test from 'node:test';
import assert from 'node:assert/strict';
import {costFixture,ticketRows,importRows,review,seedSale,orderPayload} from './cost-fixture.mjs';
import {mutateCost,readCostProfit} from '../lib/cost-profit.mjs';
import {dailyAdAllocation,assertDailyAdAllocation} from '../lib/finance-ad-allocation.mjs';
import {financeDays} from '../lib/business-action-finance.mjs';
import {costContext,sourceBasis,dailyCostSuggestion} from '../lib/cost-source-context.mjs';
import {mutateFinanceLedger,readFinanceLedger} from '../lib/finance-ledger.mjs';
import {financialSalesSummary} from '../lib/finance-sales.mjs';
import {readSalesDashboard} from '../lib/sales-dashboard.mjs';
import {inventoryValuation} from '../lib/finance-inventory.mjs';
import {costSalesSources} from '../lib/cost-sale-sources.mjs';
const d='2026-09-20';
const doc=(changes={})=>({action:'document',kind:'supplier_payment',businessKey:'PAY-1',revision:0,businessDate:d,counterparty:'TEST-ONLY 工厂',site:'',channel:'',currency:'CNY',amount:100,reference:'TEST-BANK-1',evidence:'TEST-ONLY 银行凭据',reason:'隔离测试核对',...changes});
const fin=(f,p)=>mutateFinanceLedger(f.db,f.users.finance,p);
async function po(f){f.sqlite.prepare("INSERT INTO series_purchase_orders(id,month,series_name,supplier_name,status,total_qty,sku_count,approval_id,creator_id,created_at,updated_at,document_json) VALUES('po','2026-09','测试系列','TEST-ONLY 工厂','ordered',10,1,'TEST-approved','admin-1',?,?,?)").run(d,d,JSON.stringify({currency:'CNY',items:[{sku:'BAG-A',purchasePrice:10}]}));f.sqlite.prepare("INSERT INTO series_purchase_order_items VALUES('poi','po','BAG-A','测试',10,'[]',?,?)").run(d,d);}
function seedFinanceDay(f,sku,ads,revision=1){f.sqlite.prepare('INSERT INTO business_action_finance_days VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(crypto.randomUUID(),'印尼','TikTok',sku,d,revision,'IDR','test-basis','{}',JSON.stringify({landed:0,ads,platform:0,fulfillment:0,returns:0}),'TEST-ONLY','测试',f.users.finance.id,d);}
function seedAds(f){f.sqlite.prepare("INSERT INTO sales_ad_spend(id,business_date,site,channel,currency,amount,note,actor_id,updated_at) VALUES('ad',?,'印尼','TikTok','IDR',10,'TEST-ONLY','finance-1',?)").run(d,d);}

test('广告分配守恒：10元店铺广告最多分6+4，重复10+10被阻止，修订释放原分配',async()=>{
 const f=costFixture();seedAds(f);seedFinanceDay(f,'BAG-A',6);const scope={site:'印尼',channel:'TikTok',sku:'BAG-B',date:d,currency:'IDR'};
 assert.equal((await dailyAdAllocation(f.db,scope)).available,4);await assertDailyAdAllocation(f.db,scope,4);await assert.rejects(assertDailyAdAllocation(f.db,scope,5),/超额/);
 seedFinanceDay(f,'BAG-A',3,2);assert.equal((await dailyAdAllocation(f.db,scope)).available,7);
 const other={...scope,date:'2026-09-21'};await assert.rejects(assertDailyAdAllocation(f.db,other,1),/来源待核实/);
});

test('旧超额广告不能继续当已核实利润；来源范围和币种独立',async()=>{
 const f=costFixture();seedAds(f);seedFinanceDay(f,'BAG-A',10);seedFinanceDay(f,'BAG-B',10);
 const entries=(await f.db.prepare('SELECT * FROM business_action_finance_days').all()).results,ads=(await f.db.prepare('SELECT * FROM sales_ad_spend').all()).results;
 const args={dates:[d],site:'印尼',channel:'TikTok',sku:'BAG-A',sales:[{id:'s',import_id:'i',sku:'BAG-A',business_date:d,qty:1,reported_amount:100,currency:'IDR'}],imports:[{id:'i',business_date:d,report_kind:'complete'}],ads,afters:[],entries:[],scopeEntries:entries};
 const basis=await financeDays(args);const same={...entries[0],basis_hash:basis[0].basisHash};const day=(await financeDays({...args,entries:[same]}))[0];assert.equal(day.status,'stale');assert.equal(day.overallocated,true);
});

test('成本版本联动日核算；已关联实际成本建议可带入，参考值不冒充实际',async()=>{
 const f=costFixture();const {ids}=await importRows(f);await review(f,ids[0]);seedSale(f);await mutateCost(f.db,f.users.admin,orderPayload());
 const scope={site:'印尼',channel:'TikTok',sku:'BAG-A',date:'2026-10-20',currency:'CNY'};const context=await costContext(f.db),before=sourceBasis(context,scope),suggestion=await dailyCostSuggestion(f.db,context,scope);
 assert.equal(suggestion.status,'actual_linked');assert.deepEqual(suggestion.costs,{landed:200,platform:40,fulfillment:18,ads:30,returns:0});
 const changed=ticketRows({revision:1,seaAmount:450,reason:'后补真实海运费用'});await importRows(f,changed);const after=sourceBasis(await costContext(f.db),scope);assert.notDeepEqual(before,after);assert.equal((await dailyCostSuggestion(f.db,await costContext(f.db),scope)).costs,null);
});

test('冲销销售后可作废旧关联，再登记新来源；历史及库存不被重写',async()=>{
 const f=costFixture(),{ids}=await importRows(f);await review(f,ids[0]);seedSale(f);await mutateCost(f.db,f.users.admin,orderPayload());
 const before=f.sqlite.prepare('SELECT * FROM inventory_balances').all();f.sqlite.prepare("UPDATE sales_records SET reversed_at='2026-10-21' WHERE id='s1'").run();
 assert.equal((await readCostProfit(f.db,f.users.admin)).orders[0].contribution,null);
 await mutateCost(f.db,f.users.admin,orderPayload({action:'voidOrder',revision:1,reason:'源销售已冲销，释放关联'}));let r=await readCostProfit(f.db,f.users.admin);assert.equal(r.orders.length,0);assert.equal(r.tickets[0].lots.reduce((s,l)=>s+l.used,0),0);assert.equal(r.voidedOrders.length,1);
 seedSale(f,{id:'s2'});await mutateCost(f.db,f.users.admin,orderPayload({businessKey:'ORDER-2',lines:orderPayload().lines.map(l=>({...l,salesRecordId:'s2'}))}));assert.equal((await readCostProfit(f.db,f.users.admin)).orders[0].contribution,11200);assert.deepEqual(f.sqlite.prepare('SELECT * FROM inventory_balances').all(),before);assert.equal(f.sqlite.prepare("SELECT count(*) n FROM cost_records WHERE kind='order'").get().n,3);
});

test('显式纠正关联保留旧版本，普通费用修订不能静默换来源',async()=>{
 const f=costFixture(),{ids}=await importRows(f);await review(f,ids[0]);seedSale(f);await mutateCost(f.db,f.users.admin,orderPayload());f.sqlite.prepare("UPDATE sales_records SET reversed_at='2026-10-21' WHERE id='s1'").run();seedSale(f,{id:'s2'});const p=orderPayload({revision:1,reason:'纠正来源销售编号',lines:orderPayload().lines.map(l=>({...l,salesRecordId:'s2'}))});
 await assert.rejects(mutateCost(f.db,f.users.admin,p),/不能更改原出库关联/);await mutateCost(f.db,f.users.admin,{...p,action:'replaceOrder'});const r=await readCostProfit(f.db,f.users.admin);assert.equal(r.orders[0].revision,2);assert.equal(r.tickets[0].lots.reduce((s,l)=>s+l.used,0),15);
});

test('按SKU收入守恒分摊，两个SKU贡献相加等于整单且暂估单独列示',async()=>{
 const f=costFixture();const input=ticketRows();input[1].sku='BAG-B';const {ids}=await importRows(f,input);await review(f,ids[0]);seedSale(f,{qty:10,amount:300});seedSale(f,{id:'s2',sku:'BAG-B',qty:5,amount:100});
 await mutateCost(f.db,f.users.admin,orderPayload({lines:[{ticketKey:'SHIP-TEST',lineKey:'A',salesRecordId:'s1',qty:10},{ticketKey:'SHIP-TEST',lineKey:'B',salesRecordId:'s2',qty:5}]}));
 const total=await readCostProfit(f.db,f.users.admin),a=await readCostProfit(f.db,f.users.admin,{sku:'BAG-A'}),b=await readCostProfit(f.db,f.users.admin,{sku:'BAG-B'});assert.equal(a.totals.contribution+b.totals.contribution,total.totals.contribution);assert.notEqual(a.totals.contribution,total.totals.contribution);
 await importRows(f,input.map(r=>({...r,revision:1,seaState:'estimated',reason:'运费暂估修订'})));const latest=f.sqlite.prepare("SELECT id FROM cost_records WHERE kind='ticket' ORDER BY revision DESC").get();await review(f,latest.id);const r=await readCostProfit(f.db,f.users.admin);assert.equal(r.totals.confirmedContribution,0);assert.equal(r.totals.estimatedContribution,11200);
});

test('线下已发货进入成本缺口；寄售发货不计收入，实销后才列入',async()=>{
 const f=costFixture();const id=await f.create({businessDate:d});await f.approve(id);await f.ship(id,5,d);let r=await readCostProfit(f.db,f.users.admin);assert.equal(r.uncovered.find(s=>s.sourceKind==='wholesale').uncoveredQty,5);
 const before=f.sqlite.prepare('SELECT COUNT(*) n FROM sales_records').get().n;assert.equal(before,0);
 const cid=await f.create({businessDate:d,saleType:'consignment'});await f.approve(cid);await f.ship(cid,5,d);
 const sources=await costSalesSources(f.db,f.users.admin);assert.equal(sources.filter(s=>s.sourceKind==='consignment').length,0);
 const report=await readSalesDashboard(f.db,f.users.admin,{from:d,to:d,site:'印尼',channel:'线下分销'});assert.equal(report.totalQty,5);assert.equal(report.currencies[0].revenue,500000);
 const item=f.sqlite.prepare('SELECT id FROM wholesale_order_items WHERE order_id=?').get(cid);f.sqlite.prepare('INSERT INTO wholesale_consignment_sales(id,order_id,order_item_id,qty,amount,reference,business_date,note,actor_id,actor_name,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run('cs',cid,item.id,2,200000,'TEST-SOLD',d,'TEST-ONLY','finance-1','财务',d);
 assert.equal((await costSalesSources(f.db,f.users.admin)).find(s=>s.sourceKind==='consignment').qty,2);assert.equal((await readSalesDashboard(f.db,f.users.admin,{from:d,to:d,site:'印尼',channel:'线下分销'})).totalQty,7);assert.equal((await inventoryValuation(f.db)).rows.find(r=>r.channel==='线下分销').consigned,3);
});

test('供应商发票关联采购，付款/预付与应付分开，核销不能超额或重复凭据',async()=>{
 const f=costFixture();await po(f);await fin(f,doc());await assert.rejects(fin(f,doc({businessKey:'PAY-2'})),/同一凭据/);
 await fin(f,doc({kind:'supplier_bill',businessKey:'BILL-1',reference:'TEST-INVOICE',purchaseOrderId:'po',lines:[{sku:'BAG-A',qty:10,unitPrice:10}],taxAmount:0,exceptionReason:'已收到发票，国内集运收货待补凭据'}));
 await fin(f,doc({kind:'supplier_allocation',businessKey:'ALLOC-1',cashKey:'PAY-1',debtKey:'BILL-1',amount:60}));
 let r=await readFinanceLedger(f.db,f.users.finance,{month:'2026-09'});assert.equal(r.balances.find(r=>r.business_key==='BILL-1').remaining,4000);assert.equal(r.balances.find(r=>r.business_key==='PAY-1').remaining,4000);
 await assert.rejects(fin(f,doc({kind:'supplier_allocation',businessKey:'ALLOC-2',cashKey:'PAY-1',debtKey:'BILL-1',amount:41})),/超过/);
 await assert.rejects(fin(f,doc({revision:1,status:'void'})),/先作废关联核销/);
 await fin(f,doc({kind:'supplier_allocation',businessKey:'ALLOC-1',revision:1,status:'void'}));await fin(f,doc({revision:1,status:'void'}));r=await readFinanceLedger(f.db,f.users.finance,{month:'2026-09'});assert.equal(r.balances.find(r=>r.business_key==='BILL-1').remaining,10000);
});

test('平台结算净额校验、重叠账期拦截，到账核销不再产生收入',async()=>{
 const f=costFixture();seedSale(f,{businessDate:d,amount:100});const p=doc({kind:'platform_settlement',businessKey:'SET-1',site:'印尼',channel:'TikTok',counterparty:'TEST-TikTok',reference:'TEST-SETTLEMENT',from:d,to:d,gross:100,refunds:5,fees:10,adjustment:0,amount:85,reconciliationNote:'核对平台总销售及退款账单'});await fin(f,p);
 await assert.rejects(fin(f,{...p,businessKey:'SET-2',reference:'TEST-SET2'}),/重叠账期/);await assert.rejects(fin(f,{...p,revision:1,amount:90}),/待到账净额/);
 await fin(f,doc({kind:'platform_receipt',businessKey:'BANK-1',site:'印尼',channel:'TikTok',counterparty:'TEST-TikTok',amount:85}));await fin(f,doc({kind:'platform_allocation',businessKey:'MATCH-1',site:'印尼',channel:'TikTok',counterparty:'TEST-TikTok',amount:85,cashKey:'BANK-1',debtKey:'SET-1'}));
 const r=await readFinanceLedger(f.db,f.users.finance,{month:'2026-09'});assert.equal(r.balances.find(r=>r.business_key==='SET-1').remaining,0);assert.equal(f.sqlite.prepare('SELECT SUM(reported_amount) n FROM sales_records').get().n,100);
});

test('核定月汇率与关账销售固定；原始销售变化不会改写封存快照，反关账可重算',async()=>{
 const f=costFixture();seedSale(f,{businessDate:d,amount:2000000});f.sqlite.prepare("UPDATE sales_records SET currency='IDR' WHERE id='s1'").run();await fin(f,{action:'rate',month:'2026-09',currency:'IDR',rate:0.0005,revision:0,evidence:'TEST-ONLY 财务九月汇率'});
 const q={from:d,to:d,site:'印尼',channel:'TikTok'},load=async()=>financialSalesSummary(f.db,f.users.admin,await readSalesDashboard(f.db,f.users.admin,q));assert.equal((await load()).total.revenueCny,1000);
 await mutateFinanceLedger(f.db,f.users.admin,{action:'close',month:'2026-09',revision:0,evidence:'TEST-ONLY 核对已知部分并封存'});
 assert.throws(()=>f.sqlite.prepare("UPDATE sales_records SET reported_amount=3000000 WHERE id='s1'").run(),/closed finance/);assert.equal((await load()).total.revenueCny,1000);
 await assert.rejects(fin(f,{action:'rate',month:'2026-09',currency:'IDR',rate:0.00045,revision:1,evidence:'TEST'}),/关账/);
 await mutateFinanceLedger(f.db,f.users.admin,{action:'reopen',month:'2026-09',revision:1,evidence:'TEST-ONLY 复核修订'});f.sqlite.prepare("UPDATE sales_records SET reported_amount=3000000 WHERE id='s1'").run();assert.equal((await load()).total.revenueCny,1500);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM finance_period_events').get().n,2);
});

test('库存六类互斥，参考与实际分列；财务批次核对后金额可追溯，库存变动立即失效',async()=>{
 const f=costFixture(),{ids}=await importRows(f);await review(f,ids[0]);f.sqlite.prepare("UPDATE inventory_balances SET reserved_qty=2,pending_shelf_qty=3,quarantine_qty=1 WHERE site='印尼' AND channel='TikTok' AND sku='BAG-A'").run();
 let row=(await inventoryValuation(f.db)).rows.find(r=>r.site==='印尼'&&r.channel==='TikTok'&&r.sku==='BAG-A');assert.equal(row.available,8);assert.equal(row.totalQty,14);assert.equal(row.actualValueCny,null);assert.equal(row.referenceValueCny,null);
 await fin(f,doc({kind:'inventory_valuation',businessKey:'VAL-1',businessDate:'2026-10-20',counterparty:'自有存货',site:'印尼',channel:'TikTok',sku:'BAG-A',lots:[{ticketKey:'SHIP-TEST',lineKey:'A',qty:14}],amount:0}));
 row=(await inventoryValuation(f.db)).rows.find(r=>r.site==='印尼'&&r.channel==='TikTok'&&r.sku==='BAG-A');assert.equal(row.actualValueCny,168);
 f.stock('BAG-A',9,10);row=(await inventoryValuation(f.db)).rows.find(r=>r.site==='印尼'&&r.channel==='TikTok'&&r.sku==='BAG-A');assert.equal(row.actualValueCny,null);assert.match(row.valuationStatus,/需重新核对/);
});

test('资金和库存价值API业务层拒绝工厂与运营；管理员独立授权且不自动开通',async()=>{
 const f=costFixture();for(const actor of [f.users.sales,f.users.supply,f.users.indonesia])await assert.rejects(readFinanceLedger(f.db,actor),/仅管理员和财务/);
 await assert.rejects(fin(f,{action:'access',userId:f.users.supply.id,canRead:true,reason:'TEST'}),/仅管理员/);
 await mutateFinanceLedger(f.db,f.users.admin,{action:'access',userId:f.users.supply.id,canRead:false,canWrite:true,canReview:true,reason:'收回测试访问'});const row=f.sqlite.prepare('SELECT * FROM cost_access WHERE user_id=?').get(f.users.supply.id);assert.equal(row.can_read,0);assert.equal(row.can_write,0);assert.equal(row.can_review,0);
});

test('批次数量纠错不得低于已关联数量，修订后须重新独立复核',async()=>{
 const f=costFixture(),{ids}=await importRows(f);await review(f,ids[0]);seedSale(f);await mutateCost(f.db,f.users.admin,orderPayload());
 const p={action:'correctTicket',businessKey:'SHIP-TEST',revision:1,reason:'原数量录入错误，按收货凭据核对',quantities:[{lineKey:'A',qty:9},{lineKey:'B',qty:50}]};
 await assert.rejects(mutateCost(f.db,f.users.admin,p),/小于已关联数量/);p.quantities[0].qty=90;await mutateCost(f.db,f.users.admin,p);const r=await readCostProfit(f.db,f.users.admin);assert.equal(r.tickets[0].revision,2);assert.equal(r.tickets[0].reviewed_at,null);assert.equal(r.orders[0].contribution,null);assert.equal(r.tickets[0].lots[0].qty,90);
});

test('省略入仓费用不能冒充完整实际成本；旧模板仍可导入但保持待核实',async()=>{
 const f=costFixture();const input=ticketRows().map(r=>Object.fromEntries(Object.entries(r).filter(([k])=>!k.startsWith('inbound'))));const {ids}=await importRows(f,input);await review(f,ids[0]);seedSale(f);await mutateCost(f.db,f.users.admin,orderPayload());const r=await readCostProfit(f.db,f.users.admin);assert.equal(r.orders[0].contribution,null);assert.ok(r.orders[0].missing.some(s=>s.includes('入仓')));assert.equal(r.totals.confirmedContribution,0);
});

test('财务核销并发争用同一余额只能一个成功，失败写入及审计原子回滚',async()=>{
 const f=costFixture();await po(f);await fin(f,doc());await fin(f,doc({kind:'supplier_bill',businessKey:'BILL-1',reference:'TEST-INVOICE',purchaseOrderId:'po',lines:[{sku:'BAG-A',qty:10,unitPrice:10}],taxAmount:0,exceptionReason:'收货待核对'}));
 const result=await Promise.allSettled(['A','B'].map(key=>fin(f,doc({kind:'supplier_allocation',businessKey:key,amount:70,cashKey:'PAY-1',debtKey:'BILL-1'}))));assert.equal(result.filter(r=>r.status==='fulfilled').length,1);const view=await readFinanceLedger(f.db,f.users.admin,{month:'2026-09'});assert.equal(view.balances.find(r=>r.business_key==='PAY-1').remaining,3000);assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM finance_documents WHERE kind='supplier_allocation'").get().n,1);
});

test('核定财务汇率缺失保持未知，运营只能看到自己的冻结行，工厂不得读取',async()=>{
 const f=costFixture();seedSale(f,{businessDate:d,amount:2000000});f.sqlite.prepare("UPDATE sales_records SET currency='IDR' WHERE id='s1'").run();seedSale(f,{id:'my-sale',businessDate:d,site:'马来西亚',amount:5000});
 const report=await readSalesDashboard(f.db,f.users.admin,{from:d,to:d});const c=await financialSalesSummary(f.db,f.users.admin,report);assert.equal(c.total.revenueComplete,false);assert.equal(c.scopes.find(s=>s.site==='印尼').revenueCny,null);
 await fin(f,{action:'rate',month:'2026-09',currency:'IDR',rate:0.0005,revision:0,evidence:'TEST 核定凭据'});await mutateFinanceLedger(f.db,f.users.admin,{action:'close',month:'2026-09',revision:0,evidence:'TEST 本月关账'});
 const op=await financialSalesSummary(f.db,f.users.indonesia,report);assert.ok(op.scopes.every(r=>r.site==='印尼'&&r.channel==='TikTok'));assert.equal(op.total.revenueCny,1000);await assert.rejects(financialSalesSummary(f.db,{role:'工厂'},report),e=>e.status===403);
});

test('新财务台账、固定汇率、关账快照可完整备份恢复且保持不可改写',async()=>{
 const {mkdtempSync,rmSync}=await import('node:fs'),{tmpdir}=await import('node:os'),{join}=await import('node:path'),{createBackup,restoreBackup}=await import('../server/backup.mjs'),{fileBucket,openDatabase}=await import('../server/storage.mjs');const root=mkdtempSync(join(tmpdir(),'finance-chain-backup-'));
 try{const f=costFixture();await fin(f,doc());await fin(f,{action:'rate',month:'2026-09',currency:'IDR',rate:0.0005,revision:0,evidence:'TEST-ONLY 月度汇率'});await mutateFinanceLedger(f.db,f.users.admin,{action:'close',month:'2026-09',revision:0,evidence:'TEST-ONLY 保存关账快照'});
 const archive=join(root,'backup.tar');await createBackup({DB:f.db,WHOLESALE_FILES:fileBucket(join(root,'files'))},archive);await restoreBackup(archive,join(root,'restored'));const db=openDatabase(join(root,'restored/business.sqlite'));
 const r=await readFinanceLedger(db,f.users.admin,{month:'2026-09'});assert.equal(r.balances[0].amount_minor,10000);assert.equal(r.rates.find(r=>r.currency==='IDR').rate,0.0005);assert.ok(r.snapshot);assert.throws(()=>db.sqlite.prepare("UPDATE finance_documents SET amount_minor=0").run(),/immutable/);db.sqlite.close();
 }finally{rmSync(root,{recursive:true,force:true});}
});


test('关账后存货以新日期续记，不改变旧月库存快照且可加载旧月版本',async()=>{
 const f=costFixture(),{ids}=await importRows(f,ticketRows({businessDate:d,effectiveAt:d}));await review(f,ids[0]);
 const p=doc({kind:'inventory_valuation',businessKey:'VAL-CARRY',businessDate:d,counterparty:'自有存货',site:'印尼',channel:'TikTok',sku:'BAG-A',lots:[{ticketKey:'SHIP-TEST',lineKey:'A',qty:10}],amount:0});await fin(f,p);
 await mutateFinanceLedger(f.db,f.users.admin,{action:'close',month:'2026-09',revision:0,evidence:'TEST-ONLY 封存九月'});
 const original=(await readFinanceLedger(f.db,f.users.admin,{month:'2026-09'})).snapshot.inventory;
 const next=await readFinanceLedger(f.db,f.users.finance,{month:'2026-10'});assert.equal(next.valuations.find(v=>v.business_key==='VAL-CARRY').revision,1);
 f.stock('BAG-A',9,10);await fin(f,{...p,businessDate:'2026-10-20',revision:1,lots:[{ticketKey:'SHIP-TEST',lineKey:'A',qty:9}]});
 assert.equal((await inventoryValuation(f.db)).rows.find(r=>r.channel==='TikTok'&&r.sku==='BAG-A').actualValueCny,108);
 assert.deepEqual((await readFinanceLedger(f.db,f.users.admin,{month:'2026-09'})).snapshot.inventory,original);
});

test('本月广告费用池不能通过分摊改写已关账月份的成本',async()=>{
 const f=costFixture(),{ids}=await importRows(f,ticketRows({businessDate:d,effectiveAt:d}));await review(f,ids[0]);seedSale(f,{businessDate:d});
 await mutateCost(f.db,f.users.finance,orderPayload({businessDate:d,adMode:'allocated',advertising:{amount:0,state:'not_applicable',source:'TEST共享广告'}}));
 await mutateFinanceLedger(f.db,f.users.admin,{action:'close',month:'2026-09',revision:0,evidence:'TEST-ONLY 九月封存'});
 await assert.rejects(mutateCost(f.db,f.users.finance,{action:'advertising',businessKey:'CROSS-MONTH',revision:0,site:'印尼',channel:'TikTok',businessDate:'2026-10-20',reason:'TEST',amount:10,state:'actual',source:'TEST',currency:'CNY',fx:1,fxVersion:'CNY1',orderKeys:['ORDER-TEST']}),/关账/);
});

test('线下与寄售实销可直接消耗原渠道成本批次，跨业务累计守恒且运营无额外金额可见',async()=>{
 const f=costFixture();for(const channel of ['TikTok','Shopee']){const {ids}=await importRows(f,ticketRows({businessKey:'LOT-'+channel,channel,businessDate:d,effectiveAt:d}));await review(f,ids[0]);}
 const oid=await f.create({businessDate:d});await f.approve(oid);await f.ship(oid,5,d);const sale=(await costSalesSources(f.db,f.users.admin)).find(s=>s.sourceKind==='wholesale'),before=f.sqlite.prepare('SELECT * FROM inventory_balances').all();
 const lines=sale.stockChannels.filter(c=>c.qty>0).map(c=>({ticketKey:'LOT-'+c.channel,lineKey:'A',salesRecordId:sale.id,qty:c.qty}));
 await mutateCost(f.db,f.users.finance,orderPayload({businessKey:'OFFLINE',businessDate:d,channel:'线下分销',lines}));
 const view=await readCostProfit(f.db,f.users.admin);assert.equal(view.uncovered.filter(s=>s.sourceKind==='wholesale').length,0);assert.equal(view.tickets.reduce((sum,t)=>sum+t.lots.reduce((n,l)=>n+l.used,0),0),5);assert.deepEqual(f.sqlite.prepare('SELECT * FROM inventory_balances').all(),before);
 const op=await readCostProfit(f.db,f.users.indonesia);assert.equal(op.orders.length,0);assert.ok(op.sales.every(s=>s.channel==='TikTok'));assert.equal(op.tickets.reduce((n,t)=>n+t.lots.reduce((n,l)=>n+l.used,0),0),sale.stockChannels.find(c=>c.channel==='TikTok').qty);
 const bad={...lines[0],qty:5};await assert.rejects(mutateCost(f.db,f.users.finance,orderPayload({businessKey:'OFFLINE',revision:1,action:'replaceOrder',businessDate:d,channel:'线下分销',lines:[bad]})),/原出库份额|实际出货量/);
 const cid=await f.create({businessDate:d,saleType:'consignment'});await f.approve(cid);await f.ship(cid,5,d);const item=f.sqlite.prepare('SELECT id FROM wholesale_order_items WHERE order_id=?').get(cid);f.sqlite.prepare('INSERT INTO wholesale_consignment_sales(id,order_id,order_item_id,qty,amount,reference,business_date,note,actor_id,actor_name,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run('consign-linked',cid,item.id,2,200000,'TEST-SOLD-LINKED',d,'TEST-ONLY','finance-1','财务',d);
 const consigned=(await costSalesSources(f.db,f.users.admin)).find(s=>s.id==='whc:consign-linked');let left=2;const consignedLines=consigned.stockChannels.flatMap(c=>{const qty=Math.min(left,c.qty);left-=qty;return qty?[{ticketKey:'LOT-'+c.channel,lineKey:'A',salesRecordId:consigned.id,qty}]:[];});
 await mutateCost(f.db,f.users.finance,orderPayload({businessKey:'CONSIGNED-SOLD',businessDate:d,channel:'线下分销',lines:consignedLines}));const final=await readCostProfit(f.db,f.users.admin);assert.equal(final.uncovered.length,0);assert.equal(final.tickets.reduce((n,t)=>n+t.lots.reduce((n,l)=>n+l.used,0),0),7);
});

test('SKU分摊依据不足时保留整单待分配金额，缺报日期不遗漏整天无记录的日期',async()=>{
 const f=costFixture(),input=ticketRows();input[1].sku='BAG-B';const {ids}=await importRows(f,input);await review(f,ids[0]);seedSale(f,{qty:10,amount:null});seedSale(f,{id:'s2',sku:'BAG-B',qty:5,amount:null});await mutateCost(f.db,f.users.admin,orderPayload({lines:[{ticketKey:'SHIP-TEST',lineKey:'A',salesRecordId:'s1',qty:10},{ticketKey:'SHIP-TEST',lineKey:'B',salesRecordId:'s2',qty:5}]}));
 const result=await readCostProfit(f.db,f.users.admin);assert.ok(result.skuRows.every(r=>r.contribution===null));assert.equal(result.unallocated[0].contribution,result.orders[0].contribution);
 await mutateFinanceLedger(f.db,f.users.admin,{action:'close',month:'2026-09',revision:0,evidence:'TEST-ONLY 明确缺报不视为零'});const raw=f.sqlite.prepare('SELECT snapshot_json FROM finance_period_events').get();assert.equal(JSON.parse(raw.snapshot_json).quality.missingSalesDays.length,30);
});
