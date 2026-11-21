import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {answerEmployee,assistantHome,employeeModel,reserveAssistantCall} from '../lib/employee-assistant.mjs';
import {employeeActionCounts} from '../lib/business-actions.mjs';
import {wakeQuestion} from '../lib/employee-wake.mjs';
import {guidesFor} from '../lib/employee-guides.mjs';
import {NAVIGATION_BY_ROLE} from '../lib/permissions.mjs';

const actor=(role='运营',site='印尼',channel='TikTok')=>({id:role+'-fixture',role,site,channel});
const requestFor=choice=>async()=>Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(choice)}]}]});

test('小品同学 only wakes on the leading name, accepts Chinese punctuation and leaves ordinary searches intact',()=>{
  assert.equal(wakeQuestion(' 小品同学  '),'');
  assert.equal(wakeQuestion('小品同学， 如何导入销售日报？'),'如何导入销售日报？');
  for(const query of ['库存','哪里找到小品同学','小品',''])assert.equal(wakeQuestion(query),null);
});
test('every staff role has an accessible starter and only navigable workspaces',()=>{
  for(const [role,nav] of Object.entries(NAVIGATION_BY_ROLE)) {
    const a=actor(role);
    assert.ok(assistantHome(a).guides.length);
    for(const g of guidesFor(a))assert.ok(nav.includes(g.page));
  }
  assert.deepEqual(assistantHome(actor('拍摄剪辑')).guides.map(x=>x.id),['studio','unmatched-video','material-preview']);
  assert.ok(!guidesFor(actor('运营','泰国')).some(g=>['wholesale','distribution'].includes(g.page)));
  assert.ok(!guidesFor(actor('工厂')).some(g=>g.id==='finance-day'));
  assert.ok(!guidesFor(actor('管理员')).some(g=>g.id==='sales-import'));
});
test('new hire, incomplete day, contextual handoff, unknown question and foreign guide ID without upstream',async()=>{
  const a=actor();
  const ask=(question,extra={})=>answerEmployee(a,{question,...extra});
  assert.equal((await ask('小品同学')).guide.id,'sales-import');
  assert.match((await ask('这个系统是用来干嘛的？')).answer,/下一岗位/);
  assert.match((await ask('怎么导入销售日报？')).guide.steps.join(''),/部分日报/);
  assert.match((await ask('下一步谁审核？',{previous:'monthly-request'})).answer,/管理员审核/);
  assert.equal((await ask('我要订机票')).guide,null);
  assert.equal((await ask('继续',{previous:'finance-day',guideId:'finance-day'})).guide,null);
});
test('model uses Responses and only sees the allowed handbook; selected step is grounded verbatim',async()=>{
  const a={...actor('拍摄剪辑'),email:'private@example.test'};
  const request=async(url,init)=>{
    assert.equal(url,'https://api.openai.com/v1/responses');
    assert.equal(init.headers.authorization,'Bearer fixture-only');
    const body=JSON.parse(init.body);
    assert.equal(body.model,'gpt-5.4-mini');assert.equal(body.store,false);
    assert.equal(body.text.format.strict,true);assert.equal(body.tools,undefined);
    assert.ok(!init.body.includes(a.email)&&!init.body.includes('finance-day'));
    const context=JSON.parse(body.input);
    assert.equal(context.previous,'');assert.equal(context.page,'');
    return requestFor({id:'studio',intent:'step',step:2})();
  };
  const result=await answerEmployee(a,{question:'怎么交片？',page:'cost-profit',previous:'finance-day'},{apiKey:'fixture-only',request});
  assert.equal(result.source,'openai');assert.equal(result.answer,result.guide.steps[1]);assert.equal(employeeModel,'gpt-5.4-mini');
});
test('model failures, invalid guide or nonexistent step fall back to verified role instructions',async()=>{
  for(const request of [requestFor({id:'finance-day',intent:'steps',step:0}),requestFor({id:'studio',intent:'step',step:4}),async()=>new Response('',{status:429}),async()=>Response.json({status:'incomplete'})]){
    const r=await answerEmployee(actor('拍摄剪辑'),{question:'怎么交片？'},{apiKey:'fixture-only',request});
    assert.equal(r.source,'handbook');assert.equal(r.guide,null);
  }
});
test('project credit exhaustion is reported with an immediately usable offline guide',async()=>{
  const request=async()=>Response.json({error:{code:'credit_balance_exhausted'}},{status:429});
  const result=await answerEmployee(actor(),{question:'该怎样提交这个文件？'},{apiKey:'fixture-only',request});
  assert.equal(result.source,'handbook');assert.match(result.notice,/额度不足/);assert.equal(result.guide,null);
});
test('manual guide picks do not spend model calls; per account limit resets',async()=>{
  const r=await answerEmployee(actor(),{question:'导入销售',guideId:'sales-import'},{apiKey:'fixture-only',request:()=>assert.fail('unexpected call')});
  assert.equal(r.source,'handbook');for(let i=0;i<8;i++)assert.ok(reserveAssistantCall('quota-test',10000));
  assert.equal(reserveAssistantCall('quota-test',10001),false);assert.ok(reserveAssistantCall('quota-other',10002));assert.ok(reserveAssistantCall('quota-test',70000));
});
test('action counts use the real queue scope, separate incomplete evidence and do not leak finance details',async()=>{
  const db=new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE business_actions(site TEXT,channel TEXT,status TEXT,snapshot_json TEXT,updated_at TEXT)');
    const put=db.prepare('INSERT INTO business_actions VALUES(?,?,?,?,?)');
    for(const [site,channel,status,condition] of [['印尼','TikTok','open','verify'],['印尼','TikTok','resolved','active'],['印尼','Shopee','review_pending','active'],['泰国','TikTok','open','active']]){
      put.run(site,channel,status,JSON.stringify({condition,profit:500}),'2026-11-01');
    }
    const d1={prepare:sql=>({bind:(...args)=>({first:()=>db.prepare(sql).get(...args)})})};
    const o=await employeeActionCounts(d1,actor());assert.equal(o.total,2);assert.equal(o.verifying,1);assert.equal(o.triggered,0);
    const f=await employeeActionCounts(d1,actor('财务'));assert.equal(f.total,3);assert.equal(f.review,1);assert.equal(f.triggered,1);
    assert.ok(!('profit' in f));assert.equal((await employeeActionCounts(d1,actor('运营','越南'))).total,0);
    await assert.rejects(employeeActionCounts(d1,actor('工厂')),err=>err.status===403);
  }finally{db.close();}
});
