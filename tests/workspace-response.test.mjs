import test from 'node:test';
import assert from 'node:assert/strict';
import {parseWorkspaceResponse} from '../lib/workspace-response.mjs';
import {systemFixture,svc} from './system-fixture.mjs';
import {NAVIGATION_BY_ROLE} from '../lib/permissions.mjs';

test('异常200、代理HTML和缺失身份不能替换已可用的工作区快照',async()=>{
 const good={module:'overview',actor:{id:'admin',role:'管理员'},myTasks:[],metrics:{},monthlyStatus:[],issues:[]};
 let current=await parseWorkspaceResponse(Response.json(good),{snapshot:true});
 for(const bad of [null,[],{}, {...good,actor:null},{...good,myTasks:null},{...good,issues:null},{...good,actor:{id:'x',role:'unknown'}},{error:'维护中'}]){
  await assert.rejects(async()=>{current=await parseWorkspaceResponse(Response.json(bad),{snapshot:true});});
  assert.deepEqual(current,good);
 }
 await assert.rejects(parseWorkspaceResponse(new Response('<html>proxy error</html>')),/无法识别/);
 await assert.rejects(parseWorkspaceResponse(Response.json({error:'登录已过期'},{status:401})),/登录已过期/);
 await assert.rejects(parseWorkspaceResponse(Response.json(null,{status:500})),/操作失败/);
});

test('九种角色所有导航模块返回可渲染快照，禁止模块仍返回403',async()=>{
 const f=systemFixture();try{
  for(const [role,modules] of Object.entries(NAVIGATION_BY_ROLE)){
   const actor={...f.users.admin,role,site:'印尼',channel:'TikTok'};svc.setActor(actor);
   for(const module of modules){
    const response=await svc.GET(new Request(`http://localhost/api/system?module=${module}`));
    assert.equal(response.status,200,`${role}/${module}: ${await response.clone().text()}`);
    const raw=await response.clone().json();let result;
    try{result=await parseWorkspaceResponse(response,{snapshot:true});}catch(e){throw Error(`${role}/${module}: ${e.message}; fields=${JSON.stringify(Object.fromEntries(Object.entries(raw).map(([k,v])=>[k,Array.isArray(v)?'array':typeof v])))}`);}
    assert.equal(result.actor.role,role);
   }
   if(role!=='管理员')assert.equal((await svc.GET(new Request('http://localhost/api/system?module=users'))).status,403);
  }
 }finally{f.sqlite.close();}
});

test('成本工作区不重复构建全局预测，供应参数查询故障不阻断独立入口',async()=>{
 const f=systemFixture();try{
  const prepare=f.db.prepare.bind(f.db);f.db.prepare=sql=>{
   if(sql.includes('FROM supply_policies'))throw Error('模拟供应参数查询故障');
   return prepare(sql);
  };
  svc.setActor(f.users.admin);
  const r=await svc.GET(new Request('http://localhost/api/system?module=cost-profit'));
  assert.equal(r.status,200,await r.clone().text());assert.equal((await parseWorkspaceResponse(r,{snapshot:true})).module,'cost-profit');
 }finally{f.sqlite.close();}
});
