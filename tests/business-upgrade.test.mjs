import test from 'node:test';
import assert from 'node:assert/strict';
import {forecastPlan} from '../lib/forecast-model.mjs';
import {loadForecast} from '../lib/forecast.ts';
import {transportSummary} from '../lib/supply-diagnostics.mjs';
import {forecastBasis,recordForecastObservations,forecastChanges,explainForecastChange} from '../lib/forecast-observations.mjs';
import {readEvidenceWorkbench,mutateEvidenceTask,groupEvidenceTasks} from '../lib/evidence-workbench.mjs';
import {financeBrief,distributionFunnel,qualitySignals} from '../lib/business-insights.mjs';
import {chooseBusinessTool,dispatchBusinessTool,answerForecastChanges} from '../lib/employee-business-router.mjs';
import {createRequestMetrics} from '../server/request-metrics.mjs';
import {fixture} from './fixtures.mjs';
import {contentFixture,original} from './content-center-fixture.mjs';
import {readPlatformReports} from '../lib/content-center.mjs';
const at='2026-11-18',input={dailySales:Array(56).fill(10),dailyCoverage:Array(56).fill(true),currentQty:200,seaInTransit:800,arrivalLots:[{qty:800,days:10}]};
test('大促按日期消耗，活动前缺货不能被晚到海运掩盖，补货用短周期需求',()=>{
 const policy={campaign_start:'2026-11-19',campaign_end:'2026-11-23',campaign_factor:5};
 const row=forecastPlan(input,policy,[],[],at);
 assert.equal(row.projection.firstShortageDate,'2026-11-23');
 assert.equal(row.projection.curve[1].demand,50);assert.equal(row.projection.curve[6].demand,10);
 assert.ok(row.actions.some(a=>a.kind==='expedite'));assert.equal(row.suggestedProduction,0);
 const short=forecastPlan({...input,currentQty:0,seaInTransit:0,arrivalLots:[]},{production_days:10,transport_days:2,review_days:1,campaign_start:'2026-11-28',campaign_end:'2026-11-28',campaign_factor:5},[],[],at);
 assert.equal(short.suggestedReplenishment,30);assert.equal(short.forecastSales,340);
});
test('有日期在产按承诺计入曲线，晚于周期不能冲减当期，未知交期不假定到货',()=>{
 const base={...input,currentQty:0,seaInTransit:0,arrivalLots:[],productionInProgress:1000};
 const late=forecastPlan({...base,productionArrivalLots:[{qty:1000,days:100}]},{},[],[],at);
 assert.equal(late.lateProductionQty,1000);assert.equal(late.suggestedProduction,630);
 const unknown=forecastPlan(base,{},[],[],at);assert.equal(unknown.suggestedProduction,0);assert.equal(unknown.unknownProductionQty,1000);assert.equal(unknown.projection.unknownArrivalQty,1000);
 const promise=forecastPlan({...base,productionArrivalLots:[{qty:1000,days:0}]},{},[],[],at);assert.equal(promise.projection.firstShortageDate,null);
 const missing=forecastPlan({...base,dailyCoverage:Array(56).fill(false)},{},[],[],at);assert.equal(missing.suggestedProduction,null);
});
test('运输旧批次、装运批次与分腿统一计数，并且分腿不重复计算',()=>{
 const leg={id:'x',exceptions:[{type:'节点停滞'}],pendingShelfQty:2};
 assert.deepEqual(transportSummary([{id:'a',stalled:true}],[],[leg,leg]),{stalledBatchCount:2,pendingShelfCount:1});
});
test('每日首次依据不覆盖，日内更新最新值，缺资料和模型升级不伪造下降',async()=>{
 const f=fixture(),r={site:'印尼',channel:'TikTok',sku:'BAG-A',asOf:'2026-11-17',forecastVersion:'v3',suggestedProduction:20,recommendationReady:true,forecastDaily:2,qty:10,policy:{}};
 await recordForecastObservations(f.db,[r],'2026-11-17T01:00:00Z');
 await recordForecastObservations(f.db,[{...r,suggestedProduction:30}],'2026-11-17T02:00:00Z');
 const saved=f.sqlite.prepare('SELECT * FROM forecast_daily_observations').get();assert.equal(JSON.parse(saved.first_json).qty,20);assert.equal(JSON.parse(saved.latest_json).qty,30);
 const changes=await forecastChanges(f.db,f.users.indonesia,[{...r,asOf:at,suggestedProduction:40},{...r,site:'菲律宾',asOf:at}]);assert.equal(changes.items.length,1);assert.equal(changes.delta,10);
 assert.equal(explainForecastChange({ready:true,qty:30,version:'a'},{ready:false,qty:null,version:'a'}).delta,null);
 assert.equal(explainForecastChange({ready:true,qty:30,version:'a'},{ready:true,qty:40,version:'b'}).delta,null);
 const before=forecastBasis({...r,arrivalLots:[{qty:10,days:1}]}),after=forecastBasis({...r,suggestedProduction:25,arrivalLots:[{qty:10,days:100}]});assert.ok(explainForecastChange(before,after).reasons.some(s=>s.includes('承诺到仓日期变化')));
});
test('共同缺口按SKU去重，批量分派保持原子性与岗位边界',async()=>{
 const f=fixture(),now=new Date('2026-11-18T04:00:00Z'),data=await readEvidenceWorkbench(f.db,f.users.admin,now);
 const tasks=data.tasks.filter(t=>t.kind==='report'&&t.site==='印尼'&&t.channel==='TikTok').slice(0,2);
 const groups=groupEvidenceTasks(tasks,now);assert.equal(groups.length,1);assert.equal(groups[0].count,2);assert.equal(groups[0].skuCount,2);
 const payload={action:'evidenceBulkAssign',items:tasks.map(t=>({key:t.key,version:t.version,basisHash:t.basisHash})),ownerId:f.users.indonesia.id,dueAt:'2026-11-19T04:00:00Z',note:'TEST ONLY 批量安排共同资料'};
 await assert.rejects(mutateEvidenceTask(f.db,f.users.admin,{...payload,ownerId:f.users.malaysia.id},now),/有效人员/);
 await assert.rejects(mutateEvidenceTask(f.db,f.users.admin,{...payload,items:payload.items.map((t,i)=>({...t,version:i?99:t.version}))},now),/来源已变化/);
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM evidence_tasks').get().n,0);
 await mutateEvidenceTask(f.db,f.users.admin,payload,now);
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM evidence_task_events').get().n,2);
 await assert.rejects(mutateEvidenceTask(f.db,f.users.indonesia,payload,now),/仅管理员/);
});
test('财务类型币种不混加，空分销分母不变成0%业绩，品质趋势排除草稿',()=>{
 const brief=financeBrief([{kind:'supplier_bill',currency:'IDR',remaining:10000,business_date:'2026-10-01'},{kind:'supplier_payment',currency:'IDR',remaining:2000,business_date:at},{kind:'platform_receipt',currency:'THB',remaining:300,business_date:at}],{IDR:{rate:.0004}},at);
 assert.equal(brief.length,3);assert.equal(brief[0].cnyMinor,4);assert.equal(brief[0].agedMinor,10000);assert.equal(brief[2].cnyMinor,null);
 assert.equal(distributionFunnel([]).firstOrderRate,null);
 const funnel=distributionFunnel([{customer_id:'a',status:'active',activated:1,valid_order_count:2},{customer_id:'b',status:'pending',activated:0,valid_order_count:2}]);assert.equal(funnel.repeat,1);assert.equal(funnel.firstOrderRate,1);
 const rows=[{id:'a',sku:'A',site:'印尼',status:'confirmed',business_date:at,data:{qty:2,reason:'拉链',rectification:{reviewDate:'2026-11-17',outcome:'failed'}}}];
 const q=qualitySignals([...rows,{...rows[0],id:'draft',status:'draft'}],at);assert.equal(q[0].count,1);assert.equal(q[0].overdue,1);assert.equal(q[0].weekly['2026-11-16'],1);
});
test('模型只选白名单工具，不接收台账；恶意工具与越权查询不能执行',async()=>{
 let body;const request=async(_,init)=>{body=JSON.parse(init.body);return {ok:true,json:async()=>({output_text:'{"tool":"sales"}'})};};
 assert.equal(await chooseBusinessTool('最近卖货咋样',{apiKey:'TEST',request}),'sales');assert.equal(body.store,false);assert.equal(body.input,'最近卖货咋样');
 assert.equal(await chooseBusinessTool('test',{apiKey:'TEST',request:async()=>({ok:true,json:async()=>({output_text:'{"tool":"delete"}'})})}),null);
 const f=fixture();assert.equal(await dispatchBusinessTool('delete',f.db,f.users.admin,{question:'删掉记录'},at),null);
 const denied=await dispatchBusinessTool('sales',f.db,f.users.indonesia,{question:'菲律宾本月卖了多少'},at+'T04:00:00Z');assert.match(denied.answer,/本站|自己|权限|不能|只能|负责/);
 const changes=await answerForecastChanges(f.db,f.users.indonesia,'菲律宾生产建议为什么每天变化',at+'T04:00:00Z');assert.match(changes.answer,/自己站点/);
 const alias=await answerForecastChanges(f.db,f.users.indonesia,'大马备货建议每天为什么变化',at+'T04:00:00Z');assert.match(alias.answer,/自己站点/);
 const single=await answerForecastChanges(f.db,f.users.admin,'印尼 TK BAG-A 生产建议比昨天变化多少',at+'T04:00:00Z');assert.match(single.answer,/印尼 \/ TikTok \/ BAG-A/);
});
test('单SKU测算与全量结果一致，并在源SQL缩小SKU读取范围',async()=>{
 const f=fixture(),whole=await loadForecast(f.db,f.users.admin,at);let filtered=false;
 const prepare=f.db.prepare;f.db.prepare=sql=>{if(sql.includes('SELECT * FROM inventory_balances WHERE sku IN'))filtered=true;return prepare(sql);};
 const one=await loadForecast(f.db,f.users.admin,at,'印尼|TikTok|BAG-A');assert.equal(filtered,true);assert.deepEqual(one.suggestions,whole.suggestions.filter(r=>r.site==='印尼'&&r.channel==='TikTok'&&r.sku==='BAG-A'));
});
test('性能窗口有界、剔除查询参数及过期样本',()=>{
 let time=100;const metrics=createRequestMetrics({clock:()=>time,limit:3,ttl:1000});
 for(const v of [10,20,30,2000])metrics.record('/api/system',v,200);
 metrics.record('/api/system?secret=private',10,500);const row=metrics.snapshot().rows[0];assert.equal(row.count,3);assert.equal(row.p95,2000);assert.equal(row.slow,1);
 time=1200;assert.equal(metrics.snapshot().rows.length,0);
});

test('内容关联覆盖按权限范围统计，分页筛选不漏未关联视频',async()=>{
 const f=contentFixture();await original(f);
 const insert=f.sqlite.prepare('INSERT INTO content_platform_reports VALUES(?,?,?,?,?,?,?,?,?,?)');
 for(const [site,id] of [['马来西亚','987654321001'],['马来西亚','987654321002'],['印尼','987654321003']])insert.run(site,'2026-11-01','2026-11-02',id,1,site==='印尼'?'IDR':'MYR','{}','TEST ONLY','admin-1',new Date().toISOString());
 const all=await readPlatformReports(f.db,f.users.malaysia,'',0,'all',Date.now(),'','all');assert.equal(all.coverage.total,2);assert.equal(all.coverage.matched,1);
 const unmatched=await readPlatformReports(f.db,f.users.malaysia,'',0,'all',Date.now(),'','unmatched');assert.equal(unmatched.rows.length,1);assert.equal(unmatched.rows[0].video_id,'987654321002');assert.equal(unmatched.coverage.total,2);
 await assert.rejects(readPlatformReports(f.db,f.users.malaysia,'印尼'),/无权|权限/);
});
