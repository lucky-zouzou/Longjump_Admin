import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './fixtures.mjs';
import {answerWithKnowledge} from '../lib/employee-assistant.mjs';
import {validDecisionContext} from '../lib/employee-decisions.mjs';
import {SALES_CURRENCIES} from '../lib/sales-data.mjs';
import {saveSalesTarget} from '../lib/sales-targets.mjs';

const screenshot='目前我们那个站点的业绩贡献最小，投入占比相对又比较大';
const fullText=reply=>[reply.answer,reply.brief?.period,...(reply.brief?.details||[])].join('\n');
const asOf='2026-11-02T06:00:00Z';
function environment(t){
  const f=fixture();
  t.after(()=>f.sqlite.close());
  const current=new Date();
  f.sqlite.prepare('INSERT INTO sales_fx_snapshots VALUES(?,?,?,?,?,?)')
    .run('fixture','fixture',current.toISOString(),current.toISOString(),new Date(+current+86400000).toISOString(),
      JSON.stringify(Object.fromEntries(SALES_CURRENCIES.map(c=>[c,1]))));
  return f;
}
function record(f,site,channel,revenue,spend,date='2026-11-01'){
  const id=crypto.randomUUID(),qty=10;
  f.sqlite.prepare('INSERT INTO sales_imports(id,import_key,business_date,site,channel,row_count,total_qty,actor_id,created_at,report_kind) VALUES(?,?,?,?,?,1,?,?,?,?)')
    .run(id,id,date,site,channel,qty,f.users.admin.id,date,'complete');
  f.sqlite.prepare('INSERT INTO sales_records(id,import_id,business_date,site,channel,sku,qty,currency,reported_amount,ad_cost,actor_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(id,id,date,site,channel,'BAG-A',qty,'CNY',revenue,spend,f.users.admin.id,date);
}
function seed(f){
  for(const [site,sales,cost] of [['印尼',600,10],['马来西亚',100,20],['泰国',190,15],['菲律宾',90,50],['越南',20,5]]){
    for(const channel of ['TikTok','Shopee'])record(f,site,channel,sales/2,cost/2);
  }
}
const ask=(f,question,options={},actor=f.users.admin)=>answerWithKnowledge(f.db,actor,
  {question,...options},{now:asOf,apiKey:'',request:()=>{throw Error('unexpected external request');}});

test('原话在无模型时读取实时台账，区分最低贡献与最大投放差额，补录后立即刷新',async t=>{
  const f=environment(t);seed(f);
  let reply=await ask(f,screenshot);
  assert.equal(reply.source,'ledger');assert.match(reply.answer,/越南的销售额最低/);
  assert.match(reply.answer,/优先复核菲律宾/);assert.match(reply.answer,/广告费占比 50.0%，销售额占比 9.0%，相差 41.0 个百分点/);
  assert.equal(reply.ledger.month,'2026-11');assert.equal(reply.ledger.page,'sales-targets');
  f.sqlite.prepare("UPDATE sales_records SET reported_amount=6000 WHERE site='越南'").run();
  reply=await ask(f,screenshot);assert.match(reply.answer,/菲律宾的销售额最低/);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM employee_knowledge').get().n,0);
});
test('月份、平台、站点可追问，追问读取当前账号权限',async t=>{
  const f=environment(t);seed(f);record(f,'印尼','Shopee',291,23,'2026-10-31');
  const base=await ask(f,screenshot);
  const october=await ask(f,'那上个月呢？',{decisionContext:base.decisionContext});assert.equal(october.ledger.month,'2026-10');
  const shopee=await ask(f,'只看虾皮',{decisionContext:october.decisionContext});
  assert.equal(shopee.decisionContext.channel,'Shopee');assert.match(shopee.answer,/291/);
  const id=await ask(f,'印尼呢？',{decisionContext:shopee.decisionContext});assert.equal(id.decisionContext.site,'印尼');
  const scoped=await ask(f,'上个月呢？',{decisionContext:shopee.decisionContext},f.users.malaysia);
  assert.equal(scoped.decisionContext.site,'马来西亚');assert.equal(scoped.decisionContext.channel,'TikTok');
  assert.doesNotMatch(scoped.answer,/291|菲律宾|越南|（占 /);
  const forbidden=await ask(f,'越南呢？',{decisionContext:base.decisionContext},f.users.indonesia);
  assert.doesNotMatch(forbidden.answer,/¥|%/);assert.match(forbidden.answer,/你的账号/);
  assert.equal(validDecisionContext({...base.decisionContext,month:['2026-11']}),false);
  assert.match((await ask(f,screenshot,{},f.users.supply)).answer,/没有.*读取权限/);
});
test('数据不足、待补金额和真实零分开，平台投放效率只用完整口径',async t=>{
  const f=environment(t);
  record(f,'越南','TikTok',10,null);
  let reply=await ask(f,screenshot);assert.doesNotMatch(reply.answer,/优先复核|销售额最低/);
  assert.match(reply.answer,/有可比数据的站点不足两个/);assert.match(reply.answer,/广告 0\/2/);
  record(f,'泰国','TikTok',60,0);
  reply=await ask(f,'哪个站点投放效率最高');
  assert.doesNotMatch(reply.answer,/的全店销售额／广告费最高|Infinity|NaN/);assert.match(reply.answer,/广告归因/);
  f.sqlite.prepare("UPDATE sales_records SET ad_cost=3 WHERE site='越南'").run();
  record(f,'泰国','Shopee',60,3);record(f,'越南','Shopee',10,2);
  assert.match((await ask(f,'哪个站点投放效率最高')).answer,/泰国的全店销售额／广告费最高/);
});
test('利润从财务账读取，销售金额不冒充利润，岗位权限和不同日期口径生效',async t=>{
  const f=environment(t);seed(f);
  const profit=await ask(f,'各站点的贡献利润排名',{},f.users.finance);
  assert.equal(profit.ledger.view,'finance');assert.equal(profit.ledger.month,'2026-11');assert.match(profit.answer,/暂无已核金额/);assert.doesNotMatch(profit.answer,/¥600/);
  assert.match((await ask(f,'各站点的贡献利润排名',{},f.users.indonesia)).answer,/财务月结账册权限/);
  const daily=await ask(f,'近7天哪个站点销售额最高');
  assert.equal(daily.salesContext.range,'last7');assert.match(daily.answer,/尚未全部齐备/);
});
test('生产依据与大促来自驾驶舱，追问具体货品能区分缺报和预计零需求',async t=>{
  const f=environment(t);
  const general=await ask(f,'建议启动生产的依据是什么，下个月TK大促考虑了吗？');
  assert.equal(general.ledger.page,'suggestions');assert.match(fullText(general),/50%、30%、20%/);assert.match(fullText(general),/按活动日期逐日叠加需求/);
  const q='印尼 TikTok SKU BAG-A';
  let reply=await ask(f,q,{previous:'production-basis'},f.users.indonesia);
  assert.match(reply.answer,/目前无法确认生产数量/);assert.match(fullText(reply),/尚未登记|没有登记/);
  for(let i=1;i<=56;i++)record(f,'印尼','TikTok',100,10,new Date(Date.parse('2026-11-02')-i*86400000).toISOString().slice(0,10));
  reply=await ask(f,q,{previous:'production-basis'},f.users.indonesia);
  assert.match(reply.answer,/建议启动生产 \d+ 件/);assert.match(reply.answer,/覆盖 \d+ 天/);
  assert.match((await ask(f,'越南 Shopee SKU BAG-A 为什么建议生产',{},f.users.indonesia)).answer,/只能核对自己/);
});

test('已关账取冻结的贡献利润，保留负数与缺数据，排除线下分销',async t=>{
  const f=environment(t);
  const snapshot={balances:[],profitSummary:{lines:[
    {site:'印尼',channel:'TikTok',confirmed:12345},
    {site:'印尼',channel:'线下分销',confirmed:100000},
    {site:'菲律宾',channel:'Shopee',confirmed:-12800},
    {site:'越南',channel:'TikTok',confirmed:null,reason:'成本待核'}
  ]}};
  f.sqlite.prepare('INSERT INTO finance_period_events VALUES(?,?,?,?,?,?,?,?)')
    .run('period-1','2026-10',1,'closed',JSON.stringify(snapshot),'test',f.users.admin.id,asOf);
  const reply=await ask(f,'10月哪个站点的利润最少？',{},f.users.finance);
  assert.match(reply.brief.period,/已关账/);assert.match(fullText(reply),/印尼　¥123.45/);
  assert.match(fullText(reply),/菲律宾　¥-128/);assert.match(fullText(reply),/越南　暂无已核金额，1 项待核实/);
  assert.match(reply.answer.split('\n')[0],/菲律宾.*亏了 ¥128/);
});

test('非站点指标不会误报为站点销售排名，经营复盘可以从普通问法进入',async t=>{
  const f=environment(t);seed(f);
  assert.match((await ask(f,'我们这个月经营情况如何？')).answer,/优先复核菲律宾/);
  assert.doesNotMatch((await ask(f,'哪个平台销售额最低')).answer,/越南的销售额最低/);
  const both=await ask(f,'印尼和越南哪个站点销售额最低？');
  const last=await ask(f,'上个月呢？',{decisionContext:both.decisionContext});
  assert.deepEqual(last.decisionContext.selectedSites.sort(),['印尼','越南'].sort());
});

test('口语问钱花得值不值，先给结果和两项依据，追问沿用期间并重算',async t=>{
  const f=environment(t);seed(f);
  const reply=await ask(f,'小品同学，这个月钱花得值不值？');
  assert.match(reply.answer.split('\n')[0],/优先复核菲律宾/);
  assert.match(reply.answer,/50.0%.*9.0%/);
  assert.match(reply.answer,/是否回本还要核对/);
  assert.ok(reply.answer.split('\n').length<=3);
  assert.match(reply.brief.period,/2026-11-01/);
  assert.match(reply.brief.details.join('\n'),/印尼.*¥600/);
  assert.doesNotMatch(reply.answer,/¥600/);
  const why=await ask(f,'你怎么看出来的？',{decisionContext:reply.decisionContext});
  assert.match(why.answer,/¥50 广告费，五站合计 ¥100/);
  const who=await ask(f,'我该找谁？',{decisionContext:reply.decisionContext});
  assert.match(who.answer,/菲律宾的月度任务负责人/);assert.match(who.answer,/还没有有效的任务负责人/);
  assert.match((await ask(f,'我们总共卖了多少钱？')).answer.split('\n')[0],/¥1,000/);
  assert.match((await ask(f,'这个月哪个站拖后腿？')).answer,/越南的销售额最低/);
});

test('问今天最该盯什么沿用行动队列并定位到单据，无记录、待核、已分配均说清',async t=>{
  const f=environment(t);
  const q='今天最该盯哪件事？';
  assert.match((await ask(f,q)).answer,/暂时没有已触发或待核实/);
  const insert=f.sqlite.prepare("INSERT INTO business_actions(id,site,channel,sku,kind,status,owner_id,snapshot_json,due_at,review_at,opened_at,updated_at) VALUES(?,?,'TikTok',?,'loss','open',?,?,'2026-11-03','2026-11-04',?,?)");
  function add(id,site,condition,owner=null){
    insert.run(id,site,id,owner,JSON.stringify({condition,kind:'loss',reliability:3,mustActInDays:1,window:{cutoff:'2026-11-01'},mustActDate:'2026-11-03'}),asOf,asOf);
  }
  add('VERIFY','越南','verify');
  const pending=await ask(f,'哪个站最让人操心？');
  assert.match(pending.answer,/先补证据/);assert.doesNotMatch(pending.answer,/已触发“越卖越亏”/);
  add('TOP','印尼','active',f.users.indonesia.id);
  const reply=await ask(f,q);
  assert.equal(reply.ledger.entity,'TOP');assert.match(reply.answer,/印尼运营/);assert.match(reply.answer,/行动单记录了/);
  const scoped=await ask(f,'越南呢？',{decisionContext:reply.decisionContext},f.users.indonesia);
  assert.doesNotMatch(scoped.answer,/VERIFY/);
  assert.match((await ask(f,q,{},f.users.malaysia)).answer,/暂时没有已触发或待核实/);
});

test('利润没核全会直说，按月查收益不会误报成最高站点，补货追问沿用同一SKU',async t=>{
  const f=environment(t);
  const snapshot={profitSummary:{lines:[
    {site:'印尼',channel:'TikTok',confirmed:90000},{site:'菲律宾',channel:'Shopee',confirmed:-30000}
  ]}};
  f.sqlite.prepare('INSERT INTO finance_period_events VALUES(?,?,?,?,?,?,?,?)')
   .run('period','2026-09',1,'closed',JSON.stringify(snapshot),'test',f.users.admin.id,asOf);
  const reply=await ask(f,'我们9月赚了多少钱？');
  assert.match(reply.answer.split('\n')[0],/线上站点已核的贡献利润为 ¥600/);
  assert.match(reply.answer,/2\/5 个站点/);assert.match(reply.answer,/待核/);
  const stock=await ask(f,'印尼 TikTok SKU BAG-A 大促前货够不够卖？');
  assert.match(stock.answer.split('\n')[0],/还判断不了大促前的货够不够/);
  const next={previous:'production-basis',productionContext:stock.productionContext};
  const why=await ask(f,'那大促呢？',next);
  assert.match(why.answer,/BAG-A/);assert.match(why.answer,/没有登记带起止日期的活动/);
  const denied=await ask(f,'那大促呢？',next,f.users.malaysia);
  assert.equal(denied.ledger,null);assert.doesNotMatch(denied.answer,/BAG-A/);
});

test('直接回答平台销量与月度目标差额，未分配任务的销售不抬高进度',async t=>{
  const f=environment(t);seed(f);
  f.sqlite.prepare("UPDATE sales_records SET reported_amount=reported_amount*2 WHERE channel='Shopee'").run();
  const platform=await ask(f,'印尼 TikTok和虾皮哪个平台卖得最好？');
  assert.match(platform.answer.split('\n')[0],/Shopee的销售额最高/);assert.match(platform.answer,/¥600/);
  const unknown=await ask(f,'这个月能不能达标？');
  assert.match(unknown.answer,/还算不出/);assert.match(unknown.answer,/0\/10/);
  await saveSalesTarget(f.db,f.users.admin,{month:'2026-11',site:'印尼',channel:'TikTok',ownerId:f.users.indonesia.id,revenueCny:900,quantity:30,budgetCny:40,version:0,note:'日常核对销售',reason:'测试月度目标'});
  const target=await ask(f,'这个月离目标还差多少？');
  assert.match(target.answer,/还差 ¥600/);assert.match(target.answer,/已报 ¥300，目标 ¥900，完成 33.3%/);
  assert.match(target.answer,/已设置目标 1\/10/);
});

test('问题太宽时给可直接提问的经营选项，手册操作和个人评价不会误入广告排名',async t=>{
  const f=environment(t);
  const reply=await ask(f,'咱们最近情况怎么样？');
  assert.equal(reply.source,'conversation');assert.ok(reply.questions.includes('我们本月赚了多少钱？'));
  const handbook=await ask(f,'怎么导入本站的销售额？');
  assert.notEqual(handbook.source,'ledger');
  const staff=await ask(f,'哪个员工拖后腿？');
  assert.doesNotMatch(staff.answer,/优先复核|销售额最低/);
});
