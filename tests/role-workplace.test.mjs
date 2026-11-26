import test from 'node:test';
import assert from 'node:assert/strict';
import {ROLE_PERMISSIONS} from '../lib/permissions.mjs';
import {personalWorkplaceEntries,workplaceSection,workplaceScope,financeWorkplaceTabs} from '../lib/role-workplace.mjs';
import {workplaceFixture} from './workplace-fixture.mjs';
import {readAttendance,mutateLeave,punch} from '../lib/attendance.mjs';
import {readExpenses} from '../lib/finance-workbench.mjs';
import {workplaceCsv} from '../lib/workplace-export.mjs';
import {workplaceTasks} from '../lib/workplace-tasks.mjs';

test('每个岗位都有本人打卡和请假；运营办理广告，管理员与财务进入审批',()=>{
 for(const role of Object.keys(ROLE_PERMISSIONS)){
  const entries=personalWorkplaceEntries({role});
  assert.deepEqual(entries.slice(0,2).map(x=>[x.page,x.view]),[['attendance','mine'],['attendance','leave']],role);
  assert.equal(entries.some(x=>x.view==='advertising'),role==='运营',role);
  assert.equal(entries.some(x=>x.view==='advertising-trend'),['运营','运营主管'].includes(role),role);
 }
 for(const role of ['管理员','财务']){
  assert.equal(workplaceSection({role},'finance-workbench','advertising'),'advertising-approvals');
  assert.equal(workplaceSection({role},'finance-workbench','advertising-trend'),'expenses');
  assert.deepEqual(financeWorkplaceTabs({role},{advertisingApprovals:true}).map(x=>x.view),['advertising-approvals','expenses']);
 }
 assert.equal(workplaceSection({role:'工厂'},'attendance',''),'mine');
 assert.equal(workplaceScope('attendance','leave'),'mine');
 assert.equal(workplaceScope('attendance','approvals'),'authorized');
 assert.equal(workplaceScope('finance','advertising'),'mine');
 assert.equal(workplaceScope('finance','advertising-approvals'),'authorized');
});

test('主管个人出勤与导出不夹带团队记录；审批入口保留团队待办',async()=>{
 const f=await workplaceFixture();try{
  await punch(f.db,f.users.indonesia,{kind:'in'},new Date('2026-11-23T02:00:00Z'));
  const request=await mutateLeave(f.db,f.users.indonesia,{action:'leaveCreate',date:'2026-11-24',portion:'full',reason:'TEST handover',operationId:crypto.randomUUID()});
  const team=await readAttendance(f.db,f.users.manager,{month:'2026-11'});
  assert.ok(team.requests.some(r=>r.id===request.id&&r.canManager));
  const mine=await readAttendance(f.db,f.users.manager,{month:'2026-11',scope:'mine'});
  assert.equal(mine.access.attendanceManagement,true);
  assert.equal(mine.scope,'mine');assert.deepEqual(mine.requests,[]);assert.deepEqual(mine.days,[]);assert.deepEqual(mine.events,[]);
  assert.equal(mine.configuration.canConfigure,false);assert.deepEqual(mine.configuration.grants,[]);
  assert.doesNotMatch(workplaceCsv(mine,'attendance'),/TEST-ONLY id-ops/);
  assert.ok((await workplaceTasks(f.db,f.users.manager)).some(t=>t.entity===request.id&&t.view==='approvals'));
  const admin=await readAttendance(f.db,f.users.admin,{scope:'mine'});
  assert.equal(admin.access.attendanceManagement,true);assert.equal(admin.configuration.canConfigure,false);assert.deepEqual(admin.configuration.users,[]);
  assert.equal(admin.feishu.configuration,undefined);
 }finally{f.sqlite.close();}
});

test('个人费用的列表、汇总、审计和导出与审批范围分开，授权不会被入口扩大',async()=>{
 const f=await workplaceFixture();try{
  const id=await f.expense();
  const review=await readExpenses(f.db,f.users.manager,{month:'2026-09'});
  assert.ok(review.requests.some(r=>r.id===id&&r.canManager));
  const mine=await readExpenses(f.db,f.users.manager,{month:'2026-09',scope:'mine'});
  assert.equal(mine.access.advertisingApprovals,true);
  for(const key of ['requests','summary','budgetSummary','bills','events'])assert.deepEqual(mine[key],[],key);
  assert.doesNotMatch(workplaceCsv(mine,'finance'),/TEST ENTITY ID/);
  const ordinary=await readExpenses(f.db,f.users.studio);
  assert.equal(ordinary.access.advertisingApprovals,false);
  assert.equal(financeWorkplaceTabs(ordinary.actor,ordinary.access).some(t=>t.view==='advertising-approvals'),false);
  await assert.rejects(f.change(f.users.admin,id,'managerApprove'),e=>e.status===403);
 }finally{f.sqlite.close();}
});
