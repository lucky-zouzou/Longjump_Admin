import test from 'node:test';
import assert from 'node:assert/strict';
import {svc,systemFixture,seedMonthly,race} from './system-fixture.mjs';
import {inspectPlanInventory,checkPlanInventory} from '../lib/plan-integrity.mjs';
const items=[{sku:'BAG-A',allocations:[{site:'印尼',channel:'TikTok'}]}];
const approve=(f,id,extra={})=>svc.decideApproval(f.users.admin,{approvalId:id,version:1,decision:'approve',comment:'已核对负库存来源，继续备货并另行盘点',...extra});
const negative=f=>f.sqlite.prepare("UPDATE inventory_balances SET qty=-1 WHERE sku='BAG-A' AND site='印尼' AND channel='TikTok'").run();
test('检查去重并区分普通负库存与结构异常，忽略计划外库存',()=>{
 const row={sku:'BAG-A',site:'印尼',channel:'TikTok',qty:-2,reserved_qty:0,pending_shelf_qty:0,quarantine_qty:0};
 const result=inspectPlanInventory([...items,...items],[row,{...row,sku:'OTHER',reserved_qty:-1}]);assert.equal(result.snapshot.length,1);assert.equal(result.warnings,1);assert.equal(result.blocking,0);
 for(const changes of [{reserved_qty:1},{reserved_qty:-1},{pending_shelf_qty:-1},{quarantine_qty:-1}])assert.equal(inspectPlanInventory(items,[{...row,...changes}]).blocking,1);
});
test('负库存必须明确确认最新快照，批准只生成执行单并记录预警、不改库存',async()=>{
 const f=systemFixture(),id=seedMonthly(f);negative(f);const check=await checkPlanInventory(f.db,items);
 await assert.rejects(approve(f,id),/负库存预警/);
 await assert.rejects(approve(f,id,{inventoryAcknowledged:true,inventorySnapshot:[]}),/库存已变化/);
 await approve(f,id,{inventoryAcknowledged:true,inventorySnapshot:check.snapshot});
 assert.equal(f.sqlite.prepare("SELECT qty FROM inventory_balances WHERE sku='BAG-A' AND site='印尼' AND channel='TikTok'").get().qty,-1);
 const log=f.sqlite.prepare("SELECT detail_json FROM audit_logs WHERE entity_type='approval'").get();assert.equal(JSON.parse(log.detail_json).inventoryReview.issues.length,1);assert.equal(JSON.parse(log.detail_json).inventoryReview.acknowledged,true);
 await assert.rejects(approve(f,id),/已处理/);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM series_purchase_orders').get().n,1);
});
test('检查后库存再变化，确认失效并保留待审批状态',async()=>{
 const f=systemFixture(),id=seedMonthly(f);negative(f);const check=await checkPlanInventory(f.db,items);f.sqlite.prepare("UPDATE inventory_balances SET qty=-2 WHERE sku='BAG-A'").run();
 await assert.rejects(approve(f,id,{inventoryAcknowledged:true,inventorySnapshot:check.snapshot}),/库存已变化/);assert.equal(f.sqlite.prepare('SELECT status FROM approval_requests').get().status,'pending');
});
test('提交事务前库存并发变化，整笔审批回滚',async()=>{
 const f=systemFixture(),id=seedMonthly(f);
 const result=await race(f,()=>approve(f,id),async()=>{negative(f);return true;});assert.equal(result.filter(r=>r.ok).length,1);assert.equal(f.sqlite.prepare('SELECT status FROM approval_requests').get().status,'pending');assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM series_purchase_orders').get().n,0);
});
test('库存检查接口只读、校验权限和计划版本',async()=>{
 const f=systemFixture(),id=seedMonthly(f);negative(f);const request=version=>new Request('http://localhost/api/system',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'checkPlanApproval',approvalId:id,version})});
 svc.setActor(f.users.indonesia);assert.equal((await svc.POST(request(1))).status,403);
 svc.setActor(f.users.admin);assert.equal((await svc.POST(request(9))).status,409);const response=await svc.POST(request(1));assert.equal(response.status,200);assert.equal((await response.json()).warnings,1);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM series_purchase_orders').get().n,0);
});
