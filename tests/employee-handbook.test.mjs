import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {parseHandbook} from '../lib/employee-handbook.mjs';
import {currentHandbook,importHandbook} from '../lib/employee-handbook-store.mjs';
import {answerEmployee,assistantHome,answerWithKnowledge} from '../lib/employee-assistant.mjs';
import {fixture} from './fixtures.mjs';

const topic={id:'fixture-procedure',page:'users',roles:['管理员'],keywords:['专门操作'],title:'示例流程',steps:['示例第一步','示例第二步'],next:'演示核对人接手。'};
function pack(t,entry=topic){
 const data=parseHandbook({format:1,edition:'测试版',guides:[entry]});return {...data,revision:createHash('sha256').update(JSON.stringify(data)).digest('hex')};
}
test('同一私有手册可直接回答和追问；页面、菜单和模型均遵守岗位范围',async t=>{
 const handbook=pack(t),admin={role:'管理员',id:'staff',handbook},factory={role:'工厂',id:'fac',handbook};
 assert.equal(assistantHome(admin).edition,'测试版');
 assert.equal((await answerEmployee(admin,{question:'专门操作怎么做'})).guide.id,topic.id);
 assert.equal((await answerEmployee(admin,{question:'第二步呢',previous:topic.id})).answer,topic.steps[1]);
 assert.ok(!assistantHome(factory).guides.some(g=>g.id===topic.id));
 assert.equal((await answerEmployee(factory,{question:'专门操作怎么做',guideId:topic.id})).guide,null);
});
test('手册修订后同一句话按新版本回答，知识库能继续复用',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());
 const ask=(handbook)=>answerWithKnowledge(f.db,{...f.users.admin,handbook},{question:'专门操作怎么做'});
 const old=pack(t);assert.equal((await ask(old)).source,'handbook');assert.equal((await ask(old)).source,'knowledge');
 const changed=pack(t,{...topic,steps:['新的办理方法']});
 assert.deepEqual((await ask(changed)).guide.steps,['新的办理方法']);
});
test('未导入时支持原手册；无效条目及覆盖内置指引明确失败',t=>{
 assert.equal(assistantHome({role:'工厂'}).edition,undefined);
 for(const invalid of [{...topic,id:'finance-day'},{...topic,page:'unknown'},{...topic,roles:['合作方']},{...topic,steps:[]}]){
  assert.throws(()=>pack(t,invalid),/Invalid handbook procedure/);
 }
});

test('管理员首发及修订留历史，同版重传幂等，非管理员与过期覆盖均被拒绝',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());const admin=f.users.admin;
 const base={format:1,edition:'v1',guides:[topic]};assert.equal(await currentHandbook(f.db),null);
 await assert.rejects(()=>importHandbook(f.db,{...admin,role:'财务'},base,''),{status:403});
 const one=await importHandbook(f.db,admin,base,'');await importHandbook(f.db,admin,base,'');
 assert.equal((await currentHandbook(f.db)).revision,one.revision);
 const next={...base,edition:'v2'};await assert.rejects(()=>importHandbook(f.db,admin,next,''),{status:409});
 await importHandbook(f.db,admin,next,one.revision);assert.equal((await currentHandbook(f.db)).edition,'v2');
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM employee_handbooks').get().n,2);
});

test('岗位日程识别自然问句，区分代问、具体操作和实时数值，复用时仍校验权限',async t=>{
  const f=fixture();t.after(()=>f.sqlite.close());
  const entry=(id,role,page)=>({...topic,id,page,title:role+'日常示例',roles:[...new Set([role,'管理员'])],dailyRole:role});
  const ops=entry('fixture-routine-ops','运营','sales'), admin=entry('fixture-routine-admin','管理员','overview');
  const handbook={...parseHandbook({format:1,edition:'test',guides:[ops,admin]}),revision:'test-1'};
  const options={apiKey:'offline-test',request:()=>assert.fail('unexpected upstream call')};
  const ask=(a,question,extra={})=>answerWithKnowledge(f.db,{...a,handbook},{question,...extra},options);
  const exact='我是一名新入职的运营，我每天需要做什么';
  assert.equal((await ask(f.users.admin,exact)).guide.id,ops.id);
  assert.equal((await ask(f.users.admin,exact,{page:'sales'})).source,'knowledge');
  assert.equal((await ask(f.users.admin,'第二步呢',{previous:ops.id})).answer,ops.steps[1]);
  assert.equal((await ask(f.users.admin,'今天上班我先做什么？')).guide.id,admin.id);
  const operator=Object.values(f.users).find(a=>a.role==='运营');
  for(const q of [exact,'小品同学，作为站点运营，日常工作怎么安排？','我每天都要做哪些事','我刚入职，从哪里开始？','运营一天要干嘛','上班第一件事是什么','我的岗位是运营，主要职责是什么？'])
    assert.equal((await ask(operator,q)).guide.id,ops.id);
  assert.equal((await ask(operator,'刚入职，如何导入销售日报？')).guide.id,'sales-import');
  assert.equal((await ask(operator,'昨天的销售额是多少？')).intent,'live');
  assert.equal((await ask(operator,'管理员每天需要做什么？')).guide,null);
  assert.throws(()=>parseHandbook({format:1,edition:'bad',guides:[ops,{...ops,id:'another'}]}),/daily handbook/);
  assert.throws(()=>parseHandbook({format:1,edition:'bad',guides:[{...ops,dailyRole:'工厂'}]}),/daily handbook/);
});
