import test from 'node:test';
import assert from 'node:assert/strict';
import {transportFixture} from './transport-fixture.mjs';
import {transportGuidance,transportSteps} from '../lib/transport-workflow.mjs';
import {svc,race} from './system-fixture.mjs';
import {workspaceTasks} from '../lib/workspace-tasks.mjs';
import {transportCompletionStatements} from '../lib/inventory-holds.mjs';

test('目的地指导准确映射现有后台全流程，登记到仓不提前增加可售，部分上架不提前完结',async()=>{
 const f=await transportFixture();try{
 const before=f.sqlite.prepare("SELECT qty FROM inventory_balances WHERE site='印尼' AND channel='TikTok' AND sku='BAG-A'").get().qty;
 const created=await f.createTransport();assert.equal(created.status,200);
 const leg=()=>f.sqlite.prepare('SELECT * FROM transport_legs').get();
 const day=new Date(Date.now()+8*3600000).toISOString().slice(0,10);
 for(let i=0;i<5;i++){
  const current=leg(),actor=i===0?f.users.supply:f.sea;
  assert.equal(current.stage,transportSteps[i][0]);assert.equal(transportGuidance(current,actor).allowed,true);
  if(i===1){assert.equal(transportGuidance(current,f.users.supply).allowed,false);const bad=await f.post(f.users.supply,'advanceTransportLeg',{legId:current.id,version:current.version,evidenceRef:'TEST',note:'越权不得推进'});assert.equal(bad.status,403);}
  const result=await f.post(actor,'advanceTransportLeg',{legId:current.id,version:current.version,evidenceRef:'TEST-'+i,note:'按凭证推进节点',etd:day,eta:'2027-01-01',ata:day,portName:'TEST-PORT'});assert.equal(result.status,200,result.error);
 }
 assert.equal(leg().stage,'awaiting_receipt');const item=f.sqlite.prepare('SELECT * FROM transport_leg_items').get();
 assert.equal(leg().stage_owner,'海运');
 const result=await f.post(f.users.supply,'receiveTransportLeg',{legId:leg().id,receiptNo:'TEST-RCV',proofRef:'TEST-PROOF',items:[{id:item.id,receivedQty:10,quarantineQty:0}]});assert.equal(result.status,200,result.error);assert.equal(leg().stage,'shelf_pending');
 assert.equal(f.sqlite.prepare("SELECT qty FROM inventory_balances WHERE site='印尼' AND channel='TikTok' AND sku='BAG-A'").get().qty,before);
 for(const qty of [4,6]){const r=await f.post(f.users.indonesia,'confirmTransportShelf',{legItemId:item.id,shelvedQty:qty,listingRef:'TEST-LISTING',note:'运营确认上架'});assert.equal(r.status,200,r.error);assert.equal(leg().stage,qty===4?'shelf_pending':'on_shelf');}
 assert.equal(f.sqlite.prepare('SELECT status FROM transport_batches').get().status,'completed');assert.equal(JSON.parse(leg().evidence_json).length,5);
 }finally{f.sqlite.close();}
});

test('海运登录待办涵盖旧负责人记录的签收节点，读模型同步展示当前责任，其他海运看不到',async()=>{
 const f=await transportFixture();try{
  await f.createTransport();f.sqlite.prepare("UPDATE transport_legs SET stage='awaiting_receipt',stage_owner='供应链'").run();
  const leg=f.sqlite.prepare('SELECT * FROM transport_legs').get();
  assert.ok((await workspaceTasks(f.db,f.sea)).some(t=>t.entity===leg.id&&t.title==='登记仓库签收数量'));
  assert.equal((await workspaceTasks(f.db,{...f.sea,id:'other-sea'})).filter(t=>t.entity===leg.id).length,0);
  const snapshot=await f.read(f.sea);
  assert.equal(snapshot.transportBatches[0].legs[0].stage_owner,'海运');
  await f.db.batch(transportCompletionStatements(f.db,leg.id,new Date().toISOString()));
  assert.equal(f.sqlite.prepare('SELECT stage_owner FROM transport_legs').get().stage_owner,'海运');
  f.sqlite.prepare("UPDATE transport_legs SET stage='shelf_pending',stage_owner='运营'").run();
  assert.equal((await workspaceTasks(f.db,f.sea)).filter(t=>t.entity===leg.id).length,0);
 }finally{f.sqlite.close();}
});

test('供应链与海运同时签收只记一份实收；处理中转派负责人会拒绝旧海运账号',async()=>{
 const f=await transportFixture();try{
  await f.createTransport();f.sqlite.prepare("UPDATE transport_legs SET stage='awaiting_receipt'").run();
  const leg=f.sqlite.prepare('SELECT * FROM transport_legs').get(),item=f.sqlite.prepare('SELECT * FROM transport_leg_items').get();
  const payload={legId:leg.id,receiptNo:'CONCURRENT-SEA',proofRef:'WAREHOUSE-PROOF',items:[{id:item.id,receivedQty:6}]};
  const [sea,supply]=await race(f,()=>svc.receiveTransportLeg(f.sea,payload),()=>svc.receiveTransportLeg(f.users.supply,{...payload,receiptNo:'CONCURRENT-SUPPLY'}));
  assert.equal(sea.ok,false);assert.equal(sea.error.status,409);assert.equal(supply.ok,true);
  assert.equal(f.sqlite.prepare('SELECT received_qty FROM transport_leg_items').get().received_qty,6);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM transport_receipts').get().n,1);
  const [reassigned]=await race(f,()=>svc.receiveTransportLeg(f.sea,{...payload,receiptNo:'STALE-ASSIGNEE',items:[{id:item.id,receivedQty:4}]}),async()=>{
   f.sqlite.prepare('UPDATE transport_legs SET assigned_user_id=NULL').run();
  });
  assert.equal(reassigned.ok,false);assert.equal(reassigned.error.status,409);
  assert.equal(f.sqlite.prepare('SELECT received_qty FROM transport_leg_items').get().received_qty,6);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM transport_receipts').get().n,1);
 }finally{f.sqlite.close();}
});
test('按钮遵守海运负责人、运营站点边界，其他账号显示下一步与责任方但不越权',()=>{
 const leg={stage:'sea_freight',assigned_user_id:'sea1',site:'印尼',channel:'TikTok'};
 assert.equal(transportGuidance(leg,{id:'sea1',role:'海运'}).allowed,true);assert.equal(transportGuidance(leg,{id:'sea2',role:'海运'}).allowed,false);assert.equal(transportGuidance(leg,{id:'sea2',role:'海运'}).canEta,false);
 for(const role of ['供应链','财务','工厂','销售']){const g=transportGuidance(leg,{role});assert.equal(g.allowed,false);assert.ok(g.hint.includes('到港'));assert.ok(g.owner.includes('海运'));}
 assert.equal(transportGuidance(leg,{role:'管理员'}).allowed,true);
 leg.stage='shelf_pending';assert.equal(transportGuidance(leg,{role:'运营',site:'印尼',channel:'TikTok'}).allowed,true);assert.equal(transportGuidance(leg,{role:'运营',site:'印尼',channel:'Shopee'}).allowed,false);
 leg.stage='unknown';assert.equal(transportGuidance(leg,{role:'管理员'}).allowed,false);
});

test('分配海运账号可按仓库凭证分批签收，供应链保留协作，隔离与上架分别记账',async()=>{
 const f=await transportFixture();try{
  await f.createTransport();
  const leg=()=>f.sqlite.prepare('SELECT * FROM transport_legs').get();
  // Existing legs remain usable without a data rewrite of the previous owner.
  f.sqlite.prepare("UPDATE transport_legs SET stage='awaiting_receipt',stage_owner='供应链'").run();
  const item=f.sqlite.prepare('SELECT * FROM transport_leg_items').get();
  const stock=()=>f.sqlite.prepare("SELECT * FROM inventory_balances WHERE site='印尼' AND channel='TikTok' AND sku='BAG-A'").get();
  const before=stock().qty;
  const payload={legId:leg().id,receiptNo:'SEA-RECEIPT-1',proofRef:'WAREHOUSE-SIGNED-1',items:[{id:item.id,receivedQty:8,quarantineQty:2}]};
  assert.equal(transportGuidance(leg(),f.sea).allowed,true);
  assert.equal(transportGuidance(leg(),f.users.supply).allowed,true);
  assert.equal(transportGuidance(leg(),f.users.admin).allowed,true);
  const otherSea={...f.sea,id:'other-sea'};
  assert.equal(transportGuidance(leg(),otherSea).allowed,false);
  assert.equal((await f.post(otherSea,'receiveTransportLeg',payload)).status,403);
  assert.equal((await f.post(f.users.indonesia,'receiveTransportLeg',payload)).status,403);
  assert.equal((await f.post(f.sea,'receiveShipmentBatch',{batchId:'legacy',receiptNo:'SEA-LEGACY',proofRef:'PROOF',items:[]})).status,403);
  for(const bad of [
   {...payload,proofRef:''},
   {...payload,items:[{id:item.id,receivedQty:11}]},
   {...payload,items:[{id:item.id,receivedQty:3,quarantineQty:4}]},
   {...payload,items:[{id:item.id,receivedQty:-1}]},
   {...payload,items:[{id:'other-leg-item',receivedQty:1}]},
   {...payload,items:[{id:item.id,receivedQty:1},{id:item.id,receivedQty:1}]},
  ])assert.ok([400,409].includes((await f.post(f.sea,'receiveTransportLeg',bad)).status));
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM transport_receipts').get().n,0);
  const startVersion=leg().version;
  let result=await f.post(f.sea,'receiveTransportLeg',{...payload,version:startVersion});
  assert.equal(result.status,200,result.error);assert.equal(leg().stage,'awaiting_receipt');assert.equal(leg().stage_owner,'海运');
  assert.equal(stock().qty,before);assert.equal(stock().pending_shelf_qty,6);assert.equal(stock().quarantine_qty,2);
  assert.equal(f.sqlite.prepare('SELECT actor_id FROM transport_receipts').get().actor_id,f.sea.id);
  assert.equal((await f.post(f.sea,'receiveTransportLeg',payload)).status,409);
  assert.equal((await f.post(f.sea,'receiveTransportLeg',{...payload,receiptNo:'SEA-STALE',version:startVersion,items:[{id:item.id,receivedQty:1}]})).status,409);
  assert.equal((await f.post(f.sea,'receiveTransportLeg',{...payload,receiptNo:'SEA-OVER',items:[{id:item.id,receivedQty:3}]})).status,409);
  result=await f.post(f.users.supply,'receiveTransportLeg',{...payload,receiptNo:'SUPPLY-RECEIPT-2',items:[{id:item.id,receivedQty:2}]});
  assert.equal(result.status,200,result.error);assert.equal(leg().stage,'shelf_pending');assert.equal(leg().stage_owner,'运营');
  assert.equal(stock().qty,before);assert.equal(stock().pending_shelf_qty,8);assert.equal(stock().quarantine_qty,2);
  assert.equal((await f.post(f.sea,'confirmTransportShelf',{legItemId:item.id,shelvedQty:8,listingRef:'LISTING'})).status,403);
  assert.equal((await f.post(f.users.malaysia,'confirmTransportShelf',{legItemId:item.id,shelvedQty:8,listingRef:'LISTING'})).status,403);
  result=await f.post(f.users.indonesia,'confirmTransportShelf',{legItemId:item.id,shelvedQty:8,listingRef:'PLATFORM-LISTING'});
  assert.equal(result.status,200,result.error);assert.equal(stock().qty,before+8);assert.equal(stock().quarantine_qty,2);assert.equal(leg().stage,'shelf_pending');
 }finally{f.sqlite.close();}
});

test('无负责人分腿不给任意海运开放签收，供应链仍可处理',async()=>{
 const f=await transportFixture();try{
  await f.createTransport();f.sqlite.prepare("UPDATE transport_legs SET stage='awaiting_receipt',assigned_user_id=NULL,stage_owner='供应链'").run();
  const leg=f.sqlite.prepare('SELECT * FROM transport_legs').get(),item=f.sqlite.prepare('SELECT * FROM transport_leg_items').get();
  assert.equal(transportGuidance(leg,f.sea).allowed,false);assert.equal(transportGuidance(leg,f.users.supply).owner,'供应链');
  const payload={legId:leg.id,receiptNo:'UNASSIGNED-RCV',proofRef:'WAREHOUSE-PROOF',items:[{id:item.id,receivedQty:1}]};
  assert.equal((await f.post(f.sea,'receiveTransportLeg',payload)).status,409);
  assert.equal((await f.post(f.users.supply,'receiveTransportLeg',payload)).status,200);
  assert.equal(f.sqlite.prepare('SELECT stage_owner FROM transport_legs').get().stage_owner,'供应链');
 }finally{f.sqlite.close();}
});
