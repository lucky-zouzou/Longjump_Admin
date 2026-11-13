import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkspaceLoader} from '../lib/workspace-loader.mjs';
import {systemFixture,svc} from './system-fixture.mjs';
import {moduleSnapshot} from '../lib/workspace-model.mjs';
import {parseWorkspaceResponse} from '../lib/workspace-response.mjs';

function controlledLoader(){
  const calls=[];
  const loader=createWorkspaceLoader((page,signal)=>new Promise((resolve,reject)=>calls.push({page,signal,resolve,reject})));
  return {loader,calls};
}
test('并发自动刷新合并为一次请求；完成后下一次读取仍取得新数据',async()=>{
  const {loader,calls}=controlledLoader();
  const first=loader.load('overview'),second=loader.load('overview');
  assert.equal(first,second);await Promise.resolve();assert.equal(calls.length,1);
  calls[0].resolve({version:1});assert.deepEqual(await first,{version:1});
  const next=loader.load('overview');await Promise.resolve();assert.equal(calls.length,2);
  calls[1].resolve({version:2});assert.deepEqual(await next,{version:2});
});
test('快速切换取消旧请求；即使底层忽略取消，迟到结果也不能覆盖新页面',async()=>{
  const {loader,calls}=controlledLoader();
  const old=loader.load('overview');await Promise.resolve();
  const next=loader.load('inventory');await Promise.resolve();assert.equal(calls[0].signal.aborted,true);
  calls[1].resolve({module:'inventory'});assert.deepEqual(await next,{module:'inventory'});
  calls[0].resolve({module:'overview'});assert.equal(await old,undefined);
});
test('保存后强制刷新不用提交前的在途快照；卸载后不显示取消错误',async()=>{
  const {loader,calls}=controlledLoader();
  const old=loader.load('overview');await Promise.resolve();
  const fresh=loader.load('overview',{force:true});await Promise.resolve();assert.equal(calls[0].signal.aborted,true);
  calls[0].reject(new Error('aborted'));assert.equal(await old,undefined);
  calls[1].resolve({stock:8});assert.deepEqual(await fresh,{stock:8});
  const unmounted=loader.load('overview');await Promise.resolve();loader.cancel();
  assert.equal(calls[2].signal.aborted,true);calls[2].reject(new Error('aborted'));assert.equal(await unmounted,undefined);
});
test('真实失败不吞掉；失败后的重试可以成功',async()=>{
  const {loader,calls}=controlledLoader();const failed=loader.load('overview');await Promise.resolve();
  calls[0].reject(new Error('timeout'));await assert.rejects(failed,/timeout/);
  const retry=loader.load('overview');await Promise.resolve();calls[1].resolve({ok:true});assert.deepEqual(await retry,{ok:true});
});

test('总览和库存摘要保持完整统计及权限，但不读取历史备货核算和无关附件',async()=>{
  const f=systemFixture();try {
    for(const actor of [f.users.admin,f.users.indonesia,f.users.finance]){
      svc.setActor(actor);
      const full=await(await svc.GET(new Request('http://localhost/api/system'))).json();
      const prepare=f.db.prepare,queries=[];
      f.db.prepare=sql=>{queries.push(sql);return prepare(sql);};
      try {
        for(const module of ['overview','inventory']){
          // Finance may not have inventory navigation; the authorization remains unchanged.
          const response=await svc.GET(new Request('http://localhost/api/system?module='+module));
          if(response.status===403){assert.equal(actor.role,'财务');continue;}
          const actual=await parseWorkspaceResponse(response,{snapshot:true}),expected=moduleSnapshot(full,module);
          delete actual.generatedAt;delete expected.generatedAt;
          assert.deepEqual(actual,expected);
        }
      } finally {f.db.prepare=prepare;}
      assert.ok(!queries.some(sql=>sql.includes('FROM forecast_snapshots')));
      assert.ok(!queries.some(sql=>sql.includes('FROM inbound_documents')));
      assert.ok(!queries.some(sql=>/SELECT \* FROM sales_ad_spend/.test(sql)));
    }
  }finally{f.sqlite.close();}
});
test('月度清仓入口不查询全站预测与生产明细，待办保持一致',async()=>{
  const f=systemFixture();try {
    svc.setActor(f.users.admin);
    const full=await(await svc.GET(new Request('http://localhost/api/system'))).json();
    const prepare=f.db.prepare,queries=[];f.db.prepare=sql=>{queries.push(sql);return prepare(sql);};
    const fast=await parseWorkspaceResponse(await svc.GET(new Request('http://localhost/api/system?module=clearance')),{snapshot:true});
    assert.deepEqual(fast.myTasks,full.myTasks);assert.deepEqual(fast.metrics,{});
    assert.ok(!queries.some(sql=>sql.includes('FROM forecast_snapshots')||/SELECT \* FROM series_production_order_items/.test(sql)));
  }finally{f.sqlite.close();}
});
test('历史计划一次汇总保留月份、站点、平台、冲销和退货口径；运营仅见本人范围',async()=>{
  const f=systemFixture();try {
    const snap=f.sqlite.prepare('INSERT INTO forecast_snapshots(id,month,sku,site,channel,system_qty,forecast_sales,operator_qty,model_json,created_at) VALUES(?,?,?,?,?,10,20,10,?,?)');
    for(const [id,month,site,channel,model] of [['oct','2026-10','印尼','TikTok','{}'],['nov','2026-11','印尼','TikTok','{"forecastReady":false,"suggestedProduction":null}'],['shopee','2026-10','印尼','Shopee','{}'],['my','2026-10','马来西亚','TikTok','{}']])snap.run(id,month,'BAG-A',site,channel,model,'2026-10-01');
    const sale=f.sqlite.prepare('INSERT INTO sales_records(id,import_id,business_date,site,channel,sku,qty,actor_id,created_at,reversed_at) VALUES(?,?,?,?,?,?,?,?,?,?)');
    for(const [id,day,site,channel,qty,reversed] of [['a','2026-10-01','印尼','TikTok',12,null],['b','2026-10-31','印尼','TikTok',8,null],['c','2026-11-01','印尼','TikTok',5,null],['d','2026-10-01','印尼','TikTok',99,'2026-10-02'],['e','2026-10-01','印尼','Shopee',6,null],['f','2026-10-01','马来西亚','TikTok',7,null]])sale.run(id,id,day,site,channel,'BAG-A',qty,f.users.admin.id,day,reversed);
    f.sqlite.exec("INSERT INTO sales_imports(id,import_key,business_date,site,channel,row_count,total_qty,actor_id,created_at,reversed_at) SELECT import_id,import_id,business_date,site,channel,1,qty,actor_id,created_at,reversed_at FROM sales_records");
    f.sqlite.prepare("INSERT INTO sales_demand_corrections(id,sku,site,channel,business_date,return_qty,reason,actor_id,updated_at) VALUES('return','BAG-A','印尼','TikTok','2026-10-15',3,'退货',?,'2026-10-15')").run(f.users.admin.id);
    svc.setActor(f.users.admin);
    const all=await(await svc.GET(new Request('http://localhost/api/system?module=suggestions'))).json();
    assert.deepEqual(Object.fromEntries(all.forecastHistory.map(r=>[r.id,r.actual_sales])),{nov:5,oct:17,shopee:6,my:7});
    const pending=all.forecastHistory.find(r=>r.id==='nov');assert.equal(pending.system_qty,null);assert.equal(pending.forecast_sales,null);
    svc.setActor(f.users.indonesia);
    const own=await(await svc.GET(new Request('http://localhost/api/system?module=suggestions'))).json();
    assert.deepEqual(own.forecastHistory.map(r=>r.id),['nov','oct']);
  }finally{f.sqlite.close();}
});
