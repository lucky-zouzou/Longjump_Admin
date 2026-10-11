import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import {systemFixture,svc,seedMonthly,race} from './system-fixture.mjs';
import {productionWorkbook,productionTracking} from '../lib/production-workflow.mjs';
import {ROLE_PERMISSIONS,navigationForRole,canReadDomain} from '../lib/permissions.mjs';
const day=new Date(Date.now()+8*3600000).toISOString().slice(0,10);
async function setup(){
 const f=systemFixture(),approvalId=seedMonthly(f);
 await svc.decideApproval(f.users.admin,{approvalId,version:1,decision:'approve',comment:'批准生产流程测试'});
 f.factory={id:'factory-1',name:'工厂甲',role:'工厂'};
 f.order=()=>f.sqlite.prepare('SELECT * FROM series_production_orders').get();
 f.item=()=>f.sqlite.prepare('SELECT * FROM series_production_order_items').get();
 await svc.confirmPurchaseOrder(f.users.supply,{purchaseOrderId:f.order().purchase_order_id,orderRef:'TEST-PO',expectedCompletionDate:day,note:'供应商确认订单'});
 f.export=actor=>svc.exportProductionOrder(actor||f.factory,{productionOrderId:f.order().id}).then(r=>r.json());
 f.accept=(exportReceiptId,actor=f.factory)=>svc.acceptProductionOrder(actor,{productionOrderId:f.order().id,promisedCompletionDate:day,evidenceRef:'FACTORY-CONFIRM',note:'核对订单无误',orderReviewed:true,exportReceiptId});
 return f;
}
const read=async actor=>{svc.setActor(actor);return (await svc.GET(new Request('http://localhost/api/system'))).json();};
test('工厂导出核对→生产进度→完工待质检→供应链放行，全程留痕且不改库存',async()=>{
 const f=await setup();try{
 const before=f.sqlite.prepare('SELECT * FROM inventory_balances').all();
 await assert.rejects(f.accept('missing'),/尚未导出/);
 const doc=await f.export();assert.equal(f.order().status,'awaiting_factory');
 const book=XLSX.read(XLSX.write(productionWorkbook(XLSX,doc.document),{type:'buffer',bookType:'xlsx'}),{type:'buffer'});
 assert.deepEqual(book.SheetNames,['订单确认','SKU生产明细']);assert.equal(book.Sheets['SKU生产明细'].C2.v,10);assert.equal(book.Sheets['SKU生产明细'].C2.t,'n');
 await f.accept(doc.exportReceiptId);assert.equal(f.order().status,'in_production');
 await svc.updateProductionProgress(f.factory,{productionOrderId:f.order().id,progressPct:55,evidenceRef:'PROGRESS-1',note:'已完成裁剪缝制'});
 await assert.rejects(svc.updateProductionProgress(f.factory,{productionOrderId:f.order().id,progressPct:20,evidenceRef:'PROGRESS-2'}),/不能倒退/);
 await svc.completeProductionOrder(f.factory,{productionOrderId:f.order().id,evidenceRef:'FINISH-1',note:'短产一件待核对',items:[{id:f.item().id,producedQty:9}]});
 assert.equal(f.order().status,'completed_with_variance');assert.equal(f.order().qc_status,'pending');
 const qc=decision=>svc.confirmProductionQc(f.users.supply,{productionOrderId:f.order().id,decision,evidenceRef:'QC-1',note:decision==='pass'?'复检质量合格':'车线问题返工'});
 await assert.rejects(svc.confirmProductionQc(f.factory,{productionOrderId:f.order().id,decision:'pass',evidenceRef:'QC',note:'不允许自检放行'}),/权限/);
 await qc('reject');assert.equal((await read(f.users.sales)).productionTracking[0].stage,'qc_rejected');
 await qc('pass');const view=await read(f.users.sales);assert.equal(view.productionTracking[0].stage,'ready_to_ship');
 assert.ok(view.productionTracking[0].events.some(e=>e.label==='登记生产完成，转待质检'));
 assert.ok(view.productionTracking[0].events.some(e=>e.label==='质检通过'));
 assert.deepEqual(f.sqlite.prepare('SELECT * FROM inventory_balances').all(),before);
 await assert.rejects(qc('pass'),/不能重复/);
 }finally{f.sqlite.close();}
});
test('导出凭证绑定本人、订单版本和工厂；过期或越权不能接单',async()=>{
 const f=await setup();try{
 const exported=await f.export();
 await assert.rejects(f.accept(exported.exportReceiptId,f.users.admin),/尚未导出/);
 await assert.rejects(f.export({...f.factory,id:'other-factory'}),/其他负责人/);
 await assert.rejects(f.export(f.users.sales),/权限/);
 f.sqlite.prepare("UPDATE series_production_order_items SET planned_qty=11").run();
 await assert.rejects(f.accept(exported.exportReceiptId),/已变化/);
 f.sqlite.prepare("UPDATE series_production_order_items SET planned_qty=10").run();
 await assert.rejects(svc.acceptProductionOrder(f.factory,{productionOrderId:f.order().id,promisedCompletionDate:day,evidenceRef:'X',exportReceiptId:exported.exportReceiptId,orderReviewed:false}),/先导出/);
 const next=await f.export();const results=await race(f,()=>f.accept(next.exportReceiptId),()=>f.accept(next.exportReceiptId));assert.equal(results.filter(r=>r.ok).length,1);
 assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action='工厂确认生产接单'").get().n,1);
 }finally{f.sqlite.close();}
});
test('所有已知岗位共享生产动态，独立工厂业务范围与敏感字段仍隔离',async()=>{
 const f=await setup();try{
 await f.export();
 f.sqlite.prepare("UPDATE series_production_orders SET evidence_json=?").run(JSON.stringify([{stage:'factory_accepted',at:new Date().toISOString(),by:'工厂甲',reference:'PRIVATE-REPORT',note:'PRIVATE-NOTE'}]));
 for(const role of Object.keys(ROLE_PERMISSIONS)){
  const actor=role==='工厂'?{...f.factory,id:'other-factory'}:role==='运营'?f.users.indonesia:{...f.users.sales,role};
  const data=await read(actor);assert.equal(data.productionTracking.length,1,role);
  assert.ok(navigationForRole(role).includes('production-tracking'));assert.equal(canReadDomain(role,'production_tracking'),true);
  const text=JSON.stringify(data.productionTracking);for(const privateValue of ['PRIVATE-REPORT','PRIVATE-NOTE','assigned_user_id','creator_id','evidence_json'])assert.equal(text.includes(privateValue),false,role+privateValue);
  if(['销售','财务','新品开发','海运','工厂'].includes(role))assert.equal(data.productionOrders.length,0,role);
 }
 }finally{f.sqlite.close();}
});
test('历史已完工单直接展示待质检；订单文本安全、超20个SKU完整导出',()=>{
 const order={id:'P',purchase_order_id:'PO',status:'completed',qc_status:'pending',series_name:'测试',total_planned_qty:25,total_produced_qty:25,created_at:'2026-10-01',updated_at:'2026-10-01',completed_at:'2026-10-01'};
 const rows=productionTracking([order],[],[]);assert.equal(rows[0].stage,'awaiting_qc');assert.ok(rows[0].events.some(e=>e.label==='历史记录：生产完成'));
 const document={id:'P',plannedQty:25,items:Array.from({length:25},(_,i)=>({sku:i===0?'0001':String(i),name:'=1+1',plannedQty:1,producedQty:0}))};
 const wb=productionWorkbook(XLSX,document);assert.equal(wb.Sheets['SKU生产明细']['!ref'],'A1:D26');assert.equal(wb.Sheets['SKU生产明细'].A2.t,'s');assert.equal(wb.Sheets['SKU生产明细'].A2.v,'0001');assert.equal(wb.Sheets['SKU生产明细'].B2.f,undefined);
});
