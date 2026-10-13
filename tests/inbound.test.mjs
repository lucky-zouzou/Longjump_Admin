import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './fixtures.mjs';
import {race} from './system-fixture.mjs';
import {previewInbound,submitInbound,readInboundDocuments} from '../lib/inbound.mjs';
import {validateImportRows,groupInboundRows,parseImportGrid} from '../lib/tabular-import.mjs';
import {resolveInventoryHoldSources} from '../lib/inventory-holds.mjs';
import {backupStream} from '../lib/full-backup.mjs';

export function setupWarehouses(f){for(const [code,site,channel] of [['ID-TK','印尼','TikTok'],['ID-SP','印尼','Shopee'],['MY-TK','马来西亚','TikTok']])f.sqlite.prepare('INSERT INTO warehouses(id,code,site,channel,name,active,created_at,updated_at) VALUES(?,?,?,?,?,1,?,?)').run(code,code,site,channel,code+'主仓','2026-01-01','2026-01-01');}
const row=(extra={})=>({receiptNo:'RCV-001',businessDate:'2026-10-01',site:'印尼',channel:'TikTok',sku:'BAG-A',qty:3,proofRef:'WAREHOUSE-PROOF-001',note:'核对历史在途货物实际签收',...extra});
const save=async(f,rows,actor=f.users.admin)=>{const p=await previewInbound(f.db,actor,{rows});return submitInbound(f.db,actor,{rows:p.rows,previewToken:p.token,confirmed:true});};
const count=(f,table)=>f.sqlite.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;
const stock=f=>f.sqlite.prepare("SELECT * FROM inventory_balances WHERE site='印尼' AND channel='TikTok' AND sku='BAG-A'").get();

test('到仓一单多SKU多渠道，预览不写入，确认累加库存并持久化回执',async()=>{const f=fixture();try{
  setupWarehouses(f);const rows=[row({qty:400}),row({channel:'Shopee',qty:440}),row({sku:'BAG-B',qty:60})];
  const p=await previewInbound(f.db,f.users.admin,{rows});assert.equal(count(f,'inbound_documents'),0);assert.equal(stock(f).qty,10);
  assert.deepEqual(p.summary,{documents:1,skuCount:2,rows:3,totalQty:900,available:900,pending:0,quarantine:0});
  assert.equal(p.lines[0].warehouseCode,'ID-TK');assert.equal(p.lines[0].after.available,410);
  const result=await submitInbound(f.db,f.users.admin,{rows:p.rows,previewToken:p.token,confirmed:true});assert.equal(result.summary.totalQty,900);
  assert.equal(count(f,'inbound_documents'),1);assert.equal(count(f,'inbound_document_lines'),3);assert.equal(count(f,'inventory_movements'),3);
  assert.equal(stock(f).qty,410);const [doc]=await readInboundDocuments(f.db,f.users.admin);assert.equal(doc.sku_count,2);assert.equal(doc.total_qty,900);assert.equal(doc.business_date,'2026-10-01');assert.equal(doc.lines[0].before.available,10);
  const scoped=await readInboundDocuments(f.db,f.users.indonesia);assert.equal(scoped[0].total_qty,460);assert.ok(scoped[0].lines.every(l=>l.channel==='TikTok'));assert.equal((await readInboundDocuments(f.db,f.users.finance)).length,0);
  await assert.rejects(save(f,rows),/已经入库/);assert.equal(count(f,'inventory_movements'),3);
}finally{f.sqlite.close();}});

test('未知SKU、目的仓不匹配、未来日期、同单头冲突和重复分配逐行拒绝',async()=>{const f=fixture();try{setupWarehouses(f);
  await assert.rejects(previewInbound(f.db,f.users.admin,{rows:[row({sku:'TYPO',_row:8}),row({sku:'BAG-B',warehouseCode:'MY-TK',_row:10})]}),e=>e.errors.length===2&&e.errors[0].row===8&&e.errors[1].row===10);
  await assert.rejects(save(f,[row({businessDate:'2099-01-01'})]),e=>e.errors[0].message.includes('晚于今天'));
  const invalid=validateImportRows('inbound',[row({proofRef:'10/12/26'}),row({qty:1.5})]);assert.equal(invalid.errors.length,2);
  assert.throws(()=>groupInboundRows([row({_row:2}),row({sku:'BAG-B',proofRef:'DIFFERENT',_row:3})]),/凭证/);
  assert.equal(validateImportRows('inbound',[row(),row()]).errors.length,1);
  assert.equal(count(f,'inbound_documents'),0);assert.equal(stock(f).qty,10);
}finally{f.sqlite.close();}});

test('预览后库存、目的仓或表单变化要求重新预览；必须明确确认实收',async()=>{const f=fixture();try{setupWarehouses(f);
  let p=await previewInbound(f.db,f.users.admin,{rows:[row()]});await assert.rejects(submitInbound(f.db,f.users.admin,{rows:p.rows,previewToken:p.token}),/请确认/);
  f.sqlite.prepare("UPDATE inventory_balances SET qty=qty+1 WHERE sku='BAG-A'").run();
  await assert.rejects(submitInbound(f.db,f.users.admin,{rows:p.rows,previewToken:p.token,confirmed:true}),/重新预览/);
  p=await previewInbound(f.db,f.users.admin,{rows:[row()]});await assert.rejects(submitInbound(f.db,f.users.admin,{rows:[{...p.rows[0],qty:9}],previewToken:p.token,confirmed:true}),/重新预览/);
  f.sqlite.prepare("UPDATE warehouses SET name='新主仓' WHERE id='ID-TK'").run();await assert.rejects(submitInbound(f.db,f.users.admin,{rows:p.rows,previewToken:p.token,confirmed:true}),/重新预览/);
  assert.equal(count(f,'inbound_documents'),0);
}finally{f.sqlite.close();}});

test('入库事务并发重复只成功一次；任一行变化整批回滚',async()=>{const f=fixture();try{setupWarehouses(f);
  const p=await previewInbound(f.db,f.users.admin,{rows:[row()]});const payload={rows:p.rows,previewToken:p.token,confirmed:true};
  const outcomes=await race(f,()=>submitInbound(f.db,f.users.admin,payload),()=>submitInbound(f.db,f.users.admin,payload));assert.equal(outcomes.filter(x=>x.ok).length,1);assert.equal(stock(f).qty,13);
  const p2=await previewInbound(f.db,f.users.admin,{rows:[row({receiptNo:'SECOND'}),row({receiptNo:'THIRD',sku:'BAG-B'})]});
  const [first]=await race(f,()=>submitInbound(f.db,f.users.admin,{rows:p2.rows,previewToken:p2.token,confirmed:true}),async()=>f.sqlite.prepare("UPDATE inventory_balances SET qty=99 WHERE sku='BAG-B'").run());
  assert.equal(first.ok,false);assert.equal(count(f,'inbound_documents'),1);assert.equal(stock(f).qty,13);assert.equal(count(f,'inventory_movements'),1);
}finally{f.sqlite.close();}});

test('同一SKU跨多张到仓单累计预览；第二单冲突不写第一单，兼容旧单号防重',async()=>{const f=fixture();try{setupWarehouses(f);
  const p=await previewInbound(f.db,f.users.admin,{rows:[row({receiptNo:'R1',qty:3}),row({receiptNo:'R2',qty:4})]});assert.equal(p.lines[1].before.available,13);assert.equal(p.lines[1].after.available,17);
  await submitInbound(f.db,f.users.admin,{rows:p.rows,previewToken:p.token,confirmed:true});assert.equal(stock(f).qty,17);
  await assert.rejects(save(f,[row({receiptNo:'R3'}),row({receiptNo:'R2'})]),/整份文件未写入/);assert.equal(count(f,'inbound_documents'),2);
  f.sqlite.prepare('INSERT INTO inbound_receipts(id,receipt_no,sku,name,source_batch,proof_ref,total_qty,actor_id,received_at) VALUES(?,?,?,?,?,?,?,?,?)').run('old','OLD-R','BAG-A','','','OLD-P',4,f.users.admin.id,'2026-09-01');
  await assert.rejects(save(f,[row({receiptNo:'OLD-R'})]),/已经入库/);assert.equal(stock(f).qty,17);
}finally{f.sqlite.close();}});

test('供应链必须关联完整到仓批次；入库至待上架，不能直接转可售',async()=>{const f=fixture();try{setupWarehouses(f);
  await assert.rejects(previewInbound(f.db,f.users.supply,{rows:[row()]}),/必须关联/);
  await assert.rejects(previewInbound(f.db,f.users.indonesia,{rows:[row()]}),/权限/);
  const allocations=JSON.stringify([{site:'印尼',channel:'TikTok',qty:3}]);
  f.sqlite.prepare('INSERT INTO production_batches(id,month,sku,name,qty,stage,stage_owner,allocations_json,evidence_json,creator_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run('BATCH','2026-10','BAG-A','BAG-A',3,'awaiting_receipt','供应链',allocations,'[]',f.users.supply.id,'2026-10-01','2026-10-01');
  const result=await save(f,[row({sourceBatch:'BATCH'})],f.users.supply);assert.equal(result.summary.pending,3);assert.equal(stock(f).qty,10);assert.equal(stock(f).pending_shelf_qty,3);assert.equal(f.sqlite.prepare("SELECT stage FROM production_batches WHERE id='BATCH'").get().stage,'shelf_pending');
  assert.equal(validateImportRows('inbound',[row({sourceBatch:'BATCH',stockState:'available'})]).errors.length,1);
  await assert.rejects(save(f,[row({receiptNo:'AGAIN',sourceBatch:'BATCH'})],f.users.supply),e=>e.errors[0].message.includes('等待到仓'));
}finally{f.sqlite.close();}});

test('跨站点旧批次按站点分单并整体导入，缺少任一站点不能提前推进',async()=>{const f=fixture();try{setupWarehouses(f);
  const allocations=JSON.stringify([{site:'印尼',channel:'TikTok',qty:3},{site:'马来西亚',channel:'TikTok',qty:4}]);
  f.sqlite.prepare('INSERT INTO production_batches(id,month,sku,name,qty,stage,stage_owner,allocations_json,evidence_json,creator_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run('CROSS','2026-10','BAG-A','BAG-A',7,'awaiting_receipt','供应链',allocations,'[]',f.users.supply.id,'2026-10-01','2026-10-01');
  const rows=[row({receiptNo:'ID-RECEIPT',sourceBatch:'CROSS'}),row({receiptNo:'MY-RECEIPT',site:'马来西亚',qty:4,sourceBatch:'CROSS',proofRef:'MY-PROOF'})];
  await assert.rejects(save(f,[rows[0]],f.users.supply),e=>e.errors[0].message.includes('跨站点'));
  assert.equal(count(f,'inbound_documents'),0);assert.equal(stock(f).pending_shelf_qty,0);
  const result=await save(f,rows,f.users.supply);assert.equal(result.summary.documents,2);assert.equal(result.summary.pending,7);assert.equal(stock(f).qty,10);assert.equal(stock(f).pending_shelf_qty,3);
  const batch=f.sqlite.prepare("SELECT * FROM production_batches WHERE id='CROSS'").get(),evidence=JSON.parse(batch.evidence_json)[0];assert.equal(batch.stage,'shelf_pending');assert.equal(evidence.reference,'ID-RECEIPT、MY-RECEIPT');assert.equal(evidence.proofRef,'WAREHOUSE-PROOF-001；MY-PROOF');
  assert.equal(f.sqlite.prepare("SELECT pending_shelf_qty FROM inventory_balances WHERE site='马来西亚' AND channel='TikTok' AND sku='BAG-A'").get().pending_shelf_qty,4);
}finally{f.sqlite.close();}});

test('隔离到仓不增加可售，验收放行或报损保留来源流水且不能重复处理',async()=>{const f=fixture();try{setupWarehouses(f);
  await save(f,[row({qty:5,stockState:'quarantine'})]);assert.equal(stock(f).qty,10);assert.equal(stock(f).quarantine_qty,5);
  const r=await resolveInventoryHoldSources(f.db,f.users.admin,{site:'印尼',channel:'TikTok',sku:'BAG-A',qty:3,resolution:'release',reason:'重新质检合格放行'});assert.equal(r.inboundReleased,3);assert.equal(stock(f).qty,13);assert.equal(stock(f).quarantine_qty,2);
  await resolveInventoryHoldSources(f.db,f.users.supply,{site:'印尼',channel:'TikTok',sku:'BAG-A',qty:2,resolution:'writeoff',reason:'核实破损无法销售'});assert.equal(stock(f).qty,13);assert.equal(stock(f).quarantine_qty,0);assert.equal(f.sqlite.prepare('SELECT quarantine_remaining FROM inbound_document_lines').get().quarantine_remaining,0);
  await assert.rejects(resolveInventoryHoldSources(f.db,f.users.admin,{site:'印尼',channel:'TikTok',sku:'BAG-A',qty:1,resolution:'release',reason:'重复尝试处理'}),/不足/);
}finally{f.sqlite.close();}});

test('Excel粘贴可沿用单头，200行整单可入库不截断，备份维护锁保护新表',async()=>{const f=fixture();try{setupWarehouses(f);
  const parsed=parseImportGrid('inbound',[['SKU','渠道','数量'],['BAG-A','TikTok',400],['BAG-A','Shopee',440]],row());assert.equal(parsed.errors.length,0);assert.equal(groupInboundRows(parsed.rows)[0].totalQty,840);
  const rows=Array.from({length:200},(_,i)=>row({sku:'CAT-'+i}));for(const r of rows)f.sqlite.prepare('INSERT INTO sku_settings(sku,name,updated_at) VALUES(?,?,?)').run(r.sku,r.sku,'2026-10-01');
  const result=await save(f,rows);assert.equal(result.summary.skuCount,200);assert.equal(count(f,'inbound_document_lines'),200);
  const stream=await backupStream(f.db,{get:async()=>null},f.users.admin,[]);assert.throws(()=>f.sqlite.prepare("UPDATE inbound_documents SET note='changed'").run(),/maintenance/);assert.throws(()=>f.sqlite.prepare('UPDATE inbound_document_lines SET quarantine_remaining=0').run(),/maintenance/);await stream.cancel();
}finally{f.sqlite.close();}});
