import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import {parseImportGrid,validateImportRows,matchImportItems,groupInboundRows,readImportSheet,IMPORT_SCHEMAS} from '../lib/tabular-import.mjs';
import {translateWholesale} from '../lib/wholesale-i18n.mjs';
import {systemFixture,svc,race} from './system-fixture.mjs';

const meta={fileName:'仓库数据.xlsx',fileHash:'a'.repeat(64)};
const stock=(sku,countedQty,extra={})=>({site:'印尼',channel:'TikTok',sku,countedQty,reason:'仓库盘点核实',...extra});
const inbound=(receiptNo,sku,qty,extra={})=>({receiptNo,sku,name:sku,site:'印尼',channel:'TikTok',qty,sourceBatch:'',proofRef:'仓库签收凭证001',...extra});
const call=(f,kind,rows,actor=f.users.admin)=>svc.bulkImport(actor,{kind,rows,...meta});

test('导入解析：中文/平台表头、前导零SKU、千位分隔及Excel和CSV一致',()=>{
  const csv='\uFEFFSeller SKU,Product name,Units confirmed\r\n0012,旅行包,"1,200"\r\nBAG-A,背包,3';
  const workbook=XLSX.read(csv,{type:'string',raw:true});
  const grid=XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]],{header:1,defval:'',raw:false});
  let result=parseImportGrid('sales',grid);assert.deepEqual(result.errors,[]);assert.equal(result.rows[0].sku,'0012');assert.equal(result.rows[0].qty,1200);
  const file=XLSX.write(workbook,{bookType:'xlsx',type:'buffer'}),roundtrip=XLSX.read(file,{type:'buffer'});
  result=parseImportGrid('sales',XLSX.utils.sheet_to_json(roundtrip.Sheets[roundtrip.SheetNames[0]],{header:1,raw:false,defval:''}));
  assert.equal(result.rows[0].sku,'0012');assert.equal(result.rows[0].qty,1200);
});
test('印尼语订单、发货、退货模板的表头可以原样重新导入',()=>{
  const row={sku:'0001',qty:2,unitPrice:10000,itemId:'line-1',businessDate:'2026-09-16',proofRef:'REF-01',reason:'Retur rusak'};
  for(const kind of ['order','shipment','returns']){
    const columns=IMPORT_SCHEMAS[kind].columns,headers=columns.map(c=>translateWholesale('id',c.label));
    assert.ok(!/[\u3400-\u9fff]/.test(headers.join('')));
    const result=parseImportGrid(kind,[headers,columns.map(c=>row[c.key])]);assert.deepEqual(result.errors,[]);assert.equal(result.rows[0].qty,2);assert.equal(result.rows[0].sku,'0001');
  }
});
test('错误明细保留实际行号，不舍入或静默跳过小数、空SKU、负数',()=>{
  const result=parseImportGrid('sales',[[],['SKU','销量'],['A',2],['B','1.5'],['',3],['C',-2],['D',0],[]]);
  assert.deepEqual(result.errors.map(e=>e.row),[4,5,6,7]);assert.equal(result.rows.length,1);
  assert.throws(()=>parseImportGrid('sales',[['SKU','Quantity','销量'],['A',1,2]]),/多个匹配/);
  assert.throws(()=>parseImportGrid('inventory',[['SKU','数量'],['A',2]]),/未找到/);
  assert.throws(()=>validateImportRows('inventory',Array.from({length:201},()=>stock('A',1))),/最多导入200行/);
});
test('公式与超范围工作表必须报错，不能只导入截断后的部分数据',()=>{
  const ws=XLSX.utils.aoa_to_sheet([['SKU','数量'],['A',2]]),book={Sheets:{明细:ws},SheetNames:['明细']};
  ws.B2.f='1+1';assert.throws(()=>readImportSheet(XLSX,'sales',book,'明细'),/含公式/);delete ws.B2.f;
  ws['!fullref']='A1:B9000';assert.throws(()=>readImportSheet(XLSX,'sales',book,'明细'),/范围过大/);
  assert.throws(()=>readImportSheet(XLSX,'sales',book,'不存在'),/不存在/);
});
test('盘点允许零但拒绝空值、重复目标；明细匹配禁止跨单据和超额',()=>{
  const result=validateImportRows('inventory',[stock('A',0),stock('A',2),stock('B','')]);
  assert.equal(result.rows[0].countedQty,0);assert.equal(result.errors.length,2);
  const items=[{id:'one',sku:'A',remaining:3},{id:'two',sku:'A',remaining:4}];
  assert.throws(()=>matchImportItems([{sku:'A',qty:1,_row:2}],items),/明细编号/);
  assert.throws(()=>matchImportItems([{sku:'A',itemId:'one',qty:4,_row:2}],items),/最多/);
  assert.throws(()=>matchImportItems([{sku:'B',itemId:'one',qty:1,_row:2}],items),/不存在/);
  assert.equal(matchImportItems([{sku:'A',itemId:'one',qty:2,_row:2}],items)[0].itemId,'one');
  assert.equal(validateImportRows('receipt',[{sku:'A',qty:1,quarantineQty:2}]).errors.length,1);
});
test('到仓同单多渠道汇总；不同SKU或凭证不能共用同单号',()=>{
  const rows=[inbound('RCV1','A',3),inbound('RCV1','A',4,{channel:'Shopee'})];
  assert.equal(groupInboundRows(rows)[0].totalQty,7);
  assert.throws(()=>groupInboundRows([...rows,inbound('RCV1','B',1)]),/不同SKU/);
  assert.throws(()=>groupInboundRows([inbound('R1','A',1,{sourceBatch:'batch'}),inbound('R2','A',1,{sourceBatch:'batch'})]),/只能对应/);
});
test('管理员批量盘点写流水、零库存、新SKU及无变化行；改文件名不能重复导入',async()=>{
  const f=systemFixture();try{
    const rows=[stock('BAG-A',0),stock('NEW-ITEM',15,{name:'新库存'}),stock('BAG-B',10)];
    const result=await (await call(f,'inventory',rows)).json();assert.equal(result.imported,2);assert.equal(result.skipped,1);
    assert.equal(f.sqlite.prepare("SELECT qty FROM inventory_balances WHERE site='印尼' AND channel='TikTok' AND sku='BAG-A'").get().qty,0);
    assert.equal(f.sqlite.prepare("SELECT name,qty FROM inventory_balances WHERE sku='NEW-ITEM'").get().name,'新库存');
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM inventory_movements").get().n,2);
    await assert.rejects(svc.bulkImport(f.users.admin,{kind:'inventory',rows:[...rows].reverse(),...meta,fileName:'改名.csv',fileHash:'b'.repeat(64)}),/已经导入/);
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM inventory_movements").get().n,2);
  }finally{f.sqlite.close();}
});
test('批量盘点验证失败不产生任何改动；非管理员不能直接修正或跨站点',async()=>{
  const f=systemFixture();try{
    await assert.rejects(call(f,'inventory',[stock('BAG-A',3),stock('BAG-B',1.5)]),/第3行/);
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM inventory_movements").get().n,0);
    await assert.rejects(call(f,'inventory',[stock('BAG-A',1)],f.users.supply),/权限/);
    await assert.rejects(call(f,'inventory',[stock('BAG-A',1)],f.users.malaysia),/权限/);
    await call(f,'inventory',[stock('BAG-A',5)],f.users.indonesia);
    assert.equal(f.sqlite.prepare("SELECT qty FROM inventory_balances WHERE site='印尼' AND channel='TikTok' AND sku='BAG-A'").get().qty,10);
    assert.equal(f.sqlite.prepare('SELECT status,counted_qty FROM inventory_count_requests').get().status,'pending');
  }finally{f.sqlite.close();}
});
test('整批事务：第二行库存并发变化时第一行也回滚，文件可修正后重试',async()=>{
  const f=systemFixture();try{
    const [first,second]=await race(f,()=>call(f,'inventory',[stock('BAG-A',3),stock('BAG-B',4)]),()=>svc.inventoryAdjust(f.users.admin,stock('BAG-B',9)));
    assert.equal(first.ok,false);assert.equal(second.ok,true);
    assert.equal(f.sqlite.prepare("SELECT qty FROM inventory_balances WHERE site='印尼' AND channel='TikTok' AND sku='BAG-A'").get().qty,10);
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM system_operations WHERE action='批量文件导入'").get().n,0);
    await call(f,'inventory',[stock('BAG-A',3),stock('BAG-B',4)]);
  }finally{f.sqlite.close();}
});
test('并发重复盘点文件仅写入一次',async()=>{
  const f=systemFixture();try{
    const results=await race(f,()=>call(f,'inventory',[stock('BAG-A',2)]),()=>call(f,'inventory',[stock('BAG-A',2)]));
    assert.equal(results.filter(r=>r.ok).length,1);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM inventory_movements').get().n,1);
  }finally{f.sqlite.close();}
});
test('批量到仓：多单多渠道一次入库，重复单号使整份文件回滚',async()=>{
  const f=systemFixture();try{
    const rows=[inbound('RCV-A','BAG-A',3),inbound('RCV-A','BAG-A',4,{channel:'Shopee'}),inbound('RCV-B','BAG-B',5)];
    const result=await (await call(f,'inbound',rows)).json();assert.equal(result.imported,2);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM inbound_receipts').get().n,2);
    assert.equal(f.sqlite.prepare("SELECT qty FROM inventory_balances WHERE site='印尼' AND channel='TikTok' AND sku='BAG-A'").get().qty,13);
    await assert.rejects(call(f,'inbound',[inbound('RCV-C','BAG-A',1),inbound('RCV-A','BAG-A',2)]),/第3行.*整份文件未写入/);
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM inbound_receipts WHERE receipt_no='RCV-C'").get().n,0);
    await assert.rejects(call(f,'inbound',[inbound('RCV-D','BAG-A',1)],f.users.supply),/必须关联/);
    await assert.rejects(call(f,'inbound',[inbound('RCV-D','BAG-A',1)],f.users.indonesia),/权限/);
  }finally{f.sqlite.close();}
});
test('销售服务器拒绝小数，不会将1.5四舍五入成2件',()=>{
  assert.throws(()=>svc.normalizedSales([{sku:'BAG-A',qty:1.5}]),/非正整数/);
  assert.equal(svc.normalizedSales([{sku:'a',qty:2},{sku:'A',qty:3}])[0].qty,5);
});
