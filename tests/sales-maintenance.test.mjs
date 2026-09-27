import test from 'node:test';
import assert from 'node:assert/strict';
import {systemFixture,svc,race} from './system-fixture.mjs';
import {saveSalesAdSpend} from '../lib/sales-ad-spend.mjs';
import {readSalesDashboard,reportToday} from '../lib/sales-dashboard.mjs';
const day=reportToday(),yesterday=new Date(Date.parse(day)-86400000).toISOString().slice(0,10);
const payload=(more={})=>({site:'印尼',channel:'TikTok',businessDate:yesterday,sourceBatchRef:crypto.randomUUID(),importKey:crypto.randomUUID(),rows:[{sku:'BAG-A',qty:3,amount:300}],...more});
const expense=(more={})=>({action:'salesAdSpendSave',site:'印尼',channel:'TikTok',businessDate:yesterday,currency:'IDR',amount:50,note:'广告后台总费用核对',version:0,...more});
const stock=f=>f.sqlite.prepare("SELECT qty FROM inventory_balances WHERE sku='BAG-A' AND site='印尼' AND channel='TikTok'").get().qty;
const snapshot=async actor=>{svc.setActor(actor);return (await svc.GET(new Request('http://test/api/system'))).json();};

test('昨日待办按完整日报判断；今日导入不能代替昨日，修改后恢复核对提醒',async()=>{
 const f=systemFixture();try{
  await svc.salesImport(f.users.indonesia,payload({businessDate:day,reportKind:'complete'}));
  let s=await snapshot(f.users.indonesia);assert(s.myTasks.some(t=>t.title==='导入昨日销售'));assert.equal(s.salesScopeStatus[0].updatedExpected,false);
  const p=payload({reportKind:'complete'}),{importId}=await (await svc.salesImport(f.users.indonesia,p)).json();
  s=await snapshot(f.users.indonesia);assert.equal(s.salesScopeStatus[0].updatedExpected,true);assert(!s.myTasks.some(t=>t.title==='导入昨日销售'));
  await svc.correctSalesImport(f.users.indonesia,{...p,importId,reason:'核对平台实际数量',rows:[{sku:'BAG-A',qty:2,amount:200}]});
  s=await snapshot(f.users.indonesia);assert.equal(s.salesScopeStatus[0].updatedExpected,false);assert.equal(s.salesScopeStatus[0].salesExpected,2);assert(s.myTasks.some(t=>t.title==='导入昨日销售'));
 }finally{f.sqlite.close();}
});
test('修改批次在一个事务中冲销旧批次并写入新记录；删除只恢复对应库存，审计可追溯',async()=>{
 const f=systemFixture();try{
  const p=payload(),{importId}=await (await svc.salesImport(f.users.indonesia,p)).json();assert.equal(stock(f),7);
  const corrected=await (await svc.correctSalesImport(f.users.indonesia,{...p,importId,reason:'平台核对修订销量',rows:[{sku:'BAG-A',qty:1,amount:180}]})).json();assert.equal(stock(f),9);
  assert.equal(f.sqlite.prepare('SELECT reported_amount FROM sales_records WHERE import_id=?').get(importId).reported_amount,300);
  assert(f.sqlite.prepare('SELECT reversed_at FROM sales_imports WHERE id=?').get(importId).reversed_at);
  let r=await readSalesDashboard(f.db,f.users.admin,{from:yesterday,to:day});assert.equal(r.totalQty,1);assert.equal(r.currencies[0].revenue,180);
  await svc.reverseSalesImport(f.users.indonesia,{importId:corrected.importId,reason:'误导入按实际删除'});assert.equal(stock(f),10);
  assert.equal((await readSalesDashboard(f.db,f.users.admin,{from:yesterday,to:day})).totalQty,0);
  const logs=f.sqlite.prepare("SELECT detail_json FROM audit_logs WHERE action='修改销售导入批次'").all();assert.equal(logs.length,1);assert.equal(JSON.parse(logs[0].detail_json).replacementImportId,corrected.importId);
 }finally{f.sqlite.close();}
});
test('修订数据非法时旧记录及库存不变；越权修改、删除和读取均被拒绝',async()=>{
 const f=systemFixture();try{
  const p=payload(),{importId}=await (await svc.salesImport(f.users.indonesia,p)).json();
  await assert.rejects(svc.correctSalesImport(f.users.indonesia,{...p,importId,reason:'修改核对失败测试',rows:[{sku:'BAG-A',qty:-1}]}));assert.equal(stock(f),7);assert.equal(f.sqlite.prepare('SELECT reversed_at FROM sales_imports WHERE id=?').get(importId).reversed_at,null);
  for(const actor of [f.users.malaysia,f.users.supply,f.users.finance]){
   await assert.rejects(svc.correctSalesImport(actor,{...p,importId,reason:'跨站点尝试修改'}),e=>e.status===403);
   await assert.rejects(svc.reverseSalesImport(actor,{importId,reason:'跨站点尝试删除'}),e=>e.status===403);
   svc.setActor(actor);assert.equal((await svc.GET(new Request('http://test/api/system?salesImportId='+importId))).status,403);
  }
 }finally{f.sqlite.close();}
});
test('修改与删除并发只能一个成功，不重复冲销库存',async()=>{
 const f=systemFixture();try{
  const p=payload(),{importId}=await (await svc.salesImport(f.users.indonesia,p)).json();
  const results=await race(f,()=>svc.correctSalesImport(f.users.indonesia,{...p,importId,reason:'核对后修订该批次',rows:[{sku:'BAG-A',qty:2}]}),()=>svc.reverseSalesImport(f.users.indonesia,{importId,reason:'核对后删除该批次'}));
  assert.equal(results.filter(r=>r.ok).length,1);assert.equal(stock(f),10);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM sales_imports WHERE reversed_at IS NULL').get().n,0);
 }finally{f.sqlite.close();}
});
test('批次明细读取不受快照1000行限制，完整修订支持超过1000个SKU',async()=>{
 const f=systemFixture();try{
  const p=payload({rows:Array.from({length:1002},(_,i)=>({sku:'TEST-'+i,qty:1}))}),{importId}=await (await svc.salesImport(f.users.indonesia,p)).json();svc.setActor(f.users.indonesia);
  const details=await (await svc.GET(new Request('http://test/api/system?salesImportId='+importId))).json();assert.equal(details.rows.length,1002);
  await svc.correctSalesImport(f.users.indonesia,{...p,importId,reason:'修订完整销售批次',rows:details.rows.map(r=>({sku:r.sku,qty:2}))});
  assert.equal((await readSalesDashboard(f.db,f.users.indonesia,{from:yesterday,to:day})).totalQty,2004);
 }finally{f.sqlite.close();}
});
test('渠道总费用用于整体ROAS，SKU未知不虚构排名；总费用覆盖而非叠加同日SKU费用',async()=>{
 const f=systemFixture();try{
  await svc.salesImport(f.users.indonesia,payload({rows:[{sku:'BAG-A',qty:3,amount:300},{sku:'BAG-B',qty:1,amount:100,adCost:10}]}));
  await saveSalesAdSpend(f.db,f.users.indonesia,expense());
  const r=await readSalesDashboard(f.db,f.users.indonesia,{from:yesterday,to:day});assert.equal(r.currencies[0].adCost,50);assert.equal(r.currencies[0].roas,8);assert.equal(r.scopes[0].roas,8);assert.equal(r.daily[0].roas,8);assert.equal(r.roiRanking.find(x=>x.sku==='BAG-A').roas,null);assert.equal(r.roiRanking.find(x=>x.sku==='BAG-B').roas,10);assert.equal(stock(f),7);
  await saveSalesAdSpend(f.db,f.users.indonesia,expense({version:1,amount:80}));assert.equal((await readSalesDashboard(f.db,f.users.indonesia,{from:yesterday,to:day})).currencies[0].roas,5);
  await saveSalesAdSpend(f.db,f.users.indonesia,expense({version:2,action:'salesAdSpendDelete'}));const cleared=await readSalesDashboard(f.db,f.users.indonesia,{from:yesterday,to:day});assert.equal(cleared.currencies[0].adCost,10);assert.equal(cleared.currencies[0].roas,null);assert.equal(stock(f),7);
 }finally{f.sqlite.close();}
});
test('费用有投放无销售仍计入整体；币种、日期、渠道独立；零成本与未知区分',async()=>{
 const f=systemFixture();try{
  await svc.salesImport(f.users.indonesia,payload());
  await saveSalesAdSpend(f.db,f.users.indonesia,expense({amount:0}));
  await saveSalesAdSpend(f.db,f.users.indonesia,expense({businessDate:day,amount:20}));
  await saveSalesAdSpend(f.db,f.users.indonesia,expense({currency:'USD',amount:5}));
  await saveSalesAdSpend(f.db,f.users.admin,expense({channel:'Shopee',amount:10}));
  const r=await readSalesDashboard(f.db,f.users.indonesia,{from:yesterday,to:day});assert.equal(r.totalQty,3);assert.equal(r.currencies.find(c=>c.currency==='IDR').roas,15);assert.equal(r.currencies.find(c=>c.currency==='USD').adCost,5);assert.equal(r.daily.find(c=>c.currency==='IDR'&&c.date===yesterday).roas,null);
  const all=await readSalesDashboard(f.db,f.users.admin,{from:yesterday,to:day});assert.equal(all.currencies.find(c=>c.currency==='IDR').adCost,30);
 }finally{f.sqlite.close();}
});
test('费用版本冲突、权限、格式校验、备份锁阻止写入，审计保留每个版本',async()=>{
 const f=systemFixture();try{
  for(const actor of [f.users.supply,f.users.malaysia,f.users.finance])await assert.rejects(saveSalesAdSpend(f.db,actor,expense()),e=>e.status===403);
  for(const p of [{amount:''},{amount:-1},{amount:'0.001'},{businessDate:'2026-02-30'},{currency:'ZZZ'},{version:'0'}])await assert.rejects(saveSalesAdSpend(f.db,f.users.indonesia,expense(p)));
  const run=()=>saveSalesAdSpend(f.db,f.users.indonesia,expense());const result=await race(f,run,run);assert.equal(result.filter(r=>r.ok).length,1);
  await assert.rejects(saveSalesAdSpend(f.db,f.users.indonesia,expense()),e=>e.status===409);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM audit_logs WHERE entity_type='sales_ad_spend'").get().n,1);
  f.sqlite.prepare("INSERT INTO system_maintenance(id,mode,token_hash,actor_id,expires_at,updated_at) VALUES('global','backup','x','a','9999-12-01','now')").run();
  await assert.rejects(saveSalesAdSpend(f.db,f.users.indonesia,expense({version:1,amount:20})),/备份/);
  assert.throws(()=>f.sqlite.prepare('UPDATE sales_ad_spend SET amount=1').run(),/guard_maintenance/);
 }finally{f.sqlite.close();}
});
