import test from 'node:test';
import assert from 'node:assert/strict';
import {workplaceFixture} from './workplace-fixture.mjs';
import {readExpenses} from '../lib/finance-workbench.mjs';
import {ledgerDocuments,ledgerBalances,mutateFinanceLedger,createFinanceSnapshot} from '../lib/finance-ledger.mjs';
import {wholesaleBankSnapshot} from '../lib/finance-bank-snapshot.mjs';
import {readFinanceHub} from '../lib/finance-hub.mjs';
import {answerFinance} from '../lib/employee-finance.mjs';
import {scopedFinanceRequestAllowed} from '../lib/finance-scope.mjs';

test('跨月支付上期应付，原单与关账快照不改，月份按银行日统计',async()=>{
 const f=await workplaceFixture(),id=await f.expense();await f.approve(id);f.close();
 const original=f.sqlite.prepare('SELECT * FROM finance_period_events').get();
 await f.pay(id,40,{bankDate:'2026-10-11'});
 let r=(await readExpenses(f.db,f.users.finance2,{month:'2026-10'})).requests[0];
 await f.change(f.users.finance2,id,'bankCheck',{linkId:r.links[0].id,bankDate:'2026-10-11'});
 for(const [month,approved,paid] of [['2026-08',0,0],['2026-09',10000,0],['2026-10',0,4000]]){
  const s=(await readExpenses(f.db,f.users.finance,{month})).summary[0];assert.equal(s.approved,approved);assert.equal(s.paid,paid);assert.equal(s.outstanding,6000);
 }
 assert.deepEqual(f.sqlite.prepare('SELECT * FROM finance_period_events').get(),original);
 assert.equal(ledgerBalances(await ledgerDocuments(f.db)).find(r=>r.kind==='supplier_bill').remaining,96000);
 await assert.rejects(f.pay(id,10,{bankDate:'2026-09-12'}),/关账/);
});

test('银行预收按截点还原，不重复订单核销，旧月不混入次月退款',()=>{
 const s={orders:[{order_no:'TEST',entries:[{id:'a',kind:'receipt',bank_receipt_id:'b',business_date:'2026-09-15',amount:200000}]}],bankReceipts:[{id:'b',reference:'TEST bank',business_date:'2026-09-10',amount:500000,bank_account:'TEST bank account'}],bankEvents:[{id:'e',receipt_id:'b',business_date:'2026-10-01',kind:'refund',amount:100000}]};
 const sep=wholesaleBankSnapshot(s,'2026-09','2026-11-26'),oct=wholesaleBankSnapshot(s,'2026-10','2026-11-26');
 assert.deepEqual(sep.totals,{received:500000,refunded:0,unallocated:300000});assert.deepEqual(oct.totals,{received:0,refunded:100000,unallocated:200000});assert.equal(sep.unclassified,1);
});

test('非采购服务账单独立复核、组织归属、费用支付链完整',async()=>{
 const f=await workplaceFixture(),p={action:'document',kind:'supplier_bill',billType:'service',businessKey:'TEST-SERVICE',revision:0,businessDate:'2026-09-10',site:'印尼',channel:'TikTok',currency:'CNY',counterparty:'TEST service vendor',amount:100,reference:'TEST invoice',evidence:'TEST invoice document',reason:'TEST evidence',unitId:'ID',category:'office',serviceFrom:'2026-09-01',serviceTo:'2026-09-30',dueDate:'2026-10-10',contractReference:'TEST contract',acceptanceEvidence:'TEST accepted'};
 await mutateFinanceLedger(f.db,f.users.finance,p);
 assert.ok(!(await readExpenses(f.db,f.users.finance,{month:'2026-09'})).bills.some(b=>b.key===p.businessKey));
 await assert.rejects(mutateFinanceLedger(f.db,f.users.finance,{action:'serviceReview',businessKey:p.businessKey,revision:1,reason:'TEST self review'}),/另一位/);
 await mutateFinanceLedger(f.db,f.users.finance2,{action:'serviceReview',businessKey:p.businessKey,revision:1,reason:'TEST independent review'});
 const id=await f.expense();await f.change(f.users.manager,id,'managerApprove');await f.change(f.users.finance,id,'financeApprove',{sourceKey:p.businessKey,entityConfirmed:true});await f.pay(id,100);
 const r=(await readExpenses(f.db,f.users.finance2,{month:'2026-09'})).requests[0];await f.change(f.users.finance2,id,'bankCheck',{linkId:r.links[0].id,bankDate:'2026-09-11'});
 assert.equal(ledgerBalances(await ledgerDocuments(f.db)).find(b=>b.business_key===p.businessKey).remaining,0);
 await assert.rejects(mutateFinanceLedger(f.db,f.users.finance,{...p,businessKey:'TEST-CROSS',reference:'TEST other invoice',unitId:'MY'}),/无权/);
});

test('费用分页不改变汇总或泄漏跨站记录，查询数不随每行增长',async()=>{
 const f=await workplaceFixture();for(let i=0;i<101;i++)await f.expense({amount:1});await f.expense({amount:9999},f.users.malaysia);
 let queries=0;const db={...f.db,prepare:(...args)=>{queries++;return f.db.prepare(...args);}};
 const page=await readExpenses(db,f.users.finance,{month:'2026-09',page:'2'});
 assert.equal(page.requests.length,50);assert.equal(page.pagination.total,101);assert.ok(page.requests.every(r=>r.unit_id==='ID'));assert.ok(queries<40,`${queries} queries`);
 const boss=await readExpenses(f.db,f.users.boss,{month:'2026-09'});assert.equal(boss.requests.length,0);assert.equal(boss.events.length,0);
});

test('闭账后的错误付款独立更正、释放应付、原银行流水号重录，账期和现金分开',async()=>{
 const f=await workplaceFixture(),id=await f.expense();await f.approve(id);await f.pay(id,100,{bankReference:'TEST SAME BANK'});
 let r=(await readExpenses(f.db,f.users.finance2,{month:'2026-09'})).requests[0],link=r.links[0];await f.change(f.users.finance2,id,'bankCheck',{linkId:link.id,bankDate:link.bankDate});f.close();
 await f.change(f.users.finance,id,'correctionRequest',{linkId:link.id,correctionDate:'2026-10-10'});
 r=(await readExpenses(f.db,f.users.finance2,{month:'2026-10'})).requests[0];const requestEventId=r.corrections[0].id;
 await assert.rejects(f.change(f.users.finance,id,'correctionApprove',{requestEventId}),/独立复核/);
 await f.change(f.users.finance2,id,'correctionApprove',{requestEventId});
 assert.equal(ledgerBalances(await ledgerDocuments(f.db)).find(d=>d.kind==='supplier_bill').remaining,100000);
 await assert.rejects(f.change(f.users.finance2,id,'correctionApprove',{requestEventId}),/已处理/);
 await f.pay(id,80,{bankReference:'TEST SAME BANK',accountingDate:'2026-10-10'});
 r=(await readExpenses(f.db,f.users.finance2,{month:'2026-10'})).requests[0];assert.equal(r.paidMinor,8000);assert.equal(r.unpaidMinor,2000);assert.equal(r.links.filter(l=>l.reversed).length,1);
 const replacement=r.links.find(l=>!l.reversed);await f.change(f.users.finance2,id,'bankCheck',{linkId:replacement.id,bankDate:replacement.bankDate,accountingDate:'2026-10-10'});
 const old=ledgerBalances((await ledgerDocuments(f.db)).filter(d=>d.business_date<='2026-09-30'));assert.equal(old.find(d=>d.kind==='supplier_bill').remaining,90000);
 const hub=await readFinanceHub(f.db,f.users.finance,{month:'2026-10'});assert.equal(hub.cashTotals.paid.cnyMinor,0);assert.equal(hub.cashTotals.corrections.cnyMinor,-2000);assert.equal(f.sqlite.prepare('PRAGMA foreign_key_check').all().length,0);
});

test('中央月结包含未分配预收及外币汇率缺口',async()=>{
 const f=await workplaceFixture(),customer=await f.call(f.users.sales,'customerCreate',{name:'TEST bank customer',contact:'TEST',phone:'081200000',city:'Jakarta',address:'TEST only',salesUserId:f.users.sales.id});
 const b=await f.call(f.users.finance,'bankReceiptCreate',{customerId:customer.id,amount:500000,reference:'TEST UNALLOCATED',bankAccount:'TEST BANK',businessDate:'2026-10-11',note:'TEST only'});
 const s=await createFinanceSnapshot(f.db,f.users.admin,'2026-10');assert.equal(s.bank.balances[0].id,b.id);assert.equal(s.bank.totals.unallocated,500000);assert.ok(s.quality.missingRates.includes('IDR'));assert.equal(s.offline.totals.receipts,0);
 const answer=await answerFinance(f.db,f.users.finance,'10月线下回款到账多少？','2026-11-26T04:00:00Z');assert.match(answer.answer,/500,000 IDR/);assert.match(answer.answer,/缺 IDR/);const platform=await answerFinance(f.db,f.users.finance,'10月平台回款多少？','2026-11-26T04:00:00Z');assert.doesNotMatch(platform.answer,/登记银行到账：500,000/);
});

test('范围财务中央入口拒绝，授权工作台与只读问答不扩大到别的组织',async()=>{
 const f=await workplaceFixture();await f.config({action:'financeMode',userId:f.users.finance.id,mode:'scoped',reason:'TEST role scope'});
 const {readFinanceLedger}=await import('../lib/finance-ledger.mjs');await assert.rejects(readFinanceLedger(f.db,f.users.finance),e=>e.status===403);
 const id=await f.expense();await f.approve(id);await f.pay(id,40);
 assert.equal((await readExpenses(f.db,f.users.finance,{month:'2026-09'})).actor.financeMode,'scoped');const h=await readFinanceHub(f.db,f.users.finance,{month:'2026-09'});assert.equal(h.mode,'scoped');assert.equal(h.bank,null);assert.equal(h.domestic,null);assert.ok(h.payables.every(x=>x.unitId==='ID'));
 await f.config({action:'grant',userId:f.users.finance.id,unitId:'ID',capability:'finance',enabled:false,reason:'TEST revoke'});const empty=await readFinanceHub(f.db,f.users.finance,{month:'2026-09'});assert.equal(empty.payables.length,0);assert.equal(empty.cash.length,0);const {answerWithKnowledge}=await import('../lib/employee-assistant.mjs');const guide=await answerWithKnowledge(f.db,f.users.finance,{question:'服务应付怎么登记？',mode:'internal'},{apiKey:''});assert.equal(guide.guide.id,'finance-closure');assert.match(guide.guide.steps.join('\n'),/另一位授权财务复核/);const protectedAnswer=await answerWithKnowledge(f.db,f.users.finance,{question:'昨天各站销售多少？',mode:'internal'},{apiKey:''});assert.match(protectedAnswer.answer,/总部财务/);
 assert.equal(scopedFinanceRequestAllowed(new Request('https://test.invalid/api/system?module=home&navigation=shell')),true);assert.equal(scopedFinanceRequestAllowed(new Request('https://test.invalid/api/system?module=home&history=finance')),false);assert.equal(scopedFinanceRequestAllowed(new Request('https://test.invalid/api/wholesale?export=1')),false);
 const denied=await answerFinance(f.db,f.users.indonesia,'公司这月实际支出了多少？');assert.match(denied.answer,/财务授权/);
});

test('已批未付申请可独立取消，释放占用而不改已关账原单',async()=>{
 const f=await workplaceFixture(),id=await f.expense();await f.approve(id);f.close();const before=f.sqlite.prepare('SELECT data_json,status FROM workplace_requests WHERE id=?').get(id);
 await f.change(f.users.indonesia,id,'cancelRequest',{correctionDate:'2026-10-12'});
 await assert.rejects(f.pay(id,10,{bankDate:'2026-10-13'}),/正在复核/);
 const r=(await readExpenses(f.db,f.users.finance,{month:'2026-10'})).requests.find(r=>r.id===id);assert.ok(r.cancellations[0].canReview);
 await f.change(f.users.finance,id,'cancelApprove',{requestEventId:r.cancellations[0].id});
 assert.deepEqual(f.sqlite.prepare('SELECT data_json,status FROM workplace_requests WHERE id=?').get(id),before);
 const cancelled=(await readExpenses(f.db,f.users.finance,{month:'2026-10'}));assert.equal(cancelled.summary[0].outstanding,0);assert.equal(cancelled.requests.find(r=>r.id===id).unpaidMinor,0);
 await assert.rejects(f.pay(id,10,{bankDate:'2026-10-13'}),/已取消/);
 const next=await f.expense({businessDate:'2026-10-13',settlementDate:'2026-10-13',amount:1000});await f.approve(next);
});

test('共用费用分摊守恒、同法人授权、待核不提前计入已核发生额',async()=>{
 const f=await workplaceFixture(),p={action:'document',kind:'supplier_bill',billType:'service',businessKey:'TEST-SPLIT',revision:0,businessDate:'2026-09-10',site:'印尼',channel:'TikTok',currency:'CNY',counterparty:'TEST services',amount:100,reference:'TEST split',evidence:'TEST file',reason:'TEST basis',unitId:'ID',category:'office',serviceFrom:'2026-09-01',serviceTo:'2026-09-30',dueDate:'2026-10-10',contractReference:'TEST contract',acceptanceEvidence:'TEST accepted',allocations:[{unitId:'ID',amount:90,basis:'TEST 9/10'}]};
 await assert.rejects(mutateFinanceLedger(f.db,f.users.finance,p),/分摊合计/);
 await assert.rejects(mutateFinanceLedger(f.db,f.users.finance,{...p,allocations:[{unitId:'MY',amount:100,basis:'TEST bad entity'}]}),/同法人/);
 await mutateFinanceLedger(f.db,f.users.finance,{...p,allocations:[{unitId:'ID',amount:100,basis:'TEST department full'}]});
 let h=await readFinanceHub(f.db,f.users.finance,{month:'2026-09'});assert.equal(h.categories.find(c=>c.category==='office').cnyMinor,0);assert.equal(h.categories.find(c=>c.category==='office').pendingReview,1);
 await mutateFinanceLedger(f.db,f.users.finance2,{action:'serviceReview',businessKey:p.businessKey,revision:1,reason:'TEST approved allocation'});
 h=await readFinanceHub(f.db,f.users.finance,{month:'2026-09'});assert.equal(h.categories.find(c=>c.category==='office').cnyMinor,10000);const answer=await answerFinance(f.db,f.users.finance,'印尼9月费用多少？','2026-11-26T04:00:00Z');assert.match(answer.answer,/办公.*100 CNY/);assert.doesNotMatch(answer.answer,/登记实际付款/);assert.equal(h.payables.find(b=>b.key===p.businessKey).details.allocations[0].amountMinor,10000);
});

test('广告账户对账：来源分配守恒、独立复核、预算非现金、来源修订后撤销重核',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-11-23T05:00:00Z')});const f=await workplaceFixture();const {mutateExpense}=await import('../lib/finance-workbench.mjs'),{mutateMarketingFinance,marketingFinance}=await import('../lib/finance-marketing.mjs');
 const id=(await mutateExpense(f.db,f.users.indonesia,{action:'advertisingCreate',operationId:crypto.randomUUID(),startDate:'2026-11-23',endDate:'2026-11-30',currency:'CNY',amount:100,shop:'TEST store',adAccount:'TEST ACCOUNT',purpose:'TEST campaign'})).id;await f.change(f.users.manager,id,'managerApprove');const queue=(await readExpenses(f.db,f.users.finance,{month:'2026-11'})).queue;assert.equal(queue.advertisingReviews,1);await f.change(f.users.finance,id,'advertisingApprove',{approvedAmount:100});
 f.sqlite.prepare("INSERT INTO sales_ad_spend(id,business_date,site,channel,currency,amount,note,version,updated_at,actor_id) VALUES('TEST-AD','2026-11-23','印尼','TikTok','CNY',30,'TEST',1,'2026-11-23','id-ops')").run();
 const p={action:'adStatementCreate',budgetId:id,from:'2026-11-23',to:'2026-11-23',opening:0,topup:100,refund:0,closing:70,allocations:[{id:'TEST-AD',amount:30}],evidence:'TEST account and bank statement',reason:'TEST verified same ad account'};
 await assert.rejects(mutateMarketingFinance(f.db,f.users.finance,{...p,closing:71}),/余额不平/);
 await f.config({action:'financeMode',userId:f.users.finance.id,mode:'scoped',reason:'TEST scope'});await assert.rejects(mutateMarketingFinance(f.db,f.users.finance,p),/总部财务分配/);await f.config({action:'financeMode',userId:f.users.finance.id,mode:'headquarters',reason:'TEST restore synthetic role'});
 const s=await mutateMarketingFinance(f.db,f.users.finance,p);await assert.rejects(mutateMarketingFinance(f.db,f.users.finance,p),/重叠/);await assert.rejects(mutateMarketingFinance(f.db,f.users.finance,{action:'adStatementReview',id:s.id,reason:'TEST self'}),/另一名/);
 await mutateMarketingFinance(f.db,f.users.finance2,{action:'adStatementReview',id:s.id,reason:'TEST independent'});
 let h=await marketingFinance(f.db,f.users.admin,'2026-11');assert.equal(h.budgets[0].verifiedConsumedMinor,3000);assert.equal(h.budgets[0].remainingBudgetMinor,7000);assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM finance_documents WHERE kind='supplier_payment'").get().n,0);
 await f.config({action:'financeMode',userId:f.users.finance2.id,mode:'scoped',reason:'TEST read scope'});const scoped=await marketingFinance(f.db,f.users.finance2,'2026-11');assert.equal(scoped.statements[0].data.allocations[0].sourceAmountMinor,undefined);
 const answer=await answerFinance(f.db,f.users.finance,'印尼TK广告预算还剩多少？','2026-11-23T06:00:00Z');assert.match(answer.answer,/70 CNY/);assert.match(answer.answer,/只扣已核消耗/);
 f.sqlite.prepare("UPDATE sales_ad_spend SET amount=20,version=2 WHERE id='TEST-AD'").run();h=await marketingFinance(f.db,f.users.finance2,'2026-11');assert.equal(h.budgets[0].stale,true);assert.equal(h.budgets[0].remainingBudgetMinor,null);
 await mutateMarketingFinance(f.db,f.users.finance2,{action:'adStatementSupersede',id:s.id,reason:'TEST source revised'});await mutateMarketingFinance(f.db,f.users.finance,{...p,closing:80,allocations:[{id:'TEST-AD',amount:20}]});
});

test('人事月度摘要只向授权财务交接统计，源变化须重签，不转成工资',async()=>{
 const f=await workplaceFixture(),{mutateHrHandoff,readHrHandoffs}=await import('../lib/hr-finance-handoff.mjs');
 await assert.rejects(mutateHrHandoff(f.db,f.users.indonesia,{action:'hrHandoffIssue',unitId:'ID',month:'2026-09',reason:'TEST'}),e=>e.status===403);
 const s=await mutateHrHandoff(f.db,f.users.hr,{action:'hrHandoffIssue',unitId:'ID',month:'2026-09',reason:'TEST source gap noted'});
 const h=await readHrHandoffs(f.db,f.users.finance,'2026-09');assert.equal(h.rows.length,1);assert.equal(h.rows[0].snapshot.localSavedDays,0);assert.equal(h.rows[0].snapshot.lastSyncSuccess,null);assert.match(h.rows[0].snapshot.coverage,/不等于旷工/);assert.equal((await readHrHandoffs(f.db,f.users.malaysia,'2026-09')).rows.length,0);
 f.sqlite.prepare("UPDATE workplace_profiles SET active=0 WHERE user_id='studio'").run();await assert.rejects(mutateHrHandoff(f.db,f.users.finance,{action:'hrHandoffAcknowledge',id:s.id,reason:'TEST'}),/来源已更新/);
 const newer=await mutateHrHandoff(f.db,f.users.hr,{action:'hrHandoffIssue',unitId:'ID',month:'2026-09',reason:'TEST corrected coverage'});await mutateHrHandoff(f.db,f.users.finance,{action:'hrHandoffAcknowledge',id:newer.id,reason:'TEST received only, no payroll'});
 assert.equal((await readHrHandoffs(f.db,f.users.finance,'2026-09')).rows[0].canAcknowledge,false);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM hr_finance_handoffs').get().n,2);
});

test('旧月无资金快照不回答零到账，待办计数独立于费用分页',async()=>{
 const f=await workplaceFixture();for(let i=0;i<55;i++)await f.expense({amount:1});const r=await readExpenses(f.db,f.users.manager,{month:'2026-09',page:'2'});assert.equal(r.requests.length,5);assert.equal(r.queue.reviews,55);
 f.close();const a=await answerFinance(f.db,f.users.finance,'9月实际到账多少？','2026-11-26T04:00:00Z');assert.match(a.answer,/无法给出完整/);assert.doesNotMatch(a.answer,/登记银行到账：0/);
});

test('财务问答按自然下周筛选，月份遵守北京时间，不把费用误报成现金',async()=>{
 const f=await workplaceFixture();
 const seed=(id,dueDate)=>f.sqlite.prepare("INSERT INTO finance_documents VALUES(?, 'supplier_bill', ?,1,'2026-11-01',?,'印尼','TikTok','CNY',1000,'active',?,'TEST evidence','TEST only','finance-1','2026-11-01')").run(id,id,id,JSON.stringify({matchStatus:'matched',dueDate,category:'office'}));
 seed('TEST-OVERDUE','2026-11-25');seed('TEST-THIS-FRIDAY','2026-11-27');seed('TEST-NEXT-MONDAY','2026-11-30');seed('TEST-AFTER-NEXT-WEEK','2026-12-07');
 const result=await answerFinance(f.db,f.users.admin,'下周需要付哪些钱？','2026-11-26T04:00:00Z');
 assert.match(result.answer,/2026-11-30 至 2026-12-06/);assert.match(result.answer,/TEST-OVERDUE/);assert.match(result.answer,/TEST-NEXT-MONDAY/);assert.doesNotMatch(result.answer,/TEST-THIS-FRIDAY|TEST-AFTER-NEXT-WEEK/);
 const local=await answerFinance(f.db,f.users.admin,'本月费用多少？','2026-10-31T17:00:00Z');assert.match(local.answer,/2026-11，/);assert.match(local.answer,/办公.*40 CNY/);assert.doesNotMatch(local.answer,/登记实际付款/);
});


test('错误服务应付可独立驳回作废，保留版本且禁止本人复核',async()=>{
 const f=await workplaceFixture(),p={action:'document',kind:'supplier_bill',billType:'service',businessKey:'TEST-SERVICE-REJECT',revision:0,businessDate:'2026-09-10',site:'印尼',channel:'TikTok',currency:'CNY',counterparty:'TEST service vendor',amount:100,reference:'TEST rejected invoice',evidence:'TEST evidence',reason:'TEST only',unitId:'ID',category:'office',serviceFrom:'2026-09-01',serviceTo:'2026-09-30',dueDate:'2026-10-10',contractReference:'TEST contract',acceptanceEvidence:'TEST acceptance'};
 await mutateFinanceLedger(f.db,f.users.finance,p);
 await assert.rejects(mutateFinanceLedger(f.db,f.users.finance,{action:'serviceReject',businessKey:p.businessKey,revision:1,reason:'TEST self'}),/另一位/);
 await mutateFinanceLedger(f.db,f.users.finance2,{action:'serviceReject',businessKey:p.businessKey,revision:1,reason:'TEST source incorrect'});
 assert.equal((await readFinanceHub(f.db,f.users.finance,{month:'2026-09'})).payables.some(b=>b.key===p.businessKey),false);
 const history=f.sqlite.prepare('SELECT status FROM finance_documents WHERE business_key=? ORDER BY revision').all(p.businessKey);assert.deepEqual(history.map(r=>r.status),['active','void']);const id=await f.expense();await f.approve(id);await f.change(f.users.indonesia,id,'cancelRequest',{correctionDate:'2026-09-12'});const requested=(await readExpenses(f.db,f.users.finance,{month:'2026-09'})).requests.find(r=>r.id===id);await f.change(f.users.finance,id,'cancelApprove',{requestEventId:requested.cancellations[0].id});assert.equal((await readExpenses(f.db,f.users.finance,{month:'2026-09'})).summary[0].approved,0);
});
