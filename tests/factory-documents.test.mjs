import test from 'node:test';
import assert from 'node:assert/strict';
import * as X from 'xlsx';
import {systemFixture,svc,seedMonthly,race} from './system-fixture.mjs';
import {preparePurchase} from './factory-document-fixture.mjs';
import {purchasePreparation,savePurchaseDraft,normalizePurchaseDocuments,today} from '../lib/purchase-documents.mjs';
import {issueDispatchNotice,readFactoryDocuments,changeDispatch,dispatchAvailability,packingTransportContext} from '../lib/factory-documents.mjs';
import {uploadFactoryFile,readFactoryFile} from '../lib/factory-document-files.mjs';
import {purchaseWorkbook,noticeWorkbook,packingWorkbook} from '../lib/factory-document-export.mjs';
import {REQUIRED_MONTHLY_SCOPES} from '../lib/rules.mjs';
import {ticketRows,orderPayload,importRows,review} from './cost-fixture.mjs';
import {mutateCost,readCostProfit} from '../lib/cost-profit.mjs';
import {localDay} from '../lib/promotion-model.mjs';
async function setup({modern=true,complete=true}={}){
 const f=systemFixture();seedMonthly(f);f.factory={id:'factory-1',name:'工厂甲',role:'工厂'};
 if(modern){f.sqlite.prepare('DELETE FROM approval_requests').run();for(const scope of REQUIRED_MONTHLY_SCOPES)await svc.monthlySubmit({...f.users.indonesia,...scope},{month:'2026-09',...scope,...(scope.site==='印尼'&&scope.channel==='TikTok'?{items:[{sku:'BAG-A',qty:10,name:'测试包'}]}:{zeroDemand:true,zeroReason:'本月无需备货'})});await preparePurchase(f);await svc.submitPlan(f.users.supply,{month:'2026-09'});}
 const approval=f.sqlite.prepare('SELECT * FROM approval_requests').get();await svc.decideApproval(f.users.admin,{approvalId:approval.id,version:1,decision:'approve',comment:'核对条款数量和采购价'});
 f.order=()=>f.sqlite.prepare('SELECT * FROM series_production_orders').get();f.item=()=>f.sqlite.prepare('SELECT * FROM series_production_order_items').get();
 if(!modern)await svc.confirmPurchaseOrder(f.users.supply,{purchaseOrderId:f.order().purchase_order_id,orderRef:'LEGACY',expectedCompletionDate:today()});
 if(complete){const doc=await(await svc.exportProductionOrder(f.factory,{productionOrderId:f.order().id})).json();await svc.acceptProductionOrder(f.factory,{productionOrderId:f.order().id,promisedCompletionDate:today(),evidenceRef:'CONFIRM-1',note:'核对订单完毕',orderReviewed:true,exportReceiptId:doc.exportReceiptId});await svc.completeProductionOrder(f.factory,{productionOrderId:f.order().id,items:[{id:f.item().id,producedQty:10}],evidenceRef:'FINISH',note:'生产已完成'});await svc.confirmProductionQc(f.users.supply,{productionOrderId:f.order().id,decision:'pass',evidenceRef:'QC-1',note:'抽检全部合格'});}
 const stamp=new Date().toISOString();f.sqlite.prepare('INSERT INTO warehouses(id,site,channel,code,name,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run('WH','印尼','TikTok','WH','印尼仓',stamp,stamp);
 f.sqlite.prepare('INSERT INTO users(id,email,name,role,created_at,updated_at) VALUES(?,?,?,?,?,?)').run('sea','sea@example.test','海运','海运',stamp,stamp);
 f.sqlite.prepare('INSERT INTO business_partners(id,type,code,name,assigned_user_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run('carrier','carrier','SEA','承运商','sea',stamp,stamp);
 f.issue=(qty=10,number='NOTICE-1')=>issueDispatchNotice(f.db,f.users.supply,{productionOrderId:f.order().id,noticeNo:number,warehouseId:'WH',shippingDate:today(),receiver:'收货人',phone:'123456',address:'测试集运仓',items:[{itemId:f.item().id,qty}]});
 f.notice=id=>f.sqlite.prepare('SELECT * FROM factory_dispatch_notices WHERE id=?').get(id);
 f.bucket={objects:new Map(),async put(k,b){this.objects.set(k,b)},async delete(k){this.objects.delete(k)},async get(k){const b=this.objects.get(k);return b?{body:new ReadableStream({start(c){c.enqueue(new Uint8Array(b));c.close()}})}:null;}};
 f.pack=async(id,qty=10)=>{const proof=await uploadFactoryFile(f.db,f.bucket,f.factory,{noticeId:id,file:new File(['%PDF-1.7\nsigned'], 'signed.pdf',{type:'application/pdf'})});return {noticeId:id,version:f.notice(id).version,action:'submitPacking',number:'PACK-'+id,shippedDate:today(),shipper:'发货员',inspector:'质检员',trackingNo:'TRACK-001',shippedConfirmed:true,reason:qty<10?'部分尾货稍后补发':'',proofIds:[proof.id],rows:[{itemId:f.item().id,pcsPerCarton:qty,cartons:1,cartonStart:1,length:58,width:39,height:38}]};};
 return f;
}
test('采购准备→管理员批准锁定并下发→工厂导出可见采购价，销售价始终隔离',async()=>{
 const f=await setup({complete:false});try{const po=f.sqlite.prepare('SELECT * FROM series_purchase_orders').get(),d=JSON.parse(po.document_json);assert.equal(po.workflow_version,1);assert.equal(f.order().status,'awaiting_factory');assert.equal(d.totalAmount,255);assert.equal(d.approvedBy,f.users.admin.name);
 const exported=await(await svc.exportProductionOrder(f.factory,{productionOrderId:f.order().id})).json();assert.equal(exported.purchaseDocument.items[0].purchasePrice,25.5);
 const own=await readFactoryDocuments(f.db,f.factory);assert.equal(own.orders.length,1);assert.equal((await readFactoryDocuments(f.db,{...f.factory,id:'other'})).orders.length,0);
 await assert.rejects(readFactoryDocuments(f.db,f.users.indonesia),e=>e.status===403);assert.ok(!JSON.stringify(own).includes('unit_price'));
 const b=X.read(X.write(purchaseWorkbook(X,d),{type:'buffer',bookType:'xlsx'}),{type:'buffer'});assert.equal(b.Sheets['采购订单'].G8.v,25.5);assert.equal(b.Sheets['采购订单'].I8.v,255);assert.equal(b.Sheets['采购订单'].I8.f,'ROUND(F8*G8,2)');assert.equal(b.Sheets['站点需求分配'].F2.v,10);
 await assert.rejects(preparePurchase(f),/已更新|变化/);
 }finally{f.sqlite.close();}
});
test('三单闭环：装箱复核后按实发转海运，不改海外库存、不允许重复转单',async()=>{
 const f=await setup();try{const before=f.sqlite.prepare('SELECT * FROM inventory_balances').all(),n=await f.issue();let a=await dispatchAvailability(f.db,f.order().id);assert.equal(a[0].available,0);
 await changeDispatch(f.db,f.factory,await f.pack(n.id,8));assert.equal(f.notice(n.id).status,'packing_submitted');
 await changeDispatch(f.db,f.users.supply,{action:'reviewPacking',noticeId:n.id,version:2,decision:'confirm',reason:'核对签字箱数实发八件'});
 svc.setActor(f.users.supply);const response=await svc.POST(new Request('http://localhost/api/system',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'createTransportBatch',noticeId:n.id,noticeVersion:3,batchNo:'TR-PACK-1',carrierName:'承运商'})}));assert.equal(response.status,200,JSON.stringify(await response.clone().json()));
 assert.equal(f.notice(n.id).status,'linked');assert.equal(f.sqlite.prepare('SELECT total_shipped_qty FROM transport_batches').get().total_shipped_qty,8);assert.equal((await dispatchAvailability(f.db,f.order().id))[0].available,2);
 await assert.rejects(packingTransportContext(f.db,f.users.supply,{noticeId:n.id,noticeVersion:3}),/已转海运/);
 assert.deepEqual(f.sqlite.prepare('SELECT * FROM inventory_balances').all(),before);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM inventory_movements').get().n,0);
 const view=await readFactoryDocuments(f.db,f.users.admin),wb=packingWorkbook(X,view.notices[0]);assert.equal(wb.Sheets['商品装箱清单'].F6.v,8);assert.equal(wb.Sheets['商品装箱清单'].H6.v,1);for(const col of [5,7,12])assert.ok(!wb.Sheets['商品装箱清单']['!merges'].some(m=>m.s.r<=6&&m.e.r>=6&&m.s.c<=col&&m.e.c>=col),'装箱合计不能被合并覆盖');assert.equal(wb.Sheets['商品装箱清单'].L6.v,.085956);assert.equal(noticeWorkbook(X,view.notices[0]).Sheets['发货通知单'].G7.v,10);
 svc.setActor(f.users.sales);const tracked=await(await svc.GET(new Request('http://localhost/api/system?module=production-tracking'))).json();assert.ok(tracked.productionTracking[0].events.some(e=>e.label==='已按装箱清单建立海运批次'));assert.ok(!JSON.stringify(tracked).includes('purchasePrice'));
 }finally{f.sqlite.close();}
});
test('同一真实业务链：月度需求采购→工厂质检装箱→运输到仓上架→销售扣库→成本结算与销售修订',async()=>{
 const f=await setup();try{
  const post=async(actor,action,payload)=>{svc.setActor(actor);const response=await svc.POST(new Request('http://localhost/api/system',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,...payload})}));return {status:response.status,body:await response.json()};};
  const stock=()=>f.sqlite.prepare("SELECT qty FROM inventory_balances WHERE site='印尼' AND channel='TikTok' AND sku='BAG-A'").get().qty;
  const initial=stock(),n=await f.issue();await changeDispatch(f.db,f.factory,await f.pack(n.id));
  await changeDispatch(f.db,f.users.supply,{action:'reviewPacking',noticeId:n.id,version:2,decision:'confirm',reason:'TEST-ONLY 实发十件核对'});
  const created=await post(f.users.supply,'createTransportBatch',{noticeId:n.id,noticeVersion:3,batchNo:'TEST-E2E',carrierName:'承运商'});assert.equal(created.status,200,JSON.stringify(created.body));
  const leg=()=>f.sqlite.prepare('SELECT * FROM transport_legs').get();
  for(let i=0;i<5;i++){
   const r=await post(i===0?f.users.supply:{id:'sea',role:'海运',name:'海运'},'advanceTransportLeg',{legId:leg().id,version:leg().version,evidenceRef:`TEST-E2E-${i}`,note:'隔离环境运输凭证',etd:today(),eta:today(),ata:today(),portName:'TEST-PORT'});assert.equal(r.status,200,JSON.stringify(r.body));
  }
  const item=f.sqlite.prepare('SELECT * FROM transport_leg_items').get();
  const received=await post(f.users.supply,'receiveTransportLeg',{legId:leg().id,receiptNo:'TEST-RCV-E2E',proofRef:'TEST-RECEIVED',items:[{id:item.id,receivedQty:10,quarantineQty:0}]});assert.equal(received.status,200,JSON.stringify(received.body));assert.equal(stock(),initial);
  for(const qty of [4,6]){const r=await post(f.users.indonesia,'confirmTransportShelf',{legItemId:item.id,shelvedQty:qty,listingRef:'TEST-LISTING',note:'隔离环境确认上架'});assert.equal(r.status,200,JSON.stringify(r.body));}
  assert.equal(leg().stage,'on_shelf');assert.equal(stock(),initial+10);
  assert.notEqual((await post(f.users.indonesia,'confirmTransportShelf',{legItemId:item.id,shelvedQty:1,listingRef:'TEST-LISTING',note:'重复上架必须拒绝'})).status,200);assert.equal(stock(),initial+10);
  const date=localDay(new Date(),'印尼'),sale={site:'印尼',channel:'TikTok',businessDate:date,sourceBatchRef:'TEST-E2E-SALES',importKey:'TEST-E2E-IMPORT',reportKind:'complete',fullDayConfirmed:true,rows:[{sku:'BAG-A',qty:2,amount:100,currency:'CNY'}]};
  const imported=await(await svc.salesImport(f.users.indonesia,sale)).json();assert.equal(stock(),initial+8);
  assert.equal(f.sqlite.prepare('SELECT report_kind FROM sales_imports WHERE id=?').get(imported.importId).report_kind,'partial','当天报表不能提前视为完整');
  await assert.rejects(svc.salesImport(f.users.indonesia,{...sale,importKey:crypto.randomUUID(),sourceBatchRef:'RENAMED'}),/重叠|重复/);assert.equal(stock(),initial+8);
  for(const u of [f.users.supply,f.users.finance])f.sqlite.prepare('INSERT INTO cost_access VALUES(?,?,?,?)').run(u.id,1,1,u.role==='财务'?1:0);
  const rows=[{...ticketRows({businessKey:'TEST-E2E-COST',businessDate:date,effectiveAt:date,warehouse:'印尼仓',legId:leg().id,seaAmount:20})[0],qty:10,unitCost:25.5}];
  const cost=await importRows(f,rows);await review(f,cost.ids[0]);
  const source=f.sqlite.prepare('SELECT id FROM sales_records WHERE import_id=?').get(imported.importId);
  const settlement=orderPayload({businessKey:'TEST-E2E-SETTLEMENT',businessDate:date,revenue:90,platform:{amount:10,state:'actual',source:'TEST-已扣佣金'},advertising:{amount:0,state:'zero',source:'TEST-确认零广告'},warehouse:{state:'actual',source:'TEST-履约账单',perOrder:3,perParcel:0,perItem:1,parcels:1},lines:[{ticketKey:'TEST-E2E-COST',lineKey:'A',salesRecordId:source.id,qty:2}]});
  await mutateCost(f.db,f.users.admin,settlement);
  const ledger=await readCostProfit(f.db,f.users.admin);assert.equal(ledger.orders[0].contribution,3000,'100收入 - 55到仓 - 10佣金 - 5履约 = 30 CNY');assert.equal(ledger.uncovered.length,0);assert.equal(stock(),initial+8,'财务结算不得二次扣库存');
  await svc.correctSalesImport(f.users.admin,{...sale,importId:imported.importId,reason:'TEST-平台核对实际销售三件',rows:[{sku:'BAG-A',qty:3,amount:150,currency:'CNY'}]});assert.equal(stock(),initial+7);
  assert.equal((await readCostProfit(f.db,f.users.admin)).orders[0].contribution,null,'源销售修订必须使旧利润待核实');
  assert.equal(f.sqlite.prepare('PRAGMA foreign_key_check').all().length,0);
 }finally{f.sqlite.close();}
});
test('发货通知必须质检通过、属于供应链负责人、遵守站点和累计数量',async()=>{
 const f=await setup();try{await assert.rejects(issueDispatchNotice(f.db,f.factory,{}),e=>e.status===403);await f.issue(6);await assert.rejects(f.issue(5,'NOTICE-2'),/超过可发/);await f.issue(4,'NOTICE-2');assert.equal((await dispatchAvailability(f.db,f.order().id))[0].available,0);
 }finally{f.sqlite.close();}const g=await setup({complete:false});try{await assert.rejects(g.issue(),/质检/);}finally{g.sqlite.close();}
});
test('并发通知不会重复占用；取消未发通知释放数量并保留记录',async()=>{
 const f=await setup();try{const result=await race(f,()=>f.issue(7,'N-A'),()=>f.issue(7,'N-B'));assert.equal(result.filter(r=>r.ok).length,1);const n=f.sqlite.prepare('SELECT * FROM factory_dispatch_notices').get();await changeDispatch(f.db,f.users.supply,{noticeId:n.id,version:n.version,action:'cancelNotice',reason:'计划发货时间调整'});assert.equal((await dispatchAvailability(f.db,f.order().id))[0].available,10);assert.equal(f.notice(n.id).status,'cancelled');}finally{f.sqlite.close();}
});
test('工厂装箱超量、箱号冲突、缺签字、未来日期、其他工厂越权全部阻止',async()=>{
 const f=await setup();try{const n=await f.issue(),p=await f.pack(n.id);for(const [patch,pattern] of [[{rows:[{...p.rows[0],pcsPerCarton:11}]},/超过通知/],[{rows:[{...p.rows[0],pcsPerCarton:5},{...p.rows[0],pcsPerCarton:5}]},/箱号范围重复/],[{proofIds:[]},/签字/],[{shippedDate:'2099-01-01'},/发货日期/]])await assert.rejects(changeDispatch(f.db,f.factory,{...p,...patch}),pattern);
 await assert.rejects(changeDispatch(f.db,{...f.factory,id:'other'},p),e=>e.status===403);await assert.rejects(changeDispatch(f.db,f.users.supply,p),e=>e.status===403);
 await changeDispatch(f.db,f.factory,p);await assert.rejects(changeDispatch(f.db,f.factory,p),/已更新/);await assert.rejects(changeDispatch(f.db,f.users.supply,{action:'cancelNotice',noticeId:n.id,version:2,reason:'不能删除已发货记录'}),/不可直接取消/);
 await changeDispatch(f.db,f.users.supply,{action:'reviewPacking',noticeId:n.id,version:2,decision:'return',reason:'请补正检验签字资料'});await assert.rejects(changeDispatch(f.db,f.users.supply,{action:'cancelNotice',noticeId:n.id,version:3,reason:'不能删除退回单据'}),/不可直接取消/);
 await changeDispatch(f.db,f.factory,{...p,version:3});assert.equal(f.notice(n.id).status,'packing_submitted');
 }finally{f.sqlite.close();}
});
test('新版订单不可绕开发货通知直接创建新旧海运接口',async()=>{
 const f=await setup();try{await assert.rejects(packingTransportContext(f.db,f.users.supply,{items:[{productionOrderItemId:f.item().id}]}),/先下发发货通知/);await assert.rejects(svc.createShipmentBatch(f.users.supply,{productionOrderId:f.order().id,batchNo:'BYPASS',items:[{id:f.item().id,shippedQty:10}]}),/新版采购单/);}finally{f.sqlite.close();}
});
test('附件严格绑定工厂及通知、验证文件格式，备份维护期间禁止新单据写入',async()=>{
 const f=await setup();try{const n=await f.issue();await assert.rejects(uploadFactoryFile(f.db,f.bucket,f.users.supply,{noticeId:n.id,file:new File(['%PDF-1'], 'f.pdf',{type:'application/pdf'})}),e=>e.status===403);await assert.rejects(uploadFactoryFile(f.db,f.bucket,f.factory,{noticeId:n.id,file:new File(['<script>'], 'f.pdf',{type:'application/pdf'})}),/内容与格式/);const p=await f.pack(n.id);await assert.rejects(readFactoryFile(f.db,{...f.factory,id:'other'},p.proofIds[0]),e=>e.status===403);assert.ok(await readFactoryFile(f.db,f.users.admin,p.proofIds[0]));
 f.sqlite.prepare("INSERT INTO system_maintenance(id,mode,token_hash,actor_id,expires_at,updated_at) VALUES('global','backup','','admin','2099-01-01','2026-01-01') ON CONFLICT(id) DO UPDATE SET mode='backup',expires_at='2099-01-01'").run();await assert.rejects(changeDispatch(f.db,f.factory,p),/备份/);
 }finally{f.sqlite.close();}
});
test('采购草稿不把空价当零；数量和工厂随原需求校验；变更后必须重新确认',async()=>{
 const f=await setup({complete:false});try{const s=await purchasePreparation(f.db,'2026-09'),d=s.draft.documents;
 assert.throws(()=>normalizePurchaseDocuments(s.groups,d.map(x=>({...x,items:x.items.map(i=>({...i,purchasePrice:null}))})),{strict:true}),/采购价/);
 assert.throws(()=>normalizePurchaseDocuments(s.groups,d.map(x=>({...x,termsReviewed:false})),{strict:true}),/逐单确认/);
 assert.throws(()=>normalizePurchaseDocuments(s.groups,d.map(x=>({...x,key:'other'})),{strict:true}),/分组/);
 }finally{f.sqlite.close();}
});

test('采购已批准内容不可改写；追加计划需重新填写并审批采购单；指派交接同步通知',async()=>{
 const {managePlan}=await import('../lib/plan-changes.mjs'),f=await setup();try{
 const po=f.sqlite.prepare('SELECT * FROM series_purchase_orders').get();assert.throws(()=>f.sqlite.prepare("UPDATE series_purchase_orders SET document_json='{}' WHERE id=?").run(po.id),/immutable/);
 const base=f.sqlite.prepare('SELECT * FROM approval_requests').get(),rows=[{sku:'BAG-A',name:'测试包',site:'印尼',channel:'TikTok',qty:15}],ctx={buildSeriesOrders:svc.buildSeriesOrders},input={approvalId:base.id,version:base.version,reason:'追加五件销售需求',rows};
 const prepared=await managePlan(f.db,f.users.supply,{...input,action:'planChangePrepare'},ctx);assert.equal(prepared.groups[0].items[0].total,5);
 await assert.rejects(managePlan(f.db,f.users.supply,{...input,action:'planChangeSubmit'},ctx),/采购单数量/);
 const original=JSON.parse(po.document_json),purchaseDocuments=prepared.groups.map(g=>({...original,...g,number:'ADDITIONAL-PO',items:g.items.map(i=>({...original.items[0],...i}))}));
 const c=await managePlan(f.db,f.users.supply,{...input,action:'planChangeSubmit',purchaseDocuments},ctx);await managePlan(f.db,f.users.admin,{action:'planChangeDecide',changeId:c.id,version:1,decision:'approve',supplyUserId:f.users.supply.id,reason:'确认追加采购价格和条款'},ctx);
 const added=f.sqlite.prepare('SELECT * FROM series_purchase_orders WHERE id<>?').get(po.id);assert.equal(added.workflow_version,1);assert.equal(added.total_qty,5);assert.equal(JSON.parse(added.document_json).totalAmount,127.5);
 const n=await f.issue(5);await managePlan(f.db,f.users.admin,{action:'purchaseReassign',purchaseOrderId:po.id,updatedAt:po.updated_at,supplyUserId:f.users.supply2.id,reason:'负责人交接未完通知'},ctx);assert.equal(f.notice(n.id).supply_user_id,f.users.supply2.id);assert.equal(f.notice(n.id).version,2);
 }finally{f.sqlite.close();}
});
test('模板Excel保持数字、公式、单元格边框与打印宽度；文本不会被当公式',async()=>{
 const {writeFactoryWorkbook}=await import('../lib/factory-document-export.mjs'),f=await setup();try{
 const d=JSON.parse(f.sqlite.prepare('SELECT document_json FROM series_purchase_orders').get().document_json);d.items[0].name='=HYPERLINK("https://example.test")';
 const bytes=writeFactoryWorkbook(X,purchaseWorkbook(X,d)),b=X.read(bytes,{type:'array',cellStyles:true});assert.equal(b.Sheets['采购订单'].C8.t,'s');assert.equal(b.Sheets['采购订单'].C8.f,undefined);assert.equal(b.Sheets['采购订单'].I8.f,'ROUND(F8*G8,2)');assert.equal(b.Sheets['采购订单'].I8.v,255);
 const zip=X.CFB.read(bytes,{type:'array'}),decode=new TextDecoder();assert.match(decode.decode(X.CFB.find(zip,'/xl/styles.xml').content),/wrapText="1"/);assert.match(decode.decode(X.CFB.find(zip,'/xl/worksheets/sheet1.xml').content),/fitToWidth="1"/);
 }finally{f.sqlite.close();}
});
test('旧订单也可以使用通知流程；两个渠道分别占用，直建海运不能挤占通知份额',async()=>{
 const f=await setup({modern:false});try{
 f.sqlite.prepare('UPDATE series_purchase_order_items SET allocations_json=?').run(JSON.stringify([{site:'印尼',channel:'TikTok',qty:5},{site:'印尼',channel:'Shopee',qty:5}]));await f.issue(5);
 svc.setActor(f.users.supply);const response=await svc.POST(new Request('http://localhost/api/system',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'createTransportBatch',batchNo:'SCOPE-CONFLICT',carrierName:'承运商',items:[{productionOrderItemId:f.item().id,shippedQty:5,allocations:[{site:'印尼',channel:'TikTok',warehouseId:'WH',qty:5}]}]})}));assert.equal(response.status,409);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM transport_batches').get().n,0);
 const n=f.sqlite.prepare('SELECT * FROM factory_dispatch_notices').get(),p=await f.pack(n.id,5);await changeDispatch(f.db,f.factory,p);assert.equal(f.notice(n.id).status,'packing_submitted');
 }finally{f.sqlite.close();}
});
