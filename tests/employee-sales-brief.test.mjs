import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './fixtures.mjs';
import {answerWithKnowledge} from '../lib/employee-assistant.mjs';
import {answerSalesBrief,validSalesContext} from '../lib/employee-sales-brief.mjs';
import {readSalesTargets} from '../lib/sales-targets.mjs';
import {SALES_CURRENCIES} from '../lib/sales-data.mjs';
const now='2026-11-23T04:00:00Z';
const rates=Object.fromEntries(SALES_CURRENCIES.map(c=>[c,c==='IDR'?2000:1]));
function setup(t,fx=true){const f=fixture();t.after(()=>f.sqlite.close());if(fx)f.sqlite.prepare('INSERT INTO sales_fx_snapshots VALUES(?,?,?,?,?,?)').run('test','test',now,now,'2026-11-24T04:00:00Z',JSON.stringify(rates));return f;}
function sale(f,{date='2026-11-22',site='印尼',channel='TikTok',qty=10,revenue=100,cost=10,currency='CNY',kind='complete',sku='BAG-A',reversed=false}={}){
 const id=crypto.randomUUID();f.sqlite.prepare('INSERT INTO sales_imports(id,import_key,business_date,site,channel,row_count,total_qty,actor_id,created_at,report_kind,reversed_at) VALUES(?,?,?,?,?,1,?,?,?,?,?)').run(id,id,date,site,channel,qty,f.users.admin.id,now,kind,reversed?now:null);
 f.sqlite.prepare('INSERT INTO sales_records(id,import_id,business_date,site,channel,sku,qty,currency,reported_amount,ad_cost,actor_id,created_at,reversed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,id,date,site,channel,sku,qty,currency,revenue,cost,f.users.admin.id,now,reversed?now:null);return id;
}
const ask=(f,q,ctx={},actor=f.users.admin,time=now)=>answerWithKnowledge(f.db,actor,{question:q,mode:'internal',...ctx},{now:time,apiKey:'',request:()=>assert.fail('briefings must not call a model')});
const text=r=>[r.answer,r.brief?.period,...(r.brief?.details||[])].join('\n');

test('每天销售原话直接给结果、依据、可比变化；补录后即刻重算，不写答案缓存',async t=>{
 const f=setup(t);sale(f,{date:'2026-11-21',qty:20,revenue:200});sale(f,{qty:10});
 let r=await ask(f,'昨天印尼TK销售怎么样？帮我总结一下，有什么需要跟进？');
 assert.equal(r.source,'ledger');assert.equal(r.intent,'live');assert.match(r.answer,/卖出 10 件.*¥100/);assert.match(r.answer,/减少 10（50.0%）/);assert.match(r.answer,/印尼运营/);assert.match(text(r),/2026-11-22|参考汇率/);
 f.sqlite.prepare("UPDATE sales_records SET qty=30 WHERE business_date='2026-11-22'").run();
 r=await ask(f,'昨天印尼TK销售总结');assert.match(r.answer,/增加 10（50.0%）/);
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM employee_knowledge').get().n,0);
});
test('无模型、模型报错均不阻断日报；每天/近期/日期问法进入同一只读链路',async t=>{
 const f=setup(t);sale(f);
 for(const q of ['昨天各站销售怎么样','每天销售数据帮我总结反馈','给我销售简报','最近7天销量情况','过去7天销售总结','2026-11-22销售情况','11月22号销售情况']){
  const r=await answerWithKnowledge(f.db,f.users.admin,{question:q},{now,apiKey:'test',request:()=>assert.fail('no model call')});
  assert.equal(r.source,'ledger',q);assert.ok(r.salesContext,q);assert.doesNotMatch(r.answer,/问住|岗位手册/);
 }
});
test('财务可读，运营重新按当前账号收窄；工厂销售BD无金额越权，伪造上下文无效',async t=>{
 const f=setup(t);sale(f,{revenue:777});sale(f,{site:'马来西亚',revenue:333});
 const all=await ask(f,'昨天销售总结');
 const other=await ask(f,'昨天呢？',{salesContext:all.salesContext},f.users.malaysia);
 assert.match(other.answer,/¥333/);assert.doesNotMatch(text(other),/777|印尼运营|越南/);
 assert.match((await ask(f,'印尼呢？',{salesContext:other.salesContext},f.users.malaysia)).answer,/只能查/);
 assert.match((await ask(f,'昨天销售总结',{},f.users.finance)).answer,/1,110/);
 for(const actor of [f.users.sales,f.users.supply,{role:'工厂'}, {role:'达人BD'},{role:'运营',site:'未知',channel:'TikTok'}]){
  const r=await ask(f,'昨天销售总结',{},actor);assert.doesNotMatch(text(r),/777|333/);assert.match(r.answer,/权限|范围/);
 }
 assert.equal(validSalesContext({...all.salesContext,sites:['不存在']}),false);
 assert.equal(validSalesContext({...all.salesContext,channel:{sql:'1=1'}}),false);
});
test('追问站点、平台和解释保留期间，换成月度问题交还月度引擎',async t=>{
 const f=setup(t);sale(f);
 let r=await ask(f,'近7天销售怎么样');assert.equal(r.salesContext.range,'last7');
 r=await ask(f,'那印尼呢',{salesContext:r.salesContext});assert.deepEqual(r.salesContext.sites,['印尼']);
 r=await ask(f,'只看TK',{salesContext:r.salesContext});assert.equal(r.salesContext.channel,'TikTok');
 const dated=await ask(f,'那11月22日呢？',{salesContext:r.salesContext});assert.equal(dated.salesContext.range,'dates');assert.equal(dated.salesContext.channel,'TikTok');
 r=await ask(f,'我该找谁？',{salesContext:r.salesContext});assert.match(r.answer,/印尼运营/);assert.match(r.brief.period,/2026-11-16 至 2026-11-22/);
 assert.equal(await answerSalesBrief(f.db,f.users.admin,'本月哪个站点销售额最高',now,r.salesContext),null);
 assert.equal(await answerSalesBrief(f.db,f.users.admin,'销售日报怎么导入',now,r.salesContext),null);
});
test('缺报不是零、部分上报不算完整、撤销数据剔除、真正零销量保留',async t=>{
 const f=setup(t,false);sale(f,{kind:'partial',revenue:null,cost:null});sale(f,{revenue:99999,qty:999,reversed:true});
 let r=await ask(f,'昨天印尼TK销售总结');assert.match(r.answer,/已报数据.*10 件/);assert.match(r.answer,/待补|尚未全部齐备/);assert.doesNotMatch(text(r),/99999|999 件|减少.*%/);
 f.sqlite.prepare("UPDATE sales_imports SET reversed_at=?").run(now);f.sqlite.prepare("UPDATE sales_records SET reversed_at=?").run(now);
 r=await ask(f,'昨天印尼TK销售总结');assert.match(r.answer,/还没有收到销售数据/);assert.doesNotMatch(r.answer,/卖出 0/);
 sale(f,{qty:0,revenue:0,cost:0,kind:'zero'});sale(f,{date:'2026-11-21',qty:0,revenue:0,cost:0,kind:'zero'});
 r=await ask(f,'昨天印尼TK销售总结');assert.match(r.answer,/卖出 0 件/);assert.match(r.answer,/仍为 0/);assert.doesNotMatch(text(r),/NaN|Infinity/);
});
test('外币按同一参考汇率换算，过期或缺汇率只显示原币，不把缺失补成零',async t=>{
 const f=setup(t);sale(f,{currency:'IDR',revenue:200000,cost:20000});
 let r=await ask(f,'昨天印尼TK销售总结');assert.match(r.answer,/¥100/);assert.match(text(r),/广告费 ¥10/);
 f.sqlite.prepare("UPDATE sales_fx_snapshots SET effective_at='2026-11-01T00:00:00Z'").run();
 r=await ask(f,'昨天印尼TK销售总结');assert.match(r.answer,/销售额 待补/);assert.match(text(r),/IDR 销售额 200,000/);assert.doesNotMatch(r.answer,/¥0|¥100/);
});
test('店铺广告费覆盖SKU费用，重复广告疑点有提示，与月度同源算法一致',async t=>{
 const f=setup(t);for(const sku of ['BAG-A','BAG-B','BAG-C'])sale(f,{sku,cost:10});
 let r=await ask(f,'昨天印尼TK销售总结');assert.match(text(r),/疑似重复店铺广告费/);
 f.sqlite.prepare('INSERT INTO sales_ad_spend(id,business_date,site,channel,currency,amount,note,actor_id,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run('ad','2026-11-22','印尼','TikTok','CNY',15,'test',f.users.admin.id,now);
 r=await ask(f,'昨天印尼TK销售总结');assert.match(text(r),/广告费 ¥15/);assert.doesNotMatch(text(r),/疑似重复|广告费 ¥30/);
 const monthly=await readSalesTargets(f.db,f.users.admin,'2026-11',{now:new Date(now),fx:{rates}});
 assert.equal(monthly.rows.find(r=>r.site==='印尼'&&r.channel==='TikTok').adCostCny,15);
});
test('今天未结束即使标完整也不强行比较；东七区和东八区按各自当地昨日查询',async t=>{
 const f=setup(t);sale(f,{date:'2026-11-23'});sale(f,{date:'2026-11-22'});
 const today=await ask(f,'今天印尼TK销售总结');assert.match(today.answer,/今天还没结束/);assert.doesNotMatch(today.answer,/减少.*%|增加.*%/);
 sale(f,{date:'2026-11-21',qty:5});sale(f,{site:'马来西亚',qty:9});
 const r=await ask(f,'昨天各站销售总结',{},f.users.admin,'2026-11-22T16:30:00Z');
 assert.match(r.brief.period,/2026-11-21 至 2026-11-21/);assert.match(r.brief.period,/2026-11-22 至 2026-11-22/);
 assert.match(text(r),/印尼 \/ TikTok：已报 5 件/);assert.match(text(r),/马来西亚 \/ TikTok：已报 9 件/);
});
test('显式日期跨月、连续零基数和未来/非法/过长日期处理明确',async t=>{
 const f=setup(t);sale(f,{date:'2026-10-31'});sale(f,{date:'2026-11-01'});
 const r=await ask(f,'2026-10-31至2026-11-01印尼TK销售总结');assert.match(r.answer,/20 件/);assert.match(r.brief.period,/2026-10-31 至 2026-11-01/);
 for(const [q,re] of [['2026-02-30销售总结',/日期没对上/],['2026-11-30销售总结',/未来/],['近90天销售总结',/近7天或近30天/],['2026-01-01至2026-11-22销售总结',/1 至 31 天/],['近30天销售和上周比',/重叠/]])assert.match((await ask(f,q)).answer,re,q);
});
test('默认未指定日期的销售简报明确给昨日；不会用销量冒充订单或分销额',async t=>{
 const f=setup(t);sale(f);const r=await ask(f,'给我总结一下销售');assert.match(r.brief.period,/2026-11-22/);
 assert.match((await ask(f,'昨天新加坡销售怎么样')).answer,/暂未纳入/);
 for(const q of ['昨天分销销售额多少','昨天销售订单数多少','昨天销售转化率多少'])assert.match((await ask(f,q)).answer,/不能用件数代替/);
});

test('完整两期按金额和件数正确排名，平台与站点不混排，零基数不显示无限增长',async t=>{
 const f=setup(t);
 for(const site of ['印尼','马来西亚','泰国','越南','菲律宾'])for(const channel of ['TikTok','Shopee']){
  sale(f,{site,channel,qty:channel==='TikTok'?12:3,revenue:site==='泰国'?500:100});
  sale(f,{site,channel,date:'2026-11-21',qty:0,revenue:0,cost:0,kind:'zero'});
 }
 const site=await ask(f,'昨天哪个站点销售额最高');assert.match(site.answer,/泰国销售额最高/);
 const platform=await ask(f,'昨天哪个平台销量最高');assert.match(platform.answer,/TikTok销量最高/);assert.doesNotMatch(platform.answer,/马来西亚销量最高/);
 assert.match(platform.answer,/从 0 增至 75，不计算增长率/);assert.doesNotMatch(text(platform),/NaN|Infinity/);
 assert.match((await ask(f,'昨天SKU BAG-A销售情况')).answer,/不会拿全店金额/);
});
test('对比上周同日读正确日期，缺报逐日可追查且显示负责运营',async t=>{
 const f=setup(t);sale(f);sale(f,{date:'2026-11-15',qty:50});sale(f,{date:'2026-11-21',qty:10});
 const r=await ask(f,'昨天印尼TK销售和上周同期比');assert.match(r.answer,/减少 40（80.0%）/);assert.match(text(r),/2026-11-15 至 2026-11-15/);
 const gap=await ask(f,'近7天印尼TK销售总结');assert.match(text(gap),/缺完整日报：2026-11-16/);assert.match(text(gap),/印尼运营/);
});

test('一个店铺当天多组重复广告金额不会把销售数量和金额倍增',async t=>{
 const f=setup(t);
 for(let i=0;i<6;i++)sale(f,{sku:'BAG-'+i,cost:i<3?10:20});
 const r=await ask(f,'昨天印尼TK销售总结');assert.match(r.answer,/卖出 60 件.*¥600/);assert.match(text(r),/广告费 ¥90/);assert.match(text(r),/疑似重复店铺广告费/);
});
