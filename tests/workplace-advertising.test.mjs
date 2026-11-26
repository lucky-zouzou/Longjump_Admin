import test from 'node:test';
import assert from 'node:assert/strict';
import {workplaceFixture} from './workplace-fixture.mjs';
import {mutateExpense,readExpenses,expenseRequest} from '../lib/finance-workbench.mjs';
import {mutateFinanceLedger} from '../lib/finance-ledger.mjs';
import {workplaceTasks} from '../lib/workplace-tasks.mjs';
import {workplaceCsv} from '../lib/workplace-export.mjs';

const time=t=>t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-11-23T05:00:00Z')});
const payload=(extra={})=>({action:'advertisingCreate',operationId:crypto.randomUUID(),startDate:'2026-11-24',endDate:'2026-11-30',currency:'CNY',amount:100,shop:'TEST store',adAccount:'TEST TikTok ad account',purpose:'TEST ONLY creative campaign',...extra});
const create=async(f,extra={},actor=f.users.indonesia)=>(await mutateExpense(f.db,actor,payload(extra))).id;
const count=(f,table)=>f.sqlite.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;
const approve=async(f,id,amount=80)=>{await f.change(f.users.manager,id,'managerApprove');return f.change(f.users.finance,id,'advertisingApprove',{approvedAmount:amount});};

test('广告预算：运营申请、主管审批、财务核减闭环，预算不冒充付款或实耗',async t=>{
 time(t);const f=await workplaceFixture();try{
  const before=Object.fromEntries(['finance_documents','workplace_payment_links','workplace_bank_checks','sales_ad_spend','cost_records','sales_monthly_targets'].map(k=>[k,count(f,k)]));
  const id=await create(f),draft=await expenseRequest(f.db,id);assert.equal(draft.status,'submitted');assert.equal(draft.data.channel,'TikTok');assert.equal(draft.data.unit.site,'印尼');
  assert.ok((await workplaceTasks(f.db,f.users.manager)).some(x=>x.entity===id&&x.title==='审批广告预算申请'&&x.view==='advertising'));
  await f.change(f.users.manager,id,'managerApprove');
  const review=(await readExpenses(f.db,f.users.finance,{month:'2026-11'})).requests.find(x=>x.id===id);assert.equal(review.canBudgetApprove,true);assert.equal(review.canFinance,false);assert.equal(review.canFinanceReject,true);
  assert.ok((await workplaceTasks(f.db,f.users.finance)).some(x=>x.entity===id&&x.title==='核定广告预算'&&x.view==='advertising'));
  await f.change(f.users.finance,id,'advertisingApprove',{approvedAmount:80});
  const r=await expenseRequest(f.db,id);assert.equal(r.status,'approved');assert.equal(r.data.amountMinor,10000);assert.equal(r.data.budget.approvedAmountMinor,8000);assert.equal(r.data.budget.approvedBy,f.users.finance.id);assert.equal(r.data.rate.rate,1);
  const view=await readExpenses(f.db,f.users.indonesia,{month:'2026-11'});assert.equal(view.serverTime,'2026-11-23T05:00:00.000Z');assert.equal(new Intl.DateTimeFormat('en-CA',{timeZone:view.configuration.units[0].timezone}).format(new Date(view.serverTime)),'2026-11-23');assert.equal(view.summary.length,0);assert.deepEqual(view.budgetSummary[0],{entity:'TEST ENTITY ID',site:'印尼',currency:'CNY',requested:10000,approved:8000,approvedCny:8000,fxMissing:0,count:1});
  assert.equal(view.requests[0].canPay,false);assert.equal(view.requests[0].paidMinor,null);assert.equal(view.requests[0].unpaidMinor,null);assert.deepEqual(view.requests[0].links,[]);
  assert.equal((await workplaceTasks(f.db,f.users.finance)).some(x=>x.entity===id),false);
  for(const [k,n] of Object.entries(before))assert.equal(count(f,k),n,k);
  const audit=f.sqlite.prepare("SELECT detail_json FROM workplace_events WHERE entity_id=? AND action='advertisingApprove'").get(id);assert.equal(JSON.parse(audit.detail_json).data.budget.approvedAmountMinor,8000);
  const csv=workplaceCsv(view,'finance');assert.match(csv,/广告预算/);assert.match(csv,/"100","80","80"/);
 }finally{f.sqlite.close();}
});

test('广告预算：组织/主管/独立财务缺项可见，申请不依赖打卡班次',async t=>{
 time(t);const f=await workplaceFixture();try{
  f.sqlite.prepare("UPDATE workplace_profiles SET shift_id=NULL WHERE user_id='id-ops'").run();assert.equal((await readExpenses(f.db,f.users.indonesia)).setup.canApplyAdvertising,true);
  await create(f);f.sqlite.prepare("UPDATE users SET active=0 WHERE id='manager'").run();
  assert.equal((await readExpenses(f.db,f.users.indonesia)).setup.managerReady,false);await assert.rejects(create(f),/有效主管/);
  f.sqlite.prepare("UPDATE users SET active=1 WHERE id='manager'").run();f.sqlite.prepare("DELETE FROM workplace_grants WHERE capability='finance'").run();assert.equal((await readExpenses(f.db,f.users.indonesia)).setup.financeReady,false);await assert.rejects(create(f),/独立财务/);
  f.sqlite.prepare("DELETE FROM workplace_profiles WHERE user_id='id-ops'").run();const v=await readExpenses(f.db,f.users.indonesia);assert.equal(v.profile,null);assert.equal(v.setup.organizationReady,false);assert.equal(v.requests.length,1);await assert.rejects(create(f),/配置/);
 }finally{f.sqlite.close();}
});

test('广告预算：强制本人站点平台，不能自审、越组织审批或伪装成普通费用',async t=>{
 time(t);const f=await workplaceFixture();try{
  await assert.rejects(create(f,{},f.users.studio),e=>e.status===403);await assert.rejects(create(f,{site:'马来西亚'}),e=>e.status===403);await assert.rejects(create(f,{channel:'Shopee'}),e=>e.status===403);
  f.sqlite.prepare("UPDATE users SET channel=NULL WHERE id='id-ops'").run();assert.equal((await readExpenses(f.db,f.users.indonesia)).setup.canApplyAdvertising,false);await assert.rejects(create(f),e=>e.status===403);f.sqlite.prepare("UPDATE users SET channel='TikTok' WHERE id='id-ops'").run();
  const id=await create(f);await assert.rejects(f.change(f.users.indonesia,id,'managerApprove'),e=>e.status===403);await assert.rejects(f.change(f.users.admin,id,'managerApprove'),e=>e.status===403);await assert.rejects(f.change(f.users.malaysia,id,'managerApprove'),e=>e.status===403);
  await f.change(f.users.manager,id,'managerApprove');await assert.rejects(f.change(f.users.manager,id,'advertisingApprove',{approvedAmount:80}),e=>e.status===403);await assert.rejects(f.change(f.users.finance,id,'financeApprove',{sourceKey:'TEST-BILL',entityConfirmed:true}),/广告申请/);
  await assert.rejects(f.expense({category:'advertising'}),/广告预算申请入口/);
  const other=await readExpenses(f.db,f.users.malaysia,{month:'2026-11'});assert.equal(other.requests.length,0);assert.equal(other.budgetSummary.length,0);assert.doesNotMatch(workplaceCsv(other,'finance'),/TEST ENTITY ID/);
  const boss=await readExpenses(f.db,f.users.boss,{month:'2026-11'});assert.equal(boss.requests.length,0);assert.equal(boss.events.length,0);assert.equal(boss.budgetSummary[0].requested,10000);
 }finally{f.sqlite.close();}
});

test('广告预算：不能核增、重复核定或直接付款核销；并发核定只记一次',async t=>{
 time(t);const f=await workplaceFixture();try{
  const id=await create(f);await f.change(f.users.manager,id,'managerApprove');
  for(const approvedAmount of [101,0,-1,'1.001'])await assert.rejects(f.change(f.users.finance,id,'advertisingApprove',{approvedAmount}));
  const r=await expenseRequest(f.db,id),results=await Promise.allSettled([f.users.finance,f.users.finance2].map(a=>mutateExpense(f.db,a,{action:'advertisingApprove',id,version:r.version,approvedAmount:80,reason:'TEST independent budget review'})));assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM workplace_events WHERE action='advertisingApprove' AND entity_id=?").get(id).n,1);
  await assert.rejects(f.change(f.users.finance,id,'advertisingApprove',{approvedAmount:80}),/独立财务/);
  for(const action of ['payment','bankCheck'])await assert.rejects(f.change(f.users.finance,id,action,{amount:80,bankDate:'2026-11-24'}),/广告预算核定不代表付款/);
  assert.equal(count(f,'finance_documents'),1);assert.equal(count(f,'workplace_payment_links'),0);assert.equal(count(f,'workplace_bank_checks'),0);
 }finally{f.sqlite.close();}
});

test('广告预算：兼任主管的财务不能独自完成两级审批',async t=>{
 time(t);const f=await workplaceFixture();try{
  await f.config({action:'profile',userId:'id-ops',unitId:'ID',jobTitle:'TEST ops',managerId:'finance-1',version:1});
  const id=await create(f);await f.change(f.users.finance,id,'managerApprove');
  await assert.rejects(f.change(f.users.finance,id,'advertisingApprove',{approvedAmount:80}),/独立财务/);await f.change(f.users.finance2,id,'advertisingApprove',{approvedAmount:80});
  const next=await create(f);await f.config({action:'grant',userId:'finance2',unitId:'ID',capability:'finance',enabled:false,reason:'TEST revoke second reviewer'});await assert.rejects(f.change(f.users.finance,next,'managerApprove'),/另一位有效财务/);assert.equal((await expenseRequest(f.db,next)).status,'submitted');
 }finally{f.sqlite.close();}
});

test('广告预算：旧意向不能冒充预算，撤回重提保留历史',async t=>{
 time(t);const f=await workplaceFixture();try{
  const old=await f.expense({businessDate:'2026-11-23',settlementDate:'2026-11-30'});const r=await expenseRequest(f.db,old);f.sqlite.prepare('UPDATE workplace_requests SET data_json=? WHERE id=?').run(JSON.stringify({...r.data,category:'advertising'}),old);
  await f.change(f.users.manager,old,'managerApprove');const v=(await readExpenses(f.db,f.users.finance,{month:'2026-11'})).requests.find(x=>x.id===old);assert.equal(v.legacyAdvertising,true);assert.equal(v.canBudgetApprove,false);assert.equal(v.canFinanceReject,true);
  await assert.rejects(f.change(f.users.finance,old,'advertisingApprove',{approvedAmount:80}),/旧广告意向/);await f.change(f.users.indonesia,old,'withdraw');assert.equal((await expenseRequest(f.db,old)).status,'withdrawn');
  const next=await create(f);await approve(f,next);const summary=(await readExpenses(f.db,f.users.indonesia,{month:'2026-11'})).budgetSummary[0];assert.equal(summary.count,1);assert.equal(summary.requested,10000);assert.equal(count(f,'workplace_requests'),2);
 }finally{f.sqlite.close();}
});

test('广告预算：币种与审批汇率快照独立，月度历史不重复累计',async t=>{
 time(t);const f=await workplaceFixture();try{
  const id=await create(f,{currency:'IDR',amount:100000});await approve(f,id,80000);let v=await readExpenses(f.db,f.users.indonesia,{month:'2026-11'});assert.equal(v.budgetSummary[0].approved,8000000);assert.equal(v.budgetSummary[0].approvedCny,null);assert.equal(v.budgetSummary[0].fxMissing,1);
  await mutateFinanceLedger(f.db,f.users.finance,{action:'rate',month:'2026-11',currency:'IDR',rate:0.00045,revision:0,evidence:'TEST checked monthly rate'});assert.equal((await expenseRequest(f.db,id)).data.rate,null);
  const next=await create(f,{currency:'IDR',amount:100000});await approve(f,next,80000);assert.equal((await expenseRequest(f.db,next)).data.rate.rate,0.00045);v=await readExpenses(f.db,f.users.indonesia,{month:'2026-11'});assert.equal(v.budgetSummary[0].approvedCny,null);
  const future=await create(f,{startDate:'2026-12-01',endDate:'2027-01-05'});await approve(f,future);v=await readExpenses(f.db,f.users.indonesia,{month:'2026-12'});assert.equal(v.requests.length,1);assert.equal(v.budgetSummary[0].approved,8000);
  v=await readExpenses(f.db,f.users.indonesia,{month:'2027-01'});assert.equal(v.requests.length,0);assert.equal(v.budgetSummary.length,0);
 }finally{f.sqlite.close();}
});

test('广告预算：停用撤权、调站及维护锁即时生效，失败不写预算核定',async t=>{
 time(t);const f=await workplaceFixture();try{
  const id=await create(f);await f.change(f.users.manager,id,'managerApprove');
  await f.config({action:'grant',userId:'finance-1',unitId:'ID',capability:'finance',enabled:false,reason:'TEST revoke'});await assert.rejects(f.change(f.users.finance,id,'advertisingApprove',{approvedAmount:80}),e=>e.status===403);
  f.sqlite.prepare("UPDATE users SET site='马来西亚' WHERE id='id-ops'").run();await assert.rejects(f.change(f.users.finance2,id,'advertisingApprove',{approvedAmount:80}),/归属已变化/);f.sqlite.prepare("UPDATE users SET site='印尼' WHERE id='id-ops'").run();
  f.sqlite.prepare("INSERT INTO system_maintenance(id,mode,token_hash,actor_id,expires_at,updated_at) VALUES('global','backup','TEST','admin-1','2099-01-01','2026-11-23')").run();await assert.rejects(f.change(f.users.finance2,id,'advertisingApprove',{approvedAmount:80}),/备份|迁移/);
  assert.equal((await expenseRequest(f.db,id)).status,'manager_approved');assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM workplace_events WHERE action='advertisingApprove'").get().n,0);
 }finally{f.sqlite.close();}
});

test('广告预算：本地日期和字段校验防止补批或不完整申请',async t=>{
 time(t);const f=await workplaceFixture();try{
  for(const extra of [{startDate:'2026-11-22'},{endDate:'2026-11-23'},{endDate:'2028-01-01'},{adAccount:''},{purpose:''},{amount:'1.001'},{currency:'BAD'}])await assert.rejects(create(f,extra));
  const p=payload();await mutateExpense(f.db,f.users.indonesia,p);await assert.rejects(mutateExpense(f.db,f.users.indonesia,p),/已提交/);
  const id=await create(f,{startDate:'2026-11-23',endDate:'2026-11-23'});await f.change(f.users.manager,id,'managerApprove');t.mock.timers.setTime(Date.parse('2026-11-24T05:00:00Z'));await assert.rejects(f.change(f.users.finance,id,'advertisingApprove',{approvedAmount:80}),/投放期间已结束/);
 }finally{f.sqlite.close();}
});

test('广告预算：校验后发生关账或反关账时整笔申请回滚，不留下审计或预算',async t=>{
 time(t);
 for(const reopen of [false,true]){
  const f=await workplaceFixture();try{
   const original=f.db.batch;let injected=false;
   f.db.batch=async statements=>{
    if(!injected){injected=true;f.sqlite.prepare("INSERT INTO finance_period_events VALUES('TEST-RACE-CLOSE','2026-11',1,'closed','{}','TEST concurrent close','admin-1','2026-12-01')").run();if(reopen)f.sqlite.prepare("INSERT INTO finance_period_events VALUES('TEST-RACE-REOPEN','2026-11',2,'open','{}','TEST concurrent reopen','admin-1','2026-12-01')").run();}
    return original(statements);
   };
   await assert.rejects(create(f),e=>e.status===409);
   assert.equal(count(f,'workplace_requests'),0);assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM workplace_events WHERE action='advertisingCreate'").get().n,0);assert.equal(count(f,'finance_documents'),1);
  }finally{f.sqlite.close();}
 }
});
