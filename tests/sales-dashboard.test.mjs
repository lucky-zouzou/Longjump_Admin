import test from 'node:test';
import assert from 'node:assert/strict';
import {systemFixture,svc,race} from './system-fixture.mjs';
import {parseImportGrid} from '../lib/tabular-import.mjs';
import {normalizeSales,salesMoney} from '../lib/sales-data.mjs';
import {readSalesDashboard,reportFilters,reportToday} from '../lib/sales-dashboard.mjs';
import {indonesiaDate} from '../lib/wholesale.mjs';
const day=reportToday();
const range={from:day,to:day};
const payload=(rows,more={})=>({site:'印尼',channel:'TikTok',businessDate:day,sourceBatchRef:crypto.randomUUID(),importKey:crypto.randomUUID(),rows,...more});
const insert=(f,{id=crypto.randomUUID(),sku='BAG-A',qty=1,site='印尼',channel='TikTok',currency='IDR',amount=100,adCost=10,date=day,reversed=null,oldAmount=0}={})=>f.sqlite.prepare('INSERT INTO sales_records(id,import_id,business_date,site,channel,sku,qty,currency,reported_amount,ad_cost,amount,actor_id,created_at,reversed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,id,date,site,channel,sku,qty,currency,amount,adCost,oldAmount,f.users.indonesia.id,day,reversed);

test('销售金额解析：中英表头、明确零、空成本、实际折扣额和分币种',()=>{
  const data=parseImportGrid('sales',[['Seller SKU','Quantity','Unit price','Revenue','Ad spend','Currency'],['0012',2,'100.25','180.00',0,'IDR'],['B',0,'','',5,'IDR']],{currency:'IDR'});
  assert.deepEqual(data.errors,[]);const rows=normalizeSales(data.rows,'IDR');assert.equal(rows[0].amount,180);assert.equal(rows[0].adCost,0);assert.equal(rows[0].sku,'0012');assert.equal(rows[1].amount,0);assert.equal(rows[1].adCost,5);
  assert.equal(salesMoney('1,234.56'),1234.56);assert.equal(salesMoney(''),null);
  for(const value of [true,{},[],NaN,Infinity,-1,'1e3','1.234,56','0.001'])assert.throws(()=>salesMoney(value));
  assert.throws(()=>normalizeSales([{sku:'B',qty:0,amount:1,adCost:2}],'IDR'),/零销量/);
  assert.throws(()=>normalizeSales([{sku:'B',qty:1,amount:1,currency:'EUR'}],'IDR'),/币种/);
  assert.throws(()=>normalizeSales([{sku:'B',qty:1,amount:1}]),/币种/);
  const mixed=normalizeSales([{sku:'A',qty:2,unitPrice:10,adCost:2},{sku:'A',qty:3,unitPrice:20,adCost:5},{sku:'A',qty:1,currency:'MYR',amount:3,adCost:1}],'IDR');
  assert.equal(mixed.length,2);assert.equal(mixed[0].amount,80);assert.equal(mixed[0].adCost,7);
  const incomplete=normalizeSales([{sku:'A',qty:1,amount:10,adCost:2},{sku:'A',qty:1}],'IDR');assert.equal(incomplete.length,2);assert.equal(incomplete[0].amount,10);assert.equal(incomplete[1].amount,null);assert.equal(incomplete[1].adCost,null);
});

test('实际导入金额与加权成交价持久化；零销量投放不扣库存；冲销全部恢复',async()=>{
 const f=systemFixture();try{
  f.sqlite.prepare("UPDATE sku_settings SET unit_price=99999 WHERE sku='BAG-A'").run();
  const p=payload([{sku:'BAG-A',qty:2,unitPrice:10,adCost:2},{sku:'BAG-A',qty:3,unitPrice:20,adCost:5},{sku:'NO-SALES',qty:0,adCost:30}]);
  const created=await (await svc.salesImport(f.users.indonesia,p)).json();
  const r=f.sqlite.prepare("SELECT * FROM sales_records WHERE sku='BAG-A'").get();assert.equal(r.reported_amount,80);assert.equal(r.unit_price,16);assert.equal(r.ad_cost,7);assert.equal(r.currency,'IDR');
  assert.equal(f.sqlite.prepare("SELECT qty FROM inventory_balances WHERE site='印尼' AND channel='TikTok' AND sku='BAG-A'").get().qty,5);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM inventory_movements').get().n,1);assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM inventory_balances WHERE sku='NO-SALES'").get().n,0);
  const report=await readSalesDashboard(f.db,f.users.indonesia,range);assert.equal(report.totalQty,5);assert.equal(report.roiRanking.find(r=>r.sku==='NO-SALES').roas,0);assert.equal(report.currencies[0].roas,80/37);
  await assert.rejects(svc.salesImport(f.users.indonesia,p),/已经导入/);
  await svc.reverseSalesImport(f.users.admin,{importId:created.importId,reason:'重复报表核对后冲销'});
  assert.equal((await readSalesDashboard(f.db,f.users.admin,range)).totalQty,0);
  assert.equal(f.sqlite.prepare("SELECT qty FROM inventory_balances WHERE site='印尼' AND channel='TikTok' AND sku='BAG-A'").get().qty,10);
  await assert.rejects(svc.reverseSalesImport(f.users.admin,{importId:created.importId,reason:'重复报表核对后冲销'}),/已经冲销/);
 }finally{f.sqlite.close();}
});

test('成本单独导入的零销量批次并发冲销只能成功一次',async()=>{
 const f=systemFixture();try{
  const {importId}=await (await svc.salesImport(f.users.indonesia,payload([{sku:'BAG-A',qty:0,adCost:20}]))).json();
  const run=()=>svc.reverseSalesImport(f.users.admin,{importId,reason:'核对广告账单后冲销'});
  const result=await race(f,run,run);assert.equal(result.filter(r=>r.ok).length,1);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM inventory_movements').get().n,0);
 }finally{f.sqlite.close();}
});

test('服务器直接调用拒绝非法金额、日期、跨站点和不合规数量，整批没有副作用',async()=>{
 const f=systemFixture();try{
  for(const bad of [{rows:[{sku:'BAG-A',qty:1,adCost:-2}]},{rows:[{sku:'BAG-A',qty:true}]},{rows:[{sku:'BAG-A',qty:[],adCost:2}]},{rows:[{sku:'BAG-A',qty:'0x10'}]},{rows:[{sku:'BAG-A',qty:0}]},{businessDate:day.slice(0,4)+'-02-30'},{site:'马来西亚'},{currency:'BAD'}])await assert.rejects(svc.salesImport(f.users.indonesia,payload([{sku:'BAG-A',qty:2,amount:10}],bad)));
  await assert.rejects(svc.salesImport(f.users.admin,payload([{sku:'BAG-A',qty:2}])));
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM sales_imports').get().n,0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM inventory_movements').get().n,0);
 }finally{f.sqlite.close();}
});

test('全站同SKU跨站合并，金额分币种，ROAS使用加权总额而非比例平均值',async()=>{
 const f=systemFixture();try{
  insert(f,{qty:4,amount:100,adCost:10});insert(f,{qty:6,site:'马来西亚',currency:'MYR',amount:20,adCost:2});insert(f,{qty:1,site:'印尼',channel:'Shopee',amount:50,adCost:20});insert(f,{sku:'BAG-B',qty:7,amount:50,adCost:5});
  const r=await readSalesDashboard(f.db,f.users.admin,range);assert.equal(r.totalQty,18);assert.equal(r.skuCount,2);assert.equal(r.skuRanking[0].sku,'BAG-A');assert.equal(r.skuRanking[0].qty,11);assert.equal(r.skuRanking[0].siteCount,2);assert.equal(r.skuRanking[1].qty,7);
  assert.equal(r.currencies.find(c=>c.currency==='IDR').revenue,200);assert.equal(r.currencies.find(c=>c.currency==='MYR').revenue,20);
  assert.equal(r.roiRanking.find(c=>c.currency==='IDR'&&c.sku==='BAG-A').roas,5);
  assert.equal(r.roiRanking.filter(c=>c.currency==='IDR')[0].sku,'BAG-B');
 }finally{f.sqlite.close();}
});

test('历史估算额、未填成本和零投放不产生虚假ROAS；有成本无销售排名为0',async()=>{
 const f=systemFixture();try{
  insert(f,{sku:'OLD',amount:null,adCost:null,currency:null,oldAmount:99999});
  insert(f,{sku:'MISSING',amount:100,adCost:null});insert(f,{sku:'FREE',amount:200,adCost:0});insert(f,{sku:'NO-SALES',qty:0,amount:0,adCost:50});
  const r=await readSalesDashboard(f.db,f.users.admin,range);assert.equal(r.totalQty,3);assert.equal(r.currencies.find(c=>c.currency==='UNKNOWN').revenue,null);assert.equal(r.currencies.find(c=>c.currency==='IDR').roas,null);
  for(const sku of ['OLD','MISSING','FREE'])assert.equal(r.roiRanking.find(r=>r.sku===sku).roas,null);
  assert.equal(r.roiRanking[0].sku,'NO-SALES');assert.equal(r.roiRanking[0].roas,0);
 }finally{f.sqlite.close();}
});

test('报表覆盖超过1000条销售及100个SKU，冲销、日期和权限范围在查询前过滤',async()=>{
 const f=systemFixture();try{
  for(let i=0;i<1101;i++)insert(f,{sku:'SKU-'+i});insert(f,{qty:99,reversed:day});insert(f,{qty:100,date:'2020-01-01'});insert(f,{qty:8,site:'马来西亚',currency:'MYR'});
  const r=await readSalesDashboard(f.db,f.users.admin,range);assert.equal(r.totalQty,1109);assert.equal(r.skuCount,1102);
  const own=await readSalesDashboard(f.db,f.users.indonesia,range);assert.equal(own.totalQty,1101);assert.deepEqual(own.scopes.map(r=>r.site),['印尼']);
  assert.equal((await readSalesDashboard(f.db,f.users.admin,{...range,site:'马来西亚'})).totalQty,8);
  await assert.rejects(readSalesDashboard(f.db,f.users.indonesia,{...range,site:'马来西亚'}),e=>e.status===403);
  for(const role of ['销售','海运','新品开发','财务'])await assert.rejects(readSalesDashboard(f.db,{...f.users.admin,role},range),e=>e.status===403);
  for(const invalid of [{from:'2026-02-30'},{from:day,to:'2020-01-01'},{from:'2020-01-01'},{site:'日本'},{channel:'Amazon'}])assert.throws(()=>reportFilters(f.users.admin,{...range,...invalid}));
 }finally{f.sqlite.close();}
});

test('线下销售只统计实际发货和退货事件，不重复计订单或电商库存扣减',async()=>{
 const day=indonesiaDate(),range={from:day,to:day};
 const f=systemFixture();try{
  const id=await f.create({qty:5,businessDate:day});await f.approve(id);assert.equal((await readSalesDashboard(f.db,f.users.admin,range)).totalQty,0);
  await f.ship(id,3,day);const r=await readSalesDashboard(f.db,f.users.admin,range);assert.equal(r.totalQty,3);assert.equal(r.currencies[0].revenue,300000);assert.equal(r.currencies[0].roas,null);
  const item=f.sqlite.prepare('SELECT id FROM wholesale_order_items WHERE order_id=?').get(id);await f.change(f.users.supply,id,'orderReturn',{itemId:item.id,qty:1,businessDate:day,reason:'退回商品验收完成',proofRef:'RETURN-REPORT-1',receivedConfirmed:true,resellable:false});
  const returned=await readSalesDashboard(f.db,f.users.admin,range);assert.equal(returned.totalQty,2);assert.equal(returned.currencies[0].revenue,200000);
  assert.equal((await readSalesDashboard(f.db,f.users.indonesia,range)).totalQty,0);
  assert.equal((await readSalesDashboard(f.db,{...f.users.supply,role:'工厂'},range)).totalQty,0);
 }finally{f.sqlite.close();}
});
