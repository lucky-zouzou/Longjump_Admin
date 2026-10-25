import test from 'node:test';
import assert from 'node:assert/strict';
import {systemFixture,svc,race} from './system-fixture.mjs';
import {fixture} from './fixtures.mjs';
import {readSalesDashboard,reportToday} from '../lib/sales-dashboard.mjs';
import {validateFxPayload,loadSalesFx,convertSalesSummary} from '../lib/sales-fx.mjs';
import {salesImportWarnings} from '../lib/sales-quality.mjs';
import {repairRepeatedAdSpend,saveSalesAdSpend} from '../lib/sales-ad-spend.mjs';
const day=reportToday(),now=Date.parse(day+'T06:00:00Z'),DAY=86400000;
const rates={CNY:1,IDR:2000,MYR:.6,THB:5,VND:3500,PHP:8,USD:.14};
const payload=(time=now)=>({result:'success',base_code:'CNY',time_last_update_unix:(time-3600000)/1000,time_next_update_unix:(time+23*3600000)/1000,rates});
const fx={status:'fresh',rates,effectiveAt:new Date(now).toISOString()};
const response=p=>new Response(JSON.stringify(p));
const scope=(site,currency,revenue,adCost,more={})=>({site,channel:'TikTok',currency,qty:2,revenue,adCost,revenueMissing:0,costMissing:0,...more});

test('人民币汇总统一五站、渠道和原币范围，合计与逐项明细一致，原值不变',()=>{
 const report={filters:{},scopes:[scope('印尼','IDR',20000,2000),scope('马来西亚','MYR',6,.6),scope('泰国','THB',50,5),scope('越南','VND',35000,3500),scope('菲律宾','PHP',80,8),scope('印尼','CNY',10,1)]};
 const original=JSON.stringify(report),c=convertSalesSummary(report,fx);
 assert.equal(c.total.revenueCny,60);assert.equal(c.total.adCostCny,6);assert.equal(c.total.roas,10);assert.equal(c.total.qty,12);assert.equal(c.total.averagePrice,5);
 assert.equal(c.sites.length,5);assert.equal(c.sites.find(r=>r.site==='印尼').revenueCny,20);assert.equal(JSON.stringify(report),original);
 const round=convertSalesSummary({filters:{site:'印尼'},scopes:[scope('印尼','IDR',12345,1234),scope('印尼','CNY',10.01,1.01,{channel:'Shopee'})]},fx);
 assert.equal(round.total.revenueCny,16.18);assert.equal(round.sites[0].revenueCny,16.18);assert.equal(round.total.adCostCny,1.63);assert.equal(round.sites.length,1);
});
test('缺金额或汇率不伪造0，不完整资料不算整体投产比；退货负额仍保留',()=>{
 const r={filters:{},scopes:[scope('印尼','IDR',20000,null,{costMissing:1}),scope('印尼','UNKNOWN',300,10),scope('马来西亚','CNY',null,20,{revenueMissing:1})]};
 const c=convertSalesSummary(r,fx);assert.equal(c.total.revenueCny,10);assert.equal(c.total.adCostCny,20);assert.equal(c.total.unconverted,1);assert.equal(c.total.roas,null);assert.equal(c.total.averagePrice,null);
 const unavailable=convertSalesSummary({filters:{},scopes:[scope('印尼','IDR',20000,2000),scope('马来西亚','CNY',100,10)]},{status:'unavailable',rates:{CNY:1}});
 assert.equal(unavailable.total.revenueCny,100);assert.equal(unavailable.total.revenueComplete,false);
 const negative=convertSalesSummary({filters:{},scopes:[scope('印尼','IDR',-20000,0,{qty:-2})]},fx);assert.equal(negative.total.revenueCny,-10);assert.equal(negative.total.averagePrice,null);assert.equal(negative.total.roas,null);
 const empty=convertSalesSummary({filters:{},scopes:[]},fx);assert.equal(empty.total.revenueCny,null);assert.equal(empty.total.revenueComplete,false);
});
test('汇率验证拒绝错误基准、缺币种、非法数值、未来及过期日期',()=>{
 assert.equal(validateFxPayload(payload(),now).rates.IDR,2000);
 for(const bad of [{base_code:'USD'},{result:'error'},{rates:{...rates,IDR:0}},{rates:{...rates,PHP:'8'}},{rates:{...rates,CNY:2}},{time_last_update_unix:(now+DAY)/1000},{time_last_update_unix:(now-8*DAY)/1000},{time_next_update_unix:0}])assert.throws(()=>validateFxPayload({...payload(),...bad},now));
});
test('汇率只请求固定公共地址，缓存每日快照，重试同一时间戳不改历史汇率',async()=>{
 const f=fixture();try{
 let calls=0;const fetcher=async(url,options)=>{calls++;assert.equal(url,'https://open.er-api.com/v6/latest/CNY');assert.equal(options.redirect,'error');assert.equal(options.body,undefined);return response(payload());};
 const a=await loadSalesFx(f.db,{now,fetcher});assert.equal(a.status,'fresh');assert.equal(a.rates.MYR,.6);
 await loadSalesFx(f.db,{now:now+1000,fetcher});assert.equal(calls,1);
 const changed=await loadSalesFx(f.db,{now:now+DAY,fetcher:async()=>response({...payload(),time_next_update_unix:(now+2*DAY)/1000,rates:{...rates,IDR:3000}})});
 assert.equal(changed.rates.IDR,2000);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM sales_fx_snapshots').get().n,1);
 }finally{f.sqlite.close();}
});
test('汇率请求合并，故障退避，陈旧与不可用明确区分，维护锁不写入',async()=>{
 const f=fixture();try{
 let calls=0;const fetcher=async()=>{calls++;await new Promise(r=>setTimeout(r,10));return response(payload());};
 await Promise.all([loadSalesFx(f.db,{now,fetcher}),loadSalesFx(f.db,{now,fetcher})]);assert.equal(calls,1);
 const fail=async()=>{calls++;throw Error('offline');};
 const stale=await loadSalesFx(f.db,{now:now+2*DAY,fetcher:fail});assert.equal(stale.status,'stale');assert.equal(stale.refreshFailed,true);
 await loadSalesFx(f.db,{now:now+2*DAY+100,fetcher:fail});assert.equal(calls,2);
 const old=await loadSalesFx(f.db,{now:now+8*DAY,fetcher:fail});assert.equal(old.status,'unavailable');assert.deepEqual(old.rates,{CNY:1});
 f.sqlite.prepare("INSERT INTO system_maintenance(id,mode,token_hash,actor_id,expires_at,updated_at) VALUES('global','backup','x','a','9999-12-01','now')").run();
 const locked=await loadSalesFx(f.db,{now:now+9*DAY,fetcher});assert.equal(locked.status,'unavailable');assert.equal(calls,3);
 assert.throws(()=>f.sqlite.prepare('DELETE FROM sales_fx_snapshots').run(),/guard_maintenance/);
 }finally{f.sqlite.close();}
});
test('超大汇率响应不缓存；无网络也能保留人民币数据',async()=>{
 const f=fixture();try{const result=await loadSalesFx(f.db,{now,fetcher:async()=>new Response('x'.repeat(66000))});assert.equal(result.status,'unavailable');assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM sales_fx_snapshots').get().n,0);}finally{f.sqlite.close();}
});
test('导入提醒区分相同费用、原币不符与零金额；零费用和未知不误判',()=>{
 const rows=Array.from({length:48},(_,i)=>({sku:'BAG-'+i,qty:1,amount:i===47?0:100,adCost:22695,currency:'IDR'}));
 const alerts=salesImportWarnings(rows,'IDR');assert.equal(alerts.length,2);assert.match(alerts[0].message,/1,089,360/);assert.match(alerts[1].message,/销售额为 0/);
 assert.equal(salesImportWarnings([{sku:'A',qty:1,amount:100,currency:'CNY'}],'IDR')[0].code,'foreign-CNY');
 assert.equal(salesImportWarnings([{sku:'A',qty:1,amount:100,adCost:0},{sku:'B',qty:1,amount:'',adCost:''}],'IDR').length,0);
});
async function importRepeated(f){
 const rows=Array.from({length:48},(_,i)=>({sku:'BAG-'+i,qty:1,amount:100,adCost:22695,currency:'IDR'}));
 const {importId}=await (await svc.salesImport(f.users.indonesia,{site:'印尼',channel:'TikTok',businessDate:day,sourceBatchRef:crypto.randomUUID(),importKey:crypto.randomUUID(),reportKind:'complete',fullDayConfirmed:true,rows})).json();return importId;
}
const repairPayload=id=>({importId:id,expectedRows:48,expectedCost:22695,totalAmount:22695,confirmed:true,note:'运营确认该费用为店铺当天总费用，误填在每行'});
const inventory=f=>JSON.stringify(f.sqlite.prepare('SELECT * FROM inventory_balances ORDER BY site,channel,sku').all());
test('48行重复全店广告费修正为1笔，库存销量及日报状态不变，原值保留审计',async()=>{
 const f=systemFixture();try{
 const id=await importRepeated(f),stock=inventory(f),source=f.sqlite.prepare('SELECT * FROM sales_imports WHERE id=?').get(id),before=await readSalesDashboard(f.db,f.users.admin,{from:day,to:day});
 assert.equal(before.currencies[0].adCost,1089360);assert.equal(before.quality.repeatedCosts.length,1);
 await repairRepeatedAdSpend(f.db,f.users.admin,repairPayload(id));
 const after=await readSalesDashboard(f.db,f.users.admin,{from:day,to:day});assert.equal(after.totalQty,48);assert.equal(after.currencies[0].revenue,4800);assert.equal(after.currencies[0].adCost,22695);assert.equal(after.currencies[0].costMissing,0);assert.equal(after.quality.repeatedCosts.length,0);assert(after.roiRanking.every(r=>r.roas===null));
 assert.equal(inventory(f),stock);assert.deepEqual(f.sqlite.prepare('SELECT * FROM sales_imports WHERE id=?').get(id),source);
 const audit=JSON.parse(f.sqlite.prepare("SELECT detail_json FROM audit_logs WHERE action='修正重复全店广告费'").get().detail_json);assert.equal(audit.before.length,48);assert.equal(audit.before[0].ad_cost,22695);assert.equal(audit.channelTotal.amount,22695);
 await assert.rejects(repairRepeatedAdSpend(f.db,f.users.admin,repairPayload(id)),e=>e.status===409);
 }finally{f.sqlite.close();}
});
test('重复费用修正拒绝越权、无确认、陈旧清单和已有总费用；未修改销售',async()=>{
 const f=systemFixture();try{
 const id=await importRepeated(f),p=repairPayload(id);
 svc.setActor(f.users.admin);const refused=await svc.POST(new Request('https://admin.example/api/system',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'repairRepeatedAdSpend',...p,confirmed:false})}));assert.equal(refused.status,400);assert.match((await refused.json()).error,/核对依据/);
 for(const actor of [f.users.finance,f.users.supply,f.users.malaysia])await assert.rejects(repairRepeatedAdSpend(f.db,actor,p),e=>e.status===403);
 for(const extra of [{confirmed:false},{note:'少'},{totalAmount:'1.001'},{totalAmount:0}])await assert.rejects(repairRepeatedAdSpend(f.db,f.users.indonesia,{...p,...extra}),e=>e.status===400);
 await assert.rejects(repairRepeatedAdSpend(f.db,f.users.admin,{...p,expectedRows:47}),e=>e.status===409);
 await saveSalesAdSpend(f.db,f.users.admin,{action:'salesAdSpendSave',site:'印尼',channel:'TikTok',businessDate:day,currency:'IDR',amount:123,note:'已有渠道费用核对',version:0});
 await assert.rejects(repairRepeatedAdSpend(f.db,f.users.admin,p),e=>e.status===409);
 assert.equal(f.sqlite.prepare('SELECT SUM(ad_cost) n FROM sales_records WHERE import_id=?').get(id).n,1089360);
 }finally{f.sqlite.close();}
});
test('重复费用修正并发只成功一次，失败事务回滚全部修改',async()=>{
 const f=systemFixture();try{
 const id=await importRepeated(f),p=repairPayload(id),stock=inventory(f);const run=()=>repairRepeatedAdSpend(f.db,f.users.admin,p);
 const results=await race(f,run,run);assert.equal(results.filter(r=>r.ok).length,1);assert.equal(inventory(f),stock);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM sales_ad_spend').get().n,1);
 }finally{f.sqlite.close();}
 const f2=systemFixture();try{const id=await importRepeated(f2);f2.sqlite.exec("CREATE TRIGGER fail_repair BEFORE INSERT ON sales_ad_spend BEGIN SELECT RAISE(ABORT,'test_failure'); END");await assert.rejects(repairRepeatedAdSpend(f2.db,f2.users.admin,repairPayload(id)),/test_failure/);assert.equal(f2.sqlite.prepare('SELECT SUM(ad_cost) n FROM sales_records WHERE import_id=?').get(id).n,1089360);}finally{f2.sqlite.close();}
});
test('看板核对提示按运营范围隔离，工厂响应不包含费用与人民币数据',async()=>{
 const f=systemFixture();try{
 await importRepeated(f);const op=await readSalesDashboard(f.db,f.users.malaysia,{from:day,to:day});assert.equal(op.quality.repeatedCosts.length,0);
 const factory=await readSalesDashboard(f.db,{id:'factory',role:'工厂'},{from:day,to:day});assert.equal(factory.financialVisible,false);assert.equal(factory.quality,undefined);assert.equal(factory.cny,undefined);assert(!JSON.stringify(factory).includes('22695'));
 }finally{f.sqlite.close();}
});

// The provider may legitimately serve yesterday's snapshot before publishing the next one.
test('已成功读取但供应商尚未更新时，短期缓存不会误报更新失败',async()=>{
 const f=fixture();try{let calls=0;const fetcher=async()=>{calls++;return response({...payload(now-DAY),time_next_update_unix:(now-1000)/1000});};
 const first=await loadSalesFx(f.db,{now,fetcher}),cached=await loadSalesFx(f.db,{now:now+1000,fetcher});
 assert.equal(first.refreshFailed,false);assert.equal(cached.refreshFailed,false);assert.equal(calls,1);
 }finally{f.sqlite.close();}
});
