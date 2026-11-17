import {navigationForActor} from '../lib/permissions.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {claimReminder,rankedReminderTasks} from '../lib/login-task-reminder.mjs';
import {workspaceTasks} from '../lib/workspace-tasks.mjs';
import {reviewPeriod,reviewToday} from '../lib/business-review-model.mjs';
import {answerWithKnowledge} from '../lib/employee-assistant.mjs';
import {systemFixture} from './system-fixture.mjs';

test('同次登录只主动提醒一次，重新登录和换账号分别提醒',()=>{
  const bucket=new Map(),storage={getItem:key=>bucket.get(key),setItem:(key,value)=>bucket.set(key,value)};
  const browser={localStorage:storage,sessionStorage:storage};
  assert.equal(claimReminder('运营-A','first',browser),true);
  assert.equal(claimReminder('运营-A','first',browser),false);
  assert.equal(claimReminder('运营-A','second',browser),true);
  assert.equal(claimReminder('运营-B','first',browser),true);
  assert.deepEqual([...bucket.values()],['second','first']);
  const broken={get localStorage(){throw Error('blocked');}};
  assert.equal(claimReminder('private','session',broken),true);
  assert.equal(claimReminder('private','session',broken),false);
});

test('只展示可进入的待办，优先事项置顶，保留原单据及筛选条件',()=>{
  const normal={tab:'sales',title:'填日报',level:'amber'};
  const urgent={tab:'approval',title:'审批',entity:'plan-1',view:'pending',month:'2026-11',level:'red'};
  const other={tab:'users',title:'无权限',level:'red'};
  const tasks=[normal,other,urgent];
  assert.deepEqual(rankedReminderTasks(tasks,['sales','approval']),[urgent,normal]);
  assert.deepEqual(tasks,[normal,other,urgent]);
});

test('新品开发的选款及样品确认随真实单据状态和样品版本进出待办',async t=>{
  const f=systemFixture();t.after(()=>f.sqlite.close());
  const actor={...f.users.admin,role:'新品开发'};
  const due='2020-01-01T00:00:00Z',db=f.sqlite;
  db.prepare(`INSERT INTO new_product_projects(id,cycle_month,sku,name,stage_started_at,current_due_at,created_by,created_at,updated_at)
    VALUES('remind-project','2026-11','REMIND','样品',?,?,?,?,?)`).run(due,due,actor.id,due,due);
  const read=async()=>(await workspaceTasks(f.db,actor)).filter(item=>item.entity==='remind-project');
  assert.equal((await read())[0].level,'red');
  const record=(key,body,source=null)=>db.prepare(`INSERT INTO new_product_stage_records
    (id,project_id,stage_key,data_json,source_version,actor_id,actor_name,submitted_at,updated_at)
    VALUES(?,'remind-project',?,?,?,?,?,?,?)`).run(key,key,JSON.stringify(body),source,actor.id,'测试',due,due);
  record('candidate',{});assert.deepEqual(await read(),[]);
  db.prepare("UPDATE new_product_projects SET stage='sample' WHERE id='remind-project'").run();
  record('sample',{appearanceResult:'通过',qualityResult:'不通过'});assert.deepEqual(await read(),[]);
  db.prepare("UPDATE new_product_stage_records SET data_json=?,version=2 WHERE id='sample'").run(JSON.stringify({appearanceResult:'通过',qualityResult:'通过'}));
  assert.equal((await read())[0].title,'确认当前版本的样品');
  record('sample_development',{},1);assert.equal((await read()).length,1);
  db.prepare("UPDATE new_product_stage_records SET source_version=2 WHERE id='sample_development'").run();
  assert.deepEqual(await read(),[]);
});

test('尚未到期的周月报保留在清单，只有截止日当天及以后标为优先',async t=>{
  const f=systemFixture();t.after(()=>f.sqlite.close());
  const tasks=await workspaceTasks(f.db,f.users.indonesia),today=reviewToday();
  for(const kind of ['weekly','monthly']){
    const task=tasks.find(row=>row.tab==='reviews'&&row.view===kind);
    const deadline=reviewPeriod(kind,today).deadline;
    assert.equal(task.level,today>=deadline?'red':'amber');
    assert.ok(task.detail.includes(deadline));
  }
});

test('小品读本人实时待办并链接首项，不向模型发送任务和证据',async t=>{
  const f=systemFixture();t.after(()=>f.sqlite.close());
  const options={apiKey:'test',request:()=>assert.fail('个人待办应在内部查询')};
  const ask=actor=>answerWithKnowledge(f.db,actor,{question:'小品同学，我有哪些待办？'},options);
  const operator=await ask(f.users.indonesia);
  assert.equal(operator.source,'ledger');assert.match(operator.answer,/项待办/u);const expected=rankedReminderTasks(await workspaceTasks(f.db,f.users.indonesia),navigationForActor(f.users.indonesia));assert.equal(operator.ledger.page,expected[0].tab);
  const studio=await ask({...f.users.indonesia,role:'拍摄剪辑'});assert.equal(studio.ledger,null);
  assert.doesNotMatch(studio.answer,/日报/);
});
