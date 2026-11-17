import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './fixtures.mjs';
import {answerWithKnowledge} from '../lib/employee-assistant.mjs';
import {saveGuideFeedback} from '../lib/employee-learning.mjs';

const question='请问一下，咱们的出海小本本咋翻呀？',other='小品同学，咱们的出海小本本怎么翻？',page='overview';
function setup(t){
  const {db,sqlite,users}=fixture();t.after(()=>sqlite.close());
  const teach=(actor,guideId,extra={})=>saveGuideFeedback(db,actor,{question,page,guideId,...extra});
  const ask=(actor,q=other,extra={})=>answerWithKnowledge(db,actor,{question:q,page,...extra});
  return {db,sqlite,users,teach,ask};
}

test('纠正问法即时生效，换种口语也能认，改选和撤回都生效，不保存原问题',async t=>{
  const {users,teach,ask,sqlite}=setup(t),a=users.admin;
  const before=await ask(a);assert.equal(before.learnable,true);assert.notEqual(before.source,'learned-guide');
  await teach(a,'shipping');await teach(a,'shipping');
  let response=await ask(a);assert.equal(response.source,'learned-guide');assert.equal(response.personalMatch,true);assert.equal(response.guide.id,'shipping');
  const rows=sqlite.prepare('SELECT * FROM employee_guide_feedback').all();
  assert.equal(rows.length,1);assert.match(rows[0].question_key,/^[0-9a-f]{64}$/);assert.ok(!JSON.stringify(rows).includes('小本本'));
  assert.notEqual((await ask(a,other,{page:'batches'})).source,'learned-guide');
  await teach(a,'shoot-request');assert.equal((await ask(a)).guide.id,'shoot-request');
  const pack={guides:[{id:'new-process',title:'新操作',page:'overview',keywords:['新流程'],roles:['管理员'],steps:['到总览看提醒'],next:'交给同事'}]};
  await teach({...a,handbook:pack},'new-process');
  pack.guides[0].steps=['到总览核对最新流程'];
  assert.deepEqual((await ask({...a,handbook:pack})).guide.steps,['到总览核对最新流程']);
  assert.notEqual((await ask(a)).source,'learned-guide');
  await teach(a,'',{forget:true});assert.equal(sqlite.prepare('SELECT count(*) n FROM employee_guide_feedback').get().n,0);
});
test('同岗位两个不同在职账号一致后才复用，分歧、停用、跨岗位与当前权限逐项校验',async t=>{
  const {users,teach,ask,sqlite}=setup(t),a=users.admin;
  const copy=id=>{sqlite.prepare('INSERT INTO users(id,email,name,role,created_at,updated_at) SELECT ?,?,name,role,created_at,updated_at FROM users WHERE id=?').run(id,id+'@example.test',a.id);return {...a,id};};
  const b=copy('second'),c=copy('third'),d=copy('fourth');
  await teach(a,'shipping');await teach(a,'shipping');
  assert.notEqual((await ask(c)).source,'learned-guide');await teach(b,'shipping');
  assert.equal((await ask(c)).personalMatch,false);assert.equal((await ask(c)).guide.id,'shipping');
  assert.notEqual((await ask(users.supply)).source,'learned-guide');
  await teach(c,'shoot-request');assert.equal((await ask(c)).guide.id,'shoot-request');assert.notEqual((await ask(d)).source,'learned-guide');
  await teach(c,'',{forget:true});sqlite.prepare('UPDATE users SET active=0 WHERE id=?').run(b.id);
  assert.notEqual((await ask(d)).source,'learned-guide');
  await assert.rejects(teach(users.malaysia,'wholesale'),{status:403});
  sqlite.exec("UPDATE users SET role='财务' WHERE id='admin-1'");
  await assert.rejects(teach(a,'shipping'),{status:409});
});
test('实时库存持续查账，敏感问题和无权入口拒绝学习，备份期间禁止更改',async t=>{
  const {users,teach,ask,sqlite}=setup(t),a=users.admin;
  await assert.rejects(teach(a,'shipping',{question:'印尼可售库存有多少件？'}),{status:400});
  await assert.rejects(teach(a,'shipping',{question:'客户电话 081234567890 如何保存？'}),{status:400});
  await assert.rejects(teach(users.malaysia,'sales-import',{page:'users'}),{status:400});
  assert.equal((await ask(a,'印尼可售库存有多少件？')).source,'ledger');
  sqlite.exec("INSERT INTO system_maintenance VALUES('global','backup','hash','admin-1','2099-01-01','2026-11-17')");
  await assert.rejects(teach(a,'shipping'),{status:409});
});
test('小品说明本环境模型配置与本地学习方式，不花费项目额度',async t=>{
  const {db,users}=setup(t);
  const ask=(question,apiKey)=>answerWithKnowledge(db,users.admin,{question},{apiKey,request:()=>assert.fail('询问能力不应调用外网')});
  assert.match((await ask('系统可以和ChatGPT打通了？','fixture')).answer,/已经配置.*GPT-5.4 mini/);
  assert.match((await ask('你接入OpenAI了吗？','')).answer,/配置 OpenAI 项目密钥后/);
  assert.match((await ask('小品同学，你能自己训练自己吗？','')).answer,/对，就是这条/);
});
