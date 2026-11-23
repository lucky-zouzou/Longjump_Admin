import test from 'node:test';
import assert from 'node:assert/strict';
import * as X from 'xlsx';
import {purchaseWorkbook,writeFactoryWorkbook} from '../lib/factory-document-export.mjs';
import {factoryPurchaseDocument} from '../lib/replenishment-costs.mjs';
const document={company:'TEST-ONLY',number:'PO-TEST',approvalId:'ORIGINAL-APPROVAL',orderDate:'2026-11-01',supplierName:'测试供应商',factoryName:'测试工厂',currency:'CNY',totalQty:210,totalAmount:5355,preparedBy:'原采购员',approvedBy:'原审批人',approvedAt:'2026-11-01T01:00:00Z',terms:'原采购条款保持不变',items:[{sku:'TEST-SKU',name:'测试商品',total:210,purchasePrice:25.5,lineAmount:5355,allocations:[{site:'泰国',channel:'TikTok',qty:210}],demandAllocations:[{site:'泰国',channel:'TikTok',qty:200}],demandTotal:200}]};
test('工厂导出的数量修订版显式标识新审批，保留原采购批准签字和条款',()=>{
 const revised=factoryPurchaseDocument({...document,quantityChangeId:'QTY-CHANGE-TEST',quantityApprovedBy:'数量审批人',quantityApprovedAt:'2026-11-23T02:30:00Z',quantityReason:'按30件一箱，将200件调整为210件'});
 const workbook=X.read(writeFactoryWorkbook(X,purchaseWorkbook(X,revised)),{type:'array'}),sheet=workbook.Sheets['采购订单'],rows=X.utils.sheet_to_json(sheet,{header:1});
 assert.equal(sheet.A2.v,'采购订单（数量修订版）');assert.equal(sheet.F8.v,210);assert.equal(sheet.I8.v,5355);
 const signing=rows.find(r=>r[0]==='采购签字');assert.equal(signing[3],'原采购批准签字');assert.equal(signing[4],'原审批人');assert.equal(signing[6],'原批准时间');assert.equal(signing[7],document.approvedAt);
 assert.equal(rows.find(r=>r[0]==='数量修订编号')[1],'QTY-CHANGE-TEST');assert.match(rows.find(r=>r[0]==='数量修订审批')[1],/数量审批人.*10:30:00（北京时间）/);assert.equal(rows.find(r=>r[0]==='数量修订原因')[1],revised.quantityReason);assert.equal(rows.find(r=>r[0]==='重点注意事项')[1],document.terms);
 assert.ok(rows.find(r=>r[0]==='版本说明')[1].includes('原采购条款及原审批记录保留'));
});
test('未修订采购单保持原审批标记，不添加虚构修订记录',()=>{const workbook=purchaseWorkbook(X,document),rows=X.utils.sheet_to_json(workbook.Sheets['采购订单'],{header:1});assert.equal(rows[1][0],'采购订单');assert.equal(rows.find(r=>r[0]==='采购签字')[3],'批准签字');assert.ok(!rows.some(r=>r[0]==='数量修订编号'));});
