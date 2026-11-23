import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './fixtures.mjs';
import {readSalesDashboard} from '../lib/sales-dashboard.mjs';
import {convertSalesSummary} from '../lib/sales-fx.mjs';
import {financialSalesSummary} from '../lib/finance-sales.mjs';
import {salesFactStatements} from '../lib/sales-facts.mjs';
import {buildTargetReport} from '../lib/sales-target-model.mjs';
import {answerSalesBrief} from '../lib/employee-sales-brief.mjs';

const today='2026-11-23',date='2026-11-08';
const fx={status:'fresh',rates:{CNY:1,USD:.14,THB:5,IDR:2000,MYR:.6,PHP:8,VND:3500}};
const range={from:date,to:date,site:'泰国',channel:'TikTok'};
function setup(t){const f=fixture();t.after(()=>f.sqlite.close());return f;}
function sale(f,more={}){
 const r={date,site:'泰国',channel:'TikTok',currency:'CNY',qty:1,revenue:100,adCost:null,kind:'complete',sku:'BAG-A',...more},id=crypto.randomUUID();
 f.sqlite.prepare('INSERT INTO sales_imports(id,import_key,business_date,site,channel,row_count,total_qty,actor_id,created_at,report_kind) VALUES(?,?,?,?,?,1,?,?,?,?)').run(id,id,r.date,r.site,r.channel,r.qty,f.users.admin.id,today,r.kind);
 f.sqlite.prepare('INSERT INTO sales_records(id,import_id,business_date,site,channel,sku,qty,currency,reported_amount,ad_cost,actor_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id,id,r.date,r.site,r.channel,r.sku,r.qty,r.currency,r.revenue,r.adCost,f.users.admin.id,today);
 return id;
}
function spend(f,more={}){
 const r={date,site:'泰国',channel:'TikTok',currency:'USD',amount:14,deleted:null,...more},id=crypto.randomUUID();
 f.sqlite.prepare('INSERT INTO sales_ad_spend(id,business_date,site,channel,currency,amount,note,actor_id,updated_at,deleted_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,r.date,r.site,r.channel,r.currency,r.amount,'TEST-ONLY 当天店铺广告总费用',f.users.admin.id,today,r.deleted);
 return id;
}
const read=(f,filters=range,actor=f.users.admin)=>readSalesDashboard(f.db,actor,filters,today);

test('泰国两天人民币销售匹配美元广告费：59条误报消除，原币金额仅计一次',async t=>{
 const f=setup(t);
 for(const [d,n,amount] of [['2026-10-27',26,236.81],[date,33,231.24]]){
  for(let i=0;i<n;i++)sale(f,{date:d,sku:'TEST-'+i});
  spend(f,{date:d,amount});
 }
 const before=f.sqlite.prepare('SELECT * FROM sales_records ORDER BY id').all();
 const report=await read(f,{...range,from:'2026-10-27'}),cny=convertSalesSummary(report,fx);
 assert.equal(cny.total.costMissing,0);assert.equal(cny.total.costComplete,true);
 assert.equal(cny.total.qty,59);assert.equal(cny.total.revenueCny,5900);
 assert.equal(report.currencies.find(r=>r.currency==='USD').adCost,468.05);
 assert.equal(cny.total.adCostCny,3343.21);assert.equal(cny.total.roas,5900/3343.21);
 assert(report.currencies.every(r=>r.crossCurrencyCostDays>0&&r.roas===null));
 assert(report.roiRanking.every(r=>r.adCost===null&&r.roas===null));
 assert.deepEqual(f.sqlite.prepare('SELECT * FROM sales_records ORDER BY id').all(),before);
});

test('多币种店铺总额覆盖各币种SKU费用，不重复计费；原币ROAS不能用局部成本计算',async t=>{
 const f=setup(t);sale(f,{adCost:25});sale(f,{sku:'BAG-B',currency:'THB',revenue:500,adCost:100});
 spend(f,{amount:14});spend(f,{currency:'CNY',amount:20});
 const report=await read(f),cny=convertSalesSummary(report,fx);
 assert.equal(cny.total.revenueCny,200);assert.equal(cny.total.adCostCny,120);assert.equal(cny.total.roas,200/120);
 assert.equal(report.scopes.find(r=>r.currency==='CNY').adCost,20);
 assert.equal(report.scopes.find(r=>r.currency==='THB').adCost,0);
 assert(report.currencies.every(r=>r.roas===null));
 assert.equal(report.roiRanking.find(r=>r.currency==='CNY').roas,4);
});

test('跨币种覆盖仅限同日同站同渠道；删除费用恢复缺报，明确零和权限隔离保留',async t=>{
 const f=setup(t);sale(f);sale(f,{date:'2026-11-09'});sale(f,{channel:'Shopee'});sale(f,{site:'印尼'});
 const id=spend(f,{amount:0});
 const filters={from:date,to:'2026-11-09'},report=await read(f,filters);
 const covered=report.dayScopes.find(r=>r.site==='泰国'&&r.channel==='TikTok'&&r.date===date&&r.currency==='CNY');
 assert.equal(covered.costMissing,0);
 assert.equal(report.dayScopes.filter(r=>r.costMissing>0).length,3);
 const own=await read(f,filters,f.users.indonesia);assert(own.dayScopes.every(r=>r.site==='印尼'&&r.channel==='TikTok'));assert.equal(own.scopes[0].costMissing,1);
 const zero=convertSalesSummary(await read(f),fx);assert.equal(zero.total.adCostCny,0);assert.equal(zero.total.costComplete,true);assert.equal(zero.total.roas,null);
 f.sqlite.prepare('UPDATE sales_ad_spend SET deleted_at=? WHERE id=?').run(today,id);
 const removed=convertSalesSummary(await read(f),fx);assert.equal(removed.total.costMissing,1);assert.equal(removed.total.adCostCny,null);assert.equal(removed.total.costComplete,false);
});

test('跨币种费用不掩盖缺销售额或缺汇率；有广告无销售也不伪造零销售',async t=>{
 const f=setup(t);const id=sale(f,{revenue:null,kind:'partial'});spend(f);
 const report=await read(f),missingRevenue=convertSalesSummary(report,fx);
 assert.equal(missingRevenue.total.costComplete,true);assert.equal(missingRevenue.total.revenueComplete,false);assert.equal(missingRevenue.total.roas,null);
 const noFx=convertSalesSummary(report,{status:'unavailable',rates:{CNY:1}});assert.equal(noFx.total.unconverted,1);assert.equal(noFx.total.costComplete,false);assert.equal(noFx.total.roas,null);
 f.sqlite.prepare('UPDATE sales_records SET reversed_at=? WHERE import_id=?').run(today,id);
 f.sqlite.prepare('UPDATE sales_imports SET reversed_at=? WHERE id=?').run(today,id);
 const costOnly=convertSalesSummary(await read(f),fx);assert.equal(costOnly.total.revenueCny,null);assert.equal(costOnly.total.revenueComplete,false);assert.equal(costOnly.total.adCostCny,100);
});

test('月度任务与每日简报使用相同跨币种覆盖口径，不重复SKU费用或催补已录入广告费',async t=>{
 const f=setup(t);for(const sku of ['BAG-A','BAG-B','BAG-C'])sale(f,{sku,adCost:25});spend(f,{amount:14});
 const [raw,spends,coverage]=(await f.db.batch(salesFactStatements(f.db,date,date))).map(r=>r.results);
 const target=buildTargetReport({month:'2026-11',scopes:[{site:'泰国',channel:'TikTok'}],raw,spend:spends,coverage,inventory:[],targets:[],users:[],fx,windows:{'泰国':{from:date,to:date,days:[date],expectedDays:1}}}).rows[0];
 const cny=convertSalesSummary(await read(f),fx).total;
 assert.equal(target.costComplete,true);assert.equal(target.costMissing,0);assert.equal(target.adDays,1);assert.equal(target.repeatedDays,0);
 assert.equal(target.adCostCny,cny.adCostCny);assert.equal(target.roas,cny.roas);
 const now='2026-11-09T04:00:00Z';f.sqlite.prepare('INSERT INTO sales_fx_snapshots VALUES(?,?,?,?,?,?)').run('test','test',now,now,'2026-11-10T04:00:00Z',JSON.stringify(fx.rates));
 const answer=await answerSalesBrief(f.db,f.users.admin,'昨天泰国TK销售怎么样',now);
 assert.doesNotMatch(answer.answer,/核对.*广告费/);assert.match(answer.brief.details.join('\n'),/广告费 ¥100/);assert.doesNotMatch(answer.brief.details.join('\n'),/疑似重复/);
});

test('未关账财务汇总采用核定汇率匹配跨币种广告费，缺汇率仍标记不完整',async t=>{
 const f=setup(t);sale(f);spend(f);
 const report=await read(f),missing=await financialSalesSummary(f.db,f.users.admin,report);
 assert.equal(missing.total.costComplete,false);assert.equal(missing.total.unconverted,1);
 f.sqlite.prepare("INSERT INTO finance_rates(id,month,currency,rate,revision,actor_id,evidence,created_at) VALUES('test-usd','2026-11','USD',7,1,?,'测试核定汇率',?)").run(f.users.admin.id,today);
 const converted=await financialSalesSummary(f.db,f.users.admin,report);
 assert.equal(converted.total.costComplete,true);assert.equal(converted.total.adCostCny,98);assert.equal(converted.total.revenueCny,100);assert.equal(converted.total.roas,100/98);
});
