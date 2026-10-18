import test from 'node:test';
import assert from 'node:assert/strict';
import {systemFixture,svc,race} from './system-fixture.mjs';
import {createCatalogSku} from '../lib/sku-catalog.mjs';
import {missingSkuCandidates,skuRegistration} from '../lib/sku-catalog-model.mjs';
import {previewInbound,submitInbound} from '../lib/inbound.mjs';
import {moduleSnapshot} from '../lib/workspace-model.mjs';
const product={sku:' h001-1-brown-l ',name:'龙耀布包 · 棕色 · 大号',productType:'老款',productSeries:'H001'};
const count=(f,table)=>f.sqlite.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;
const post=payload=>svc.POST(new Request('http://localhost/api/system',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)}));

test('管理员与供应链建档后可读取商品，建档只写主数据和审计且忽略库存及价格注入',async()=>{const f=systemFixture();try{
 const before=count(f,'inventory_balances');
 for(const [who,sku] of [[f.users.admin,'NEW-1'],[f.users.supply,'NEW-2']]){
   svc.setActor(who);const response=await post({action:'createSku',...product,sku,source:'inbound',qty:999,unit_price:123,ad_cost:888});assert.equal(response.status,200);
   const data=await response.json();assert.equal(data.sku.sku,sku);assert.equal(data.sku.product_series,'H001');assert.equal(data.sku.unit_price,0);
   const snapshot=await(await svc.GET(new Request('http://localhost/api/system?module=receipt'))).json();assert.ok(snapshot.skuSettings.some(s=>s.sku===sku));
 }
 assert.equal(count(f,'inventory_balances'),before);assert.equal(count(f,'inventory_movements'),0);assert.equal(count(f,'new_product_projects'),0);
 const log=f.sqlite.prepare("SELECT * FROM audit_logs WHERE entity_id='NEW-2'").get();assert.equal(log.actor_id,f.users.supply.id);assert.equal(JSON.parse(log.detail_json).inventoryChanged,false);
}finally{f.sqlite.close();}});

test('新增SKU拒绝越权、缺少名称、无效类型和超长编码，不能覆盖已有资料',async()=>{const f=systemFixture();try{
 for(const role of ['运营','运营主管','财务','工厂','海运','销售','新品开发']){
  svc.setActor({...f.users.admin,role});assert.equal((await post({action:'createSku',...product})).status,403);
 }
 svc.setActor(f.users.admin);
 for(const patch of [{name:''},{sku:''},{sku:'A'.repeat(121)},{name:'N'.repeat(121)},{sku:'A\nB'},{productType:'unknown'}])assert.equal((await post({action:'createSku',...product,...patch})).status,400);
 const before=f.sqlite.prepare("SELECT * FROM sku_settings WHERE sku='BAG-A'").get();
 const conflict=await post({action:'createSku',...product,sku:' bag-a '});assert.equal(conflict.status,409);assert.match((await conflict.json()).error,/未覆盖/);
 assert.deepEqual(f.sqlite.prepare("SELECT * FROM sku_settings WHERE sku='BAG-A'").get(),before);assert.equal(count(f,'audit_logs'),0);
 assert.equal(skuRegistration({...product,productSeries:''}).productSeries,'待归类');
}finally{f.sqlite.close();}});

test('并发新增同一SKU仅建档一次并保留一次审计，后提交者不可覆盖名称',async()=>{const f=systemFixture();try{
 const outcomes=await race(f,()=>createCatalogSku(f.db,f.users.admin,product),()=>createCatalogSku(f.db,f.users.supply,{...product,name:'另一名称'}));
 assert.equal(outcomes.filter(r=>r.ok).length,1);assert.equal(outcomes.find(r=>!r.ok).error.status,409);
 assert.equal(f.sqlite.prepare("SELECT name FROM sku_settings WHERE sku='H001-1-BROWN-L'").get().name,'另一名称');assert.equal(count(f,'audit_logs'),1);
}finally{f.sqlite.close();}});

test('到仓同SKU跨渠道去重，名称冲突不猜测，建档后原始行继续预览与确认入库',async()=>{const f=systemFixture();try{
 for(const channel of ['TikTok','Shopee'])f.sqlite.prepare('INSERT INTO warehouses(id,code,site,channel,name,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(channel,channel,'印尼',channel,channel+'仓','2026-01-01','2026-01-01');
 const rows=['TikTok','Shopee'].map((channel,i)=>({receiptNo:'R-NEW',businessDate:'2026-10-01',site:'印尼',channel,sku:'H001-1-BROWN-L',name:product.name,qty:i+2,proofRef:'SIGN-001',note:'历史到仓商品核对补录',_row:i+9}));
 const original=structuredClone(rows);assert.equal(missingSkuCandidates(rows,[]).length,1);assert.deepEqual(missingSkuCandidates(rows,[])[0].rows,[9,10]);
 const conflict=missingSkuCandidates([rows[0],{...rows[1],name:'另一个名称'}],[])[0];assert.equal(conflict.name,'');assert.equal(conflict.names.length,2);
 await assert.rejects(previewInbound(f.db,f.users.admin,{rows}),e=>e.errors.length===2);assert.equal(count(f,'inbound_documents'),0);
 const created=await createCatalogSku(f.db,f.users.admin,product);assert.equal(missingSkuCandidates(rows,[created.sku]).length,0);assert.deepEqual(rows,original);
 const preview=await previewInbound(f.db,f.users.admin,{rows});assert.equal(preview.summary.totalQty,5);assert.equal(preview.lines[0].before.available,0);assert.equal(count(f,'inventory_movements'),0);
 await submitInbound(f.db,f.users.admin,{rows:preview.rows,previewToken:preview.token,confirmed:true});assert.equal(count(f,'inbound_documents'),1);
 const stocks=f.sqlite.prepare("SELECT qty FROM inventory_balances WHERE sku='H001-1-BROWN-L' ORDER BY channel").all();assert.equal(stocks.reduce((n,r)=>n+r.qty,0),5);
 await assert.rejects(submitInbound(f.db,f.users.admin,{rows:preview.rows,previewToken:preview.token,confirmed:true}),/已经入库/);
 await assert.rejects(previewInbound(f.db,f.users.supply,{rows:rows.map(r=>({...r,receiptNo:'OTHER'}))}),e=>e.status===403);
}finally{f.sqlite.close();}});

test('到仓模块保留供应链关联历史批次的数据，不带入其他模块详情',()=>{
 const snapshot=moduleSnapshot({actor:{role:'供应链'},batches:[{id:'LEGACY',stage:'awaiting_receipt'}],skuSettings:[{sku:'A'}],productionOrders:[{id:'UNRELATED'}]},'receipt');
 assert.equal(snapshot.batches.length,1);assert.equal(snapshot.skuSettings.length,1);assert.deepEqual(snapshot.productionOrders,[]);
});
