import test from 'node:test';
import assert from 'node:assert/strict';
import {costFixture} from './cost-fixture.mjs';
import {marketingSamplesFixture} from './marketing-samples-fixture.mjs';
import {createFinanceSnapshot,readFinanceLedger,mutateFinanceLedger} from '../lib/finance-ledger.mjs';
import {mutateDomesticDistribution,domesticToday} from '../lib/domestic-distribution.mjs';
import {uploadDomesticFile} from '../lib/domestic-distribution-files.mjs';

const RealDate=Date;
function clock(iso){globalThis.Date=class extends RealDate{constructor(...args){super(...(args.length?args:[iso]));}static now(){return new RealDate(iso).getTime();}};}
async function domestic(f){
 const factory={id:'dom-factory',role:'工厂',name:'TEST工厂'};f.sqlite.prepare('INSERT INTO users(id,email,name,role,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(factory.id,'dom-factory@example.test',factory.name,factory.role,new Date().toISOString(),new Date().toISOString());
 const day=()=>domesticToday(),row=id=>f.sqlite.prepare('SELECT * FROM domestic_orders WHERE id=?').get(id),call=(a,action,p={})=>mutateDomesticDistribution(f.db,a,{action,...p,operationId:crypto.randomUUID()}),change=(a,id,action,p={})=>call(a,action,{orderId:id,version:row(id).version,...p}),bucket={put:async()=>{},delete:async()=>{}};
 const proof=(id,purpose,a=f.users.supply)=>uploadDomesticFile(f.db,bucket,a,{orderId:id,purpose,file:new File(['%PDF-1.4 TEST ONLY'],'test.pdf',{type:'application/pdf'}),operationId:crypto.randomUUID()});
 const customer=await call(f.users.supply,'customerCreate',{companyName:'TEST ONLY 国内公司',companyShortName:'TEST国内',contact:'TEST',phone:'TEST',address:'TEST ONLY'}),{id}=await call(f.users.supply,'orderCreate',{customerId:customer.id,businessDate:day(),items:[{sku:'BAG-A',qty:5,unitPrice:'10.00'}]});
 let pr=await proof(id,'quote');await change(f.users.supply,id,'quoteConfirm',{proofId:pr.id,customerConfirmed:true});pr=await proof(id,'contract');await change(f.users.supply,id,'contractSubmit',{proofId:pr.id,contractSigned:true,settlementMode:'credit',dueDate:'2026-01-15',factoryUserId:factory.id,contractNumber:'TEST-CN',contractTerms:'TEST ONLY'});await change(f.users.admin,id,'contractDecide',{approved:true,reason:'TEST ONLY独立审核'});await change(f.users.finance,id,'releaseConfirm',{termsVerified:true,reason:'TEST ONLY合同放行'});
 const source=await proof(id,'source',factory),packed=await proof(id,'packing',factory),item=f.sqlite.prepare('SELECT id FROM domestic_order_items WHERE order_id=?').get(id);await change(factory,id,'pack',{sourceNo:'TEST-PACK',sourceProofId:source.id,proofId:packed.id,businessDate:day(),domesticSourceConfirmed:true,items:[{itemId:item.id,qty:5}]});const line=f.sqlite.prepare('SELECT id FROM domestic_pack_lines WHERE item_id=?').get(item.id);pr=await proof(id,'shipment',factory);await change(factory,id,'ship',{items:[{packLineId:line.id,qty:5}],businessDate:day(),carrier:'TEST',trackingNo:'TEST',proofId:pr.id,handoverConfirmed:true});
 const receipt=async amount=>{const proofRecord=await proof(id,'finance',f.users.finance);return change(f.users.finance,id,'financeConfirm',{amount,proofId:proofRecord.id,businessDate:day(),bankReference:'TEST-'+crypto.randomUUID(),bankAccount:'TEST',reason:'TEST ONLY银行核对',actualConfirmed:true});};
 return {id,receipt};
}
async function sent(f,roundId='sample-round'){const {id}=await f.create({roundId});await f.approve(id);await f.assign(id);await f.ship(id,2);return id;}
async function closeReviewed(f,month){
 let r=await readFinanceLedger(f.db,f.users.admin,{month,view:'period'});
 for(const currency of r.preview.quality.missingRates)await mutateFinanceLedger(f.db,f.users.finance,{action:'rate',month,currency,rate:currency==='IDR'?0.0005:1.5,revision:0,evidence:'TEST ONLY 夹具核定汇率'});
 r=await readFinanceLedger(f.db,f.users.admin,{month,view:'period'});const keys=r.preview.quality.checks.filter(c=>c.blocking&&c.count>0).map(c=>c.key);
 await mutateFinanceLedger(f.db,f.users.admin,{action:'close',month,revision:0,evidence:'TEST ONLY完整快照回归',reviewVersion:r.version,exceptionKeys:keys,exceptionReason:'TEST ONLY已核对合成数据缺口，专为测试冻结边界'});
 return JSON.parse(f.sqlite.prepare("SELECT snapshot_json FROM finance_period_events WHERE month=? AND status='closed' ORDER BY revision DESC LIMIT 1").get(month).snapshot_json);
}

test('中央月结真实封存国内和寄样子账，后月到账/寄样不改变历史GET及快照',async()=>{
 let f;try{clock('2026-01-10T04:00:00Z');f=marketingSamplesFixture(costFixture());const d=await domestic(f);await d.receipt('20.00');const sample=await sent(f);await f.cost(sample,'sample');await f.cost(sample,'freight');clock('2026-02-02T04:00:00Z');const saved=await closeReviewed(f,'2026-01');
  assert.equal(saved.domestic.period.netReceiptsMinor,2000);assert.equal(saved.domestic.balances.contractOutstandingMinor,3000);assert.equal(saved.domestic.balances.receivableMinor,3000);assert.equal(saved.sampleCosts.totals.sample.confirmedCnyMinor,500);assert.equal(saved.sampleCosts.totals.freight.confirmedCnyMinor,300);assert.equal(saved.quality.checks.find(c=>c.key==='国内分销逾期未回款').blocking,false);assert.equal(saved.quality.checks.find(c=>c.key==='国内分销逾期未回款').count,1);
  const raw=f.sqlite.prepare("SELECT snapshot_json FROM finance_period_events WHERE month='2026-01'").get().snapshot_json;const before=await readFinanceLedger(f.db,f.users.finance,{month:'2026-01'});assert.deepEqual(before.domestic,saved.domestic);assert.deepEqual(before.sampleCosts,saved.sampleCosts);assert.deepEqual(before.snapshot.domestic,saved.domestic);assert.deepEqual(before.snapshot.sampleCosts,saved.sampleCosts);
  clock('2026-02-05T04:00:00Z');await d.receipt('30.00');f.round('sample-feb',2);const second=await sent(f,'sample-feb');await f.cost(second,'sample');await f.cost(second,'freight');const after=await readFinanceLedger(f.db,f.users.finance,{month:'2026-01'});assert.deepEqual(after.domestic,before.domestic);assert.deepEqual(after.sampleCosts,before.sampleCosts);assert.equal(f.sqlite.prepare("SELECT snapshot_json FROM finance_period_events WHERE month='2026-01'").get().snapshot_json,raw);
  const current=await readFinanceLedger(f.db,f.users.finance,{month:'2026-02'});assert.equal(current.domestic.period.netReceiptsMinor,3000);assert.equal(current.domestic.balances.contractOutstandingMinor,0);assert.equal(current.sampleCosts.totals.sample.confirmedCnyMinor,500);assert.equal(current.snapshot,null);
  await assert.rejects(readFinanceLedger(f.db,f.users.supply,{month:'2026-01'}),/仅管理员和财务/);
 }finally{globalThis.Date=RealDate;f?.sqlite.close();}
});

test('旧关账快照没有国内或寄样字段时返回null，不把当前数据填进历史结果',async()=>{
 let f;try{clock('2026-01-10T04:00:00Z');f=marketingSamplesFixture(costFixture());const d=await domestic(f);await d.receipt('10.00');const sample=await sent(f);await f.cost(sample,'sample');await f.cost(sample,'freight');clock('2026-02-02T04:00:00Z');const {domestic:ignoredDomestic,sampleCosts:ignoredSample,...legacy}=await createFinanceSnapshot(f.db,f.users.admin,'2026-01');assert.ok(ignoredDomestic);assert.ok(ignoredSample);f.sqlite.prepare("INSERT INTO finance_period_events(id,month,revision,status,snapshot_json,evidence,actor_id,created_at) VALUES('legacy','2026-01',1,'closed',?,'TEST ONLY LEGACY',?,?)").run(JSON.stringify(legacy),f.users.admin.id,new Date().toISOString());
  const r=await readFinanceLedger(f.db,f.users.finance,{month:'2026-01'});assert.equal(r.domestic,null);assert.equal(r.sampleCosts,null);assert.equal(r.snapshot.domestic,undefined);assert.equal(r.snapshot.sampleCosts,undefined);assert.deepEqual(r.snapshot.quality,legacy.quality);
 }finally{globalThis.Date=RealDate;f?.sqlite.close();}
});

test('中央快照把寄样缺费用列blocking，已知外币缺汇率不能例外关账',async()=>{
 let f;try{clock('2026-01-10T04:00:00Z');f=marketingSamplesFixture(costFixture());const sample=await sent(f);clock('2026-02-02T04:00:00Z');let r=await readFinanceLedger(f.db,f.users.admin,{month:'2026-01',view:'period'});assert.equal(r.preview.quality.checks.find(c=>c.key==='寄样成本与运费待核').count,2);assert.equal(r.preview.quality.checks.find(c=>c.key==='寄样成本与运费待核').blocking,true);await assert.rejects(mutateFinanceLedger(f.db,f.users.admin,{action:'close',month:'2026-01',revision:0,evidence:'TEST ONLY不能静默跳过'}),/未核对|汇率/);
  await f.cost(sample,'sample',{businessDate:'2026-01-10',currency:'IDR',items:[{itemId:JSON.parse(f.shipment(sample).items_json)[0].itemId,unitCost:'20000'}]});await f.cost(sample,'freight',{businessDate:'2026-01-10'});r=await readFinanceLedger(f.db,f.users.admin,{month:'2026-01',view:'period'});assert.ok(r.preview.quality.missingRates.includes('IDR'));assert.equal(r.preview.sampleCosts.totals.sample.missingRateCount,1);assert.equal(r.preview.sampleCosts.totals.sample.confirmedCnyMinor,0);assert.equal(r.preview.quality.checks.find(c=>c.key==='寄样成本与运费待核').count,0);
  await assert.rejects(mutateFinanceLedger(f.db,f.users.admin,{action:'close',month:'2026-01',revision:0,evidence:'TEST',reviewVersion:r.version,exceptionKeys:r.preview.quality.checks.filter(c=>c.blocking&&c.count>0).map(c=>c.key),exceptionReason:'TEST不得绕过缺率'}),/汇率/);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM finance_period_events').get().n,0);
 }finally{globalThis.Date=RealDate;f?.sqlite.close();}
});

test('下月才确认的寄样费用不能吞掉本月出库的待核缺口',async()=>{
 let f;try{clock('2026-01-10T04:00:00Z');f=marketingSamplesFixture(costFixture());const sample=await sent(f);clock('2026-02-02T04:00:00Z');await f.cost(sample,'sample');await f.cost(sample,'freight');const r=await readFinanceLedger(f.db,f.users.admin,{month:'2026-01',view:'period'});assert.equal(r.sampleCosts.lines.length,0);assert.equal(r.sampleCosts.pending.length,2);assert.equal(r.preview.quality.checks.find(c=>c.key==='寄样成本与运费待核').count,2);
 }finally{globalThis.Date=RealDate;f?.sqlite.close();}
});
