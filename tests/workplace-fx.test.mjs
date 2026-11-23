import test from 'node:test';
import assert from 'node:assert/strict';
import {workplaceFixture} from './workplace-fixture.mjs';
import {readExpenses,expenseRequest} from '../lib/finance-workbench.mjs';
import {mutateFinanceLedger} from '../lib/finance-ledger.mjs';

test('费用原币与复核汇率：缺失保持未知，后续核定不悄悄改写既有审批快照',async()=>{
 const f=await workplaceFixture();
 try {
  f.sqlite.prepare("INSERT INTO finance_documents VALUES('TEST-IDR-ID','supplier_bill','TEST-IDR',1,'2026-09-01','TEST supplier','印尼','TikTok','IDR',10000000,'active',?,'TEST','TEST seeded existing source','finance-1','2026-09-01')").run(JSON.stringify({matchStatus:'matched'}));
  await f.config({action:'billScope',businessKey:'TEST-IDR',unitId:'ID',entityConfirmed:true,reason:'TEST scope'});
  const first=await f.expense({currency:'IDR',amount:10000});
  await f.change(f.users.manager,first,'managerApprove');
  await f.change(f.users.finance,first,'financeApprove',{sourceKey:'TEST-IDR',entityConfirmed:true});
  let summary=(await readExpenses(f.db,f.users.boss,{month:'2026-09'})).summary[0];
  assert.equal(summary.approved,1000000);assert.equal(summary.approvedCny,null);assert.equal(summary.fxMissing,1);
  await mutateFinanceLedger(f.db,f.users.finance,{action:'rate',month:'2026-09',currency:'IDR',rate:0.00045,revision:0,evidence:'TEST monthly verified rate'});
  assert.equal((await expenseRequest(f.db,first)).data.rate,null);
  const second=await f.expense({currency:'IDR',amount:20000});
  await f.change(f.users.manager,second,'managerApprove');
  await f.change(f.users.finance,second,'financeApprove',{sourceKey:'TEST-IDR',entityConfirmed:true});
  assert.equal((await expenseRequest(f.db,second)).data.rate.rate,0.00045);
  assert.equal((await expenseRequest(f.db,second)).data.rate.revision,1);
  summary=(await readExpenses(f.db,f.users.boss,{month:'2026-09'})).summary[0];
  assert.equal(summary.approved,3000000);assert.equal(summary.approvedCny,null);assert.equal(summary.fxMissing,1);
 } finally {f.sqlite.close();}
});
