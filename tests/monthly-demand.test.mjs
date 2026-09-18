import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import {parseImportGrid,readImportSheet,IMPORT_SCHEMAS,validateImportRows} from '../lib/tabular-import.mjs';
import {initialMonthlyDemand,applyMonthlyImport,monthlyDemandItems} from '../lib/monthly-demand.mjs';
import {systemFixture,svc,seedMonthly} from './system-fixture.mjs';

const actor={id:'ops',site:'印尼',channel:'TikTok'},month='2026-09';
const known=[{sku:'BAG-A',name:'主数据商品A'},{sku:'BAG-B',name:'商品B'},{sku:'0012',name:'前导零商品'}];
const existing=[{sku:'BAG-A',name:'商品A',qty:'10',reason:'旧建议'},{sku:'BAG-B',name:'商品B',qty:'20',reason:'旧建议'}];

test('月度备货模板和Excel/CSV解析保留前导零，支持中文数量表头及可选原因',()=>{
  const result=parseImportGrid('monthlyPlan',[['SKU','计划数量','备注'],['bag-a','1,200','活动备货'],['0012',5,'']]);
  assert.deepEqual(result.errors,[]);assert.equal(result.rows[0].qty,1200);assert.equal(result.rows[1].sku,'0012');
  const columns=IMPORT_SCHEMAS.monthlyPlan.columns;
  const sheet=XLSX.utils.aoa_to_sheet([columns.map(c=>c.label),['0012','商品名称',12,'促销备货']]);
  const book=XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,sheet,'计划');
  for(const bookType of ['xlsx','xls','csv']){
    const bytes=XLSX.write(book,{bookType,type:'buffer'}),roundtrip=XLSX.read(bytes,{type:'buffer',raw:true});
    const parsed=readImportSheet(XLSX,'monthlyPlan',roundtrip,roundtrip.SheetNames[0]);
    assert.deepEqual(parsed.errors,[]);assert.equal(parsed.rows[0].sku,'0012');assert.equal(parsed.rows[0].qty,12);
  }
});

test('月度备货拒绝重复SKU、未知SKU、非法数量和超限，整批不改动原清单',()=>{
  const source=structuredClone(existing);
  for(const qty of [0,-1,1.5,'','1e3',NaN,1_000_000_001])assert.throws(()=>applyMonthlyImport([{sku:'BAG-A',qty}],existing,known),/第2行/);
  assert.throws(()=>applyMonthlyImport([{sku:'BAG-A',qty:3},{sku:'bag-a',qty:2}],existing,known),/重复/);
  assert.throws(()=>applyMonthlyImport([{sku:'BAG-A',qty:3},{sku:'UNKNOWN',qty:2,_row:8}],existing,known),/第8行.*不存在/);
  assert.throws(()=>applyMonthlyImport([{sku:'BAG-A',qty:3,reason:'字'.repeat(241)}],existing,known),/超过240/);
  assert.throws(()=>validateImportRows('monthlyPlan',Array.from({length:1001},(_,i)=>({sku:`SKU-${i}`,qty:1}))),/最多导入1000/);
  assert.deepEqual(existing,source);
});

test('替换只保留文件SKU；合并同SKU覆盖不累加，重复导入不扩大数量',()=>{
  const rows=[{sku:'BAG-A',name:'错误商品名',qty:3},{sku:'0012',qty:7,reason:'指定原因'}];
  const replace=applyMonthlyImport(rows,existing,known,'replace');
  assert.deepEqual(replace.map(row=>row.sku),['BAG-A','0012']);assert.equal(replace[0].name,'主数据商品A');assert.equal(replace[0].reason,'运营批量导入');
  const merged=applyMonthlyImport(rows,existing,known,'merge');
  assert.deepEqual(merged.map(row=>row.qty),['3','20','7']);
  assert.deepEqual(applyMonthlyImport(rows,merged,known,'merge'),merged);
  assert.equal(existing[0].qty,'10');
});

test('已提交的清单优先于系统建议，删除的SKU不会在重新打开时恢复',()=>{
  const suggestions=existing.map(row=>({...row,...actor,suggestedProduction:100}));
  const submissions=[{month,site:'马来西亚',channel:'TikTok',items:existing},{month,...actor,items:[{...existing[0],qty:3}]}];
  const initial=initialMonthlyDemand({actor,month,submissions,suggestions});
  assert.equal(initial.saved,true);assert.equal(initial.drafts.length,1);assert.equal(initial.drafts[0].qty,'3');
  const zero=initialMonthlyDemand({actor,month,submissions:[{month,...actor,items:[],zero_demand:1,zero_reason:'本月无需备货'}],suggestions});
  assert.equal(zero.zeroDemand,true);assert.deepEqual(zero.drafts,[]);
  const fresh=initialMonthlyDemand({actor,month:'2026-10',submissions,suggestions:[...suggestions,{sku:'OTHER',site:'马来西亚',channel:'TikTok',suggestedProduction:50}]});
  assert.equal(fresh.saved,false);assert.equal(fresh.drafts.length,2);
});

test('导入后删掉一款再提交：数据库、重载清单、快照均移除该SKU需求，库存和主数据保留',async()=>{
  const f=systemFixture();try{
    f.sqlite.prepare('INSERT INTO sku_settings(sku,name,updated_at) VALUES(?,?,?)').run('MANUAL','无历史手动款','2026-09-01');
    const knownSkus=[...known,{sku:'MANUAL',name:'无历史手动款'}];
    let drafts=applyMonthlyImport([{sku:'BAG-A',qty:12},{sku:'MANUAL',qty:9}],[],knownSkus);
    const payload={month,site:'印尼',channel:'TikTok'};
    await svc.monthlySubmit(f.users.indonesia,{...payload,items:monthlyDemandItems(drafts)});
    assert.equal(f.sqlite.prepare("SELECT operator_qty FROM forecast_snapshots WHERE sku='MANUAL'").get().operator_qty,9);
    drafts=drafts.filter(row=>row.sku!=='MANUAL');
    await svc.monthlySubmit(f.users.indonesia,{...payload,items:monthlyDemandItems(drafts)});
    const saved=f.sqlite.prepare('SELECT * FROM monthly_submissions').get();
    assert.equal(saved.total_qty,12);assert.deepEqual(JSON.parse(saved.items_json).map(row=>row.sku),['BAG-A']);
    assert.equal(f.sqlite.prepare("SELECT operator_qty FROM forecast_snapshots WHERE sku='MANUAL'").get().operator_qty,0);
    const restored=initialMonthlyDemand({actor:f.users.indonesia,month,submissions:[{...saved,items:JSON.parse(saved.items_json)}],suggestions:[{sku:'MANUAL',site:'印尼',channel:'TikTok',suggestedProduction:9}]});
    assert.deepEqual(restored.drafts.map(row=>row.sku),['BAG-A']);
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM sku_settings WHERE sku='MANUAL'").get().n,1);
    assert.equal(f.sqlite.prepare("SELECT qty FROM inventory_balances WHERE sku='BAG-A' AND site='印尼' AND channel='TikTok'").get().qty,10);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM inventory_movements').get().n,0);
    await assert.rejects(svc.monthlySubmit(f.users.indonesia,{...payload,items:[]}),/明细/);
    await svc.monthlySubmit(f.users.indonesia,{...payload,zeroDemand:true,zeroReason:'本月无需备货',items:[]});
    assert.equal(f.sqlite.prepare('SELECT total_qty FROM monthly_submissions').get().total_qty,0);
    assert.equal(f.sqlite.prepare("SELECT operator_qty FROM forecast_snapshots WHERE sku='BAG-A' AND site='印尼' AND channel='TikTok'").get().operator_qty,0);
  }finally{f.sqlite.close();}
});

test('服务端拒绝小数、空行等绕过校验的请求；不能跨站点或覆盖已进入审批的计划',async()=>{
  const f=systemFixture();try{
    const payload={month,site:'印尼',channel:'TikTok',items:[{sku:'BAG-A',qty:3}]};
    for(const qty of [1.5,0,-1,true,{},null,1_000_000_001])await assert.rejects(svc.monthlySubmit(f.users.indonesia,{...payload,items:[{sku:'BAG-A',qty}]}),/数量|格式/);
    await assert.rejects(svc.monthlySubmit(f.users.indonesia,{...payload,items:[null]}),/格式/);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM monthly_submissions').get().n,0);
    await assert.rejects(svc.monthlySubmit(f.users.malaysia,payload),/权限/);
    await assert.rejects(svc.monthlySubmit(f.users.finance,payload),/权限/);
    await svc.monthlySubmit(f.users.indonesia,payload);
    seedMonthly(f);
    await assert.rejects(svc.monthlySubmit(f.users.indonesia,{...payload,items:[{sku:'BAG-B',qty:8}]}),/审批/);
    assert.equal(f.sqlite.prepare('SELECT total_qty FROM monthly_submissions').get().total_qty,3);
    assert.equal(f.sqlite.prepare("SELECT operator_qty FROM forecast_snapshots WHERE sku='BAG-A' AND site='印尼' AND channel='TikTok'").get().operator_qty,3);
  }finally{f.sqlite.close();}
});
