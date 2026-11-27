import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import {parseImportGrid,readImportSheet} from '../lib/tabular-import.mjs';
import {sampleImportItems} from '../lib/marketing-sample-import.mjs';
const skus=[{sku:'BAG-A'},{sku:'00123'},{sku:'BAG-B'}];
test('two imported SKU lines survive MCN application, stock review, actual dispatch and finance costs',async()=>{
 const {marketingSamplesFixture}=await import('./marketing-samples-fixture.mjs'),{marketingSampleCostSummary}=await import('../lib/marketing-samples.mjs'),f=marketingSamplesFixture();
 try{
  const parsed=parseImportGrid('marketingSample',[['SKU','寄样数量'],['BAG-A',2],['BAG-B',3]]),items=sampleImportItems(parsed.rows,skus),day=new Date(Date.now()+7*3600000).toISOString().slice(0,10);
  const {id}=await f.call(f.users.bd,'createMcn',{scopeId:'sample-scope',mcn:{name:'TEST IMPORT MCN',contactName:'TEST',contactMethod:'TEST',cooperationRef:'TEST-IMPORT',purpose:'TEST MULTI SKU'},signedOn:day,agreementRef:'TEST AGREEMENT',items,recipient:{name:'TEST',phone:'TEST',city:'TEST',address:'TEST ONLY'},fulfillment:'sample_only',requirement:'TEST ONLY SAMPLE AGREEMENT',confirmed:true});
  assert.deepEqual({...f.stock()},{qty:10,reserved_qty:0});assert.deepEqual(f.sqlite.prepare('SELECT sku,qty FROM marketing_sample_items WHERE order_id=? ORDER BY sku').all(id).map(r=>({...r})),[{sku:'BAG-A',qty:2},{sku:'BAG-B',qty:3}]);await f.approve(id);await f.assign(id);
  await f.change(f.users.supply2,id,'ship',{shippedAt:new Date().toISOString(),carrier:'TEST',trackingNo:'TEST-IMPORT',items:f.sqlite.prepare('SELECT id,qty FROM marketing_sample_items WHERE order_id=?').all(id).map(r=>({itemId:r.id,qty:r.qty})),photos:[{name:'TEST.png',base64:Buffer.from('\x89PNG\r\n\x1a\nTEST','binary').toString('base64')}]});
  await f.cost(id);await f.cost(id,'freight');const costs=await marketingSampleCostSummary(f.db);assert.equal(costs.totals.sample.confirmedCnyMinor,1250);assert.equal(costs.totals.freight.confirmedCnyMinor,300);assert.equal(costs.pending.length,0);assert.equal(f.sqlite.prepare("SELECT qty FROM inventory_balances WHERE sku='BAG-B' AND site='印尼' AND channel='TikTok'").get().qty,7);
 }finally{f.sqlite.close();}
});
test('sample template imports Chinese, English and Indonesian columns, preserves text SKU and rejects formulas',()=>{
 for(const header of [['SKU','寄样数量','商品名称'],['Seller SKU','Quantity','Product name'],['SKU Induk','Jumlah sampel','Nama produk']]){
  const ws=XLSX.utils.aoa_to_sheet([header,['BAG-A',5,'A'],['00123',2,'B']]),book=XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,ws,'TEST');
  for(const loaded of [XLSX.read(XLSX.write(book,{type:'buffer',bookType:'xlsx'}),{type:'buffer'}),XLSX.read(XLSX.utils.sheet_to_csv(ws),{type:'string',raw:true})]){const parsed=readImportSheet(XLSX,'marketingSample',loaded,loaded.SheetNames[0]);assert.deepEqual(parsed.errors,[]);assert.deepEqual(sampleImportItems(parsed.rows,skus),[{sku:'BAG-A',sampleQty:5},{sku:'00123',sampleQty:2}]);}
  ws.B2={f:'1+1',v:2,t:'n'};assert.throws(()=>readImportSheet(XLSX,'marketingSample',book,'TEST'),/公式/);
 }
});
test('sample imports reject the whole draft on invalid quantities, duplicate/unknown SKUs and over 100 items',()=>{
 for(const qty of [0,-1,1.2,10001,'','1e3','bad'])assert.throws(()=>sampleImportItems([{sku:'BAG-A',qty:5},{sku:'BAG-B',qty}],skus));
 assert.throws(()=>sampleImportItems([{sku:'BAG-A',qty:1},{sku:'bag-a',qty:2}],skus),/重复/);assert.throws(()=>sampleImportItems([{sku:'MISSING',qty:1}],skus),/商品档案/);
 const many=Array.from({length:101},(_,i)=>({sku:'SKU-'+i,qty:10000})),catalog=many.map(r=>({sku:r.sku}));assert.throws(()=>sampleImportItems(many,catalog),/100/);assert.equal(sampleImportItems(many.slice(0,100),catalog).length,100);
 assert.throws(()=>parseImportGrid('marketingSample',[['SKU'],['BAG-A']]),/寄样数量/);
});
