import test from 'node:test';
import assert from 'node:assert/strict';
import {transportFixture} from './transport-fixture.mjs';
import {previewInbound,submitInbound} from '../lib/inbound.mjs';
import {voidTransportLeg} from '../lib/transport-void.mjs';
import {loadTransitLots} from '../lib/transit-stock.mjs';
import {loadForecast} from '../lib/forecast.ts';
import {dispatchAvailability} from '../lib/factory-documents.mjs';
import {deliveryStep} from '../lib/dispatch-demand.mjs';
import {answerPlanProgress} from '../lib/employee-plan-progress.mjs';
import {workspaceTasks} from '../lib/workspace-tasks.mjs';
import {monthEndStock} from '../lib/month-end-stock.mjs';
import {inboundCostCandidates} from '../lib/finance-candidates.mjs';
import {transportCompletionStatements,resolveInventoryHoldSources} from '../lib/inventory-holds.mjs';
import {manageBestTracking,readBestTracking,pollBestTracking} from '../lib/best-tracking.mjs';
import {waybillLocations} from '../lib/best-tracking-auto.mjs';

const config={BEST_PARTNER_ID:'TEST-ONLY',BEST_API_SECRET:'TEST-ONLY'};
const waybill='BSIDTEST001234';
const snapshot={country:'ID',status:'已派送',groups:[{events:[{kind:'actual',state:'Delivering',at:'2026-10-08T01:00:00Z',description:'派送交接'}]}]};
const current=f=>f.sqlite.prepare('SELECT * FROM transport_legs WHERE id=?').get(f.leg.id);
const ask=f=>answerPlanProgress(f.db,f.users.admin,'印尼2026年9月TikTok备货计划到哪一步了？','2026-11-24T06:00:00Z');
async function prepare(t,stage='awaiting_receipt'){
 const f=await transportFixture();t.after(()=>f.sqlite.close());
 assert.equal((await f.createTransport()).status,200);
 f.sqlite.prepare("UPDATE transport_batches SET carrier_name='百世集团'").run();
 f.sqlite.prepare("UPDATE transport_legs SET stage=?,stage_owner='海运',eta='2026-10-11',etd='2026-10-01'").run(stage);
 f.leg=f.sqlite.prepare('SELECT * FROM transport_legs').get();
 const preview=await previewInbound(f.db,f.users.admin,{rows:[{receiptNo:'HISTORICAL-ARRIVAL-001',businessDate:'2026-10-11',site:'印尼',channel:'TikTok',sku:'BAG-A',qty:10,warehouseCode:'W1',proofRef:'TEST-WAREHOUSE-SIGNED',note:'单独录入的历史到仓事实'}]});
 await submitInbound(f.db,f.users.admin,{rows:preview.rows,previewToken:preview.token,confirmed:true});
 const document=f.sqlite.prepare('SELECT id FROM inbound_documents').get();
 f.void=()=>voidTransportLeg(f.db,f.users.supply,{legId:f.leg.id,version:current(f).version,reason:'原运输票已通过历史到仓单补录',confirmed:true,historyRefs:[{kind:'document',id:document.id}]});
 f.best=(input,lookup=async()=>snapshot)=>manageBestTracking(f.db,config,f.users.admin,{legId:f.leg.id,...input},lookup);
 return f;
}

test('历史到仓核销同时退出在途/提醒，保留发货占用和库存，小品不把核销量当实收',async t=>{
 const f=await prepare(t);
 const stock=()=>f.sqlite.prepare('SELECT * FROM inventory_balances ORDER BY site,channel,sku').all();
 const moves=()=>f.sqlite.prepare('SELECT * FROM inventory_movements ORDER BY id').all();
 const beforeStock=stock(),beforeMoves=moves();
 const order=f.sqlite.prepare('SELECT id FROM series_production_orders').get();
 const available=await dispatchAvailability(f.db,order.id);
 const forecast=async()=>(await loadForecast(f.db,f.users.admin,'2026-11-24')).suggestions.find(r=>r.site==='印尼'&&r.channel==='TikTok'&&r.sku==='BAG-A');
 assert.equal((await loadTransitLots(f.db)).reduce((n,r)=>n+r.qty,0),10);
 assert.equal((await forecast()).seaInTransit,10);
 assert.ok((await workspaceTasks(f.db,f.sea)).some(r=>r.entity===f.leg.id));
 assert.match((await ask(f)).answer,/10 件 的预计到仓日已过/);
 await f.void();
 assert.deepEqual(stock(),beforeStock);assert.deepEqual(moves(),beforeMoves);
 assert.deepEqual(await dispatchAvailability(f.db,order.id),available);
 assert.equal(f.sqlite.prepare('SELECT SUM(shipped_qty) n FROM transport_batch_items').get().n,10);
 assert.equal(f.sqlite.prepare('SELECT received_qty FROM transport_leg_items').get().received_qty,0);
 assert.equal(f.sqlite.prepare('SELECT count(*) n FROM transport_receipts').get().n,0);
 assert.deepEqual(await inboundCostCandidates(f.db,[]),[]);
 assert.equal((await loadTransitLots(f.db)).length,0);
 const after=await forecast();assert.equal(after.seaInTransit,0);assert.equal(after.productionInProgress,0);
 for(const actor of [f.sea,f.users.supply,f.users.indonesia,f.users.admin])assert.equal((await workspaceTasks(f.db,actor)).filter(r=>r.entity===f.leg.id).length,0);
 const answer=await ask(f);assert.match(answer.answer,/已发出 10 件，仓库已实收 0 件/);
 assert.match(answer.answer,/已关联历史到仓处理/);assert.match(answer.answer,/不把核销数量当作本票实收/);
 assert.doesNotMatch(answer.answer,/10 件 待补到仓日期|10 件 的预计到仓日已过|已发出的货均已实收/);
 assert.ok(answer.brief.details.some(r=>r.includes(f.leg.leg_no)&&r.includes('原运输票已通过历史到仓单补录')&&r.includes('HISTORICAL-ARRIVAL-001')&&!r.includes('预计 2026-10-11')));
});

test('原订舱阶段核销不补造开船或发出数量',async t=>{
 const f=await prepare(t,'booking');
 f.sqlite.prepare("UPDATE transport_legs SET etd='' WHERE id=?").run(f.leg.id);
 await f.void();
 const reply=await ask(f);assert.match(reply.answer,/已发出 0 件，仓库已实收 0 件/);
 assert.match(reply.answer,/原运输数量合计 10 件/);
 assert.equal((await loadForecast(f.db,f.users.admin,'2026-11-24')).suggestions.find(r=>r.site==='印尼'&&r.channel==='TikTok'&&r.sku==='BAG-A').productionInProgress,0);
});

test('核销写入当前物理历史，不回写旧月末库存或产生费用候选',async t=>{
 const f=await prepare(t);
 // Put this isolated fixture's baseline/snapshots in October, then restore both
 // immutability guards before exercising the real reconciliation transaction.
 const guards=f.sqlite.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name IN ('immutable_fin_stock_baseline_update','immutable_fin_stock_history_update')").all();
 for(const g of guards)f.sqlite.exec('DROP TRIGGER '+g.name);
 f.sqlite.prepare("UPDATE finance_stock_baseline SET started_at='2026-09-01T00:00:00.000Z'").run();
 f.sqlite.prepare("UPDATE finance_stock_history SET at='2026-10-12T00:00:00.000Z'").run();
 for(const g of guards)f.sqlite.exec(g.sql);
 const before=await monthEndStock(f.db,'2026-10',{products:[]},[]);
 const historical=before.rows.find(r=>r.site==='印尼'&&r.channel==='TikTok'&&r.sku==='BAG-A');
 assert.equal(historical.transit,10);assert.equal(historical.available,20);
 await f.void();
 assert.deepEqual(await monthEndStock(f.db,'2026-10',{products:[]},[]),before);
 const latest=f.sqlite.prepare("SELECT payload FROM finance_stock_history WHERE source='transport_legs' ORDER BY seq DESC LIMIT 1").get();
 assert.equal(JSON.parse(latest.payload).stage,'voided');
});

test('核销运输只读保留百世轨迹，停止轮询/新匹配，状态重算不复活',async t=>{
 const f=await prepare(t);
 const linked=await f.best({action:'link',waybill});
 f.sqlite.prepare("UPDATE best_transport_tracking SET last_attempt_at='2000-01-01T00:00:00.000Z'").run();
 const before=f.sqlite.prepare('SELECT * FROM best_transport_tracking').get();
 await f.void();const terminal=current(f);
 await pollBestTracking(f.db,config,()=>assert.fail('核销票不应再请求承运商'));
 await f.db.batch(transportCompletionStatements(f.db,f.leg.id,new Date().toISOString()));
 assert.deepEqual(current(f),terminal);assert.deepEqual(f.sqlite.prepare('SELECT * FROM best_transport_tracking').get(),before);
 const view=await readBestTracking(f.db,f.users.admin,f.leg.id);
 assert.equal(view.canManage,false);assert.deepEqual(view.pending,[]);assert.equal(view.rows[0].id,linked.rows[0].id);
 for(const action of ['refresh','unlink','link'])await assert.rejects(f.best({action,id:linked.rows[0].id,waybill},()=>assert.fail('终态禁止外部请求')),{status:409});
 assert.match((await waybillLocations(f.db,waybill,'ID'))[0].status,/停止同步/);
});

test('百世刷新在途响应遇到核销后不覆盖历史快照，也不复活票据',async t=>{
 const f=await prepare(t,'sea_freight');
 const linked=await f.best({action:'link',waybill});
 f.sqlite.prepare("UPDATE best_transport_tracking SET last_attempt_at='2000-01-01T00:00:00.000Z'").run();
 let release,started;const ready=new Promise(r=>{started=r});
 const pending=f.best({action:'refresh',id:linked.rows[0].id},async()=>{started();await new Promise(r=>{release=r});return {...snapshot,status:'稍后回来的旧响应'};});
 await ready;await f.void();const state=current(f);release();await pending;
 assert.deepEqual(current(f),state);
 assert.equal((await readBestTracking(f.db,f.users.admin,f.leg.id)).rows[0].snapshot.status,snapshot.status);
});

test('百世自动发现查询途中核销，不新建关联或推进节点',async t=>{
 const f=await prepare(t,'sea_freight');
 f.sqlite.prepare('UPDATE transport_batches SET bill_no=?').run(waybill);
 let release,started;const ready=new Promise(r=>{started=r});
 const pending=pollBestTracking(f.db,config,async()=>{started();await new Promise(r=>{release=r});return snapshot;});
 await ready;await f.void();const state=current(f);release();await pending;
 assert.deepEqual(current(f),state);assert.equal(f.sqlite.prepare('SELECT count(*) n FROM best_transport_tracking').get().n,0);
 await pollBestTracking(f.db,config,()=>assert.fail('核销后不能重新发现关联'));
});

test('同主批另一分腿隔离处理完毕后正常完结，已核销分腿不被复活或继续挂起主批',async t=>{
 const f=await transportFixture();t.after(()=>f.sqlite.close());
 const allocations=[{site:'印尼',channel:'TikTok',qty:5},{site:'印尼',channel:'Shopee',qty:5}];
 f.sqlite.prepare('UPDATE series_purchase_order_items SET allocations_json=?').run(JSON.stringify(allocations));
 f.sqlite.prepare("INSERT INTO warehouses(id,site,channel,code,name,created_at,updated_at) VALUES('warehouse-sp','印尼','Shopee','WSP','测试Shopee目的仓','2026-10-01','2026-10-01')").run();
 const production=f.sqlite.prepare('SELECT id FROM series_production_order_items').get();
 const created=await f.post(f.users.supply,'createTransportBatch',{batchNo:'SPLIT-HISTORY',carrierName:'测试承运商',items:[{productionOrderItemId:production.id,shippedQty:10,allocations:allocations.map(a=>({...a,warehouseId:a.channel==='TikTok'?'warehouse-1':'warehouse-sp'}))}]});
 assert.equal(created.status,200,created.error);
 f.sqlite.prepare("UPDATE transport_legs SET stage='awaiting_receipt'").run();
 const first=f.sqlite.prepare("SELECT * FROM transport_legs WHERE channel='TikTok'").get();
 const second=f.sqlite.prepare("SELECT * FROM transport_legs WHERE channel='Shopee'").get();
 const preview=await previewInbound(f.db,f.users.admin,{rows:[{receiptNo:'HISTORICAL-SPLIT-001',businessDate:'2026-10-11',site:'印尼',channel:'TikTok',sku:'BAG-A',qty:5,warehouseCode:'W1',proofRef:'TEST-SIGNED',note:'独立历史到仓已登记'}]});
 await submitInbound(f.db,f.users.admin,{rows:preview.rows,previewToken:preview.token,confirmed:true});
 await voidTransportLeg(f.db,f.users.supply,{legId:first.id,version:first.version,reason:'历史已到仓单已独立登记',confirmed:true,historyRefs:[{kind:'document',id:f.sqlite.prepare('SELECT id FROM inbound_documents').get().id}]});
 assert.equal(f.sqlite.prepare('SELECT status FROM transport_batches').get().status,'active');
 const item=f.sqlite.prepare('SELECT * FROM transport_leg_items WHERE leg_id=?').get(second.id);
 const receipt=await f.post(f.users.supply,'receiveTransportLeg',{legId:second.id,receiptNo:'REAL-SPLIT-RECEIPT',proofRef:'ACTUAL-SIGNED',items:[{id:item.id,receivedQty:5,quarantineQty:1}]});
 assert.equal(receipt.status,200,receipt.error);
 const shelved=await f.post({...f.users.indonesia,channel:'Shopee'},'confirmTransportShelf',{legItemId:item.id,shelvedQty:4,listingRef:'REAL-LISTING',note:'实际完好件已上架'});
 assert.equal(shelved.status,200,shelved.error);
 await resolveInventoryHoldSources(f.db,f.users.supply,{site:'印尼',channel:'Shopee',sku:'BAG-A',qty:1,resolution:'writeoff',reason:'破损品核实后报损'});
 assert.equal(f.sqlite.prepare('SELECT stage FROM transport_legs WHERE id=?').get(first.id).stage,'voided');
 assert.equal(f.sqlite.prepare('SELECT stage FROM transport_legs WHERE id=?').get(second.id).stage,'on_shelf');
 assert.equal(f.sqlite.prepare('SELECT status FROM transport_batches').get().status,'completed');
});

test('工厂发货指引区分全部正常结束、历史核销和仍在途，不以核销冒充实收',()=>{
 const order={productionStatus:'completed',qc_status:'passed'},linked={status:'linked',approval_status:'approved',transport_closed:1,transport_voided:1};
 assert.match(deliveryStep(order,[],[linked],'2026-11-24').label,/已结束，历史到仓依据见运输明细/);
 assert.doesNotMatch(deliveryStep(order,[],[linked],'2026-11-24').label,/实收|均已到仓/);
 assert.match(deliveryStep(order,[],[{...linked,transport_voided:0}],'2026-11-24').label,/运输及上架流程已完成/);
 assert.match(deliveryStep(order,[],[linked,{...linked,transport_closed:0}],'2026-11-24').label,/已进入运输/);
 assert.match(deliveryStep(order,[{available:1}],[linked],'2026-11-24').label,/提交发货通知/);
});
