import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './fixtures.mjs';
import {answerWithKnowledge} from '../lib/employee-assistant.mjs';
const questions=[
 '本月各站销售额是多少','这个月哪个站点卖得最差','本月各站广告费花了多少','这个月哪个站点投放效率最低',
 '本月哪个站点贡献利润最少','本月各站一共卖了多少件','本月各站销售目标完成多少','本月印尼业绩怎么样',
 '今天先盯哪件急事','哪个站点最让人操心','印尼 TikTok BAG-A 建议生产多少','菲律宾 TikTok BAG-A 下个月大促货够不够卖',
 '建议启动生产为什么每天变化','菲律宾生产建议比昨天为什么变了','本月菲律宾备货计划到哪一步了','菲律宾11月份的备货计划生产了多少',
 '菲律宾11月份的备货计划发出去了多少','菲律宾11月份的备货计划什么时候可以到','我有哪些待办','我每天需要做什么'
];
test('100个真实问法与岗位组合：无模型仍有台账结果、待核实或权限说明',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());
 const actors=[f.users.admin,f.users.finance,f.users.indonesia,f.users.supply,{id:'factory-matrix',role:'工厂',name:'TEST 工厂'}];
 const u=actors[4];f.sqlite.prepare('INSERT INTO users(id,email,name,role,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(u.id,u.id+'@example.test',u.name,u.role,'2026-11-01','2026-11-01');
 for(const actor of actors)for(const question of questions)await t.test(actor.role+' · '+question,async()=>{
  const r=await answerWithKnowledge(f.db,actor,{question},{now:'2026-11-18T04:00:00Z',apiKey:'',request:()=>assert.fail('本地台账测试不应调用外部服务')});
  assert.ok(r.answer?.length>8);assert.notEqual(r.intent,'unknown');
  assert.doesNotMatch(r.answer,/这道题把我问住了|手册没有覆盖/);
  if(actor.role==='运营'&&question.includes('菲律宾'))assert.match(r.answer,/权限|自己|本站|负责|只能|跨站|账号可以查印尼/);
 });
});
