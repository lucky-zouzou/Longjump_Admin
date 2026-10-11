import test from 'node:test';
import assert from 'node:assert/strict';
import {transportFixture} from './transport-fixture.mjs';
import {transportGuidance,transportSteps} from '../lib/transport-workflow.mjs';

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
 const result=await f.post(f.users.supply,'receiveTransportLeg',{legId:leg().id,receiptNo:'TEST-RCV',proofRef:'TEST-PROOF',items:[{id:item.id,receivedQty:10,quarantineQty:0}]});assert.equal(result.status,200,result.error);assert.equal(leg().stage,'shelf_pending');
 assert.equal(f.sqlite.prepare("SELECT qty FROM inventory_balances WHERE site='印尼' AND channel='TikTok' AND sku='BAG-A'").get().qty,before);
 for(const qty of [4,6]){const r=await f.post(f.users.indonesia,'confirmTransportShelf',{legItemId:item.id,shelvedQty:qty,listingRef:'TEST-LISTING',note:'运营确认上架'});assert.equal(r.status,200,r.error);assert.equal(leg().stage,qty===4?'shelf_pending':'on_shelf');}
 assert.equal(f.sqlite.prepare('SELECT status FROM transport_batches').get().status,'completed');assert.equal(JSON.parse(leg().evidence_json).length,5);
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
