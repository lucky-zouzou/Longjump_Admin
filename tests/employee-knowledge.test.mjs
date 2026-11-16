import assert from 'node:assert/strict';
import test from 'node:test';
import {fixture} from './fixtures.mjs';
import {answerWithKnowledge,assistantHome} from '../lib/employee-assistant.mjs';
import {recentKnowledge} from '../lib/employee-knowledge.mjs';

const time='2026-11-16T04:00:00.000Z';
function setup(t){
  const {db,sqlite,users}=fixture();
  const id=crypto.randomUUID();
  sqlite.prepare('INSERT INTO users(id,email,name,role,created_at,updated_at) SELECT ?,?,name,role,created_at,updated_at FROM users WHERE id=?').run(id,id+'@example.test',users.admin.id);
  users.admin={...users.admin,id};
  t.after(()=>sqlite.close());
  return {db,sqlite,users,ask:(actor,question,input={},options={})=>answerWithKnowledge(db,actor,
    {question,...input},{now:time,...options})};
}
test('同岗位跨页面复用；手册修订后重新生成，其他岗位不能按编号读取',async t=>{
  const {db,sqlite,users,ask}=setup(t);
  const first=await ask(users.admin,'拍摄需求怎么填？',{page:'overview'});
  assert.equal(first.guide.id,'shoot-request');assert.equal(first.saved,true);
  const reused=await ask(users.admin,'拍摄需求怎么填',{page:'content-center'});
  assert.equal(reused.source,'knowledge');
  const [topic]=await recentKnowledge(db,users.admin,time);
  assert.equal(topic.title,first.guide.title);
  const other=await ask(users.finance,topic.title,{knowledgeId:topic.key,mode:'internal'});
  assert.equal(other.guide,null);
  sqlite.prepare("UPDATE employee_knowledge SET revision='old'").run();
  assert.equal((await ask(users.admin,'拍摄需求怎么填')).source,'handbook');
  assert.equal(sqlite.prepare('SELECT count(*) n FROM employee_knowledge').get().n,1);
});
test('手册追问定位指定步骤；实时数字、未解答问题和内部联系方式不入库',async t=>{
  const {users,sqlite,ask}=setup(t);
  const reply=await ask(users.admin,'第 2 步呢？',{previous:'shoot-request'});
  assert.equal(reply.intent,'step');assert.equal(reply.answer,reply.guide.steps[1]);
  const count=()=>sqlite.prepare('SELECT count(*) n FROM employee_knowledge').get().n;
  assert.equal(count(),1);
  assert.equal((await ask(users.admin,'今天销售额是多少')).intent,'live');
  assert.equal((await ask(users.admin,'如何做手工蜡烛',{mode:'internal'})).intent,'unknown');
  let calls=0;
  await ask(users.admin,'客户电话是08123456789，查这个人',{mode:'public'},{request:async()=>{calls++;throw Error();}});
  assert.equal(calls,0);assert.equal(count(),1);
});
test('公开指标附年度出处，重复问题按时效复用，过期或明确问最新时重新取数',async t=>{
  const {ask,users}=setup(t);let calls=0;
  const options={request:async url=>{
    assert.match(url,/api\.worldbank\.org/);calls++;
    return Response.json([{},[{date:'2024',value:1000}]]);
  }};
  const first=await ask(users.admin,'印尼2024年总人口是多少',{},options);
  assert.equal(first.source,'public-data');assert.equal(first.saved,true);
  assert.match(first.answer,/2024.*1,000/);assert.equal(first.citations.length,1);
  assert.equal((await ask(users.admin,'印尼2024年总人口是多少',{},options)).source,'knowledge');
  await ask(users.admin,'印尼2024年总人口是多少',{}, {...options,now:'2026-11-18T04:00:00.000Z'});
  const recent=await ask(users.admin,'印尼最新总人口',{},options);
  await ask(users.admin,'查看',{mode:'public',knowledgeId:recent.topic.key},options);
  assert.equal(calls,4);
});
test('通用公开答案必须完成检索并提供出处；额度或来源不足时不写知识库',async t=>{
  const {ask,users,sqlite}=setup(t);
  const question='公开查询 Shopee 最新官方政策';
  let response=Response.json({error:{code:'credit_balance_exhausted'}},{status:429});
  const options={apiKey:'test',request:async(url,init)=>{
    assert.equal(url,'https://api.openai.com/v1/responses');
    assert.ok(JSON.parse(init.body).tools[0].filters.allowed_domains.includes('shopee.co.id'));
    return response.clone();
  }};
  const limited=await ask(users.admin,question,{},options);
  assert.equal(limited.source,'public-unavailable');assert.match(limited.answer,/额度/);
  const web=(url,completed=true)=>Response.json({status:'completed',output:[
    {type:'web_search_call',status:completed?'completed':'in_progress'},
    {type:'message',content:[{type:'output_text',text:'公开核对结果',annotations:[{type:'url_citation',url,title:'来源',start_index:6,end_index:6}]}]}
  ]});
  for(const bad of [web('https://other.example'),web('https://seller.shopee.co.id',false)]){
    response=bad;assert.equal((await ask(users.admin,question,{},options)).source,'public-unavailable');
  }
  assert.equal(sqlite.prepare('SELECT count(*) n FROM employee_knowledge').get().n,0);
  response=web('https://seller.shopee.co.id');
  assert.equal((await ask(users.admin,question,{},options)).source,'public-web');
});
test('公开术语读取官方页面，退出备份锁后才记录为可复用',async t=>{
  const {ask,users,sqlite}=setup(t);
  const options={request:async url=>{
    assert.match(url,/support\.google\.com/);return new Response('<article>展示次数、点击次数、点击率</article>');
  }};
  sqlite.prepare("INSERT OR REPLACE INTO system_maintenance(id,mode,expires_at,updated_at) VALUES('global','backup','2099-01-01','2026-11-16')").run();
  const response=await ask(users.admin,'什么是 CTR',{},options);
  assert.equal(response.source,'public-data');assert.match(response.notice,/暂未写入/);
  sqlite.prepare("DELETE FROM system_maintenance WHERE id='global'").run();
  assert.equal((await ask(users.admin,'什么是 CTR',{},options)).saved,true);
});

test('欢迎语与系统用途分别展示；当前页的操作受岗位限制，同一句页面问题按页面回答',async t=>{
  const {users,ask}=setup(t);
  const home=assistantHome(users.admin,'batches');
  assert.equal(home.intro,'是什么风把你给吹来了，有什么问题尽管问吧。');
  assert.deepEqual(home.suggestions.map(g=>g.id),['shipping']);
  assert.deepEqual(assistantHome({role:'工厂'},'approval').suggestions,[]);
  assert.match((await ask(users.admin,'系统是做什么的？')).answer,/每日销售/);
  const q='这个页面怎么用？';
  assert.equal((await ask(users.admin,q,{page:'batches'})).guide.id,'shipping');
  assert.equal((await ask(users.admin,q,{page:'sales'})).guide.id,'sales-check');
  const multiple=await ask(users.admin,q,{page:'cost-profit'});
  assert.ok(multiple.choices.some(g=>g.id==='finance-close'));
  assert.equal(multiple.guide,null);
  assert.deepEqual((await ask(users.admin,q,{page:'no-such-page'})).choices,[]);
});

test('按手册逐步追问直到交接；缓存区分步骤，明确换题不沿用上一项',async t=>{
  const {users,ask}=setup(t);
  const a=users.admin,previous='sales-check',q='下一步怎么做？';
  const next=n=>ask(a,q,{previous,previousStep:n});
  const one=await next(0),two=await next(1);
  assert.equal(one.step,1);assert.equal(one.answer,one.guide.steps[0]);
  assert.equal(two.step,2);assert.equal(two.answer,two.guide.steps[1]);
  const replay=await next(1);assert.equal(replay.source,'knowledge');assert.equal(replay.step,2);
  const end=await next(one.guide.steps.length);assert.equal(end.intent,'handoff');assert.equal(end.answer,one.guide.next);
  assert.equal((await ask(a,'这个月的海运轨迹怎么查？',{previous})).guide.id,'shipping');
  assert.equal((await ask(a,'谁来接手？',{previous})).answer,one.guide.next);
  assert.equal((await ask(a,q,{previous:'no-such-guide'})).guide,null);
});
