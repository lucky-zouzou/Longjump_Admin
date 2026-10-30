import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './fixtures.mjs';
import {costFixture,importRows,review,seedSale} from './cost-fixture.mjs';
import {forecastPlan} from '../lib/forecast-model.mjs';
import {loadForecast} from '../lib/forecast.ts';
import {localDay,shiftDay} from '../lib/promotion-model.mjs';
import {previewProductCosts,mutateProductCosts,readProductCosts} from '../lib/product-costs.mjs';
import {costContext,sourceBasis} from '../lib/cost-source-context.mjs';
import {readEvidenceWorkbench,mutateEvidenceTask} from '../lib/evidence-workbench.mjs';
import {readProductEvidence,verifyProductEvidence} from '../lib/product-evidence.mjs';
import {readCostProfit} from '../lib/cost-profit.mjs';
import {purchaseInvoiceCandidates,saleLotCandidates} from '../lib/finance-candidates.mjs';
import {mutateAfterSales,readAfterSales} from '../lib/after-sales.mjs';
import {uploadAfterEvidence} from '../lib/after-sales-files.mjs';
import {mutateFinanceLedger,readFinanceLedger} from '../lib/finance-ledger.mjs';
import {claimFinanceState} from '../lib/claim-finance.mjs';
import {qualityMonthlyReport} from '../lib/quality-report.mjs';
import {recordQualityDelivery,qualityClosureData} from '../lib/quality-closure.mjs';
import {inboundCostCandidates} from '../lib/finance-candidates.mjs';

const now=new Date('2026-10-30T05:00:00Z'),dates=Array.from({length:56},(_,i)=>shiftDay('2026-10-29',i-55));
const today=localDay(new Date(),'马来西亚'),note='TEST-ONLY 原凭据核对，非真实业务';
function addDay(f,date,{sku='BAG-A',qty=2,kind='complete',ad=null}={}){
 const id=crypto.randomUUID();f.sqlite.prepare("INSERT INTO sales_imports(id,import_key,business_date,site,channel,row_count,total_qty,actor_id,created_at,report_kind) VALUES(?,?,?,'印尼','TikTok',1,?,'id-ops',?,?)").run(id,id,date,qty,date,kind);
 f.sqlite.prepare("INSERT INTO sales_records(id,import_id,business_date,site,channel,sku,qty,currency,reported_amount,ad_cost,actor_id,created_at) VALUES(?,?,?,'印尼','TikTok',?,?,'IDR',?,?,'id-ops',?)").run('s-'+id,id,date,sku,qty,qty*100,ad,date);
 return id;
}
function factory(f,id='factory-test',name='TEST-ONLY 工厂甲'){
 f.sqlite.prepare("INSERT INTO business_partners(id,type,code,name,created_at,updated_at) VALUES(?,'supplier',?,?,?,?)").run(id,id,name,today,today);return id;
}
const bucket={put:async()=>{},delete:async()=>{}},pdf=()=>new File(['%PDF-1.4 '+crypto.randomUUID()],'proof.pdf',{type:'application/pdf'});
const state=(f,id)=>f.sqlite.prepare('SELECT * FROM after_sales WHERE id=?').get(id);
const change=(f,id,a,action,p={})=>mutateAfterSales(f.db,a,{action,id,version:state(f,id).version,note,...p});
async function claim(f,extra={}){
 const id=(await mutateAfterSales(f.db,f.users.indonesia,{action:'create',businessDate:today,caseNo:crypto.randomUUID(),orderNo:'TEST-ORDER',sku:'BAG-A',qty:2,reason:'商品质量问题',description:'隔离测试拉链品质反馈',refundAmount:100,factory:'甲厂别名',...extra})).id;
 await uploadAfterEvidence(f.db,bucket,f.users.indonesia,id,pdf());await change(f,id,f.users.indonesia,'submit');
 await change(f,id,f.users.admin,'confirm',{responsibility:'工厂',liableName:'甲厂别名',claimAmount:100});
 await change(f,id,f.users.admin,'linkFactory',{factoryId:'factory-test',confirmAlias:true});return id;
}
const source=(f,extra={})=>mutateFinanceLedger(f.db,f.users.finance,{action:'claimSource',kind:'cash',factoryId:'factory-test',currency:'IDR',amount:100,businessDate:today,reference:'TEST-BANK-'+crypto.randomUUID(),evidence:note,...extra});

test('缺失库存不能从销量外推确定补货，完整日报与有效需求样本独立',async()=>{
 const f=fixture();for(const date of dates.slice(-7))addDay(f,date);
 f.sqlite.exec("DELETE FROM inventory_balances WHERE site='印尼' AND channel='TikTok' AND sku='BAG-A'");
 const p=(await loadForecast(f.db,f.users.admin,'2026-10-30')).suggestions.find(r=>r.site==='印尼'&&r.channel==='TikTok'&&r.sku==='BAG-A');
 assert.equal(p.qty,null);assert.equal(p.inventoryKnown,false);assert.equal(p.recommendationReady,false);assert.equal(p.suggestedProduction,null);assert.equal(p.projection,null);
 const input={dailySales:Array(56).fill(0),dailyCoverage:Array(56).fill(true),currentQty:10,arrivalLots:[]};
 for(const excluded of [dates,dates.slice(-7)]){const r=forecastPlan(input,{},excluded.map(business_date=>({business_date,stockout:1})),dates,'2026-10-30');assert.equal(r.reportsReady,true);assert.equal(r.forecastReady,false);assert.equal(r.suggestedProduction,null);assert.equal(r.forecastDaily,null);assert.match(r.readinessReasons.join(' '),/有效需求/);}
 const zero=forecastPlan(input,{},[],dates,'2026-10-30');assert.equal(zero.forecastReady,true);assert.equal(zero.forecastDaily,0);assert.equal(zero.suggestedProduction,0);
});

test('补录旧成本不替换当前生效成本，未来和同日修订在商品与财务来源一致',async()=>{
 const f=fixture();for(const [effectiveDate,total] of [['2026-10-20',30],['2026-10-01',20],['2026-11-01',40],['2026-10-20',31]]){
 const p={rows:[{site:'印尼',sku:'BAG-A',total,source:{sheet:'TEST',row:2}}],currency:'CNY',currencyConfirmed:true,basis:'landed',effectiveDate,fileName:'TEST-ONLY.xlsx',fileHash:'a'.repeat(64),reason:note},v=await previewProductCosts(f.db,f.users.admin,p);
 await mutateProductCosts(f.db,f.users.admin,{...p,...v,action:'commit'});}
 const ctx=await costContext(f.db);for(const [date,amount] of [['2026-10-10',20],['2026-10-29',31],['2026-11-02',40]]){const b=sourceBasis(ctx,{site:'印尼',channel:'TikTok',sku:'BAG-A',date});assert.equal(ctx.products.find(p=>p.id===b.product.id).total/10000,amount);assert.equal((await readProductCosts(f.db,f.users.admin,{},new Date(date+'T05:00:00Z'))).costs.find(r=>r.site==='印尼').unit/10000,amount);}
});

test('同日缺报聚合为一项，半天不结案，补齐后复查留痕，跨站不能指派或读取',async()=>{
 const f=fixture();addDay(f,'2026-10-29',{kind:'partial'});
 let d=await readEvidenceWorkbench(f.db,f.users.admin,now),t=d.tasks.find(t=>t.kind==='report'&&t.site==='印尼'&&t.channel==='TikTok'&&t.date==='2026-10-29');
 assert.equal(d.tasks.filter(x=>x.key===t.key).length,1);assert.ok(t.skus.includes('BAG-B'));
 const p={key:t.key,version:t.version,basisHash:t.basisHash,action:'evidenceAssign',ownerId:f.users.indonesia.id,dueAt:'2026-10-31T05:00:00Z',note};
 await assert.rejects(mutateEvidenceTask(f.db,f.users.admin,{...p,ownerId:f.users.malaysia.id},now),/有效人员/);
 await mutateEvidenceTask(f.db,f.users.admin,p,now);
 d=await readEvidenceWorkbench(f.db,f.users.indonesia,now);assert.ok(d.tasks.every(t=>t.site==='印尼'&&t.channel==='TikTok'));t=d.tasks.find(x=>x.key===p.key);
 await assert.rejects(mutateEvidenceTask(f.db,f.users.indonesia,{...p,version:t.version,action:'evidenceReview'},now),/缺口仍存在/);
 f.sqlite.exec("UPDATE sales_imports SET report_kind='complete' WHERE business_date='2026-10-29'");
 d=await readEvidenceWorkbench(f.db,f.users.admin,now);t=d.tasks.find(x=>x.key===p.key);assert.equal(t.status,'review_ready');
 await mutateEvidenceTask(f.db,f.users.admin,{...p,version:t.version,basisHash:t.basisHash,action:'evidenceReview'},now);
 d=await readEvidenceWorkbench(f.db,f.users.admin,now);assert.equal(d.tasks.find(x=>x.key===p.key).status,'resolved');assert.equal(d.events.filter(e=>e.task_key===p.key).length,2);
 f.sqlite.exec("UPDATE sales_imports SET report_kind='partial'");assert.equal((await readEvidenceWorkbench(f.db,f.users.admin,now)).tasks.find(x=>x.key===p.key).status,'reopened');
});

test('已保存旧日期的缺口不会因滚动窗口移出而误显示解决；供应链不接收广告金额',async()=>{
 const f=fixture();for(const sku of ['BAG-A','BAG-B','TEST-C'])addDay(f,'2026-10-29',{sku,ad:22});
 const admin=await readEvidenceWorkbench(f.db,f.users.admin,now),t=admin.tasks.find(t=>t.kind==='report'&&t.site==='印尼'&&t.channel==='TikTok'&&t.date==='2026-10-02');
 await mutateEvidenceTask(f.db,f.users.admin,{action:'evidenceAssign',key:t.key,version:0,basisHash:t.basisHash,ownerId:f.users.indonesia.id,dueAt:'2026-11-01T00:00:00Z',note},now);
 assert.notEqual((await readEvidenceWorkbench(f.db,f.users.admin,new Date('2026-12-10T05:00:00Z'))).tasks.find(x=>x.key===t.key).status,'review_ready');
 assert.equal(admin.tasks.filter(t=>t.kind==='ad_repeat').length,1);const supply=await readEvidenceWorkbench(f.db,f.users.supply,now);assert.ok(!supply.tasks.some(t=>['money','ad_repeat'].includes(t.kind)));
});

test('批量复用首销候选须逐项确认，不自动证明连续有货，跨站和断货冲突整批回滚',async()=>{
 const f=fixture();addDay(f,'2026-10-01');let d=await readProductEvidence(f.db,f.users.indonesia,now),r=d.items.find(r=>r.sku==='BAG-A');assert.equal(r.suggestedListedSince,'2026-10-01');assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM promotion_availability').get().n,0);
 const p={version:d.version,items:[{...r,listedSince:r.suggestedListedSince}],confirmed:true,reference:'TEST-LISTING',note};
 await verifyProductEvidence(f.db,f.users.indonesia,p,now);let v=f.sqlite.prepare('SELECT * FROM promotion_availability').get();assert.equal(v.available_since,'');assert.equal(v.verified_through,'');
 d=await readProductEvidence(f.db,f.users.indonesia,now);r=d.items.find(r=>r.sku==='BAG-A');f.sqlite.prepare("INSERT OR REPLACE INTO promotion_stock_days(site,channel,sku,day,min_available,first_at,last_at) VALUES('印尼','TikTok','BAG-A','2026-10-20',0,?,?)").run(now.toISOString(),now.toISOString());
 d=await readProductEvidence(f.db,f.users.indonesia,now);r=d.items.find(r=>r.sku==='BAG-A');
 await assert.rejects(verifyProductEvidence(f.db,f.users.indonesia,{...p,version:d.version,items:[{...r,listedSince:'2026-10-01',confirmAvailability:true,availableSince:'2026-10-01'}]},now),/断货事实/);
 await assert.rejects(verifyProductEvidence(f.db,f.users.finance,{...p,version:d.version},now),/仅管理员/);
 await assert.rejects(verifyProductEvidence(f.db,f.users.indonesia,{...p,version:d.version,items:[{...r,site:'马来西亚',listedSince:'2026-10-01'}]},now),/无权/);
 assert.equal(f.sqlite.prepare('SELECT available_since FROM promotion_availability').get().available_since,'');
});

test('采购已收减已开票形成候选，销售只匹配同范围且已独立复核的成本，候选不入账',async()=>{
 assert.equal(purchaseInvoiceCandidates([{id:'po',approved:true,items:[{sku:'A',ordered_qty:10,receivedQty:6}]}],[{kind:'supplier_bill',status:'active',data:{purchaseOrderId:'po',lines:[{sku:'A',qty:4}]}}])[0].items[0].candidateQty,2);
 const f=costFixture();const {ids}=await importRows(f);seedSale(f);let d=await readCostProfit(f.db,f.users.admin);assert.equal(d.matchCandidates[0].options.length,0);await review(f,ids[0]);d=await readCostProfit(f.db,f.users.admin);assert.equal(d.matchCandidates[0].options.length,2);assert.equal(d.orders.length,0);
 const other=saleLotCandidates([{...d.sales[0],site:'马来西亚'}],d.tickets);assert.equal(other[0].options.length,0);assert.equal((await readCostProfit(f.db,f.users.supply)).matchCandidates.length,0);
});

test('工厂主体人工核验、提交后补PDF、财务真实来源分配，结清还需独立整改复查',async()=>{
 const f=fixture();factory(f);const before=JSON.stringify(f.sqlite.prepare('SELECT * FROM inventory_balances').all()),id=await claim(f);
 await assert.rejects(change(f,id,f.users.admin,'payment',{amount:100,reference:'FAKE',date:today}),/由财务/);
 const s=await source(f);await change(f,id,f.users.finance,'payment',{sourceId:s.id,amount:100,date:today});
 await assert.rejects(change(f,id,f.users.admin,'close'),/独立复查/);
 await change(f,id,f.users.supply,'rectifyPlan',{ownerId:f.users.supply2.id,reviewDate:today,rootCause:'拉链批次强度不足',measure:'更换配件并抽检验证',validationBatch:'TEST-NEXT-BATCH'});
 const proof=await uploadAfterEvidence(f.db,bucket,f.users.supply,id,pdf());
 await assert.rejects(change(f,id,f.users.supply,'rectifyReview',{outcome:'effective',fileIds:[proof.id]}),/独立/);
 await assert.rejects(change(f,id,f.users.admin,'rectifyReview',{outcome:'effective',fileIds:[]}),/附件/);
 await change(f,id,f.users.admin,'rectifyReview',{outcome:'effective',fileIds:[proof.id]});await change(f,id,f.users.admin,'close');assert.equal(state(f,id).status,'closed');
 const ledger=await readFinanceLedger(f.db,f.users.finance,{month:today.slice(0,7)});assert.equal(ledger.claims.sources[0].remaining,0);
 assert.equal(JSON.stringify(f.sqlite.prepare('SELECT * FROM inventory_balances').all()),before);
 assert.throws(()=>f.sqlite.exec('DELETE FROM finance_claim_allocations'),/immutable/);
 await change(f,id,f.users.admin,'reopenCase');const payment=JSON.parse(state(f,id).data_json).payments[0];await change(f,id,f.users.finance,'reversePayment',{paymentId:payment.id,date:today});assert.equal((await claimFinanceState(f.db)).sources[0].remaining,10000);
});

test('一笔财务凭据跨索赔不超分、同凭据不重复登记，冲销保留历史并释放余额',async()=>{
 const f=fixture();factory(f);const a=await claim(f),b=await claim(f),s=await source(f,{reference:'TEST-BANK-SAME'});
 await assert.rejects(source(f,{reference:'TEST-BANK-SAME'}),/已登记/);
 await change(f,a,f.users.finance,'payment',{sourceId:s.id,amount:70,date:today});await assert.rejects(change(f,b,f.users.finance,'payment',{sourceId:s.id,amount:40,date:today}),/余额/);
 await assert.rejects(mutateFinanceLedger(f.db,f.users.finance,{action:'voidClaimSource',id:s.id,businessDate:today,evidence:note}),/先冲销/);
 await change(f,b,f.users.finance,'payment',{sourceId:s.id,amount:30,date:today});assert.equal((await claimFinanceState(f.db)).sources[0].remaining,0);
 const payment=JSON.parse(state(f,a).data_json).payments[0];await change(f,a,f.users.finance,'reversePayment',{paymentId:payment.id,date:today});assert.equal((await claimFinanceState(f.db)).sources[0].remaining,7000);
 const data=await readAfterSales(f.db,f.users.admin,today.slice(0,7));assert.equal(data.summary.currencies[0].paidCents,3000);assert.equal(data.summary.currencies[0].verifiedPaidCents,3000);assert.equal(data.summary.liable.length,1);
 factory(f,'other-factory','TEST-ONLY 工厂乙');await assert.rejects(change(f,b,f.users.admin,'linkFactory',{factoryId:'other-factory',confirmAlias:true}),/不可更换/);
});

test('工厂抵扣占用应付余额，正常付款不能再核销相同余额，冲销抵扣后可恢复',async()=>{
 const f=fixture();factory(f);f.sqlite.prepare("INSERT INTO series_purchase_orders(id,month,series_name,supplier_name,status,total_qty,sku_count,approval_id,creator_id,created_at,updated_at,document_json) VALUES('po','2026-10','TEST','TEST-ONLY 工厂甲','ordered',10,1,'TEST-APPROVED','admin-1',?,?,?)").run(today,today,JSON.stringify({currency:'IDR',items:[{sku:'BAG-A',purchasePrice:10}]}));f.sqlite.prepare("INSERT INTO series_purchase_order_items VALUES('poi','po','BAG-A','TEST',10,'[]',?,?)").run(today,today);
 const base={action:'document',businessDate:today,counterparty:'TEST-ONLY 工厂甲',site:'',channel:'',currency:'IDR',amount:100,reference:'TEST-REF',evidence:note,reason:note,revision:0};
 await mutateFinanceLedger(f.db,f.users.finance,{...base,kind:'supplier_bill',businessKey:'BILL',purchaseOrderId:'po',taxAmount:0,lines:[{sku:'BAG-A',qty:10,unitPrice:10}],exceptionReason:'测试未收货先开票差异'});
 const s=await source(f,{kind:'offset',debtKey:'BILL',amount:70});let d=await readFinanceLedger(f.db,f.users.finance,{month:today.slice(0,7)});assert.equal(d.balances.find(b=>b.business_key==='BILL').remaining,3000);
 await mutateFinanceLedger(f.db,f.users.finance,{...base,kind:'supplier_payment',businessKey:'CASH'});
 await assert.rejects(mutateFinanceLedger(f.db,f.users.finance,{...base,kind:'supplier_allocation',businessKey:'MATCH',cashKey:'CASH',debtKey:'BILL',amount:40}),/余额/);
 await mutateFinanceLedger(f.db,f.users.finance,{action:'voidClaimSource',id:s.id,businessDate:today,evidence:note});d=await readFinanceLedger(f.db,f.users.finance,{month:today.slice(0,7)});assert.equal(d.balances.find(b=>b.business_key==='BILL').remaining,10000);
});

test('质量率分母缺失或跨来源不可计算，规范工厂主体可汇总且保留原名',()=>{
 const records=[{id:'1',status:'confirmed',record_kind:'after_sale',business_date:'2026-10-20',data:{reason:'商品质量问题',qty:2,claimCents:100,currency:'IDR',factoryId:'factory',factoryName:'工厂甲',liableName:'甲厂',responsibility:'工厂',sourceLinks:[{kind:'purchase',id:'po'}],rectification:{outcome:'failed'}}}];
 assert.equal(qualityMonthlyReport(records).ranking[0].feedbackRate,null);
 assert.equal(qualityMonthlyReport(records,[],'',[{factory_id:'other',month:'2026-10',reference:'po',qty:100}]).ranking[0].feedbackRate,null);
 const r=qualityMonthlyReport(records,[],'',[{factory_id:'factory',month:'2026-10',reference:'po',qty:100}]);assert.equal(r.ranking[0].feedbackRate,.02);assert.equal(r.ranking[0].recurrences,1);assert.equal(r.sheets.find(s=>s.name==='赔偿与整改核对').rows[1][2],'甲厂');
});

test('并发跨单分配共用资金余额锁，关账后不能倒写赔偿与冲销',async()=>{
 const f=fixture();factory(f);const a=await claim(f),b=await claim(f),s=await source(f);
 const results=await Promise.allSettled([change(f,a,f.users.finance,'payment',{sourceId:s.id,amount:60,date:today}),change(f,b,f.users.finance,'payment',{sourceId:s.id,amount:60,date:today})]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal((await claimFinanceState(f.db)).sources[0].remaining,4000);
 f.sqlite.prepare("INSERT INTO finance_period_events VALUES('TEST-CLOSED',?,1,'closed','{}','TEST-ONLY','admin-1',?)").run(today.slice(0,7),today);
 await assert.rejects(source(f),/已关账/);const paid=[a,b].find(id=>JSON.parse(state(f,id).data_json).payments.length),p=JSON.parse(state(f,paid).data_json).payments[0];
 await assert.rejects(change(f,paid,f.users.finance,'reversePayment',{paymentId:p.id,date:today}),/已关账/);assert.equal((await claimFinanceState(f.db)).sources[0].remaining,4000);
});

test('交付分母按实际收货单、站点当地月核对；到港日不代到仓，新增收货使旧分母待核实',async()=>{
 const f=fixture();factory(f);
 f.sqlite.exec(`
 INSERT INTO series_purchase_orders(id,month,series_name,supplier_name,total_qty,sku_count,approval_id,creator_id,created_at,updated_at,document_json) VALUES('po','2026-10','TEST','TEST-ONLY 工厂甲',10,1,'TEST-APPROVAL','admin-1','2026-10-01','2026-10-01','{"currency":"CNY","items":[{"sku":"BAG-A","purchasePrice":10}]}');
 INSERT INTO series_purchase_order_items VALUES('poi','po','BAG-A','TEST',10,'[{"site":"印尼","channel":"TikTok","qty":10}]','2026-10-01','2026-10-01');
 INSERT INTO series_production_orders(id,purchase_order_id,month,series_name,total_planned_qty,creator_id,created_at,updated_at) VALUES('prod','po','2026-10','TEST',10,'admin-1','2026-10-01','2026-10-01');
 INSERT INTO series_production_order_items(id,production_order_id,purchase_order_item_id,sku,planned_qty,produced_qty,created_at,updated_at) VALUES('pi','prod','poi','BAG-A',10,10,'2026-10-01','2026-10-01');
 INSERT INTO transport_batches(id,batch_no,carrier_name,total_shipped_qty,sku_count,series_count,creator_id,created_at,updated_at) VALUES('batch','TEST-BATCH','TEST',10,1,1,'supply-1','2026-10-01','2026-10-01');
 INSERT INTO transport_batch_items(id,batch_id,production_order_id,production_order_item_id,series_name,sku,shipped_qty,created_at,updated_at) VALUES('bi','batch','prod','pi','TEST','BAG-A',10,'2026-10-01','2026-10-01');
 INSERT INTO transport_legs(id,batch_id,leg_no,site,channel,warehouse_name,total_qty,ata,created_at,updated_at) VALUES('leg','batch','TEST-LEG','印尼','TikTok','TEST',10,'2026-09-30','2026-10-01','2026-10-01');
 INSERT INTO transport_leg_items(id,leg_id,batch_item_id,sku,qty,received_qty,created_at,updated_at) VALUES('li','leg','bi','BAG-A',10,6,'2026-10-01','2026-10-01');
 INSERT INTO transport_receipts VALUES('receipt','TEST-RECEIPT','leg','TEST-PROOF','',6,0,'supply-1','2026-09-30T18:00:00Z');
 INSERT INTO transport_receipt_items VALUES('ri','receipt','li',6,0,'2026-09-30T18:00:00Z');`);
 const p={factoryId:'factory-test',reference:'po',month:'2026-10',revision:0,qty:6,note};
 await assert.rejects(recordQualityDelivery(f.db,f.users.supply,{...p,month:'2026-09'}),/收货单/);await recordQualityDelivery(f.db,f.users.supply,p);
 let data=await qualityClosureData(f.db,f.users.admin,[],'2026-10');assert.equal(data.denominators[0].stale,false);assert.equal(data.deliveryChoices[0].qty,6);assert.equal(data.deliveryChoices[0].id,'po');
 const candidates=await inboundCostCandidates(f.db,[]);assert.equal(candidates[0].arrivedAt,'2026-10-01');assert.equal(candidates[0].items[0].receivedQty,6);assert.equal(candidates[0].items[0].approvedPurchasePrice,10);
 f.sqlite.exec("INSERT INTO transport_receipts VALUES('receipt2','TEST-RECEIPT2','leg','TEST-PROOF2','',4,0,'supply-1','2026-10-02T01:00:00Z'); INSERT INTO transport_receipt_items VALUES('ri2','receipt2','li',4,0,'2026-10-02T01:00:00Z');");
 data=await qualityClosureData(f.db,f.users.admin,[]);assert.equal(data.denominators[0].stale,true);await recordQualityDelivery(f.db,f.users.supply,{...p,revision:1,qty:10});assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM quality_delivery_evidence').get().n,2);
});

test('库存冲突可追到原流水与预留，未核对不自动改数',async()=>{
 const f=fixture();f.sqlite.exec("UPDATE inventory_balances SET qty=-1 WHERE site='印尼' AND channel='TikTok' AND sku='BAG-A'; INSERT INTO inventory_movements VALUES('TEST-MOVE','印尼','TikTok','BAG-A','TEST','销售扣减',-11,-1,'销售导入','TEST-IMPORT','TEST-ONLY','id-ops','2026-10-29');");
 const d=await readEvidenceWorkbench(f.db,f.users.supply,now),t=d.tasks.find(t=>t.kind==='inventory'&&t.sku==='BAG-A');assert.equal(t.sources.book,-1);assert.equal(t.sources.trail[0].reference_id,'TEST-IMPORT');assert.equal(t.sources.trail[0].qty_delta,-11);assert.equal(f.sqlite.prepare("SELECT qty FROM inventory_balances WHERE site='印尼' AND channel='TikTok' AND sku='BAG-A'").get().qty,-1);
});

test('新增证据任务与财务来源冲销记录完整备份恢复，历史不丢失',async()=>{
 const {mkdtempSync,rmSync}=await import('node:fs'),{tmpdir}=await import('node:os'),{join}=await import('node:path'),{createBackup,restoreBackup}=await import('../server/backup.mjs'),{fileBucket,openDatabase}=await import('../server/storage.mjs');
 const root=mkdtempSync(join(tmpdir(),'lj-evidence-closure-'));try{
  const f=fixture();factory(f);await source(f);const s=(await claimFinanceState(f.db)).sources[0];await mutateFinanceLedger(f.db,f.users.finance,{action:'voidClaimSource',id:s.id,businessDate:today,evidence:note});
  const d=await readEvidenceWorkbench(f.db,f.users.admin,now),t=d.tasks.find(t=>t.kind==='report'&&t.site==='印尼'&&t.channel==='TikTok');
  await mutateEvidenceTask(f.db,f.users.admin,{action:'evidenceAssign',key:t.key,version:0,basisHash:t.basisHash,ownerId:f.users.indonesia.id,dueAt:'2026-11-01T00:00:00Z',note},now);
  const path=join(root,'backup.tar');await createBackup({DB:f.db,WHOLESALE_FILES:fileBucket(join(root,'files'))},path);await restoreBackup(path,join(root,'restore'));
  const restored=openDatabase(join(root,'restore','business.sqlite'));try{for(const table of ['evidence_tasks','evidence_task_events','finance_claim_sources','finance_claim_reversals'])assert.deepEqual(restored.sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),f.sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());}finally{restored.sqlite.close();}
 }finally{rmSync(root,{recursive:true,force:true});}
});
