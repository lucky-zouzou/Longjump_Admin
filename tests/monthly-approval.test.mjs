import test from 'node:test';
import assert from 'node:assert/strict';
import {svc,systemFixture,seedMonthly,race} from './system-fixture.mjs';
import {REQUIRED_MONTHLY_SCOPES} from '../lib/rules.mjs';

const month='2026-09';
const row=f=>f.sqlite.prepare("SELECT * FROM approval_requests WHERE month=?").get(month);
const total=f=>JSON.parse(row(f).payload_json).items.reduce((sum,r)=>sum+r.total,0);
const logs=f=>f.sqlite.prepare("SELECT * FROM audit_logs WHERE entity_type='approval'").all().map(r=>({...r,detail:JSON.parse(r.detail_json)})).sort((a,b)=>a.detail.version-b.detail.version);
const withdraw=(f,actor=f.users.supply,version=1)=>svc.withdrawPlan(actor,{approvalId:row(f).id,version,reason:'调整送审人与需求'});
const decide=(f,decision='approve',version=1)=>svc.decideApproval(f.users.admin,{approvalId:row(f).id,version,decision,comment:'核对需求后处理计划'});
const snapshot=async actor=>{svc.setActor(actor);return (await svc.GET(new Request('http://localhost/api/system'))).json();};
async function submissions(f,qty=10){
  for(const scope of REQUIRED_MONTHLY_SCOPES){const hasDemand=scope.site==='印尼'&&scope.channel==='TikTok';await svc.monthlySubmit({...f.users.indonesia,...scope},{month,...scope,...(hasDemand?{items:[{sku:'BAG-A',qty,reason:'运营核对后提交备货'}]}:{zeroDemand:true,zeroReason:'本月库存充足无需备货'})});}
}

test('旧管理员计划撤回 → 运营调整 → 供应链重送 → 管理员审批生成执行单，完整留痕',async()=>{
  const f=systemFixture();await submissions(f);const id=seedMonthly(f);
  f.sqlite.prepare("UPDATE approval_requests SET creator_id=?,creator_role='管理员' WHERE id=?").run(f.users.admin.id,id);
  assert.ok((await snapshot(f.users.admin)).myTasks.some(t=>t.title==='撤回本人送审计划'));
  for(const decision of ['approve','reject'])await assert.rejects(decide(f,decision),/申请人不能审批/);
  await withdraw(f,f.users.admin);
  assert.equal(row(f).status,'withdrawn');assert.equal(row(f).version,2);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM monthly_submissions').get().n,10);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM series_purchase_orders').get().n,0);
  assert.ok((await snapshot(f.users.supply)).myTasks.some(t=>t.title==='重新送审月度计划'));
  await svc.monthlySubmit(f.users.indonesia,{month,site:'印尼',channel:'TikTok',items:[{sku:'BAG-A',qty:15,reason:'核对后增加五件需求'}]});
  await svc.submitPlan(f.users.supply,{month,version:2});
  assert.equal(row(f).creator_id,f.users.supply.id);assert.equal(row(f).version,3);assert.equal(total(f),15);
  await assert.rejects(decide(f,'approve',1),/版本已变化/);
  const pending=await snapshot(f.users.admin);assert.ok(pending.myTasks.some(t=>t.title==='审批月度备货'));
  assert.equal(pending.approvals[0].creator_name,f.users.supply.name);
  await decide(f,'approve',3);
  assert.equal(row(f).status,'approved');assert.equal(row(f).version,4);
  const po=f.sqlite.prepare('SELECT * FROM series_purchase_orders').get();
  assert.equal(po.total_qty,15);assert.equal(po.assigned_supply_user_id,f.users.supply.id);
  assert.equal(f.sqlite.prepare('SELECT total_planned_qty FROM series_production_orders').get().total_planned_qty,15);
  await svc.confirmPurchaseOrder(f.users.supply,{purchaseOrderId:po.id,orderRef:'RESUBMIT-PO',expectedCompletionDate:'2027-01-01'});
  assert.equal(f.sqlite.prepare('SELECT status FROM series_production_orders').get().status,'awaiting_factory');
  const history=logs(f);assert.deepEqual(history.map(r=>r.detail.status),['withdrawn','pending','approved']);
  assert.deepEqual(history.map(r=>r.detail.totalQty),[10,15,15]);assert.deepEqual(history.map(r=>r.actor_id),[f.users.admin.id,f.users.supply.id,f.users.admin.id]);
  assert.equal(history[0].detail.plan.items[0].total,10);assert.equal(history[0].detail.creatorRole,'管理员');
  assert.throws(()=>f.sqlite.prepare('DELETE FROM audit_logs WHERE id=?').run(history[0].id),/immutable/i);
  const view=await snapshot(f.users.supply);assert.equal(view.approvals[0].history.length,3);assert.equal(view.approvals[0].history[0].comment,'调整送审人与需求');
  assert.deepEqual((await snapshot(f.users.indonesia)).approvals,[]);
  await assert.rejects(decide(f,'approve',4),/已撤回或已处理/);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM series_purchase_orders').get().n,1);
});

test('只有原申请人能撤回；权限、状态、原因和版本校验均生效',async()=>{
  const f=systemFixture();seedMonthly(f);
  for(const actor of [f.users.admin,f.users.supply2,f.users.indonesia,f.users.finance])await assert.rejects(withdraw(f,actor),e=>e.status===403);
  await assert.rejects(withdraw(f,f.users.supply,99),/版本已变化/);
  await assert.rejects(svc.withdrawPlan(f.users.supply,{approvalId:row(f).id,version:1,reason:'短'}),/至少4个字/);
  await assert.rejects(svc.withdrawPlan(f.users.supply,{approvalId:row(f).id,reason:'没有提供版本'}),/版本已变化/);
  assert.equal(logs(f).length,0);assert.equal(row(f).status,'pending');
  await withdraw(f);await assert.rejects(withdraw(f,f.users.supply,2),/仅待审批/);
  assert.equal(logs(f).length,1);
});

test('送审仅供应链允许；撤回后必须携带版本，仍检查十个运营范围完整度',async()=>{
  const f=systemFixture();await submissions(f);seedMonthly(f);await withdraw(f);
  for(const actor of [f.users.admin,f.users.indonesia,f.users.finance])await assert.rejects(svc.submitPlan(actor,{month,version:2}),e=>e.status===403);
  await assert.rejects(svc.submitPlan(f.users.supply,{month}),/版本已变化/);
  await assert.rejects(svc.submitPlan(f.users.supply,{month,version:1}),/版本已变化/);
  f.sqlite.prepare("DELETE FROM monthly_submissions WHERE site='越南' AND channel='Shopee'").run();
  await assert.rejects(svc.submitPlan(f.users.supply,{month,version:2}),/未提交，不能进入审批/);
  assert.equal(row(f).status,'withdrawn');assert.equal(row(f).creator_id,f.users.supply.id);
});

test('管理员驳回后供应链可以重新送审，批准不再依赖旧审批意见',async()=>{
  const f=systemFixture();await submissions(f);seedMonthly(f);
  await decide(f,'reject');assert.equal(row(f).status,'rejected');
  await svc.submitPlan(f.users.supply2,{month,version:2});assert.equal(row(f).creator_id,f.users.supply2.id);assert.equal(row(f).decision_comment,'');
  await decide(f,'approve',3);assert.deepEqual(logs(f).map(r=>r.detail.status),['rejected','pending','approved']);
  assert.equal(f.sqlite.prepare('SELECT assigned_supply_user_id FROM series_purchase_orders').get().assigned_supply_user_id,f.users.supply2.id);
  await assert.rejects(withdraw(f,f.users.supply2,4),/已批准计划请走变更审批/);
});

for(const decision of ['approve','reject'])for(const winner of ['withdraw','decision'])test(`撤回与${decision}并发：${winner}先提交时只能成功一次`,async()=>{
  const f=systemFixture();seedMonthly(f);
  const actions={withdraw:()=>withdraw(f),decision:()=>decide(f,decision)};
  const result=await race(f,actions[winner==='withdraw'?'decision':'withdraw'],actions[winner]);
  assert.equal(result.filter(r=>r.ok).length,1);assert.equal(result[1].ok,true);
  assert.equal(row(f).status,winner==='withdraw'?'withdrawn':decision==='approve'?'approved':'rejected');
  assert.equal(logs(f).length,1);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM series_purchase_orders').get().n,winner==='decision'&&decision==='approve'?1:0);
});

test('重复撤回与并发重送不会新增多条审批或重复留痕',async()=>{
  const f=systemFixture();await submissions(f);seedMonthly(f);
  const withdrawals=await race(f,()=>withdraw(f),()=>withdraw(f));assert.equal(withdrawals.filter(r=>r.ok).length,1);
  const resends=await race(f,()=>svc.submitPlan(f.users.supply,{month,version:2}),()=>svc.submitPlan(f.users.supply2,{month,version:2}));assert.equal(resends.filter(r=>r.ok).length,1);
  assert.equal(row(f).creator_id,f.users.supply2.id);assert.equal(row(f).version,3);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM approval_requests').get().n,1);
  assert.equal(logs(f).length,2);
});

test('重新送审和运营更新并发时阻止过期需求被锁定',async()=>{
  const f=systemFixture();await submissions(f);seedMonthly(f);await withdraw(f);
  const result=await race(f,()=>svc.submitPlan(f.users.supply,{month,version:2}),()=>svc.monthlySubmit(f.users.indonesia,{month,site:'印尼',channel:'TikTok',items:[{sku:'BAG-A',qty:20,reason:'修改最新备货数量'}]}));
  assert.equal(result[0].ok,false);assert.equal(result[1].ok,true);assert.equal(row(f).status,'withdrawn');
  await svc.submitPlan(f.users.supply,{month,version:2});assert.equal(total(f),20);
});

test('真实 API 动作接通撤回，越权请求不写入；首次送审记录完整快照',async()=>{
  const f=systemFixture();await submissions(f);seedMonthly(f);f.sqlite.prepare('DELETE FROM approval_requests').run();
  const plan=await(await svc.submitPlan(f.users.supply,{month})).json();assert.equal(plan.version,1);assert.equal(logs(f)[0].detail.plan.items[0].total,10);
  const request=()=>new Request('http://localhost/api/system',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'withdrawPlan',approvalId:plan.approvalId,version:1,reason:'核对后重新送审'})});
  svc.setActor(f.users.admin);assert.equal((await svc.POST(request())).status,403);
  svc.setActor(f.users.supply);const result=await svc.POST(request());assert.equal(result.status,200);assert.equal(row(f).status,'withdrawn');
});
