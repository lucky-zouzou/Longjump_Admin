import test from 'node:test';
import assert from 'node:assert/strict';
import * as X from 'xlsx';
import {systemFixture,svc,seedMonthly,race} from './system-fixture.mjs';
import {preparePurchase} from './factory-document-fixture.mjs';
import {purchasePreparation,savePurchaseDraft,normalizePurchaseDocuments,today} from '../lib/purchase-documents.mjs';
import {dispatchAvailability,issueDispatchNotice,changeDispatch} from '../lib/factory-documents.mjs';
import {uploadFactoryFile} from '../lib/factory-document-files.mjs';
import {purchaseWorkbook} from '../lib/factory-document-export.mjs';
import {REQUIRED_MONTHLY_SCOPES} from '../lib/rules.mjs';

async function setup(){
 const f=systemFixture();seedMonthly(f);f.sqlite.prepare('DELETE FROM approval_requests').run();
 for(const scope of REQUIRED_MONTHLY_SCOPES)await svc.monthlySubmit({...f.users.indonesia,...scope},{month:'2026-09',...scope,...(scope.site==='泰国'&&scope.channel==='TikTok'?{items:[{sku:'BAG-A',qty:200,name:'测试包'}]}:{zeroDemand:true,zeroReason:'本月无需备货'})});
 await preparePurchase(f);return f;
}
const altered=source=>source.draft.documents.map(d=>({...d,items:d.items.map(i=>({...i,allocations:i.allocations.map(a=>({...a,qty:210})),cartonQty:30,quantityReason:'按装箱要求调整为七箱',demandTotal:999,demandAllocations:[{site:'泰国',channel:'TikTok',qty:999}]}))}));

test('供应链实际下单210保留运营原始200，金额、分配、工厂与海运全链路采用210',async t=>{
 const f=await setup();t.after(()=>f.sqlite.close());let prep=await purchasePreparation(f.db,'2026-09');
 await savePurchaseDraft(f.db,f.users.supply,{month:prep.month,sourceKey:prep.sourceKey,version:prep.draft.version,documents:altered(prep)});
 await svc.submitPlan(f.users.supply,{month:'2026-09'});
 const approval=f.sqlite.prepare('SELECT * FROM approval_requests').get(),plan=JSON.parse(approval.payload_json);
 assert.equal(plan.demandItems[0].total,200);assert.equal(plan.items[0].total,210);assert.equal(plan.items[0].demandTotal,200);assert.equal(plan.items[0].demandAllocations[0].qty,200);
 assert.equal(plan.purchaseDocuments[0].totalAmount,5355);assert.equal(plan.purchaseDocuments[0].totalQty,210);
 assert.equal(f.sqlite.prepare("SELECT total_qty FROM monthly_submissions WHERE site='泰国' AND channel='TikTok'").get().total_qty,200);
 await svc.decideApproval(f.users.admin,{approvalId:approval.id,version:1,decision:'approve',comment:'装箱数量与采购价核对通过'});
 const po=f.sqlite.prepare('SELECT * FROM series_purchase_orders').get(),order=f.sqlite.prepare('SELECT * FROM series_production_orders').get(),item=f.sqlite.prepare('SELECT * FROM series_production_order_items').get();
 assert.equal(po.total_qty,210);assert.equal(item.planned_qty,210);assert.equal(order.total_planned_qty,210);
 const workbook=purchaseWorkbook(X,JSON.parse(po.document_json));assert.equal(workbook.Sheets['站点需求分配'].F2.v,210);assert.equal(workbook.Sheets['站点需求分配'].G2.v,200);assert.equal(workbook.Sheets['采购订单'].F8.v,210);
 const factory={id:'factory-1',role:'工厂',name:'工厂甲'},exported=await(await svc.exportProductionOrder(factory,{productionOrderId:order.id})).json();
 await svc.acceptProductionOrder(factory,{productionOrderId:order.id,promisedCompletionDate:today(),evidenceRef:'TEST-CONFIRM',note:'已核对调整后订单',orderReviewed:true,exportReceiptId:exported.exportReceiptId});
 await svc.completeProductionOrder(factory,{productionOrderId:order.id,items:[{id:item.id,producedQty:210}],evidenceRef:'TEST-FINISH',note:'完成七箱共210件'});
 await svc.confirmProductionQc(f.users.supply,{productionOrderId:order.id,decision:'pass',evidenceRef:'TEST-QC',note:'已核对全部合格'});
 assert.equal((await dispatchAvailability(f.db,order.id))[0].available,210);
 const stamp=new Date().toISOString();
 f.sqlite.prepare('INSERT INTO warehouses(id,site,channel,code,name,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run('WH-TH','泰国','TikTok','WH-TH','泰国仓',stamp,stamp);
 f.sqlite.prepare('INSERT INTO users(id,email,name,role,created_at,updated_at) VALUES(?,?,?,?,?,?)').run('sea','sea@example.test','海运','海运',stamp,stamp);
 f.sqlite.prepare('INSERT INTO business_partners(id,type,code,name,assigned_user_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run('carrier','carrier','SEA','承运商','sea',stamp,stamp);
 const notice=await issueDispatchNotice(f.db,f.users.supply,{productionOrderId:order.id,noticeNo:'TEST-210',warehouseId:'WH-TH',shippingDate:today(),receiver:'测试收件人',phone:'TEST-ONLY',address:'TEST-ONLY',demandBasis:'按批准的七箱实际订单发货',items:[{itemId:item.id,qty:210}]});
 await changeDispatch(f.db,f.users.admin,{action:'reviewNotice',noticeId:notice.id,version:1,decision:'approve',reason:'七箱数量核对通过'});
 const proof=await uploadFactoryFile(f.db,{async put(){},async delete(){}},factory,{noticeId:notice.id,file:new File(['%PDF-1.7\nTEST-ONLY'],'signed.pdf',{type:'application/pdf'})});
 await changeDispatch(f.db,factory,{noticeId:notice.id,version:2,action:'submitPacking',number:'TEST-PACK-210',shippedDate:today(),shipper:'测试发货员',inspector:'测试质检',trackingNo:'TEST-TRACK',shippedConfirmed:true,proofIds:[proof.id],rows:[{itemId:item.id,pcsPerCarton:30,cartons:7,cartonStart:1,length:58,width:39,height:38}]});
 await changeDispatch(f.db,f.users.supply,{action:'reviewPacking',noticeId:notice.id,version:3,decision:'confirm',reason:'已核对七箱实发210件'});
 svc.setActor(f.users.supply);const response=await svc.POST(new Request('http://localhost/api/system',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'createTransportBatch',noticeId:notice.id,noticeVersion:4,batchNo:'TEST-SEA-210',carrierName:'承运商'})}));
 assert.equal(response.status,200,JSON.stringify(await response.clone().json()));assert.equal(f.sqlite.prepare('SELECT total_shipped_qty FROM transport_batches').get().total_shipped_qty,210);
 assert.equal((await dispatchAvailability(f.db,order.id))[0].available,0);
});

test('调整数量需说明，拒绝小数、负数、重复目的地、虚构目的地和无效箱规',async t=>{
 const f=await setup();t.after(()=>f.sqlite.close());const s=await purchasePreparation(f.db,'2026-09');
 for(const patch of [{quantityReason:''},{allocations:[{site:'泰国',channel:'TikTok',qty:200.5}]},{allocations:[{site:'泰国',channel:'TikTok',qty:-1}]},{allocations:[{site:'泰国',channel:'TikTok',qty:0}]},{allocations:[{site:'菲律宾',channel:'TikTok',qty:210}]},{allocations:[{site:'泰国',channel:'TikTok',qty:210},{site:'泰国',channel:'TikTok',qty:210}]},{cartonQty:0},{cartonQty:1.2}]){
  const docs=altered(s);Object.assign(docs[0].items[0],patch);assert.throws(()=>normalizePurchaseDocuments(s.groups,docs,{month:s.month}),e=>e.status===400);
 }
 await assert.rejects(savePurchaseDraft(f.db,f.users.indonesia,{month:s.month,sourceKey:s.sourceKey,version:s.draft.version,documents:altered(s)}),e=>e.status===403);
});

test('保存数量草稿遇到并发运营改报必须回退，已保存数据不覆盖新需求',async t=>{
 const f=await setup();t.after(()=>f.sqlite.close());const s=await purchasePreparation(f.db,'2026-09');
 const [first,second]=await race(f,()=>savePurchaseDraft(f.db,f.users.supply,{month:s.month,sourceKey:s.sourceKey,version:s.draft.version,documents:altered(s)}),()=>svc.monthlySubmit({...f.users.indonesia,site:'泰国',channel:'TikTok'},{month:'2026-09',site:'泰国',channel:'TikTok',items:[{sku:'BAG-A',qty:220,name:'测试包'}]}));
 assert.equal(second.ok,true);assert.equal(first.ok,false);assert.equal(first.error.status,409);assert.equal(JSON.parse(f.sqlite.prepare('SELECT documents_json FROM purchase_plan_drafts').get().documents_json)[0].items[0].total,200);
});

test('商品箱规自动带出，本单改箱规不回写主资料；主资料并发变化阻止旧草稿覆盖',async t=>{
 const f=await setup();t.after(()=>f.sqlite.close());const original=JSON.stringify({cartonQty:20,material:'测试材质'});
 f.sqlite.prepare('INSERT INTO product_profiles(sku,version,data_json,source_json,actor_id,actor_name,updated_at) VALUES(?,?,?,?,?,?,?)').run('BAG-A',1,original,'{}',f.users.supply.id,f.users.supply.name,new Date().toISOString());
 let s=await purchasePreparation(f.db,'2026-09');assert.equal(s.groups[0].items[0].cartonQty,20);
 await savePurchaseDraft(f.db,f.users.supply,{month:s.month,sourceKey:s.sourceKey,version:s.draft.version,documents:altered(s)});
 assert.equal(f.sqlite.prepare("SELECT data_json FROM product_profiles WHERE sku='BAG-A'").get().data_json,original);
 s=await purchasePreparation(f.db,'2026-09');assert.equal(s.draft.documents[0].items[0].cartonQty,30);
 f.sqlite.prepare("UPDATE product_profiles SET version=2,data_json=? WHERE sku='BAG-A'").run(JSON.stringify({cartonQty:25}));
 await assert.rejects(savePurchaseDraft(f.db,f.users.supply,{month:s.month,sourceKey:s.sourceKey,version:s.draft.version,documents:altered(s)}),e=>e.status===409);
});
