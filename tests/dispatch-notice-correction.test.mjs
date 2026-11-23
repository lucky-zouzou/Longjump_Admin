import test from 'node:test';
import assert from 'node:assert/strict';
import {systemFixture,svc,seedMonthly,race} from './system-fixture.mjs';
import {preparePurchase} from './factory-document-fixture.mjs';
import {today} from '../lib/purchase-documents.mjs';
import {REQUIRED_MONTHLY_SCOPES} from '../lib/rules.mjs';
import {issueDispatchNotice,changeDispatch,dispatchAvailability,readFactoryDocuments,readNoticeCorrection} from '../lib/factory-documents.mjs';
import {purchaseQuantitySource,mutatePurchaseQuantity} from '../lib/purchase-quantity-changes.mjs';
import {uploadFactoryFile} from '../lib/factory-document-files.mjs';

async function setup(t){
 t.mock.timers.enable({apis:['Date'],now:new Date('2026-11-20T03:00:00Z')});
 const f=systemFixture();t.after(()=>f.sqlite.close());seedMonthly(f);f.sqlite.prepare('DELETE FROM approval_requests').run();
 for(const scope of REQUIRED_MONTHLY_SCOPES)await svc.monthlySubmit({...f.users.indonesia,...scope},{month:'2026-09',...scope,...(scope.site==='泰国'&&scope.channel==='TikTok'?{items:[{sku:'BAG-A',qty:200,name:'测试包'}]}:{zeroDemand:true,zeroReason:'本月无需备货'})});
 await preparePurchase(f);await svc.submitPlan(f.users.supply,{month:'2026-09'});
 const approval=f.sqlite.prepare('SELECT * FROM approval_requests').get();await svc.decideApproval(f.users.admin,{approvalId:approval.id,version:1,decision:'approve',comment:'原订单200件已审核'});
 f.order=()=>f.sqlite.prepare('SELECT * FROM series_production_orders').get();f.item=()=>f.sqlite.prepare('SELECT * FROM series_production_order_items').get();f.factory={id:'factory-1',role:'工厂',name:'工厂甲'};
 const exported=await(await svc.exportProductionOrder(f.factory,{productionOrderId:f.order().id})).json();await svc.acceptProductionOrder(f.factory,{productionOrderId:f.order().id,promisedCompletionDate:today(),evidenceRef:'TEST-CONFIRM',note:'已核对原订单',orderReviewed:true,exportReceiptId:exported.exportReceiptId});
 f.complete=async(qty)=>{await svc.completeProductionOrder(f.factory,{productionOrderId:f.order().id,items:[{id:f.item().id,producedQty:qty}],evidenceRef:'TEST-FINISH-'+qty,note:'已核对实际产量'});await svc.confirmProductionQc(f.users.supply,{productionOrderId:f.order().id,decision:'pass',evidenceRef:'TEST-QC-'+qty,note:'已核对产品质检'});};await f.complete(200);
 const at=new Date().toISOString();f.sqlite.prepare('INSERT INTO warehouses(id,site,channel,code,name,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run('WH-TH','泰国','TikTok','WH-TH','泰国仓',at,at);
 const original=await issueDispatchNotice(f.db,f.users.supply,{productionOrderId:f.order().id,noticeNo:'ORIGINAL-200',warehouseId:'WH-TH',shippingDate:today(),receiver:'测试收件人',phone:'TEST-ONLY',address:'TEST-ONLY',demandBasis:'按原批准200件发货',items:[{itemId:f.item().id,qty:200}]});
 f.notice=id=>f.sqlite.prepare('SELECT * FROM factory_dispatch_notices WHERE id=?').get(id);f.old=original.id;
 f.approve=async id=>changeDispatch(f.db,f.users.admin,{action:'reviewNotice',noticeId:id,version:f.notice(id).version,decision:'approve',reason:'已核对实际数量和需求'});await f.approve(f.old);
 f.correct=(extra={})=>changeDispatch(f.db,f.users.supply,{action:'correctNotice',noticeId:f.old,version:f.notice(f.old).version,noticeNo:'CORRECTION-210',reason:'原通知数量填错，实际七箱210件',items:[{itemId:f.item().id,qty:210}],...extra});
 f.expand=async()=>{const source=await purchaseQuantitySource(f.db,f.users.supply,f.order().purchase_order_id);const change=await mutatePurchaseQuantity(f.db,f.users.supply,{action:'quantityChangeSubmit',orderId:source.orderId,sourceKey:source.sourceKey,reason:'按装箱实际追加十件',items:source.items.map(i=>({itemId:i.itemId,cartonQty:30,allocations:i.allocations.map(a=>({...a,qty:210}))}))});await mutatePurchaseQuantity(f.db,f.users.admin,{action:'quantityChangeDecide',changeId:change.id,version:1,decision:'approve',reason:'实际采购七箱已核对'});await f.complete(210);};
 f.packing=async(id,shippedDate='2026-11-20')=>{const file=await uploadFactoryFile(f.db,{async put(){},async delete(){}},f.factory,{noticeId:id,file:new File(['%PDF-1.7\nTEST-ONLY'],'signed.pdf',{type:'application/pdf'})});return {action:'submitPacking',noticeId:id,version:f.notice(id).version,number:'PACK-'+id,shippedDate,shipper:'测试发货员',inspector:'测试质检',trackingNo:'TEST-TRACK',shippedConfirmed:true,proofIds:[file.id],rows:[{itemId:f.item().id,pcsPerCarton:30,cartons:7,cartonStart:1,length:58,width:39,height:38}]};};
 return f;
}

test('200件原通知在PO批准调整210后原子补正，重新审批后可登记原批准日真实实发并转海运',async t=>{
 const f=await setup(t),old=f.notice(f.old),balance=f.sqlite.prepare('SELECT * FROM inventory_balances').all();
 t.mock.timers.setTime(Date.parse('2026-11-23T03:00:00Z'));
 await f.expand();const correctionSource=await readNoticeCorrection(f.db,f.users.supply,f.old);assert.equal(correctionSource.available[0].available,210);assert.equal(correctionSource.version,old.version);await assert.rejects(readNoticeCorrection(f.db,f.factory,f.old),e=>e.status===403);await assert.rejects(readNoticeCorrection(f.db,f.users.supply2,f.old),e=>e.status===403);const result=await f.correct(),n=f.notice(result.id);
 assert.equal(f.notice(f.old).status,'cancelled');assert.equal(f.notice(f.old).items_json,old.items_json);assert.equal(f.notice(f.old).approval_at,old.approval_at);
 assert.equal(n.approval_status,'pending');assert.equal(n.correction_of_id,f.old);assert.equal(n.correction_approval_at,old.approval_at);assert.equal(JSON.parse(n.items_json)[0].qty,210);
 assert.equal((await dispatchAvailability(f.db,f.order().id))[0].available,0);
 assert.equal((await readFactoryDocuments(f.db,f.factory)).notices.some(x=>x.id===n.id),false);
 await assert.rejects(changeDispatch(f.db,f.factory,{action:'submitPacking',noticeId:n.id,version:n.version}),e=>e.status===403);
 await f.approve(n.id);assert.notEqual(f.notice(n.id).approval_at,old.approval_at);
 const p=await f.packing(n.id);await assert.rejects(changeDispatch(f.db,f.factory,{...p,shippedDate:'2026-11-19'}),/实际发货日期/);
 await changeDispatch(f.db,f.factory,p);assert.equal(JSON.parse(f.notice(n.id).packing_json).shippedDate,'2026-11-20');
 await changeDispatch(f.db,f.users.supply,{action:'reviewPacking',noticeId:n.id,version:f.notice(n.id).version,decision:'confirm',reason:'七箱210件签字单核对通过'});
 const stamp=new Date().toISOString();f.sqlite.prepare('INSERT INTO users(id,email,name,role,created_at,updated_at) VALUES(?,?,?,?,?,?)').run('sea','sea@example.test','海运','海运',stamp,stamp);f.sqlite.prepare('INSERT INTO business_partners(id,type,code,name,assigned_user_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run('carrier','carrier','SEA','承运商','sea',stamp,stamp);
 svc.setActor(f.users.supply);const response=await svc.POST(new Request('http://localhost/api/system',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'createTransportBatch',noticeId:n.id,noticeVersion:f.notice(n.id).version,batchNo:'TEST-CORRECTED-210',carrierName:'承运商'})}));assert.equal(response.status,200,JSON.stringify(await response.clone().json()));assert.equal(f.sqlite.prepare('SELECT total_shipped_qty FROM transport_batches').get().total_shipped_qty,210);
 assert.deepEqual(f.sqlite.prepare('SELECT * FROM inventory_balances').all(),balance);
 assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action='补正重开发货通知' AND entity_id=?").get(f.old).n,1);
 const read=(await readFactoryDocuments(f.db,f.users.admin)).notices.find(x=>x.id===n.id);assert.equal(read.correction_notice_no,old.notice_no);
});

test('未经采购数量批准、未核实产量或超站点份额不得借补正超发，失败不取消原通知',async t=>{
 const f=await setup(t);await assert.rejects(f.correct(),/超过可发数量/);assert.equal(f.notice(f.old).status,'issued');
 await f.expand();await assert.rejects(f.correct({items:[{itemId:f.item().id,qty:211}]}),/超过可发数量/);assert.equal(f.notice(f.old).status,'issued');
 const changed=await f.correct();assert.equal(f.notice(changed.id).approval_status,'pending');
 await assert.rejects(f.correct({noticeNo:'DUPLICATE'}),/仅已批准|已被新通知替代/);
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM factory_dispatch_notices').get().n,2);
});

test('补正权限、必须重审、未提交装箱与原SKU边界不能绕过',async t=>{
 const f=await setup(t);await f.expand();const base={action:'correctNotice',noticeId:f.old,version:f.notice(f.old).version,noticeNo:'BAD-CORRECTION',reason:'测试补正权限',items:[{itemId:f.item().id,qty:210}]};
 for(const actor of [f.factory,f.users.indonesia,f.users.finance,f.users.supply2])await assert.rejects(changeDispatch(f.db,actor,base),e=>e.status===403);
 await assert.rejects(f.correct({reason:'x'}),/至少4/);await assert.rejects(f.correct({items:[{itemId:'different',qty:210}]}),/原通知SKU/);await assert.rejects(f.correct({items:[{itemId:f.item().id,qty:200}]}),/没有变化/);
 const corrected=await changeDispatch(f.db,f.users.admin,{...base,noticeNo:'ADMIN-CORRECTION'});await assert.rejects(f.approve(corrected.id),/非申请人/);
 assert.equal(f.notice(corrected.id).approval_status,'pending');
});

test('已提交装箱及退回补正的历史发货通知不能补正重开',async t=>{
 const f=await setup(t);await f.expand();const corrected=await f.correct();await f.approve(corrected.id);await changeDispatch(f.db,f.factory,await f.packing(corrected.id));
 const request=()=>changeDispatch(f.db,f.users.supply,{action:'correctNotice',noticeId:corrected.id,version:f.notice(corrected.id).version,noticeNo:'NO-REOPEN',reason:'不可重写实际发货',items:[{itemId:f.item().id,qty:205}]});
 await assert.rejects(request(),/从未提交装箱/);
 await changeDispatch(f.db,f.users.supply,{action:'reviewPacking',noticeId:corrected.id,version:f.notice(corrected.id).version,decision:'return',reason:'扫描件需要重新核对'});
 assert.equal(f.notice(corrected.id).status,'issued');await assert.rejects(request(),/从未提交装箱/);
});

test('原批准日期不可由API或数据库修改，连续补正沿最初真实批准日',async t=>{
 const f=await setup(t),oldApproval=f.notice(f.old).approval_at;await f.expand();t.mock.timers.setTime(Date.parse('2026-11-23T03:00:00Z'));
 const first=await f.correct({correction_approval_at:'2000-01-01',approval_at:'2000-01-01',correction_of_id:'made-up'});assert.equal(f.notice(first.id).correction_approval_at,oldApproval);
 assert.throws(()=>f.sqlite.prepare("UPDATE factory_dispatch_notices SET correction_approval_at='2000-01-01' WHERE id=?").run(first.id),/immutable/);
 await f.approve(first.id);const next=await changeDispatch(f.db,f.users.supply,{action:'correctNotice',noticeId:first.id,version:f.notice(first.id).version,noticeNo:'SECOND-CORRECTION',reason:'核实本批次为209件',items:[{itemId:f.item().id,qty:209}]});
 assert.equal(f.notice(next.id).correction_approval_at,oldApproval);assert.equal(f.notice(next.id).correction_of_id,first.id);
});

test('新通知插入失败时取消原通知与审计一起回滚，并发只生成一个补正通知',async t=>{
 const f=await setup(t);await f.expand();f.sqlite.exec("CREATE TRIGGER fail_test_correction BEFORE INSERT ON factory_dispatch_notices WHEN NEW.correction_of_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'guard_test_correction'); END;");
 await assert.rejects(f.correct(),/guard_|变化/);assert.equal(f.notice(f.old).status,'issued');assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM factory_dispatch_notices').get().n,1);assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action='补正重开发货通知'").get().n,0);
 f.sqlite.exec('DROP TRIGGER fail_test_correction');
 const [first,second]=await race(f,()=>f.correct({noticeNo:'CONCURRENT-A'}),()=>f.correct({noticeNo:'CONCURRENT-B'}));assert.equal(Number(first.ok)+Number(second.ok),1);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM factory_dispatch_notices').get().n,2);
});

test('补正被驳回后可修改数量重新送审，原最初批准日期延续且已替代旧单不可再次重开',async t=>{
 const f=await setup(t),originalApproval=f.notice(f.old).approval_at;await f.expand();t.mock.timers.setTime(Date.parse('2026-11-23T03:00:00Z'));
 const rejected=await f.correct();await changeDispatch(f.db,f.users.admin,{action:'reviewNotice',noticeId:rejected.id,version:f.notice(rejected.id).version,decision:'reject',reason:'请核对本批次实际为209件'});
 assert.equal(f.notice(rejected.id).approval_status,'rejected');assert.equal(f.notice(rejected.id).status,'cancelled');
 const context=await readNoticeCorrection(f.db,f.users.supply,rejected.id);assert.equal(context.available[0].available,210);
 const retry=await changeDispatch(f.db,f.users.supply,{action:'correctNotice',noticeId:rejected.id,version:f.notice(rejected.id).version,noticeNo:'REJECT-RESUBMIT-209',reason:'已核对本批次209件重新送审',correction_approval_at:'2000-01-01',items:[{itemId:f.item().id,qty:209}]});
 assert.equal(f.notice(retry.id).correction_of_id,rejected.id);assert.equal(f.notice(retry.id).correction_approval_at,originalApproval);assert.equal(f.notice(retry.id).approval_status,'pending');
 await assert.rejects(readNoticeCorrection(f.db,f.users.supply,rejected.id),/已被新通知替代/);
 await assert.rejects(changeDispatch(f.db,f.users.supply,{action:'correctNotice',noticeId:rejected.id,version:f.notice(rejected.id).version,noticeNo:'BAD-REPLAY',reason:'禁止同一旧单再重开',items:[{itemId:f.item().id,qty:208}]}),/已被新通知替代/);
 await assert.rejects(f.correct({noticeNo:'BAD-ORIGINAL-REPLAY'}),/仅已批准|已被新通知替代/);
 await f.approve(retry.id);const p=await f.packing(retry.id);p.rows[0].pcsPerCarton=209;p.rows[0].cartons=1;await changeDispatch(f.db,f.factory,p);
 assert.equal(JSON.parse(f.notice(retry.id).packing_json).shippedDate,'2026-11-20');assert.equal(JSON.parse(f.notice(retry.id).packing_json).totalQty,209);
 const view=await readFactoryDocuments(f.db,f.users.supply);assert.equal(view.notices.find(n=>n.id===rejected.id).correction_replacement_id,retry.id);
});

test('待审补正主动取消后可保持同数量补原因重送，仍需独立管理员批准',async t=>{
 const f=await setup(t),originalApproval=f.notice(f.old).approval_at;await f.expand();t.mock.timers.setTime(Date.parse('2026-11-23T03:00:00Z'));
 const cancelled=await f.correct();await changeDispatch(f.db,f.users.supply,{action:'cancelNotice',noticeId:cancelled.id,version:f.notice(cancelled.id).version,reason:'补充说明后重新提交'});
 assert.equal(f.notice(cancelled.id).approval_at,null);assert.equal(f.notice(cancelled.id).approval_status,'pending');
 const retry=await changeDispatch(f.db,f.users.supply,{action:'correctNotice',noticeId:cancelled.id,version:f.notice(cancelled.id).version,noticeNo:'CANCEL-RESUBMIT-210',reason:'补充七箱签字依据，数量仍为210件',items:[{itemId:f.item().id,qty:210}]});
 assert.equal(f.notice(retry.id).correction_approval_at,originalApproval);assert.equal(f.notice(retry.id).approval_status,'pending');
 await assert.rejects(changeDispatch(f.db,f.factory,{action:'submitPacking',noticeId:retry.id,version:1}),e=>e.status===403);
 await f.approve(retry.id);await changeDispatch(f.db,f.factory,await f.packing(retry.id));assert.equal(JSON.parse(f.notice(retry.id).packing_json).totalQty,210);
});

test('驳回补正单只补充审核依据也可按同数量重送',async t=>{
 const f=await setup(t);await f.expand();const rejected=await f.correct();await changeDispatch(f.db,f.users.admin,{action:'reviewNotice',noticeId:rejected.id,version:f.notice(rejected.id).version,decision:'reject',reason:'请补充实际装箱依据'});
 const retry=await changeDispatch(f.db,f.users.supply,{action:'correctNotice',noticeId:rejected.id,version:f.notice(rejected.id).version,noticeNo:'SAME-QTY-RESUBMIT',reason:'已核对七箱签字记录，实际为210件',items:[{itemId:f.item().id,qty:210}]});
 assert.equal(JSON.parse(f.notice(retry.id).items_json)[0].qty,210);assert.equal(f.notice(retry.id).approval_status,'pending');
 await assert.rejects(readNoticeCorrection(f.db,f.users.supply,rejected.id),/已被新通知替代/);
});

test('本单已批准箱规优先带入新通知，待审批调整不提前采用且旧快照和商品资料不变',async t=>{
 const f=await setup(t),oldSnapshot=f.notice(f.old).items_json;
 const master=JSON.stringify({cartonQty:40,cartonLengthCm:58,cartonWidthCm:39,cartonHeightCm:38});
 f.sqlite.prepare('INSERT INTO product_profiles(sku,version,data_json,source_json,actor_id,actor_name,updated_at) VALUES(?,?,?,?,?,?,?)').run('BAG-A',1,master,'{}',f.users.supply.id,f.users.supply.name,new Date().toISOString());
 const masterRow=f.sqlite.prepare('SELECT * FROM product_profiles WHERE sku=?').get('BAG-A');
 const originalReference=(await dispatchAvailability(f.db,f.order().id,f.old))[0].packingReference;assert.equal(originalReference.cartonQty,40);assert.equal(originalReference.cartonQtySource,undefined);
 const source=await purchaseQuantitySource(f.db,f.users.supply,f.order().purchase_order_id);
 const change=await mutatePurchaseQuantity(f.db,f.users.supply,{action:'quantityChangeSubmit',orderId:source.orderId,sourceKey:source.sourceKey,reason:'按本单七箱实际调整为210件',items:source.items.map(i=>({itemId:i.itemId,cartonQty:30,allocations:i.allocations.map(a=>({...a,qty:210}))}))});
 const pendingReference=(await dispatchAvailability(f.db,f.order().id,f.old))[0].packingReference;assert.equal(pendingReference.cartonQty,40);assert.equal(pendingReference.cartonQtySource,undefined);
 await mutatePurchaseQuantity(f.db,f.users.admin,{action:'quantityChangeDecide',changeId:change.id,version:1,decision:'approve',reason:'已核对本单30件一箱七箱'});await f.complete(210);
 const approvedReference=(await dispatchAvailability(f.db,f.order().id,f.old))[0].packingReference;assert.equal(approvedReference.cartonQty,30);assert.equal(approvedReference.cartonQtySource,'purchase_order');assert.equal(approvedReference.cartonLengthCm,58);
 const corrected=await f.correct(),snapshot=JSON.parse(f.notice(corrected.id).items_json)[0];assert.equal(snapshot.qty,210);assert.equal(snapshot.packingReference.cartonQty,30);assert.equal(snapshot.packingReference.cartonQtySource,'purchase_order');
 assert.equal(f.notice(f.old).items_json,oldSnapshot);assert.deepEqual(f.sqlite.prepare('SELECT * FROM product_profiles WHERE sku=?').get('BAG-A'),masterRow);
 assert.throws(()=>f.sqlite.prepare("UPDATE factory_dispatch_notices SET items_json=json_set(items_json,'$[0].packingReference.cartonQty',99) WHERE id=?").run(corrected.id),/immutable/);
 const view=(await readFactoryDocuments(f.db,f.users.admin)).notices.find(n=>n.id===corrected.id);assert.equal(view.items[0].packingReference.cartonQty,30);
});
