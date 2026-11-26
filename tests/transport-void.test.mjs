import test from 'node:test';
import assert from 'node:assert/strict';
import {systemFixture,svc,seedMonthly,race} from './system-fixture.mjs';
import {previewInbound,submitInbound} from '../lib/inbound.mjs';
import {transportVoidCandidates,voidTransportLeg} from '../lib/transport-void.mjs';
import {advanceBestLeg} from '../lib/best-tracking-auto.mjs';
import {loadTransitLots} from '../lib/transit-stock.mjs';
import {workspaceTasks} from '../lib/workspace-tasks.mjs';

const day=()=>new Date(Date.now()+8*3600000).toISOString().slice(0,10);
const get=(f,sql,...args)=>f.sqlite.prepare(sql).get(...args);
const all=(f,sql,...args)=>f.sqlite.prepare(sql).all(...args);
const count=(f,table)=>get(f,`SELECT COUNT(*) n FROM ${table}`).n;
const inventory=f=>({balances:all(f,'SELECT * FROM inventory_balances ORDER BY site,channel,sku'),movements:all(f,'SELECT * FROM inventory_movements ORDER BY id')});
const status=code=>error=>error.status===code;
const leg=(f,id=f.tkId)=>get(f,'SELECT * FROM transport_legs WHERE id=?',id);
const legItem=(f,id=f.tkId)=>get(f,'SELECT * FROM transport_leg_items WHERE leg_id=?',id);

// Approve a genuine monthly plan and create one physical container with two
// destination legs. Extra quantities, when requested, remain available to ship
// through the real transport API in source-reuse tests.
async function setup({repeat=false,extraSku=false}={}){
 const f=systemFixture(),approvalId=seedMonthly(f),now=new Date().toISOString();
 const items=[{sku:'BAG-A',name:'测试包A',total:repeat?900:500,allocations:[{site:'印尼',channel:'TikTok',qty:repeat?800:400},{site:'印尼',channel:'Shopee',qty:100}]}];
 if(extraSku)items.push({sku:'BAG-B',name:'测试包B',total:400,allocations:[{site:'印尼',channel:'TikTok',qty:400}]});
 const payload={items,seriesOrders:[{seriesName:'测试系列',supplierName:'供应商甲',factoryName:'工厂甲',items}]};
 f.sqlite.prepare('UPDATE approval_requests SET payload_json=? WHERE id=?').run(JSON.stringify(payload),approvalId);
 await svc.decideApproval(f.users.admin,{approvalId,version:1,decision:'approve',comment:'测试历史海运核销闭环'});
 f.sqlite.prepare("UPDATE series_production_orders SET status='completed',total_produced_qty=total_planned_qty,qc_status='passed'").run();
 f.sqlite.prepare('UPDATE series_production_order_items SET produced_qty=planned_qty').run();
 f.sea={id:'void-sea',name:'核销测试海运',role:'海运'};
 f.shopee={id:'void-shopee',name:'核销测试运营',role:'运营',site:'印尼',channel:'Shopee'};
 for(const user of [f.sea,f.shopee])f.sqlite.prepare('INSERT INTO users(id,email,name,role,site,channel,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(user.id,user.id+'@example.test',user.name,user.role,user.site??null,user.channel??null,now,now);
 f.sqlite.prepare("INSERT INTO business_partners(id,type,code,name,assigned_user_id,created_at,updated_at) VALUES('void-carrier','carrier','VOID-CARRIER','核销测试承运商',?,?,?)").run(f.sea.id,now,now);
 for(const [id,site,channel] of [['void-tk','印尼','TikTok'],['void-sp','印尼','Shopee'],['void-my','马来西亚','TikTok']])f.sqlite.prepare('INSERT INTO warehouses(id,code,name,site,channel,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(id,id,id,site,channel,now,now);
 f.post=async(actor,action,p={})=>{svc.setActor(actor);const response=await svc.POST(new Request('http://localhost/api/system',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action,...p})}));return {status:response.status,...await response.json()};};
 f.read=async()=>{svc.setActor(f.users.admin);return (await svc.GET(new Request('http://localhost/api/system?module=overview'))).json();};
 f.ship=async(sku,allocations,batchNo)=>{
  const item=get(f,'SELECT * FROM series_production_order_items WHERE sku=?',sku);
  const result=await f.post(f.users.supply,'createTransportBatch',{batchNo,carrierName:'核销测试承运商',items:[{productionOrderItemId:item.id,shippedQty:allocations.reduce((n,a)=>n+a.qty,0),allocations:allocations.map(a=>({site:'印尼',warehouseId:a.channel==='TikTok'?'void-tk':'void-sp',...a}))}]});
  assert.equal(result.status,200,result.error);return result;
 };
 const created=await f.ship('BAG-A',[{channel:'TikTok',qty:400},{channel:'Shopee',qty:100}],'VOID-BASE');
 f.batchId=created.batchId;f.tkId=get(f,"SELECT id FROM transport_legs WHERE batch_id=? AND channel='TikTok'",f.batchId).id;f.spId=get(f,"SELECT id FROM transport_legs WHERE batch_id=? AND channel='Shopee'",f.batchId).id;
 for(const id of [f.tkId,f.spId]){const result=await f.post(f.users.supply,'advanceTransportLeg',{legId:id,version:leg(f,id).version,evidenceRef:'TEST-ETD-'+id,note:'已核对原始装船记录',etd:day(),eta:'2099-01-01'});assert.equal(result.status,200,result.error);}
 return f;
}

async function historical(f,overrides={},more=[]){
 const receiptNo='HISTORY-'+crypto.randomUUID();
 const rows=[{receiptNo,businessDate:'2026-10-01',site:'印尼',channel:'TikTok',sku:'BAG-A',qty:400,proofRef:'SIGNED-HISTORY-'+receiptNo,note:'独立历史到仓导入，尚未关联原海运',...overrides},...more.map(row=>({receiptNo,businessDate:'2026-10-01',site:'印尼',channel:'TikTok',sku:'BAG-B',qty:400,proofRef:'SIGNED-HISTORY-'+receiptNo,note:'独立历史到仓导入，尚未关联原海运',...row}))];
 const preview=await previewInbound(f.db,f.users.admin,{rows});
 await submitInbound(f.db,f.users.admin,{rows:preview.rows,previewToken:preview.token,confirmed:true});
 return {kind:'document',id:get(f,'SELECT id FROM inbound_documents WHERE receipt_no=?',receiptNo).id};
}
function request(f,source,id=f.tkId,extra={}){return {legId:id,version:leg(f,id).version,historyRefs:[source],reason:'已核对历史到仓，关闭旧海运在途提醒',confirmed:true,...extra};}
function receivePayload(f,id=f.tkId,extra={}){return {legId:id,version:leg(f,id).version,receiptNo:'LIVE-'+crypto.randomUUID(),proofRef:'SIGNED-LIVE-WAREHOUSE',items:[{id:legItem(f,id).id,receivedQty:1,quarantineQty:0}],...extra};}
function seedBest(f,id=f.tkId){
 const now=new Date().toISOString(),at=new Date(Date.now()-1000).toISOString();
 f.sqlite.prepare("UPDATE transport_batches SET carrier_name='BEST' WHERE id=?").run(leg(f,id).batch_id);
 f.sqlite.prepare('INSERT INTO best_transport_tracking(id,leg_id,waybill,snapshot_json,last_success_at,last_attempt_at) VALUES(?,?,?,?,?,?)').run('best-'+id,id,'BEST-VOID-'+id,JSON.stringify({country:'ID',groups:[{events:[{kind:'actual',state:'DestinationArrived',at},{kind:'actual',state:'Delivered',at}]}]}),now,now);
}

test('历史入库400件核销不增减库存或流水，在途减400且已发占用保留，同柜100件继续签收上架',async()=>{
 const f=await setup();try{
  const source=await historical(f),before=inventory(f),original=leg(f),commitments=all(f,'SELECT * FROM transport_batch_items ORDER BY id');
  const list=await f.post(f.users.supply,'transportVoidCandidates',{legId:f.tkId});assert.equal(list.status,200,list.error);
  assert.deepEqual(list.leg.expectedItems,[{sku:'BAG-A',qty:400}]);assert.equal(list.candidates.find(c=>c.id===source.id).isMismatch,false);
  assert.equal((await f.read()).metrics.seaTransitQty,500);
  const result=await f.post(f.users.supply,'voidTransportLeg',request(f,source));assert.equal(result.status,200,result.error);assert.equal(result.stage,'voided');
  assert.deepEqual(inventory(f),before);assert.deepEqual(all(f,'SELECT * FROM transport_batch_items ORDER BY id'),commitments);
  assert.equal(leg(f).version,original.version+1);assert.equal(leg(f).stage,'voided');assert.equal(count(f,'transport_receipts'),0);
  const saved=get(f,'SELECT * FROM transport_leg_voids WHERE id=?',result.voidId);assert.deepEqual(JSON.parse(saved.original_json).leg,JSON.parse(JSON.stringify(original)));assert.equal(JSON.parse(saved.history_json)[0].proofRef,list.candidates.find(c=>c.id===source.id).proofRef);
  const snapshot=await f.read();assert.equal(snapshot.metrics.seaTransitQty,100);assert.equal(snapshot.metrics.productionInProgressQty,0);assert.equal(snapshot.metrics.readyToShipProductionOrderCount,0);
  assert.equal((await loadTransitLots(f.db)).reduce((n,r)=>n+r.qty,0),100);
  assert.ok(!(await workspaceTasks(f.db,f.sea)).some(task=>task.entity===f.tkId));
  const item=get(f,'SELECT * FROM series_production_order_items');const reship=await f.post(f.users.supply,'createTransportBatch',{batchNo:'ILLEGAL-RESHIP',carrierName:'核销测试承运商',items:[{productionOrderItemId:item.id,shippedQty:1,allocations:[{site:'印尼',channel:'TikTok',warehouseId:'void-tk',qty:1}]}]});assert.equal(reship.status,409);assert.equal(count(f,'transport_batches'),1);
  assert.equal(get(f,'SELECT status FROM transport_batches WHERE id=?',f.batchId).status,'active');
  for(let i=0;i<4;i++){const current=leg(f,f.spId),r=await f.post(f.sea,'advanceTransportLeg',{legId:f.spId,version:current.version,evidenceRef:'OTHER-LEG-'+i,note:'其他目的地按实际轨迹推进',ata:day(),portName:'TEST-PORT'});assert.equal(r.status,200,r.error);}
  const received=await f.post(f.sea,'receiveTransportLeg',receivePayload(f,f.spId,{items:[{id:legItem(f,f.spId).id,receivedQty:100,quarantineQty:0}]}));assert.equal(received.status,200,received.error);
  const shelved=await f.post(f.shopee,'confirmTransportShelf',{legItemId:legItem(f,f.spId).id,shelvedQty:100,listingRef:'SP-ON-SHELF',note:'另一目的地正常上架'});assert.equal(shelved.status,200,shelved.error);
  assert.equal(leg(f,f.spId).stage,'on_shelf');assert.equal(get(f,'SELECT status FROM transport_batches WHERE id=?',f.batchId).status,'completed');assert.equal(leg(f).stage,'voided');
 }finally{f.sqlite.close();}
});

test('查询和核销仅管理员/供应链可用，其他角色不能借目的地负责关系扩大权限',async()=>{
 const f=await setup();try{
  const source=await historical(f),before=inventory(f),p=request(f,source);
  for(const actor of [f.users.finance,f.users.sales,f.users.indonesia,f.users.malaysia,f.sea,{id:'factory-1',role:'工厂',name:'工厂甲'},{id:f.users.admin.id,role:'高管',name:'高管'}]){
   assert.equal((await f.post(actor,'transportVoidCandidates',{legId:f.tkId})).status,403,actor.role);
   assert.equal((await f.post(actor,'voidTransportLeg',p)).status,403,actor.role);
  }
  assert.equal(count(f,'transport_leg_voids'),0);assert.deepEqual(inventory(f),before);
  assert.equal((await f.post(f.users.admin,'voidTransportLeg',p)).status,200);
 }finally{f.sqlite.close();}
});

test('核销必须选择真实凭据并确认；陈旧版本和已推进的旧页面提交不写任何事实',async()=>{
 const f=await setup();try{
  const source=await historical(f),p=request(f,source),before=inventory(f);
  for(const bad of [{confirmed:false},{reason:'短'},{historyRefs:[]},{historyRefs:[source,source]},{version:p.version-1},{historyRefs:[{kind:'document',id:'missing'}]}])assert.ok([400,409].includes((await f.post(f.users.admin,'voidTransportLeg',{...p,...bad})).status));
  const advanced=await f.post(f.sea,'advanceTransportLeg',{legId:f.tkId,version:p.version,evidenceRef:'PORT-SIGNED',note:'核销页面打开后海运补到港',ata:day(),portName:'PORT'});assert.equal(advanced.status,200,advanced.error);
  assert.equal((await f.post(f.users.admin,'voidTransportLeg',p)).status,409);assert.equal(count(f,'transport_leg_voids'),0);assert.deepEqual(inventory(f),before);
 }finally{f.sqlite.close();}
});

test('同站点渠道历史数量不同需明确差异说明，不能借跨站点/渠道凭据核销',async()=>{
 const f=await setup();try{
  const wrongSite=await historical(f,{site:'马来西亚'}),wrongChannel=await historical(f,{channel:'Shopee'}),partial=await historical(f,{qty:390});
  // Query and mutation both constrain evidence to the target leg scope.
  const list=await transportVoidCandidates(f.db,f.users.admin,{legId:f.tkId});assert.ok(list.candidates.every(c=>![wrongSite.id,wrongChannel.id].includes(c.id)));
  for(const source of [wrongSite,wrongChannel])await assert.rejects(voidTransportLeg(f.db,f.users.admin,request(f,source,f.tkId,{discrepancyReason:'这份凭证属于别的渠道不能挪用'})),status(409));
  const before=inventory(f);assert.equal(list.candidates.find(c=>c.id===partial.id).isMismatch,true);
  await assert.rejects(voidTransportLeg(f.db,f.users.admin,request(f,partial)),status(400));
  const result=await voidTransportLeg(f.db,f.users.admin,request(f,partial,f.tkId,{discrepancyReason:'原单录入四百，实际历史入库三百九十件，差额另行核对'}));assert.equal(result.isMismatch,true);
  assert.deepEqual(inventory(f),before);assert.equal(JSON.parse(get(f,'SELECT original_json FROM transport_leg_voids').original_json).items[0].qty,400);
 }finally{f.sqlite.close();}
});

test('旧版receipt及allocation凭据可核销，保持历史记录和库存原样',async()=>{
 const f=await setup();try{
  // Seed already-imported legacy facts; the current application no longer
  // creates legacy receipts, so this fixture preserves their historical shape.
  f.sqlite.prepare('INSERT INTO inbound_receipts(id,receipt_no,sku,name,source_batch,proof_ref,total_qty,actor_id,received_at) VALUES(?,?,?,?,?,?,?,?,?)').run('legacy-proof','LEGACY-400','BAG-A','测试包A','','SIGNED-LEGACY',400,f.users.admin.id,'2026-10-01T00:00:00Z');
  f.sqlite.prepare("INSERT INTO inbound_allocations(receipt_id,site,channel,qty) VALUES('legacy-proof','印尼','TikTok',400)").run();
  f.sqlite.prepare("UPDATE inventory_balances SET qty=qty+400 WHERE site='印尼' AND channel='TikTok' AND sku='BAG-A'").run();
  f.sqlite.prepare("INSERT INTO inventory_movements(id,site,channel,sku,movement_type,qty_delta,balance_after,reference_type,reference_id,actor_id,created_at) VALUES('legacy-move','印尼','TikTok','BAG-A','历史到仓',400,410,'到仓单','LEGACY-400','admin-1','2026-10-01T00:00:00Z')").run();
  const before=inventory(f),legacy=get(f,"SELECT * FROM inbound_receipts WHERE id='legacy-proof'");
  const list=await transportVoidCandidates(f.db,f.users.supply,{legId:f.tkId,q:'LEGACY-400'});assert.equal(list.candidates.length,1);assert.equal(list.candidates[0].kind,'legacy');
  await voidTransportLeg(f.db,f.users.supply,request(f,{kind:'legacy',id:'legacy-proof'}));assert.deepEqual(inventory(f),before);assert.deepEqual(get(f,"SELECT * FROM inbound_receipts WHERE id='legacy-proof'"),legacy);
 }finally{f.sqlite.close();}
});

test('重复提交同一核销幂等，不重复审计；不同原因/人员不能覆盖已留存核销',async()=>{
 const f=await setup();try{
  const source=await historical(f),p=request(f,source),before=inventory(f),first=await voidTransportLeg(f.db,f.users.admin,p),audit=count(f,'audit_logs'),operations=count(f,'system_operations');
  const replay=await voidTransportLeg(f.db,f.users.admin,p);assert.equal(replay.replayed,true);assert.equal(replay.voidId,first.voidId);
  await assert.rejects(voidTransportLeg(f.db,f.users.admin,{...p,reason:'换个理由不得覆盖原始核销'}),status(409));
  await assert.rejects(voidTransportLeg(f.db,f.users.supply,p),status(409));
  assert.equal(count(f,'transport_leg_voids'),1);assert.equal(count(f,'audit_logs'),audit);assert.equal(count(f,'system_operations'),operations);assert.deepEqual(inventory(f),before);
  assert.throws(()=>f.sqlite.prepare("UPDATE transport_legs SET stage='sea_freight' WHERE id=?").run(f.tkId),/guard_transport_void_terminal/);
  assert.throws(()=>f.sqlite.prepare('DELETE FROM transport_legs WHERE id=?').run(f.tkId),/immutable/);
  assert.throws(()=>f.sqlite.prepare('UPDATE transport_batch_items SET shipped_qty=0').run(),/guard_transport_void_commitment/);
 }finally{f.sqlite.close();}
});

test('并发核销只成功一次，历史同范围SKU不可被第二张运输单重复消耗',async()=>{
 const f=await setup({repeat:true});try{
  const second=await f.ship('BAG-A',[{channel:'TikTok',qty:400}],'VOID-SECOND'),secondId=get(f,'SELECT id FROM transport_legs WHERE batch_id=?',second.batchId).id;
  const source=await historical(f),before=inventory(f),p=request(f,source);
  const results=await race(f,()=>voidTransportLeg(f.db,f.users.admin,p),()=>voidTransportLeg(f.db,f.users.supply,request(f,source,secondId)));
  assert.equal(results[0].ok,false);assert.equal(results[0].error.status,409);assert.equal(results[1].ok,true);assert.equal(leg(f).stage,'sea_freight');assert.equal(leg(f,secondId).stage,'voided');
  assert.equal(count(f,'transport_leg_voids'),1);assert.equal(count(f,'transport_leg_void_sources'),1);assert.deepEqual(inventory(f),before);
  const list=await transportVoidCandidates(f.db,f.users.admin,{legId:f.tkId});assert.equal(list.candidates.find(c=>c.id===source.id).usedByLegId,secondId);
  await assert.rejects(voidTransportLeg(f.db,f.users.admin,p),status(409));
 }finally{f.sqlite.close();}
});

test('同运输单同核销请求并发竞争只写一份，失败重试返回既有核销',async()=>{
 const f=await setup();try{
  const source=await historical(f),p=request(f,source),before=inventory(f);
  const result=await race(f,()=>voidTransportLeg(f.db,f.users.admin,p),()=>voidTransportLeg(f.db,f.users.admin,p));
  assert.equal(result.filter(r=>r.ok).length,1);assert.equal(result[0].error.status,409);assert.equal(count(f,'transport_leg_voids'),1);assert.equal(count(f,'transport_leg_void_sources'),1);
  const replay=await voidTransportLeg(f.db,f.users.admin,p);assert.equal(replay.replayed,true);assert.equal(replay.voidId,result[1].value.voidId);assert.deepEqual(inventory(f),before);
 }finally{f.sqlite.close();}
});

test('同一历史到仓单包含多个SKU时按SKU关联，不独占整份历史单据',async()=>{
 const f=await setup({extraSku:true});try{
  const second=await f.ship('BAG-B',[{channel:'TikTok',qty:400}],'VOID-BAG-B'),secondId=get(f,'SELECT id FROM transport_legs WHERE batch_id=?',second.batchId).id;
  const source=await historical(f,{},[{}]),before=inventory(f);
  await voidTransportLeg(f.db,f.users.admin,request(f,source));
  const list=await transportVoidCandidates(f.db,f.users.admin,{legId:secondId}),candidate=list.candidates.find(c=>c.id===source.id);assert.equal(candidate.selectable,true);assert.deepEqual(candidate.skus,['BAG-B']);
  await voidTransportLeg(f.db,f.users.supply,request(f,source,secondId));assert.equal(count(f,'transport_leg_void_sources'),2);assert.deepEqual(inventory(f),before);
 }finally{f.sqlite.close();}
});

test('历史兼容数据同范围SKU多明细按总量核销，保留所有明细而只锁一份SKU来源',async()=>{
 const f=await setup();try{
  const source=await historical(f),line=get(f,'SELECT * FROM inbound_document_lines WHERE document_id=?',source.id);
  // Only this isolated fixture relaxes the modern unique index to represent
  // legacy imports split over two physical warehouse lines.
  f.sqlite.exec('DROP INDEX idx_inbound_document_scope');
  f.sqlite.prepare('UPDATE inbound_document_lines SET qty=200 WHERE id=?').run(line.id);
  const split={...line,id:'historical-split-line',qty:200},columns=Object.keys(split);
  f.sqlite.prepare(`INSERT INTO inbound_document_lines(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`).run(...columns.map(key=>split[key]));
  const before=inventory(f),list=await transportVoidCandidates(f.db,f.users.admin,{legId:f.tkId}),candidate=list.candidates.find(c=>c.id===source.id);
  assert.deepEqual(candidate.skus,['BAG-A']);assert.equal(candidate.sourceItems.length,1);assert.equal(candidate.totalQty,400);assert.equal(candidate.isMismatch,false);
  await voidTransportLeg(f.db,f.users.admin,request(f,source));const saved=get(f,'SELECT * FROM transport_leg_void_sources');
  assert.equal(count(f,'transport_leg_void_sources'),1);assert.equal(saved.source_qty,400);assert.equal(JSON.parse(saved.source_json).items.length,2);assert.deepEqual(inventory(f),before);
 }finally{f.sqlite.close();}
});

test('已登记部分实收、隔离或上架的运输单均不得核销，保留实物收货审计',async()=>{
 for(const kind of ['received','quarantine','shelved']){
  const f=await setup();try{
   const source=await historical(f);f.sqlite.prepare("UPDATE transport_legs SET stage='awaiting_receipt' WHERE id=?").run(f.tkId);
   const received=await f.post(f.sea,'receiveTransportLeg',receivePayload(f,f.tkId,{items:[{id:legItem(f).id,receivedQty:kind==='shelved'?400:1,quarantineQty:kind==='quarantine'?1:0}]}));assert.equal(received.status,200,received.error);
   if(kind==='shelved'){const r=await f.post(f.users.indonesia,'confirmTransportShelf',{legItemId:legItem(f).id,shelvedQty:400,listingRef:'REAL-SHELF'});assert.equal(r.status,200,r.error);}
   const before=inventory(f),old=leg(f);await assert.rejects(voidTransportLeg(f.db,f.users.admin,request(f,source)),status(409));assert.deepEqual(leg(f),old);assert.deepEqual(inventory(f),before);assert.equal(count(f,'transport_leg_voids'),0);
  }finally{f.sqlite.close();}
 }
});

test('签收先提交时核销事务整体失败；核销先提交时旧签收事务不能重复入库',async()=>{
 for(const first of ['void','receipt']){
  const f=await setup();try{
   const source=await historical(f);f.sqlite.prepare("UPDATE transport_legs SET stage='awaiting_receipt' WHERE id=?").run(f.tkId);
   const before=inventory(f),p=request(f,source),receipt=receivePayload(f);
   const voidIt=()=>voidTransportLeg(f.db,f.users.admin,p),receiveIt=()=>svc.receiveTransportLeg(f.sea,receipt);
   const results=await race(f,first==='void'?voidIt:receiveIt,first==='void'?receiveIt:voidIt);
   assert.equal(results[0].ok,false);assert.equal(results[0].error.status,409);assert.equal(results[1].ok,true);
   if(first==='void'){assert.equal(count(f,'transport_leg_voids'),0);assert.equal(count(f,'transport_receipts'),1);assert.equal(legItem(f).received_qty,1);assert.equal(leg(f).stage,'awaiting_receipt');}
   else{assert.equal(count(f,'transport_leg_voids'),1);assert.equal(count(f,'transport_receipts'),0);assert.equal(legItem(f).received_qty,0);assert.equal(leg(f).stage,'voided');assert.deepEqual(inventory(f),before);}
  }finally{f.sqlite.close();}
 }
});

test('核销与BEST自动节点竞争时只保留先提交结果，已核销运输单不再被自动复活',async()=>{
 for(const first of ['void','best']){
  const f=await setup();try{
   const source=await historical(f);seedBest(f);const before=inventory(f),p=request(f,source);
   const voidIt=()=>voidTransportLeg(f.db,f.users.admin,p),bestIt=()=>advanceBestLeg(f.db,f.tkId);
   const results=await race(f,first==='void'?voidIt:bestIt,first==='void'?bestIt:voidIt);
   assert.equal(results[1].ok,true);
   if(first==='void'){assert.equal(results[0].ok,false);assert.equal(results[0].error.status,409);assert.equal(leg(f).stage,'awaiting_receipt');assert.equal(count(f,'transport_leg_voids'),0);}
   else{assert.equal(results[0].ok,true);assert.equal(leg(f).stage,'voided');assert.equal(count(f,'transport_leg_voids'),1);await advanceBestLeg(f.db,f.tkId);assert.equal(leg(f).stage,'voided');}
   assert.deepEqual(inventory(f),before);
  }finally{f.sqlite.close();}
 }
});

test('核销读取后历史证明或明细数量发生变化，旧证据不能写入核销审计',async()=>{
 for(const change of ['proof','quantity']){
  const f=await setup();try{
   const source=await historical(f),p=request(f,source),before=inventory(f);
   const results=await race(f,()=>voidTransportLeg(f.db,f.users.admin,p),async()=>{
    if(change==='proof')f.sqlite.prepare("UPDATE inbound_documents SET proof_ref='' WHERE id=?").run(source.id);
    else f.sqlite.prepare('UPDATE inbound_document_lines SET qty=qty-1 WHERE document_id=?').run(source.id);
   });
   assert.equal(results[0].ok,false);assert.equal(results[0].error.status,409);assert.equal(count(f,'transport_leg_voids'),0);assert.equal(count(f,'transport_leg_void_sources'),0);assert.equal(leg(f).stage,'sea_freight');assert.deepEqual(inventory(f),before);
  }finally{f.sqlite.close();}
 }
});

test('核销事务中操作者停用或角色撤销会回滚；备份锁阻止新核销',async()=>{
 for(const change of ['inactive','role','maintenance']){
  const f=await setup();try{
   const source=await historical(f),p=request(f,source),before=inventory(f);
   const results=await race(f,()=>voidTransportLeg(f.db,f.users.admin,p),async()=>{
    if(change==='inactive')f.sqlite.prepare('UPDATE users SET active=0 WHERE id=?').run(f.users.admin.id);
    else if(change==='role')f.sqlite.prepare("UPDATE users SET role='财务' WHERE id=?").run(f.users.admin.id);
    else f.sqlite.prepare("INSERT INTO system_maintenance(id,mode,actor_id,expires_at,updated_at) VALUES('global','backup','admin-1','2099-01-01T00:00:00Z',?) ON CONFLICT(id) DO UPDATE SET mode=excluded.mode,expires_at=excluded.expires_at").run(new Date().toISOString());
   });
   assert.equal(results[0].ok,false,change);assert.equal(results[0].error.status,409,change);assert.equal(count(f,'transport_leg_voids'),0);assert.deepEqual(inventory(f),before);
  }finally{f.sqlite.close();}
 }
});
