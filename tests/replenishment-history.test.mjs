import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './fixtures.mjs';
import {readReplenishmentHistory,previousPlanMonth} from '../lib/replenishment-history.mjs';

const now=new Date('2026-11-02T03:00:00Z');
function submit(f,{month='2026-10',site='印尼',channel='TikTok',items=[{sku:'BAG-A',name:'历史商品名',qty:12,reason:'国庆活动备货'}],zero=false,version=1}={}){
  f.sqlite.prepare('INSERT INTO monthly_submissions(id,month,site,channel,items_json,total_qty,actor_id,submitted_at,zero_demand,zero_reason,version) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(`${month}-${site}-${channel}`,month,site,channel,JSON.stringify(items),items.reduce((sum,i)=>sum+i.qty,0),'id-ops',month+'-02T02:00:00Z',zero?1:0,zero?'上月库存充足':'',version);
}
function plan(f,{month='2026-10',status='approved',version=2,items=[{sku:'BAG-A',name:'历史商品名',total:110,allocations:[{site:'印尼',channel:'TikTok',qty:10},{site:'印尼',channel:'Shopee',qty:100}]}]}={}){
  f.sqlite.prepare('INSERT INTO approval_requests(id,type,month,status,stage,creator_id,creator_role,payload_json,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(`plan-${month}`,'monthly_plan',month,status,'admin_review','supply-1','供应链',JSON.stringify({items,seriesOrders:[{factoryName:'秘密工厂',purchasePrice:999}],purchaseDocuments:{secret:'采购条款'}}),version,month+'-03',month+'-04');
}
const read=(f,actor=f.users.admin,input={})=>readReplenishmentHistory(f.db,actor,input,now);

test('默认上月，提交数量和批准分配独立展示，历史不受实时库存影响',async()=>{
  const f=fixture();submit(f,{version:3});plan(f);
  let r=await read(f,f.users.indonesia);
  assert.equal(r.month,'2026-10');assert.equal(r.plan.status,'approved');assert.equal(r.plan.version,2);
  assert.equal(r.submissions[0].version,3);assert.equal(r.rows[0].submittedQty,12);assert.equal(r.rows[0].planQty,10);
  assert.equal(r.rows[0].reason,'国庆活动备货');assert.equal(r.summary.planQty,10);
  f.stock('BAG-A',9999,9999);f.sqlite.prepare("UPDATE sku_settings SET name='最新商品名' WHERE sku='BAG-A'").run();
  assert.deepEqual(await read(f,f.users.indonesia),r);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM audit_logs').get().n,0);
  assert.equal(previousPlanMonth('2026-01'),'2025-12');
  r=await readReplenishmentHistory(f.db,f.users.admin,{},new Date('2026-10-31T16:01:00Z'));assert.equal(r.month,'2026-10');
});

test('运营仅可读取本站渠道，审批原始 payload、采购价和其他站点不得泄漏',async()=>{
  const f=fixture();submit(f);submit(f,{site:'马来西亚',month:'2026-08'});plan(f);plan(f,{month:'2026-07',items:[{sku:'MY-PRIVATE',allocations:[{site:'马来西亚',channel:'TikTok',qty:44}]}]});
  const result=await read(f,f.users.indonesia),json=JSON.stringify(result);
  assert.equal(result.rows.length,1);assert.deepEqual(result.months,['2026-10']);
  for(const secret of ['Shopee','马来西亚','MY-PRIVATE','秘密工厂','采购条款','payload_json','purchasePrice'])assert.equal(json.includes(secret),false,secret);
  for(const input of [{site:'马来西亚'},{channel:'Shopee'}])await assert.rejects(read(f,f.users.indonesia,input),e=>e.status===403);
  assert.equal((await read(f,f.users.indonesia,{month:'2026-07'})).plan,null);
  await assert.rejects(read(f,{...f.users.indonesia,site:null}),e=>e.status===403);
});

test('管理员、供应链、运营主管可筛选站点渠道，其他岗位拒绝访问',async()=>{
  const f=fixture();submit(f);submit(f,{site:'马来西亚'});plan(f);
  for(const actor of [f.users.admin,f.users.supply,{id:'supervisor',role:'运营主管'}]){
    assert.equal((await read(f,actor)).submissions.length,2);
    const r=await read(f,actor,{site:'印尼',channel:'Shopee'});
    assert.equal(r.rows.length,1);assert.equal(r.rows[0].planQty,100);assert.equal(r.rows[0].submittedQty,null);
  }
  for(const role of ['财务','销售','工厂','海运','达人BD','未知'])await assert.rejects(read(f,{id:'no',role}),e=>e.status===403);
});

test('已确认无需备货不同于缺报，没有计划不同于计划量为零',async()=>{
  const f=fixture();submit(f,{items:[],zero:true});
  let r=await read(f,f.users.indonesia);
  assert.equal(r.summary.submittedQty,0);assert.equal(r.summary.planQty,null);assert.equal(r.submissions[0].zeroDemand,true);assert.equal(r.submissions[0].zeroReason,'上月库存充足');
  r=await read(f,f.users.indonesia,{month:'2026-09'});
  assert.equal(r.summary.submittedQty,null);assert.equal(r.summary.planQty,null);assert.deepEqual(r.rows,[]);
  plan(f,{items:[]});r=await read(f,f.users.indonesia);assert.equal(r.plan.status,'approved');assert.equal(r.summary.planQty,0);
});

test('旧月份不受工作区最近100条审批限制，默认上月为空也不悄悄切换',async()=>{
  const f=fixture();submit(f,{month:'2010-01'});plan(f,{month:'2010-01'});
  for(let year=2011;year<2021;year++)for(let m=1;m<=12;m++)plan(f,{month:`${year}-${String(m).padStart(2,'0')}`});
  const r=await read(f,f.users.indonesia,{month:'2010-01'});
  assert.ok(r.months.includes('2010-01'));assert.equal(r.plan.id,'plan-2010-01');assert.equal(r.summary.planQty,10);assert.equal(r.months.length,121);
  const missing=await read(f,f.users.indonesia);assert.equal(missing.month,'2026-10');assert.equal(missing.plan,null);
});

test('待审批、驳回、撤回保留原状态，审批数量不会被误称为已批准',async()=>{
  const f=fixture();submit(f);plan(f,{status:'pending'});
  for(const status of ['pending','rejected','withdrawn']){
    f.sqlite.prepare('UPDATE approval_requests SET status=?').run(status);
    const r=await read(f);assert.equal(r.plan.status,status);assert.equal(r.summary.planQty,110);assert.equal(r.summary.submittedQty,12);
  }
});

test('只在审批中新增或删去的 SKU 仍可核对，不丢失提交原因',async()=>{
  const f=fixture();submit(f);plan(f,{items:[{sku:'BAG-B',name:'新增商品',allocations:[{site:'印尼',channel:'TikTok',qty:8}]}]});
  const r=await read(f,f.users.indonesia);
  assert.deepEqual(r.rows.map(row=>[row.sku,row.submittedQty,row.planQty]),[['BAG-A',12,0],['BAG-B',0,8]]);
  assert.equal(r.summary.skuCount,2);
});

test('非法查询及损坏的历史数据明确报错，不能静默算成零',async()=>{
  const f=fixture();submit(f);plan(f);
  for(const input of [{month:'2026-13'},{month:'2026-1'},{month:"2026-10' OR 1=1"},{site:'未知'},{channel:'线下分销'}])await assert.rejects(read(f,f.users.admin,input),e=>e.status===400);
  f.sqlite.prepare("UPDATE monthly_submissions SET items_json='bad'").run();await assert.rejects(read(f),e=>e.status===409);
  f.sqlite.prepare("UPDATE monthly_submissions SET items_json='[]'").run();await assert.rejects(read(f),e=>e.status===409);
  f.sqlite.prepare('UPDATE monthly_submissions SET total_qty=0').run();
  f.sqlite.prepare("UPDATE approval_requests SET payload_json='{}'").run();await assert.rejects(read(f),e=>e.status===409);
});
