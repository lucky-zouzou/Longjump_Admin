import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './fixtures.mjs';
import {advertisingTrendFilters,advertisingDateRange,buildAdvertisingTrend} from '../lib/advertising-trend-model.mjs';
import {readAdvertisingTrend} from '../lib/advertising-trend.mjs';
const now=new Date('2026-11-23T03:00:00Z'),actor={id:'ops',role:'运营',site:'印尼',channel:'TikTok'};
const filters=advertisingTrendFilters(actor,{from:'2026-11-20',to:'2026-11-22'},now);
const fact=(date,more={})=>({date,site:'印尼',channel:'TikTok',currency:'IDR',adCost:10,costMissing:0,repeated:0,...more});

test('广告趋势权限先于查询：运营锁定账户站点平台，其他岗位无扩权',async()=>{
 assert.deepEqual(advertisingTrendFilters(actor,{from:filters.from,to:filters.to},now),filters);
 const blocked={prepare(){assert.fail('未授权请求不应读取台账');}};
 for(const input of [{site:'马来西亚'},{channel:'Shopee'},{site:"印尼' OR 1=1--"}])await assert.rejects(readAdvertisingTrend(blocked,actor,input,now),e=>e.status===403);
 for(const role of ['财务','海运','工厂','销售','员工','达人BD','拍摄剪辑'])await assert.rejects(readAdvertisingTrend(blocked,{...actor,role},{},now),e=>e.status===403);
 await assert.rejects(readAdvertisingTrend(blocked,{...actor,site:null},{},now),e=>e.status===403);
 assert.equal(advertisingTrendFilters({...actor,role:'管理员'},{site:'菲律宾',channel:'Shopee'},now).site,'菲律宾');
 assert.equal(advertisingTrendFilters({...actor,role:'供应链'},{site:'菲律宾',channel:'Shopee'},now).site,'菲律宾');
});

test('日期使用站点当地日期，拒绝无效、未来及过长查询',()=>{
 const boundary=new Date('2026-11-23T16:30:00Z');
 assert.equal(advertisingDateRange('2026-11','马来西亚',boundary).to,'2026-11-24');
 assert.equal(advertisingDateRange('2026-11','印尼',boundary).to,'2026-11-23');
 assert.deepEqual(advertisingDateRange('2026-02','印尼',now),{from:'2026-02-01',to:'2026-02-28',today:'2026-11-23'});
 for(const input of [{month:'2026-13'},{month:'2026-12'},{from:'2026-02-30'},{from:'2025-01-01'},{to:'2026-11-24'},{from:'2026-11-22',to:'2026-11-20'}])assert.throws(()=>advertisingTrendFilters(actor,input,now),e=>e.status===400);
});

test('跨币种店铺费用覆盖同日全部SKU费用，明确零保留，多币种独立合计',()=>{
 const result=buildAdvertisingTrend({sales:[fact('2026-11-20',{currency:'CNY',adCost:800}),fact('2026-11-21',{adCost:900})],spend:[fact('2026-11-20',{currency:'USD',amount:20}),fact('2026-11-20',{currency:'IDR',amount:10000}),fact('2026-11-21',{currency:'USD',amount:0})]},filters);
 assert.deepEqual(result.currencies,['IDR','USD']);assert.equal(result.totals.find(r=>r.currency==='USD').amount,20);assert.equal(result.totals.find(r=>r.currency==='IDR').amount,10000);
 assert.equal(result.days[1].status,'reported');assert.equal(result.days[1].entries[0].amount,0);assert.equal(result.days[2].status,'missing');assert.deepEqual(result.days[2].entries,[]);
 assert.equal(result.totals.find(r=>r.currency==='USD').change,null); // Missing final date cannot be skipped for a daily comparison.
 assert.ok(!JSON.stringify(result).includes('roas'));
});

test('缺报、部分SKU费用、疑似重复分别标明，不把未知汇总成0',()=>{
 const result=buildAdvertisingTrend({sales:[fact('2026-11-20',{adCost:null,costMissing:2}),fact('2026-11-21',{adCost:3,costMissing:1}),fact('2026-11-22',{adCost:30,repeated:1})],coverage:[fact('2026-11-22')]},filters);
 assert.deepEqual(result.days.map(d=>d.status),['missing','partial','review']);assert.equal(result.totals[0].amount,33);assert.equal(result.totals[0].completeDays,0);assert.equal(result.totals[0].reviewDays,1);assert.equal(result.totals[0].change,null);
 const empty=buildAdvertisingTrend({sales:[fact('2026-11-20',{adCost:null,costMissing:1})]},filters);assert.equal(empty.totals[0].amount,null);assert.equal(empty.summary.reportedDays,0);
 const zeros=buildAdvertisingTrend({sales:[fact('2026-11-20',{adCost:0})],coverage:[fact('2026-11-20')]},filters);assert.equal(zeros.days[0].status,'reported');assert.equal(zeros.totals[0].amount,0);
});

test('日环比只比较相邻且费用完整的日期，今日未结束不比较，金额以分加总',()=>{
 const f={...filters,to:'2026-11-23'};
 const result=buildAdvertisingTrend({spend:[fact('2026-11-21',{amount:.1}),fact('2026-11-22',{amount:.2}),fact('2026-11-23',{amount:.3})]},f);
 assert.equal(result.totals[0].amount,.6);assert.deepEqual(result.totals[0].change,{date:'2026-11-22',previousDate:'2026-11-21',amount:.1,percent:1});assert.equal(result.days.at(-1).provisional,true);
 const zeroPrior=buildAdvertisingTrend({spend:[fact('2026-11-21',{amount:0}),fact('2026-11-22',{amount:20})]},filters);assert.equal(zeroPrior.totals[0].change.percent,null);
});

test('读取真实台账时在SQL过滤站点平台、撤销与删除，一次快照且响应不带销售额',async()=>{
 const f=fixture();try{
  const addSales=({date='2026-11-20',site='印尼',channel='TikTok',currency='CNY',cost=99,reversed=null}={})=>{const id=crypto.randomUUID();f.sqlite.prepare('INSERT INTO sales_records(id,import_id,business_date,site,channel,sku,qty,currency,reported_amount,ad_cost,amount,actor_id,created_at,reversed_at) VALUES(?,?,?,?,?,?,1,?,100000,?,0,?,?,?)').run(id,id,date,site,channel,'BAG-A',currency,cost,f.users.indonesia.id,date,reversed);};
  const addSpend=({date='2026-11-20',site='印尼',channel='TikTok',currency='USD',amount=2,deleted=null}={})=>f.sqlite.prepare('INSERT INTO sales_ad_spend(id,business_date,site,channel,currency,amount,note,version,updated_at,actor_id,deleted_at) VALUES(?,?,?,?,?,?,?,1,?,?,?)').run(crypto.randomUUID(),date,site,channel,currency,amount,'TEST-ONLY',date,f.users.indonesia.id,deleted);
  addSales();addSales({date:'2026-11-21',cost:999,reversed:'2026-11-22'});addSales({site:'马来西亚',cost:9999});addSales({channel:'Shopee',cost:8888});
  addSpend();addSpend({date:'2026-11-21',amount:999,deleted:'2026-11-22'});addSpend({site:'马来西亚',amount:9999});addSpend({channel:'Shopee',amount:8888});
  let batches=0;const db={prepare:sql=>f.db.prepare(sql),batch:statements=>{batches++;assert.equal(statements.length,3);return f.db.batch(statements);}};
  const report=await readAdvertisingTrend(db,f.users.indonesia,{from:filters.from,to:filters.to},now);
  assert.equal(batches,1);assert.equal(report.totals.length,1);assert.equal(report.totals[0].currency,'USD');assert.equal(report.totals[0].amount,2);assert.equal(report.days[1].status,'missing');
  assert.deepEqual(report.permissions,{canView:true,canChooseScope:false,scopeLocked:true});
  assert.ok(!JSON.stringify(report).includes('revenue'));assert.ok(!JSON.stringify(report).includes('sku'));assert.ok(!JSON.stringify(report).includes('100000'));
 }finally{f.sqlite.close();}
});
