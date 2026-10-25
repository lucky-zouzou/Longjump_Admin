import test from 'node:test';
import assert from 'node:assert/strict';
import {systemFixture,svc,race} from './system-fixture.mjs';
import {loadForecast} from '../lib/forecast.ts';
import {forecastPlan} from '../lib/forecast-model.mjs';
import {projectInventory} from '../lib/inventory-projection.mjs';
import {actionWindow,compareActions,evaluateActions} from '../lib/business-action-model.mjs';
import {actionCandidates,actionFinanceDay} from '../lib/business-action-data.mjs';
import {refreshBusinessActions,mutateBusinessAction,readActionFinanceDay,readBusinessActions} from '../lib/business-actions.mjs';
import {localDay,shiftDay} from '../lib/promotion-model.mjs';
import {completeSalesDates} from '../lib/sales-completeness.mjs';

const today=localDay(new Date(),'印尼'),yesterday=shiftDay(today,-1);
const payload=(changes={})=>({site:'印尼',channel:'TikTok',businessDate:yesterday,sourceBatchRef:crypto.randomUUID(),importKey:crypto.randomUUID(),rows:[{sku:'BAG-A',qty:2,amount:200,currency:'IDR'}],...changes});
const stock=f=>f.sqlite.prepare("SELECT qty FROM inventory_balances WHERE site='印尼' AND channel='TikTok' AND sku='BAG-A'").get().qty;

test('重叠日汇总换文件、批次、数量仍拦截，整批不新增销量或扣库存',async()=>{
 const f=systemFixture(),a=f.users.indonesia;
 await svc.salesImport(a,payload());
 const before=stock(f),n=f.sqlite.prepare('SELECT count(*) n FROM sales_records').get().n;
 for(const rows of [[{sku:'BAG-A',qty:2}],[{sku:'BAG-B',qty:4},{sku:'BAG-A',qty:3}]]){
  await assert.rejects(svc.salesImport(a,payload({rows,fileName:'另存为.xlsx'})),/无法证明报表不重叠/);
  assert.equal(stock(f),before);assert.equal(f.sqlite.prepare('SELECT count(*) n FROM sales_records').get().n,n);
 }
 // Distinct scopes and dates are independent; a disjoint SKU is allowed.
 await svc.salesImport(a,payload({rows:[{sku:'BAG-B',qty:1}]}));
 await svc.salesImport(a,payload({businessDate:shiftDay(yesterday,-1)}));
 await svc.salesImport({...a,channel:'Shopee'},payload({channel:'Shopee'}));
 assert.equal(stock(f),6);
});
test('并发换批次上传同日 SKU 只能成功一次，数据库回滚先写入的其他 SKU',async()=>{
 const f=systemFixture(),a=f.users.indonesia;
 const results=await race(f,()=>svc.salesImport(a,payload({rows:[{sku:'BAG-B',qty:3},{sku:'BAG-A',qty:2}]})),()=>svc.salesImport(a,payload()));
 assert.equal(results.filter(r=>r.ok).length,1);assert.equal(stock(f),8);
 assert.equal(f.sqlite.prepare("SELECT qty FROM inventory_balances WHERE site='印尼' AND channel='TikTok' AND sku='BAG-B'").get().qty,10);
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM sales_imports').get().n,1);
});
test('半天转全天通过原子修订只扣差额，冲销后可重新导入，不残留重复销量',async()=>{
 const f=systemFixture(),a=f.users.indonesia;
 const {importId}=await (await svc.salesImport(a,payload())).json();
 const updated=await (await svc.correctSalesImport(f.users.admin,payload({importId,reason:'半天报表修订为完整累计五件',rows:[{sku:'BAG-A',qty:5,amount:500,currency:'IDR'}]}))).json();
 assert.equal(stock(f),5);assert.equal(f.sqlite.prepare('SELECT SUM(qty) n FROM sales_records WHERE reversed_at IS NULL').get().n,5);
 await svc.reverseSalesImport(f.users.admin,{importId:updated.importId,reason:'测试冲销后重新导入确认'});assert.equal(stock(f),10);
 await svc.salesImport(a,payload({rows:[{sku:'BAG-A',qty:5}]}));assert.equal(stock(f),5);
});
test('选择完整但未核实仍是部分日报，当地未结束的今天不能提前确认',async()=>{
 const f=systemFixture(),a=f.users.indonesia;
 await svc.salesImport(a,payload({reportKind:'complete'}));
 assert.equal(f.sqlite.prepare('SELECT report_kind FROM sales_imports').get().report_kind,'partial');
 await svc.salesImport(a,payload({businessDate:today,reportKind:'complete',fullDayConfirmed:true}));
 assert.equal(f.sqlite.prepare('SELECT report_kind FROM sales_imports WHERE business_date=?').get(today).report_kind,'partial');
 await assert.rejects(svc.confirmSalesDay(a,{site:a.site,channel:a.channel,businessDate:today,confirmed:true,note:'只上传半天不能标整天'}),/尚未结束/);
 await svc.confirmSalesDay(a,{site:a.site,channel:a.channel,businessDate:yesterday,confirmed:true,note:'昨日全天平台报表核对'});
 assert.ok(f.sqlite.prepare("SELECT id FROM sales_imports WHERE business_date=? AND report_kind='complete'").get(yesterday));
});

const now=new Date('2026-10-23T05:00:00Z'),w=actionWindow('印尼',now);
function addDay(f,d,qty=2){
 f.sqlite.prepare("INSERT INTO sales_imports(id,import_key,business_date,site,channel,row_count,total_qty,actor_id,created_at,report_kind) VALUES(?,?,?,'印尼','TikTok',1,?,'id-ops',?,'complete')").run('i-'+d,'k-'+d,d,qty,d);
 f.sqlite.prepare("INSERT INTO sales_records(id,import_id,business_date,site,channel,sku,qty,currency,reported_amount,actor_id,created_at) VALUES(?,?,?,'印尼','TikTok','BAG-A',?,'IDR',?,'id-ops',?)").run('s-'+d,'i-'+d,d,qty,qty*100,d);
}
function seed(f){for(const d of w.days)addDay(f,d);f.stock('BAG-A',2,10);}
const action=f=>f.sqlite.prepare("SELECT * FROM business_actions WHERE site='印尼' AND channel='TikTok' AND sku='BAG-A' AND kind='loss'").get();
async function saveDay(f,date,costs={landed:100,ads:0,platform:0,fulfillment:0,returns:0},at=now){
 const r=action(f),d=await actionFinanceDay(f.db,r,date);
 return mutateBusinessAction(f.db,f.users.finance,{id:r.id,version:r.version,action:'finance',businessDate:date,basisHash:d.basisHash,revision:d.revision,costs,source:'每日结算凭据-'+date,confirmed:true,note:'核对原币日报、退款及广告归属'},at);
}
const candidate=async(f,kind='loss',at=now)=>(await actionCandidates(f.db,f.users.admin,at)).find(r=>r.kind===kind&&r.sku==='BAG-A'&&r.site==='印尼'&&r.channel==='TikTok');

test('有部分销量不能补足完整覆盖，当前日再大销量也不进入预测',async()=>{
 const f=systemFixture();seed(f);
 f.sqlite.prepare("UPDATE sales_imports SET report_kind='partial' WHERE business_date=?").run(w.cutoff);
 addDay(f,w.today,1000);
 let r=(await loadForecast(f.db,f.users.admin,w.today)).suggestions.find(r=>r.site==='印尼'&&r.channel==='TikTok'&&r.sku==='BAG-A');
 assert.equal(r.forecastReady,false);assert.deepEqual(r.missingDates,[w.cutoff]);assert.equal(r.suggestedProduction,null);assert.equal(r.projection,null);assert.equal(r.estimatedForecastDaily,2);assert.equal(r.dailySeries.at(-1).qty,null);assert.equal(r.dailySeries.at(-1).observedQty,2);
 assert.equal((await candidate(f,'stockout')).condition,'verify');
 f.sqlite.prepare("UPDATE sales_imports SET report_kind='complete' WHERE business_date=?").run(w.cutoff);
 r=(await loadForecast(f.db,f.users.admin,w.today)).suggestions.find(r=>r.site==='印尼'&&r.channel==='TikTok'&&r.sku==='BAG-A');
 assert.equal(r.forecastDaily,2);assert.equal(r.completeDays,7);
});
test('历史重叠报表不能继续提供确定预测，完整标记也不能掩盖重复',async()=>{
 const f=systemFixture();seed(f);
 f.sqlite.exec('DROP TRIGGER sales_summary_overlap_insert'); // simulate pre-upgrade legacy data
 f.sqlite.prepare("INSERT INTO sales_records(id,import_id,business_date,site,channel,sku,qty,currency,reported_amount,actor_id,created_at) VALUES('overlap','other',?,'印尼','TikTok','BAG-A',2,'IDR',200,'id-ops',?)").run(w.cutoff,w.cutoff);
 const r=(await loadForecast(f.db,f.users.admin,w.today)).suggestions.find(r=>r.site==='印尼'&&r.channel==='TikTok'&&r.sku==='BAG-A');
 assert.equal(r.forecastReady,false);assert.equal((await candidate(f)).profit,null);
 assert.deepEqual(completeSalesDates([{business_date:w.cutoff,report_kind:'complete'}],f.sqlite.prepare('SELECT * FROM sales_records').all()),[]);
});
test('补货和行动单使用同一需求、到货曲线和补货量，含需求修正及供应参数',async()=>{
 const f=systemFixture();seed(f);
 f.sqlite.prepare("UPDATE sku_settings SET production_lead_days=2,sea_lead_days=3,review_cycle_days=2 WHERE sku='BAG-A'").run();
 f.sqlite.prepare("INSERT INTO sales_demand_corrections(id,sku,site,channel,business_date,return_qty,reason,actor_id,updated_at) VALUES('adjust','BAG-A','印尼','TikTok',?,1,'退货需求修正','admin',?)").run(w.cutoff,w.cutoff);
 const plan=(await loadForecast(f.db,f.users.admin,w.today)).suggestions.find(r=>r.site==='印尼'&&r.channel==='TikTok'&&r.sku==='BAG-A');
 const r=await candidate(f,'stockout');assert.ok(plan.forecastDaily<2);assert.equal(r.supply.forecastDaily,plan.forecastDaily);assert.equal(r.supply.suggestedQty,plan.suggestedProduction);assert.deepEqual(r.supply.projection.curve,plan.projection.curve);
});
test('逐日缺货只累计当日未满足需求，到货恢复后停止，第二次缺口仍重新计算',()=>{
 const p=projectInventory({currentQty:1,dailyDemand:2,arrivals:[{days:3,qty:10}],horizonDays:10,asOf:w.today});
 assert.deepEqual(p.curve.slice(1,8).map(d=>d.unmetDemand),[1,2,0,0,0,0,0]);
 assert.equal(p.curve[8].unmetDemand,2);assert.equal(p.curve[3].closingQty,8);
 const unknown=projectInventory({currentQty:0,dailyDemand:2,arrivals:[{days:-1,qty:10},{days:null,qty:10}],horizonDays:7,asOf:w.today});
 assert.equal(unknown.unknownArrivalQty,20);assert.equal(unknown.curve.slice(1).reduce((n,d)=>n+d.unmetDemand,0),14);
});
test('必须明天行动的小款排在一个月后才需行动的大款前，同日再看近期损失',()=>{
 const base={site:'印尼',channel:'TikTok',kind:'stockout',condition:'active',reliability:3};
 const list=[{...base,sku:'BIG',mustActInDays:30,recoverableCny:100000},{...base,sku:'SMALL',mustActInDays:1,recoverableCny:20},{...base,sku:'TODAY',mustActInDays:0,recoverableCny:1},{...base,sku:'UNKNOWN',condition:'verify',mustActInDays:0,recoverableCny:1e9}].sort(compareActions);
 assert.deepEqual(list.map(r=>r.sku),['TODAY','SMALL','BIG','UNKNOWN']);
 assert.deepEqual([{...base,sku:'LARGE-DAILY',mustActInDays:1,delayCny:999,recoverableCny:2},{...base,sku:'AVOIDABLE',mustActInDays:1,delayCny:1,recoverableCny:20}].sort(compareActions).map(r=>r.sku),['AVOIDABLE','LARGE-DAILY']);
});
test('每日成本跨滚动窗口复用六天，只补新一天；三类行动共享同一日账',async()=>{
 const f=systemFixture();seed(f);await refreshBusinessActions(f.db,f.users.admin,now);
 for(const d of w.days.slice(-7))await saveDay(f,d);
 assert.equal((await candidate(f)).profit,700);
 addDay(f,w.today);const tomorrow=new Date(+now+86400000),before=f.sqlite.prepare('SELECT * FROM business_action_finance_days').all();
 let c=await candidate(f,'loss',tomorrow);assert.equal(c.financeDays.filter(d=>d.status==='confirmed').length,6);assert.equal(c.profit,null);
 await saveDay(f,w.today,undefined,tomorrow);c=await candidate(f,'loss',tomorrow);assert.equal(c.profit,700);
 assert.equal(f.sqlite.prepare('SELECT count(*) n FROM business_action_finance_days').get().n,8);
 for(const row of before)assert.deepEqual(f.sqlite.prepare('SELECT * FROM business_action_finance_days WHERE id=?').get(row.id),row);
 assert.equal((await candidate(f,'stockout',tomorrow)).profit,700);
});
test('成本修订追加版本保留凭据，七天自动重算；退款修改仅使相关日待复核',async()=>{
 const f=systemFixture();seed(f);await refreshBusinessActions(f.db,f.users.admin,now);
 for(const d of w.days.slice(-7))await saveDay(f,d);
 await saveDay(f,w.cutoff,{landed:100,ads:0,platform:0,fulfillment:0,returns:20});assert.equal((await candidate(f)).profit,680);
 let day=await readActionFinanceDay(f.db,f.users.finance,action(f).id,w.cutoff,now);assert.equal(day.history.length,2);assert.equal(day.history[1].costs.returns,0);assert.equal(day.history[0].costs.returns,20);
 f.sqlite.prepare("INSERT INTO after_sales(id,owner_id,owner_name,site,channel,business_date,case_no,sku,status,data_json,created_at,updated_at) VALUES('refund','id-ops','运营','印尼','TikTok',?,'R-1','BAG-A','submitted',?,?,?)").run(w.cutoff,JSON.stringify({refundAmount:30}),w.cutoff,w.cutoff);
 let c=await candidate(f);assert.equal(c.profit,null);assert.equal(c.financeDays.filter(d=>d.status==='stale').length,1);assert.equal(c.financeDays.filter(d=>d.status==='confirmed').length,6);
 await saveDay(f,w.cutoff,{landed:100,ads:0,platform:0,fulfillment:0,returns:30});assert.equal((await candidate(f)).profit,670);
 day=await actionFinanceDay(f.db,action(f),w.cutoff);assert.equal(day.history.length,3);assert.equal(day.history[0].basis.afters[0].id,'refund');
 assert.throws(()=>f.sqlite.prepare("UPDATE business_action_finance_days SET source='overwrite'").run(),/immutable/);
});
test('每日核算可先记录一个已完整日，历史修订无需其余六天，权限及并发版本受限',async()=>{
 const f=systemFixture();addDay(f,w.cutoff);await refreshBusinessActions(f.db,f.users.admin,now);
 await saveDay(f,w.cutoff);assert.equal((await candidate(f)).financeDays.filter(d=>d.status==='confirmed').length,1);
 const r=action(f);await assert.rejects(readActionFinanceDay(f.db,f.users.supply,r.id,w.cutoff,now),/仅财务/);
 await assert.rejects(readActionFinanceDay(f.db,f.users.malaysia,r.id,w.cutoff,now),/无权/);
 const d=await actionFinanceDay(f.db,r,w.cutoff),p={id:r.id,version:r.version,action:'finance',businessDate:w.cutoff,basisHash:d.basisHash,revision:0,costs:d.costs,source:'重复旧版本提交',confirmed:true,note:'测试重复旧版本'};
 await assert.rejects(mutateBusinessAction(f.db,f.users.finance,p,now),/新修订/);
 const pair=await race(f,()=>mutateBusinessAction(f.db,f.users.finance,{...p,revision:1},now),()=>mutateBusinessAction(f.db,f.users.finance,{...p,revision:1},now));assert.equal(pair.filter(r=>r.ok).length,1);
 await refreshBusinessActions(f.db,f.users.admin,now);assert.ok(!(JSON.stringify(await readBusinessActions(f.db,f.users.supply))).includes('financeDays'));
});

function pricedAction({sku='TEST',daily=2,current=1,arrivals=[],offline=[]}={}){
 const dates=Array.from({length:56},(_,i)=>shiftDay(w.today,i-56));
 const forecast=forecastPlan({dailySales:Array(56).fill(daily),dailyCoverage:Array(56).fill(true),offlineDailySales:offline,currentQty:current,arrivalLots:arrivals,seaInTransit:arrivals.reduce((n,l)=>n+l.qty,0),productionInProgress:0,pendingShelf:0},{production_days:2,transport_days:3,review_days:50},[],dates,w.today);
 return evaluateActions({sku,site:'印尼',channel:'TikTok',window:w,available:current,sales:w.days.map(d=>({business_date:d,qty:daily,reported_amount:daily*100,currency:'IDR'})),complete:w.days,observations:[],finance:{data:{landed:daily*7*50,ads:0,platform:0,fulfillment:0,returns:0}},forecast,setting:{},fx:{rates:{IDR:2000},status:'fresh'},afterCount:0}).find(r=>r.kind==='stockout');
}
test('真实预测导出最迟行动日；到货后可避免损失只计缺货的两天',()=>{
 const small=pricedAction({sku:'SMALL',current:10}),large=pricedAction({sku:'LARGE',daily:100,current:3000});
 assert.equal(small.mustActInDays,1);assert.equal(large.mustActInDays,26);assert.equal([large,small].sort(compareActions)[0].sku,'SMALL');
 const restored=pricedAction({arrivals:[{days:3,qty:100}]});assert.equal(restored.delayAmount,50);assert.equal(restored.recoverableAmount,150);
 const mixed=pricedAction({offline:[3]});assert.equal(mixed.condition,'verify');assert.equal(mixed.recoverableAmount,null);
 const unknown=pricedAction({arrivals:[{days:null,qty:100}]});assert.equal(unknown.recoverableAmount,null);assert.equal(unknown.supply.suggestedQty,null);
});
test('周期外到货不能抵消本期缺口；短补货周期仍计算完整未来七天',()=>{
 const input={dailySales:Array(56).fill(2),dailyCoverage:Array(56).fill(true),currentQty:1,seaInTransit:1000,arrivalLots:[{days:60,qty:1000}]};
 const plan=forecastPlan(input,{production_days:1,transport_days:1,review_days:1},[],w.today);
 assert.equal(plan.suggestedProduction,5);assert.equal(plan.lateSeaQty,1000);assert.equal(plan.projection.curve.length,8);
});

test('完整零销量日的费用行不要求虚构销售额，仍按每日成本计算亏损',async()=>{
 const f=systemFixture();seed(f);
 f.sqlite.prepare("UPDATE sales_records SET qty=0,reported_amount=NULL,ad_cost=20 WHERE business_date=?").run(w.cutoff);
 f.sqlite.prepare("UPDATE sales_imports SET report_kind='zero',total_qty=0 WHERE business_date=?").run(w.cutoff);
 await refreshBusinessActions(f.db,f.users.admin,now);
 for(const d of w.days.slice(-7))await saveDay(f,d,d===w.cutoff?{landed:0,ads:20,platform:0,fulfillment:0,returns:0}:undefined);
 const c=await candidate(f);assert.equal(c.qty,12);assert.equal(c.revenue,1200);assert.equal(c.profit,580);
 const day=await actionFinanceDay(f.db,action(f),w.cutoff);assert.equal(day.revenue,0);assert.equal(day.status,'confirmed');
});
