import test from 'node:test';
import assert from 'node:assert/strict';
import {systemFixture,svc,seedMonthly,race} from './system-fixture.mjs';
import {preparePurchase} from './factory-document-fixture.mjs';
import {today} from '../lib/purchase-documents.mjs';
import {purchaseQuantitySource,readPurchaseQuantityChanges,mutatePurchaseQuantity} from '../lib/purchase-quantity-changes.mjs';
import {dispatchAvailability,issueDispatchNotice,changeDispatch,readFactoryDocuments} from '../lib/factory-documents.mjs';
import {uploadFactoryFile} from '../lib/factory-document-files.mjs';
import {REQUIRED_MONTHLY_SCOPES} from '../lib/rules.mjs';
async function setup(produced=210,secondSku=false){
 const f=systemFixture();seedMonthly(f);f.sqlite.prepare('DELETE FROM approval_requests').run();
 for(const scope of REQUIRED_MONTHLY_SCOPES)await svc.monthlySubmit({...f.users.indonesia,...scope},{month:'2026-09',...scope,...(scope.site==='泰国'&&scope.channel==='TikTok'?{items:[{sku:'BAG-A',qty:200,name:'测试包'},...(secondSku?[{sku:'BAG-B',qty:200,name:'另一个SKU'}]:[])]}:{zeroDemand:true,zeroReason:'本月无需备货'})});
 await preparePurchase(f);await svc.submitPlan(f.users.supply,{month:'2026-09'});const approval=f.sqlite.prepare('SELECT * FROM approval_requests').get();await svc.decideApproval(f.users.admin,{approvalId:approval.id,version:1,decision:'approve',comment:'核对采购数量与条款'});
 f.po=()=>f.sqlite.prepare('SELECT * FROM series_purchase_orders').get();f.mo=()=>f.sqlite.prepare('SELECT * FROM series_production_orders').get();f.item=()=>f.sqlite.prepare('SELECT * FROM series_production_order_items').get();f.factory={id:'factory-1',role:'工厂',name:'工厂甲'};
 const exported=await(await svc.exportProductionOrder(f.factory,{productionOrderId:f.mo().id})).json();await svc.acceptProductionOrder(f.factory,{productionOrderId:f.mo().id,promisedCompletionDate:today(),evidenceRef:'TEST-ACCEPT',orderReviewed:true,exportReceiptId:exported.exportReceiptId});await svc.completeProductionOrder(f.factory,{productionOrderId:f.mo().id,items:f.sqlite.prepare('SELECT id FROM series_production_order_items').all().map(i=>({id:i.id,producedQty:produced})),evidenceRef:'TEST-FINISH',note:'实际完工已核对'});await svc.confirmProductionQc(f.users.supply,{productionOrderId:f.mo().id,decision:'pass',evidenceRef:'TEST-QC',note:'实际完工质量合格'});
 const at=new Date().toISOString();f.sqlite.prepare('INSERT INTO warehouses(id,site,channel,code,name,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run('WH','泰国','TikTok','WH','泰国仓',at,at);f.sqlite.prepare('INSERT INTO users(id,email,name,role,created_at,updated_at) VALUES(?,?,?,?,?,?)').run('sea','sea@example.test','海运','海运',at,at);f.sqlite.prepare('INSERT INTO business_partners(id,type,code,name,assigned_user_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run('carrier','carrier','SEA','承运商','sea',at,at);
 f.source=()=>purchaseQuantitySource(f.db,f.users.supply,f.po().id);
 f.proposal=async(qty=210)=>{const s=await f.source();return {action:'quantityChangeSubmit',orderId:s.orderId,sourceKey:s.sourceKey,items:s.items.map(i=>({...i,cartonQty:30,allocations:i.allocations.map(a=>({...a,qty}))})),reason:'每箱三十件调整为整箱'};};
 f.approve=change=>mutatePurchaseQuantity(f.db,f.users.admin,{action:'quantityChangeDecide',changeId:change.id,version:1,decision:'approve',reason:'已核对工厂实际数量'});
 f.issue=(qty=210)=>issueDispatchNotice(f.db,f.users.supply,{productionOrderId:f.mo().id,noticeNo:'TEST-NOTICE',warehouseId:'WH',shippingDate:today(),receiver:'TEST-ONLY',phone:'TEST-ONLY',address:'TEST-ONLY',demandBasis:'根据实际工厂订单七箱发货',items:[{itemId:f.item().id,qty}]});return f;
}
test('原单200已完工210：修订批准后同一生产单可装箱并创建210件海运，原需求与批准快照不改',async t=>{
 const f=await setup();t.after(()=>f.sqlite.close());const original=f.po().document_json;
 assert.equal((await dispatchAvailability(f.db,f.mo().id))[0].available,200);await assert.rejects(f.issue(),/超过/);
 const change=await mutatePurchaseQuantity(f.db,f.users.supply,await f.proposal());assert.equal(f.po().total_qty,200);
 await f.approve(change);assert.equal(f.po().total_qty,210);assert.equal(f.item().planned_qty,210);assert.equal(f.item().produced_qty,210);assert.equal(f.mo().qc_status,'passed');assert.equal(f.po().document_json,original);
 assert.equal(JSON.parse(f.po().quantity_document_json).totalAmount,5355);assert.equal((await readFactoryDocuments(f.db,f.factory)).orders[0].document.totalQty,210);
 assert.equal((await(await svc.exportProductionOrder(f.factory,{productionOrderId:f.mo().id})).json()).purchaseDocument.totalQty,210);
 assert.equal(f.sqlite.prepare("SELECT total_qty FROM monthly_submissions WHERE site='泰国' AND channel='TikTok'").get().total_qty,200);
 const n=await f.issue();await changeDispatch(f.db,f.users.admin,{action:'reviewNotice',noticeId:n.id,version:1,decision:'approve',reason:'核对七箱两百一十件'});
 const proof=await uploadFactoryFile(f.db,{async put(){},async delete(){}},f.factory,{noticeId:n.id,file:new File(['%PDF-1.7\nTEST-ONLY'],'signed.pdf',{type:'application/pdf'})});
 await changeDispatch(f.db,f.factory,{action:'submitPacking',noticeId:n.id,version:2,number:'TEST-PACK',shippedDate:today(),shipper:'测试发货',inspector:'测试质检',trackingNo:'TEST',shippedConfirmed:true,proofIds:[proof.id],rows:[{itemId:f.item().id,pcsPerCarton:30,cartons:7,cartonStart:1,length:58,width:39,height:38}]});
 await changeDispatch(f.db,f.users.supply,{action:'reviewPacking',noticeId:n.id,version:3,decision:'confirm',reason:'七箱数量准确一致'});
 svc.setActor(f.users.supply);const r=await svc.POST(new Request('http://localhost/api/system',{method:'POST',body:JSON.stringify({action:'createTransportBatch',noticeId:n.id,noticeVersion:4,batchNo:'TEST-SEA-210',carrierName:'承运商'})}));assert.equal(r.status,200,JSON.stringify(await r.clone().json()));assert.equal(f.sqlite.prepare('SELECT total_shipped_qty FROM transport_batches').get().total_shipped_qty,210);assert.equal((await dispatchAvailability(f.db,f.mo().id))[0].available,0);
 await assert.rejects(f.approve(change),/已处理/);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM series_production_orders').get().n,1);
});
test('补产变更不凭空增加完工数量或质检，工厂完工不能倒退',async t=>{
 const f=await setup(200);t.after(()=>f.sqlite.close());const c=await mutatePurchaseQuantity(f.db,f.users.supply,await f.proposal());await f.approve(c);assert.equal(f.mo().status,'in_production');assert.equal(f.mo().qc_status,'pending');assert.equal(f.item().produced_qty,200);await assert.rejects(f.issue(),/质检/);
 await assert.rejects(svc.completeProductionOrder(f.factory,{productionOrderId:f.mo().id,items:[{id:f.item().id,producedQty:190}],evidenceRef:'BAD',note:'不能减少完工'}),/不合法/);
 await svc.completeProductionOrder(f.factory,{productionOrderId:f.mo().id,items:[{id:f.item().id,producedQty:210}],evidenceRef:'MORE',note:'补产十件已完工'});await svc.confirmProductionQc(f.users.supply,{productionOrderId:f.mo().id,decision:'pass',evidenceRef:'QC-MORE',note:'新增数量质检完成'});assert.equal((await dispatchAvailability(f.db,f.mo().id))[0].available,210);
});
test('数量修改权限、重复目的地、超范围、减少完工事实与草稿重复受控',async t=>{
 const f=await setup();t.after(()=>f.sqlite.close());const p=await f.proposal();
 for(const actor of [f.users.admin,f.users.indonesia,f.factory])await assert.rejects(mutatePurchaseQuantity(f.db,actor,p),e=>e.status===403);
 await assert.rejects(purchaseQuantitySource(f.db,{...f.users.supply,id:'other'},f.po().id),e=>e.status===403);
 await assert.rejects(readPurchaseQuantityChanges(f.db,f.factory),e=>e.status===403);
 for(const qty of [200,209,-1,1.2,'',null,1e10]){const bad=structuredClone(p);bad.items[0].allocations[0].qty=qty;await assert.rejects(mutatePurchaseQuantity(f.db,f.users.supply,bad));}
 const bad=structuredClone(p);bad.items[0].allocations.push(bad.items[0].allocations[0]);await assert.rejects(mutatePurchaseQuantity(f.db,f.users.supply,bad));
 const c=await mutatePurchaseQuantity(f.db,f.users.supply,p);await assert.rejects(mutatePurchaseQuantity(f.db,f.users.supply,p));await assert.rejects(mutatePurchaseQuantity(f.db,f.users.supply,{action:'quantityChangeDecide',changeId:c.id,version:1,decision:'approve',reason:'不允许自己审批'}),e=>e.status===403);
 await mutatePurchaseQuantity(f.db,f.users.supply,{action:'quantityChangeWithdraw',changeId:c.id,version:1,reason:'重新核对工厂数量'});assert.equal(f.po().total_qty,200);assert.equal((await readPurchaseQuantityChanges(f.db,f.users.supply)).changes[0].status,'withdrawn');
});
test('审核期间出现新的发货占用时原子回退，不覆盖并发执行事实',async t=>{
 const f=await setup();t.after(()=>f.sqlite.close());const c=await mutatePurchaseQuantity(f.db,f.users.supply,await f.proposal());
 const [a,b]=await race(f,()=>f.approve(c),()=>f.issue(200));assert.equal(b.ok,true);assert.equal(a.ok,false);assert.equal(a.error.status,409);assert.equal(f.po().total_qty,200);assert.equal(f.item().planned_qty,200);assert.equal(f.sqlite.prepare('SELECT status FROM purchase_quantity_changes').get().status,'pending');
});
test('数量审核重复并发只能生效一次，保留一次审计',async t=>{
 const f=await setup();t.after(()=>f.sqlite.close());const c=await mutatePurchaseQuantity(f.db,f.users.supply,await f.proposal());const [a,b]=await race(f,()=>f.approve(c),()=>f.approve(c));assert.equal(b.ok,true);assert.equal(a.ok,false);assert.equal(f.po().total_qty,210);assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action='批准工厂下单数量调整'").get().n,1);
});

async function prepareOriginalPacking(f,{confirmed=false}={}){
 const n=await f.issue(200);await changeDispatch(f.db,f.users.admin,{action:'reviewNotice',noticeId:n.id,version:1,decision:'approve',reason:'核对原货两百件'});
 const proof=await uploadFactoryFile(f.db,{async put(){},async delete(){}},f.factory,{noticeId:n.id,file:new File(['%PDF-1.7\nTEST-ONLY'],'original-signed.pdf',{type:'application/pdf'})});
 const payload={action:'submitPacking',noticeId:n.id,version:2,number:'ORIGINAL-PACK',shippedDate:today(),shipper:'测试发货',inspector:'测试质检',trackingNo:'ORIGINAL-TRACK',shippedConfirmed:true,proofIds:[proof.id],rows:[{itemId:f.item().id,pcsPerCarton:20,cartons:10,cartonStart:1,length:58,width:39,height:38}]};
 await changeDispatch(f.db,f.factory,payload);
 if(confirmed)await changeDispatch(f.db,f.users.supply,{action:'reviewPacking',noticeId:n.id,version:3,decision:'confirm',reason:'原货已发两百件核对完成'});
 return {id:n.id,payload};
}
test('已装箱原货待复核或转海运时，补产不能重置整单质检卡住原货；其他SKU补产也保护',async t=>{
 for(const confirmed of [false,true]){
  const f=await setup(200,true);try{
   const n=await prepareOriginalPacking(f,{confirmed});
   const p=await f.proposal();
   // BAG-A has already shipped; only BAG-B asks for extra production.
   p.items=p.items.map(i=>i.sku==='BAG-A'?{...i,allocations:i.allocations.map(a=>({...a,qty:200}))}:i);
   await assert.rejects(mutatePurchaseQuantity(f.db,f.users.supply,p),e=>e.status===409&&/先复核原货并创建海运批次/.test(e.message));
   assert.equal(f.mo().qc_status,'passed');assert.equal(f.mo().status,'completed');assert.equal(f.po().total_qty,400);
   assert.equal(f.sqlite.prepare('SELECT status FROM factory_dispatch_notices WHERE id=?').get(n.id).status,confirmed?'confirmed':'packing_submitted');
   assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM purchase_quantity_changes').get().n,0);
  }finally{f.sqlite.close();}
 }
});
test('原200件转海运后可以追加补产，已完工210的数量纠正不重开生产且不拦装箱记录',async t=>{
 const f=await setup(200);try{
  const n=await prepareOriginalPacking(f,{confirmed:true});
  svc.setActor(f.users.supply);const response=await svc.POST(new Request('http://localhost/api/system',{method:'POST',body:JSON.stringify({action:'createTransportBatch',noticeId:n.id,noticeVersion:4,batchNo:'ORIGINAL-SEA',carrierName:'承运商'})}));
  assert.equal(response.status,200,JSON.stringify(await response.clone().json()));
  const c=await mutatePurchaseQuantity(f.db,f.users.supply,await f.proposal());await f.approve(c);
  assert.equal(f.mo().status,'in_production');assert.equal(f.mo().qc_status,'pending');
  assert.equal(f.sqlite.prepare('SELECT total_shipped_qty FROM transport_batches').get().total_shipped_qty,200);
  assert.equal(f.sqlite.prepare('SELECT status FROM factory_dispatch_notices WHERE id=?').get(n.id).status,'linked');
 }finally{f.sqlite.close();}
 const existing=await setup(210);try{
  const n=await prepareOriginalPacking(existing,{confirmed:true});
  const c=await mutatePurchaseQuantity(existing.db,existing.users.supply,await existing.proposal());await existing.approve(c);
  assert.equal(existing.po().total_qty,210);assert.equal(existing.mo().qc_status,'passed');
  assert.equal(existing.sqlite.prepare('SELECT status FROM factory_dispatch_notices WHERE id=?').get(n.id).status,'confirmed');
 }finally{existing.sqlite.close();}
});
test('补产申请与工厂上传原货装箱并发，申请原子回退；审批前原货装箱变化也不覆盖',async t=>{
 const f=await setup(200);try{
  const n=await f.issue(200);await changeDispatch(f.db,f.users.admin,{action:'reviewNotice',noticeId:n.id,version:1,decision:'approve',reason:'原货先发两百件'});
  const proof=await uploadFactoryFile(f.db,{async put(){},async delete(){}},f.factory,{noticeId:n.id,file:new File(['%PDF-1.7\nTEST-ONLY'],'signed.pdf',{type:'application/pdf'})});
  const proposal=await f.proposal(),packing={action:'submitPacking',noticeId:n.id,version:2,number:'RACE-PACK',shippedDate:today(),shipper:'测试发货',inspector:'测试质检',trackingNo:'TEST',shippedConfirmed:true,proofIds:[proof.id],rows:[{itemId:f.item().id,pcsPerCarton:20,cartons:10,cartonStart:1,length:58,width:39,height:38}]};
  const [a,b]=await race(f,()=>mutatePurchaseQuantity(f.db,f.users.supply,proposal),()=>changeDispatch(f.db,f.factory,packing));
  assert.equal(b.ok,true);assert.equal(a.ok,false);assert.equal(a.error.status,409);assert.equal(f.mo().qc_status,'passed');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM purchase_quantity_changes').get().n,0);
 }finally{f.sqlite.close();}
 const f2=await setup(200);try{
  const proposal=await f2.proposal(),c=await mutatePurchaseQuantity(f2.db,f2.users.supply,proposal);
  await prepareOriginalPacking(f2,{confirmed:true});
  await assert.rejects(f2.approve(c),e=>e.status===409);
  assert.equal(f2.mo().qc_status,'passed');assert.equal(f2.po().total_qty,200);assert.equal(f2.sqlite.prepare('SELECT status FROM purchase_quantity_changes').get().status,'pending');
 }finally{f2.sqlite.close();}
});

test('已发货装箱被退回补正仍保护原货质检，复核转海运后才允许追加补产',async()=>{
 const f=await setup(200);try{
  const n=await prepareOriginalPacking(f);
  await changeDispatch(f.db,f.users.supply,{action:'reviewPacking',noticeId:n.id,version:3,decision:'return',reason:'签字图片不清晰，请补正'});
  const returned=f.sqlite.prepare('SELECT * FROM factory_dispatch_notices WHERE id=?').get(n.id);
  assert.equal(returned.status,'issued');assert.ok(JSON.parse(returned.packing_json).submittedAt);
  await assert.rejects(mutatePurchaseQuantity(f.db,f.users.supply,await f.proposal()),e=>e.status===409&&/先复核原货并创建海运批次/.test(e.message));
  assert.equal(f.mo().qc_status,'passed');assert.equal(f.mo().status,'completed');assert.equal(f.po().total_qty,200);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM purchase_quantity_changes').get().n,0);
  await changeDispatch(f.db,f.factory,{...n.payload,version:4});
  await changeDispatch(f.db,f.users.supply,{action:'reviewPacking',noticeId:n.id,version:5,decision:'confirm',reason:'原两百件签字资料已核对'});
  svc.setActor(f.users.supply);const response=await svc.POST(new Request('http://localhost/api/system',{method:'POST',body:JSON.stringify({action:'createTransportBatch',noticeId:n.id,noticeVersion:6,batchNo:'RETURNED-ORIGINAL-SEA',carrierName:'承运商'})}));
  assert.equal(response.status,200,JSON.stringify(await response.clone().json()));
  assert.equal(f.sqlite.prepare('SELECT total_shipped_qty FROM transport_batches').get().total_shipped_qty,200);
  const change=await mutatePurchaseQuantity(f.db,f.users.supply,await f.proposal());await f.approve(change);
  assert.equal(f.mo().status,'in_production');assert.equal(f.mo().qc_status,'pending');
 }finally{f.sqlite.close();}
});
