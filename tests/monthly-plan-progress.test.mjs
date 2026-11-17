import test from 'node:test';
import assert from 'node:assert/strict';
import {systemFixture,svc,seedMonthly} from './system-fixture.mjs';
import {answerWithKnowledge} from '../lib/employee-assistant.mjs';
import {localDay,shiftDay} from '../lib/promotion-model.mjs';
import {rankProductionOrders} from '../lib/production-priority.mjs';
import {forecastPlan} from '../lib/forecast-model.mjs';

const date='2026-11-17',now=date+'T06:00:00Z';
const planQuestion='菲律宾11月份的备货计划到哪一步了，生产了多少？发出去了多少？大概什么时候可以到？';
const ask=(f,question,planContext,actor=f.users.admin)=>answerWithKnowledge(f.db,actor,{question,planContext},{now,request(){throw Error('internal questions cannot leave the system');}});
async function phPlan(t){
  const f=systemFixture();t.after(()=>f.sqlite.close());
  const id=seedMonthly(f);
  const payload=JSON.parse(f.sqlite.prepare('SELECT payload_json FROM approval_requests WHERE id=?').get(id).payload_json);
  for(const item of [...payload.items,...payload.seriesOrders[0].items])item.allocations[0].site='菲律宾';
  f.sqlite.prepare('UPDATE approval_requests SET month=?,payload_json=? WHERE id=?').run('2026-11',JSON.stringify(payload),id);
  return {f,id};
}
function forecast(sku,qty,daily,lots=[]){
  return {sku,site:'菲律宾',channel:'TikTok',qty,...forecastPlan({dailySales:Array(56).fill(daily),dailyCoverage:Array(56).fill(true),currentQty:qty,inventoryKnown:true,arrivalLots:lots,productionLeadDays:3,seaLeadDays:5,reviewCycleDays:7},{},[],date)};
}
const order=(id,sku,created_at=date)=>({id,created_at,status:'awaiting_factory',items:[{sku,visiblePlanned:30,visibleProduced:0,allocations:[{site:'菲律宾',channel:'TikTok',qty:30}]}]});

test('排产按缺口排、及时到货可解急，平级老单在前，核实与已完工单分开',()=>{
  const early=order('old','FAST','2026-10-31'),late=order('new','FAST'),slow=order('low','LOW'),verify=order('check','MISSING'),closed={...early,id:'done',status:'completed'};
  const orders=[closed,slow,late,verify,early],forecasts=[forecast('FAST',20,5),forecast('LOW',50,1)];
  let ranked=rankProductionOrders(orders,forecasts,'供应链');
  assert.deepEqual(ranked.map(o=>o.id),['old','new','check','low','done']);
  assert.equal(ranked[0].priority.level,'urgent');assert.equal(ranked[0].priority.stock,20);assert.equal(ranked[0].priority.shortage,'2026-11-22');
  assert.equal(ranked[2].priority.level,'verify');assert.equal(ranked.at(-1).priority,undefined);
  ranked=rankProductionOrders([early],[forecast('FAST',20,5,[{qty:90,days:2}])],'管理员');assert.equal(ranked[0].priority.level,'normal');
  ranked=rankProductionOrders([early],[forecast('FAST',20,5,[{qty:90,days:null}])],'管理员');assert.equal(ranked[0].priority.level,'verify');
  ranked=rankProductionOrders([early],[forecast('FAST',0,1)],'工厂');assert.equal(ranked[0].priority.level,'urgent');assert.equal(ranked[0].priority.stock,undefined);
});
test('菲律宾十一月从待批到排产，连续追问读取当天台账，核对站点权限',async t=>{
  const {f,id}=await phPlan(t);
  const pending=await ask(f,planQuestion);assert.match(pending.answer,/待管理员审批/);assert.match(pending.answer,/暂无记录/);
  await svc.decideApproval(f.users.admin,{approvalId:id,version:1,decision:'approve',comment:'测试批准'});
  const mo=f.sqlite.prepare('SELECT * FROM series_production_orders').get();
  assert.match((await ask(f,'生产了多少？',pending.planContext)).answer,/完工 0 件/);
  await svc.confirmPurchaseOrder(f.users.supply,{purchaseOrderId:mo.purchase_order_id,orderRef:'TEST-PO',expectedCompletionDate:localDay()});
  const item=f.sqlite.prepare('SELECT id FROM series_production_order_items').get();
  f.sqlite.prepare("UPDATE series_production_orders SET status='in_production',progress_pct=90,promised_completion_date='2026-11-25' WHERE id=?").run(mo.id);
  const progress=await ask(f,'那什么时候可以到？',pending.planContext);assert.match(progress.answer,/粗估/);assert.match((await ask(f,'生产了多少？',pending.planContext)).answer,/完工 0 件/);
  f.sqlite.prepare("UPDATE series_production_orders SET status='completed',total_produced_qty=10,qc_status='passed' WHERE id=?").run(mo.id);
  f.sqlite.prepare('UPDATE series_production_order_items SET produced_qty=10 WHERE id=?').run(item.id);
  for(const [ref,qty,eta] of [['NOV-A',6,'2026-12-04'],['NOV-B',4,'2026-12-12']]){
    await svc.createShipmentBatch(f.users.supply,{productionOrderId:mo.id,batchNo:ref,items:[{id:item.id,shippedQty:qty,allocations:[{site:'菲律宾',channel:'TikTok',qty}]}]});
    f.sqlite.prepare("UPDATE shipment_batches SET stage='sea_freight',estimated_arrival_date=? WHERE batch_no=?").run(eta,ref);
  }
  const reply=await ask(f,planQuestion);
  assert.equal(reply.source,'ledger');assert.match(reply.answer,/批准 10 件/);assert.match(reply.answer,/完工 10 件，已发出 10 件，仓库已实收 0 件/);
  assert.match(reply.answer,/2026-12-04 到 6 件/);assert.ok(reply.brief.details.some(x=>x.includes('2026-12-12')&&x.includes('4 件')));
  assert.equal(reply.ledger.month,'2026-11');
  const scoped=await ask(f,'菲律宾十一月备货到哪了？',null,f.users.indonesia);assert.match(scoped.answer,/你的账号/);assert.doesNotMatch(scoped.answer,/NOV-A|10 件/);
  const other=await ask(f,'上月呢？',reply.planContext);assert.match(other.answer,/2026-10 暂未查到/);
  assert.equal((await ask(f,'菲律宾呢？',(await ask(f,'11月的备货计划到哪了？')).planContext)).planContext.site,'菲律宾');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM employee_knowledge').get().n,0);
});
test('正常工作区入口只为已下发单排序，月度与工厂一致、库存变化解除提醒、按账号隔离',async t=>{
  const {f,id}=await phPlan(t);await svc.decideApproval(f.users.admin,{approvalId:id,version:1,decision:'approve',comment:'测试批准'});
  const mo=f.sqlite.prepare('SELECT * FROM series_production_orders').get();
  const snapshot=async(page,actor)=>{svc.setActor(actor);const r=await svc.GET(new Request('http://localhost/api/system?navigation=page&module='+page));assert.equal(r.status,200,JSON.stringify(await r.clone().json()));return r.json();};
  assert.equal((await snapshot('monthly',f.users.admin)).productionOrders[0].priority,undefined);
  await svc.confirmPurchaseOrder(f.users.supply,{purchaseOrderId:mo.purchase_order_id,orderRef:'TEST-PO',expectedCompletionDate:localDay()});
  const factory={role:'工厂',id:'factory-1'};
  assert.equal((await snapshot('fulfillment',factory)).productionOrders[0].priority.level,'verify');
  const today=localDay(new Date(),'菲律宾');f.stock('BAG-A',2,20,'菲律宾');
  for(let d=1;d<=7;d++){
    const day=shiftDay(today,-d),ref='PH-'+d;
    f.sqlite.prepare("INSERT INTO sales_imports(id,import_key,business_date,site,channel,row_count,total_qty,actor_id,created_at,report_kind) VALUES(?,?,?,'菲律宾','TikTok',1,5,?,?,'complete')").run(ref,ref,day,f.users.admin.id,day);
    f.sqlite.prepare("INSERT INTO sales_records(id,import_id,business_date,site,channel,sku,qty,actor_id,created_at) VALUES(?,?,?,'菲律宾','TikTok','BAG-A',5,?,?)").run(ref,ref,day,f.users.admin.id,day);
  }
  const monthly=await snapshot('monthly',f.users.admin),queue=await snapshot('fulfillment',factory);
  assert.equal(monthly.productionOrders[0].priority.level,'urgent');assert.equal(queue.productionOrders[0].priority.shortage,monthly.productionOrders[0].priority.shortage);
  assert.deepEqual(queue.suggestions,[]);assert.equal(queue.productionOrders[0].priority.stock,undefined);
  assert.equal((await snapshot('fulfillment',{role:'工厂',id:'other-factory'})).productionOrders.length,0);
  f.stock('BAG-A',3000,20,'菲律宾');assert.equal((await snapshot('monthly',f.users.admin)).productionOrders[0].priority.level,'normal');
});
