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
  const studioGuides=assistantHome(actor('拍摄剪辑')).guides;
  for(const id of ['studio','unmatched-video','material-preview','employee-attendance'])assert.ok(studioGuides.some(g=>g.id===id));
  assert.ok(guidesFor(actor('拍摄剪辑')).every(g=>['content-center','attendance'].includes(g.page)));
  assert.ok(!studioGuides.some(g=>['advertising-budget','advertising-trend','finance-day'].includes(g.id)));
  assert.ok(!guidesFor(actor('运营','泰国')).some(g=>['wholesale','distribution'].includes(g.page)));
  assert.ok(!guidesFor(actor('工厂')).some(g=>g.id==='finance-day'));
  assert.ok(!guidesFor(actor('管理员')).some(g=>g.id==='sales-import'));
});
test('出勤和广告操作问句命中已实现入口，预算与实耗保持区分及岗位范围',async()=>{
  const ask=(role,question)=>answerEmployee(actor(role),{question});
  for(const role of Object.keys(NAVIGATION_BY_ROLE)){
    const result=await ask(role,'在哪里签到和申请请假？');
    assert.equal(result.guide?.id,'employee-attendance');
    assert.match(result.guide.steps.join(''),/我的出勤配置.*组织、班次与授权配置/);
  }
  const application=await ask('运营','广告申请没有入口怎么办？');
  assert.equal(application.guide?.id,'advertising-budget');
  assert.match(application.guide.steps.join(''),/广告申请不要求配置打卡班次/);
  assert.match(application.guide.next,/核定预算不等于充值、付款或实际广告消耗/);
  const approval=await ask('财务','如何核定广告预算？');
  assert.equal(approval.guide?.id,'advertising-budget');
  assert.match(approval.guide.steps.join(''),/独立财务.*金额不能超过申请额/);
  const trend=await ask('运营','广告费用趋势在哪里看？');
  assert.equal(trend.guide?.id,'advertising-trend');
  assert.match(trend.guide.steps.join(''),/明确登记0才代表零费用/);
  assert.match(trend.guide.next,/广告申请和付款不计入/);
  const feishu=await ask('运营','飞书请假还要再填吗？');
  assert.equal(feishu.guide?.id,'feishu-attendance');
  assert.match(feishu.guide.steps.join(''),/启用同步且已精确绑定/);
  assert.match(feishu.guide.next,/不包含全部待审批或驳回记录/);
  assert.equal((await ask('管理员','如何配置飞书连接？')).guide?.id,'feishu-setup');
  assert.ok(!guidesFor(actor('运营')).some(g=>g.id==='feishu-setup'));
  for(const role of ['员工','工厂','拍摄剪辑','财务','海运','销售','达人BD','新品开发']){
    assert.ok(!guidesFor(actor(role)).some(g=>g.id==='advertising-trend'));
    assert.equal((await answerEmployee(actor(role),{question:'广告费用趋势在哪里看？',guideId:'advertising-trend'})).guide,null);
  }
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

test('营销寄样手册明确仅寄样的选择与库存费用边界，不向不可进入岗位提供链接',()=>{
 const guide=guidesFor(actor('达人BD')).find(g=>g.id==='indonesia-bd-samples');assert.ok(guide);const text=guide.steps.join('')+guide.next;
 assert.match(text,/只寄样不承诺内容.*明确选择/);assert.match(text,/不能留空视频数量代替/);assert.match(text,/实际出库才扣库存/);assert.match(text,/签收不代替内容完成/);assert.match(text,/不生成客户应收/);assert.match(text,/缺成本或汇率.*不能按零/);
 for(const a of [actor('运营','泰国'),actor('运营','印尼','Shopee'),actor('工厂'),actor('海运'),actor('销售')])assert.equal(guidesFor(a).some(g=>g.page==='marketing-samples'),false,a.role+'/'+a.site+'/'+a.channel);
});
