import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import {hasPermission,ROLE_PERMISSIONS} from '../lib/permissions.mjs';
import {replenishmentExportSheets,toReplenishmentWorkbook,replenishmentDownloadName} from '../lib/replenishment-export.mjs';
import {systemFixture,svc} from './system-fixture.mjs';

const row=(extra={})=>({site:'印尼',channel:'TikTok',sku:'000123',name:'背包',qty:80,seaInTransit:10,productionInProgress:30,suggestedReplenishment:15,suggestedProduction:50,targetQty:170,avg7:2.5,forecastDaily:2.75,stockCoverDays:null,nextSeaEta:'',confidence:'低',dataDays:3,alertLabel:'数据不足',alertReason:'有效销量不足7天',...extra});
function snapshot(rows=[row()]){return {actor:{role:'管理员'},generatedAt:'2026-10-11T01:03:44Z',suggestions:rows,skuSettings:[{sku:'000123',product_series:'通勤系列'}],metrics:{inventoryQty:rows.reduce((s,r)=>s+r.qty,0),seaTransitQty:rows.reduce((s,r)=>s+r.seaInTransit,0),productionInProgressQty:rows.reduce((s,r)=>s+r.productionInProgress,0),suggestedProductionQty:rows.reduce((s,r)=>s+r.suggestedProduction,0)}};}
const sheet=(sheets,name)=>sheets.find(s=>s.name===name);
const values=(sheets,name,header)=>{const s=sheet(sheets,name);return s.rows.map(r=>r[s.headers.indexOf(header)]);};
const summary=(sheets,key)=>sheet(sheets,'备货总览').rows.find(r=>r[0]===key)?.[1];

test('管理员和供应链可导出，其他岗位无全站导出入口且无法生成报表',()=>{
  for(const role of Object.keys(ROLE_PERMISSIONS)){
    const allowed=['管理员','供应链'].includes(role),data={...snapshot(),actor:{role}};
    assert.equal(hasPermission(role,'planning.export'),allowed);
    if(allowed)assert.equal(replenishmentExportSheets(data).length,4);
    else assert.throws(()=>replenishmentExportSheets(data),/仅管理员和供应链/);
  }
});

test('SKU、站点汇总及逐行明细与驾驶舱一致，不重复相加生产中和新增生产建议',()=>{
  const data=snapshot([row(),row({channel:'Shopee',qty:20,suggestedProduction:0}),row({site:'菲律宾',sku:'002',qty:-5,suggestedProduction:10})]);
  const before=JSON.stringify(data),sheets=replenishmentExportSheets(data,{exportedAt:'2026-10-11T01:04:00Z'});
  assert.equal(summary(sheets,'SKU种类数'),2);
  assert.equal(summary(sheets,'数据时间（北京时间）'),'2026-10-11 09:03:44');
  assert.equal(summary(sheets,'可售库存'),95);assert.equal(summary(sheets,'生产中'),90);assert.equal(summary(sheets,'建议启动生产'),60);
  for(const name of ['SKU备货汇总','站点渠道汇总','站点SKU明细']){
    for(const header of ['可售库存','海运在途','生产中','建议海运补货','建议启动生产'])assert.equal(values(sheets,name,header).reduce((a,b)=>a+b,0),summary(sheets,header),`${name}/${header}`);
  }
  assert.deepEqual(values(sheets,'SKU备货汇总','站点渠道数'),[2,1]);
  assert.equal(summary(sheets,'需新增生产的SKU数'),2);
  assert.equal(JSON.stringify(data),before);
});

test('原生XLSX可读回，数量为数值，SKU前导零和公式样文本保留为文本，未知值留空',()=>{
  const sheets=replenishmentExportSheets(snapshot([row({name:'=HYPERLINK("https://example.test")'})]));
  const book=XLSX.read(XLSX.write(toReplenishmentWorkbook(XLSX,sheets),{type:'buffer',bookType:'xlsx',compression:true}),{type:'buffer',cellNF:true});
  assert.deepEqual(book.SheetNames,['备货总览','SKU备货汇总','站点渠道汇总','站点SKU明细']);
  for(const s of sheets){const cells=XLSX.utils.sheet_to_json(book.Sheets[s.name],{header:1,defval:''});assert.deepEqual(cells,[s.headers,...s.rows]);}
  const detail=sheet(sheets,'站点SKU明细'),ws=book.Sheets[detail.name];
  const cell=h=>ws[XLSX.utils.encode_cell({r:1,c:detail.headers.indexOf(h)})];
  assert.equal(cell('SKU').t,'s');assert.equal(cell('SKU').v,'000123');
  assert.equal(cell('商品名称').f,undefined);assert.match(cell('商品名称').v,/^=HYPERLINK/);
  assert.equal(cell('建议启动生产').t,'n');assert.equal(cell('7日日均').v,2.5);assert.equal(cell('7日日均').z,'0.00;[Red]-0.00');
  assert.equal(cell('库存可售天数')?.v||'','');assert.equal(cell('预计到仓日期')?.v||'','');
  assert.ok(ws['!autofilter']);
  assert.equal(replenishmentDownloadName('2026-10-11T01:03:44Z'),'备货明细-2026-10-11-090344.xlsx');
});

test('导出不按图表或导入上限截断，零建议和负库存行完整保留，空表有表头与零汇总',()=>{
  const data=snapshot(Array.from({length:1205},(_,i)=>row({sku:'SKU-'+i,suggestedProduction:0,qty:i===0?-10:0})));
  const sheets=replenishmentExportSheets(data);
  assert.equal(sheet(sheets,'站点SKU明细').rows.length,1205);assert.equal(summary(sheets,'可售库存'),-10);assert.equal(summary(sheets,'建议启动生产'),0);
  const empty=replenishmentExportSheets(snapshot([])),book=toReplenishmentWorkbook(XLSX,empty);
  assert.equal(summary(empty,'SKU种类数'),0);assert.equal(summary(empty,'建议启动生产'),0);assert.equal(book.Sheets['站点SKU明细']['!ref'],'A1:Y1');
});

test('缺失、重复、失配的数据不得默默变零或生成无法对账的Excel',()=>{
  assert.throws(()=>replenishmentExportSheets({...snapshot(),generatedAt:undefined}),/数据时间/);
  assert.throws(()=>replenishmentExportSheets(snapshot([row(),row()])),/重复记录/);
  const mismatch=snapshot();mismatch.metrics.suggestedProductionQty++;
  assert.throws(()=>replenishmentExportSheets(mismatch),/总数与备货明细不一致/);
  const missing=snapshot();delete missing.suggestions[0].suggestedProduction;
  assert.throws(()=>replenishmentExportSheets(missing),/数据不完整/);
  const invalid=snapshot();invalid.suggestions[0].qty='bad';
  assert.throws(()=>replenishmentExportSheets(invalid),/无效数量/);
});

test('系统真实读取路径的管理员与供应链快照可直接对账导出，导出不写业务数据',async()=>{
  const f=systemFixture();
  try{
    f.stock('BAG-A',-3,20);
    for(const actor of [f.users.admin,f.users.supply]){
      svc.setActor(actor);
      const response=await svc.GET(new Request('http://localhost/api/system'));
      assert.equal(response.status,200);
      const data=await response.json(),changes=f.sqlite.prepare('SELECT total_changes() n').get().n;
      assert.ok(Date.parse(data.generatedAt));
      const sheets=replenishmentExportSheets(data);
      assert.equal(summary(sheets,'可售库存'),data.metrics.inventoryQty);
      assert.equal(summary(sheets,'建议启动生产'),data.metrics.suggestedProductionQty);
      assert.equal(f.sqlite.prepare('SELECT total_changes() n').get().n,changes);
    }
  }finally{f.sqlite.close();}
});
