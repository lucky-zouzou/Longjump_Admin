import test from 'node:test';
import assert from 'node:assert/strict';
import {systemFixture,svc,race} from './system-fixture.mjs';

const input={site:'印尼',channel:'TikTok',sku:'BAG-A',countedQty:93,reason:'已核对盘点报表'};
const read=(f,sql)=>f.sqlite.prepare(sql).get();
const qty=f=>read(f,"SELECT qty FROM inventory_balances WHERE site='印尼' AND channel='TikTok' AND sku='BAG-A'").qty;
const submit=async f=>(await (await svc.submitInventoryCount(f.users.indonesia,input)).json()).id;
const decide=(f,id,decision='approve')=>svc.decideInventoryCount(f.users.admin,{requestId:id,decision,comment:'核对盘点表无误'});

test('盘点依据保留提交快照、实盘、提交人和当前库存；查询遵守站点权限',async()=>{
  const f=systemFixture();try{
    const id=await submit(f);f.stock('BAG-A',8,10);
    svc.setActor(f.users.admin);const data=await (await svc.GET(new Request('http://localhost/api/system'))).json();
    const r=data.countRequests.find(r=>r.id===id);
    assert.equal(r.system_qty,10);assert.equal(r.counted_qty,93);assert.equal(r.current_qty,8);assert.equal(r.creator_name,'印尼运营');assert.ok(r.created_at);
    svc.setActor(f.users.malaysia);assert.deepEqual((await (await svc.GET(new Request('http://localhost/api/system'))).json()).countRequests,[]);
    svc.setActor(f.users.indonesia);assert.equal((await (await svc.GET(new Request('http://localhost/api/system'))).json()).countRequests.length,1);
  }finally{f.sqlite.close();}
});

test('批准把库存设为目标数，记录差额且保留预留/待上架/隔离；重复批准不再写入',async()=>{
  const f=systemFixture();try{
    f.sqlite.prepare("UPDATE inventory_balances SET reserved_qty=2,pending_shelf_qty=3,quarantine_qty=4 WHERE site='印尼' AND channel='TikTok' AND sku='BAG-A'").run();
    const id=await submit(f);const result=await (await decide(f,id)).json();assert.equal(result.delta,83);assert.equal(qty(f),93);
    const balance=read(f,"SELECT * FROM inventory_balances WHERE site='印尼' AND channel='TikTok' AND sku='BAG-A'");
    assert.deepEqual([balance.reserved_qty,balance.pending_shelf_qty,balance.quarantine_qty],[2,3,4]);
    assert.equal(read(f,'SELECT status FROM inventory_count_requests').status,'approved');
    assert.equal(read(f,'SELECT qty_delta FROM inventory_movements').qty_delta,83);
    await assert.rejects(decide(f,id),/已处理/);assert.equal(read(f,'SELECT COUNT(*) n FROM inventory_movements').n,1);
  }finally{f.sqlite.close();}
});

test('无期初库存按0形成差异；批准后只生成一次93件库存',async()=>{
  const f=systemFixture();try{
    const payload={...input,sku:'NEW-COUNT'};
    const id=(await (await svc.submitInventoryCount(f.users.indonesia,payload)).json()).id;
    assert.equal(read(f,'SELECT system_qty FROM inventory_count_requests').system_qty,0);
    await decide(f,id);assert.equal(read(f,"SELECT qty FROM inventory_balances WHERE sku='NEW-COUNT'").qty,93);
  }finally{f.sqlite.close();}
});

test('短意见给出明确原因；库存变化阻止批准；驳回不改库存且可重新提交',async()=>{
  const f=systemFixture();try{
    const id=await submit(f);svc.setActor(f.users.admin);
    const post=comment=>svc.POST(new Request('http://localhost/api/system',{method:'POST',body:JSON.stringify({action:'decideInventoryCount',requestId:id,decision:'approve',comment})}));
    const invalid=await post('同意');assert.equal(invalid.status,400);assert.match((await invalid.json()).error,/至少3个字/);assert.equal(qty(f),10);
    f.stock('BAG-A',8,10);const stale=await post('核对盘点无误');assert.equal(stale.status,409);assert.match((await stale.json()).error,/从10变为8.*驳回/);
    assert.equal(qty(f),8);assert.equal(read(f,'SELECT status FROM inventory_count_requests').status,'pending');
    await decide(f,id,'reject');assert.equal(qty(f),8);assert.equal(read(f,'SELECT COUNT(*) n FROM inventory_movements').n,0);
    assert.ok(await submit(f));
  }finally{f.sqlite.close();}
});

test('无复核权限不能批准；并发批准和驳回仅一次成功，审计与结果一致',async()=>{
  for(const firstDecision of ['approve','reject']){
    const f=systemFixture();try{
      const id=await submit(f);
      await assert.rejects(svc.decideInventoryCount(f.users.indonesia,{requestId:id,decision:'approve',comment:'尝试自行复核'}),/权限/);
      const outcomes=await race(f,()=>decide(f,id,firstDecision),()=>decide(f,id,firstDecision==='approve'?'reject':'approve'));
      assert.equal(outcomes.filter(r=>r.ok).length,1);
      assert.equal(read(f,"SELECT COUNT(*) n FROM audit_logs WHERE action IN ('批准库存盘点差异','驳回库存盘点差异')").n,1);
      assert.equal(qty(f),firstDecision==='approve'?10:93);
    }finally{f.sqlite.close();}
  }
});
