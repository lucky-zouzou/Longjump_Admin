import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {systemFixture,seedMonthly,svc,race} from './system-fixture.mjs';
import {loadForecast} from '../lib/forecast.ts';
import {readSalesDashboard,reportToday} from '../lib/sales-dashboard.mjs';
import {releaseMigrations} from '../lib/backup-version.mjs';
import {projectInventory} from '../lib/inventory-projection.mjs';
import {chartDays,chartScale} from '../lib/sales-charts.mjs';
import {indonesiaDate} from '../lib/wholesale.mjs';
const day=reportToday(),dateAt=n=>new Date(Date.parse(day)+n*86400000).toISOString().slice(0,10);
async function scenario(run){const f=systemFixture();try{return await run(f)}finally{f.sqlite.close()}}
const get=async(f,actor=f.users.admin)=>{svc.setActor(actor);const r=await svc.GET(new Request('http://localhost/api/system'));const body=await r.json();assert.equal(r.status,200,JSON.stringify(body));return body;};
const sale=(f,rows,date=day,extra={})=>svc.salesImport(f.users.indonesia,{site:'印尼',channel:'TikTok',businessDate:date,rows,sourceBatchRef:crypto.randomUUID(),importKey:crypto.randomUUID(),...extra});

test('财务脱敏后的完整响应中不保留原始财务JSON',()=>scenario(async f=>{
 const finance=JSON.stringify({unitCost:12345,internalTargetMargin:.456});
 f.sqlite.prepare('INSERT INTO new_product_projects(id,cycle_month,sku,stage_started_at,current_due_at,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run('audit-project',day.slice(0,7),'BAG-A',day,day,f.users.admin.id,day,day);
 f.sqlite.prepare("INSERT INTO new_product_stage_records(id,project_id,stage_key,data_json,actor_id,actor_name,submitted_at,updated_at) VALUES(?,?,'finance',?,?,?,?,?)").run('audit-finance','audit-project',finance,f.users.finance.id,f.users.finance.name,day,day);
 const r=(await get(f,f.users.indonesia)).newProductProjects[0].records[0];assert.deepEqual(r.data,{submitted:true});assert.ok(!JSON.stringify(r).includes('12345'));assert.ok(!Object.hasOwn(r,'data_json'));
 const allowed=(await get(f,f.users.finance)).newProductProjects[0].records[0];assert.equal(allowed.data.unitCost,12345);assert.ok(!Object.hasOwn(allowed,'data_json'));
}));
test('站点筛选后的批次不携带其他站点原始分配',()=>scenario(async f=>{
 const allocations=[{site:'印尼',channel:'TikTok',qty:3},{site:'马来西亚',channel:'Shopee',qty:7}];
 f.sqlite.prepare("INSERT INTO production_batches(id,month,sku,qty,stage,stage_owner,allocations_json,creator_id,created_at,updated_at) VALUES(?,?,?,?,'factory_production','工厂',?,?,?,?)").run('audit-batch',day.slice(0,7),'BAG-A',10,JSON.stringify(allocations),f.users.admin.id,day,day);
 const r=(await get(f,f.users.indonesia)).batches[0];assert.equal(r.qty,3);assert.equal(r.allocations.length,1);assert.ok(!JSON.stringify(r).includes('马来西亚'));assert.ok(!Object.hasOwn(r,'allocations_json'));
}));
test('费用和部分导入不改变其他SKU覆盖，完整日确认和冲销正确失效',()=>scenario(async f=>{
 await sale(f,[{sku:'BAG-B',qty:10}],dateAt(-1));
 const forecast=async()=> (await loadForecast(f.db,f.users.admin,day)).suggestions.find(r=>r.sku==='BAG-B'&&r.site==='印尼'&&r.channel==='TikTok');
 assert.equal((await forecast()).avg7,10);
 await sale(f,[{sku:'BAG-A',qty:0,adCost:100}]);assert.equal((await forecast()).avg7,10);assert.equal((await get(f,f.users.indonesia)).salesScopeStatus[0].updatedToday,false);
 const costOnly=await readSalesDashboard(f.db,f.users.indonesia,{from:day,to:day});assert.equal(chartDays(costOnly.daily,day,day)[0].qty,null);
 await svc.confirmSalesDay(f.users.indonesia,{site:'印尼',channel:'TikTok',businessDate:day,confirmed:true,note:'平台日报零销售核对'});
 assert.equal((await forecast()).avg7,5);assert.equal((await get(f,f.users.indonesia)).salesScopeStatus[0].updatedToday,true);
 const confirmed=await readSalesDashboard(f.db,f.users.indonesia,{from:day,to:day});assert.equal(chartDays(confirmed.daily,day,day)[0].qty,0);
 await sale(f,[{sku:'BAG-A',qty:0,adCost:20}]);assert.equal((await get(f,f.users.indonesia)).salesScopeStatus[0].updatedToday,true);
 const imported=await(await sale(f,[{sku:'BAG-B',qty:2}])).json();assert.equal((await get(f,f.users.indonesia)).salesScopeStatus[0].updatedToday,false);
 await svc.confirmSalesDay(f.users.indonesia,{site:'印尼',channel:'TikTok',businessDate:day,confirmed:true,note:'补录后全部日报核对'});
 await svc.reverseSalesImport(f.users.admin,{importId:imported.importId,reason:'测试冲销销量失效确认'});assert.equal((await get(f,f.users.indonesia)).salesScopeStatus[0].updatedToday,false);
}));
test('完整日报不得叠加已有销量，确认日报与新销售并发不会假完成',()=>scenario(async f=>{
 await sale(f,[{sku:'BAG-B',qty:2}]);const stock=f.sqlite.prepare("SELECT qty FROM inventory_balances WHERE site='印尼' AND channel='TikTok' AND sku='BAG-B'").get().qty;
 await assert.rejects(sale(f,[{sku:'BAG-B',qty:2}],day,{reportKind:'complete'}));assert.equal(f.sqlite.prepare("SELECT qty FROM inventory_balances WHERE site='印尼' AND channel='TikTok' AND sku='BAG-B'").get().qty,stock);
 const [confirm,added]=await race(f,()=>svc.confirmSalesDay(f.users.indonesia,{site:'印尼',channel:'TikTok',businessDate:day,confirmed:true,note:'并发核对测试说明'}),()=>sale(f,[{sku:'BAG-A',qty:1}]));
 assert.equal(added.ok,true);assert.equal(confirm.ok,false);assert.equal((await get(f,f.users.indonesia)).salesScopeStatus[0].updatedToday,false);
}));
async function production(f){const id=seedMonthly(f);await svc.decideApproval(f.users.admin,{approvalId:id,version:1,decision:'approve',comment:'测试批准计划'});const po=f.sqlite.prepare('SELECT * FROM series_purchase_orders').get(),mo=f.sqlite.prepare('SELECT * FROM series_production_orders').get();await svc.confirmPurchaseOrder(f.users.supply,{purchaseOrderId:po.id,orderRef:'AUDIT-PO',expectedCompletionDate:day});await svc.acceptProductionOrder(f.users.admin,{productionOrderId:mo.id,promisedCompletionDate:day,evidenceRef:'AUDIT-ACCEPT'});return {order:mo,item:f.sqlite.prepare('SELECT * FROM series_production_order_items').get()};}
test('零产出差异完工不再计入计划供应',()=>scenario(async f=>{
 const {order,item}=await production(f);await svc.completeProductionOrder(f.users.admin,{productionOrderId:order.id,evidenceRef:'AUDIT-ZERO',note:'全批失败实收为零',items:[{id:item.id,producedQty:0}]});
 const result=(await loadForecast(f.db,f.users.admin,day)).suggestions.find(r=>r.sku==='BAG-A'&&r.site==='印尼'&&r.channel==='TikTok');assert.equal(result.productionInProgress,0);
}));
test('两人并发完工只提交一次，不能覆盖已完成的数量',()=>scenario(async f=>{
 const {order,item}=await production(f),complete=qty=>svc.completeProductionOrder(f.users.admin,{productionOrderId:order.id,evidenceRef:'AUDIT-COMPLETE',note:'并发完工测试',items:[{id:item.id,producedQty:qty}]});
 const [first,second]=await race(f,()=>complete(0),()=>complete(10));assert.equal(second.ok,true);assert.equal(first.ok,false);assert.equal(f.sqlite.prepare('SELECT produced_qty FROM series_production_order_items WHERE id=?').get(item.id).produced_qty,10);
}));
test('线下需求按实际库存渠道分配计入预测，合计恰好等于实发',()=>scenario(async f=>{
 const day=indonesiaDate();
 const id=await f.create({qty:5,businessDate:day});await f.approve(id);await f.ship(id,5,day);
 const dashboard=await readSalesDashboard(f.db,f.users.admin,{from:day,to:day}),forecast=await loadForecast(f.db,f.users.admin,day);
 const rows=forecast.suggestions.filter(r=>r.site==='印尼'&&r.sku==='BAG-A');assert.equal(dashboard.totalQty,5);assert.equal(rows.reduce((n,r)=>n+r.offlineDailySales.at(-1),0),5);assert.equal(rows.reduce((n,r)=>n+r.forecastDaily,0),5);
}));
test('最近100条历史不能挤掉旧待审批',()=>scenario(async f=>{
 const insert=f.sqlite.prepare('INSERT INTO approval_requests(id,type,month,status,stage,creator_id,creator_role,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)');
 insert.run('old-pending','monthly_plan','2010-01','pending','admin_review',f.users.supply.id,'供应链','{}','2010-01-01','2010-01-01');
 for(let i=0;i<100;i++)insert.run('new-approved-'+i,'monthly_plan',`${2011+Math.floor(i/12)}-${String(i%12+1).padStart(2,'0')}`,'approved','done',f.users.supply.id,'供应链','{}',day,day);
 const data=await get(f);assert.ok(data.approvals.some(r=>r.id==='old-pending'));assert.equal(data.myTasks.filter(r=>r.title==='审批月度备货').length,1);
}));
test('每批到仓日期独立计入库存，识别两批之间的缺口',()=>scenario(async f=>{
 for(let i=-55;i<=0;i++)await sale(f,[{sku:'BAG-A',qty:10}],dateAt(i),{reportKind:'complete'});f.stock('BAG-A',100,10);
 for(const [id,qty,offset] of [['early',10,5],['late',1000,60]])f.sqlite.prepare("INSERT INTO production_batches(id,month,sku,qty,stage,stage_owner,allocations_json,estimated_arrival_date,creator_id,created_at,updated_at) VALUES(?,?,?,?,'sea_freight','海运',?,?,?,?,?)").run(id,day.slice(0,7),'BAG-A',qty,JSON.stringify([{site:'印尼',channel:'TikTok',qty}]),dateAt(offset),f.users.admin.id,day,day);
 const r=(await loadForecast(f.db,f.users.admin,day)).suggestions.find(r=>r.sku==='BAG-A'&&r.site==='印尼'&&r.channel==='TikTok');assert.equal(r.projectedAtNextArrival,60);assert.equal(r.alertLevel,'critical');assert.equal(r.projection.firstShortageDay,12);
}));
test('未知和逾期到货不当作今天已收到，同日多批合并、无销量不除零',()=>{
 const r=projectInventory({currentQty:10,dailyDemand:1,arrivals:[{days:null,qty:100},{days:-1,qty:200},{days:2,qty:3},{days:2,qty:4}],horizonDays:30,asOf:day});assert.equal(r.projectedAtNextArrival,15);assert.equal(r.unknownArrivalQty,300);assert.equal(r.firstShortageDay,18);
 assert.equal(projectInventory({currentQty:0,dailyDemand:0,arrivals:[],horizonDays:30,asOf:day}).firstShortageDay,null);
});
test('备份清单覆盖全部迁移并校验内容，避免恢复版本误判',()=>{
 const files=readdirSync(new URL('../drizzle/',import.meta.url)).filter(n=>n.endsWith('.sql')).sort();assert.deepEqual(releaseMigrations,files.map(name=>({name,sha256:createHash('sha256').update(readFileSync(new URL('../drizzle/'+name,import.meta.url))).digest('hex')})));
});
test('真实发布判定精确识别健康状态，并核对外部运行版本',()=>{
 const workflow=readFileSync(new URL('../.github/workflows/deploy.yml',import.meta.url),'utf8'),body=workflow.match(/case "\$status" in([\s\S]*?)esac/)[0];
 const check=(status,release='expected')=>spawnSync('/bin/bash',['-c',`set -eo pipefail\nstatus="$1"\ncurl(){ printf '%s' '{"ok":true,"release":"${release}"}'; }\n${body}\nexit 1`,'health-test',status],{env:{...process.env,EXPECTED_RELEASE:'expected'}}).status;
 assert.equal(check('true healthy'),0);for(const status of ['true unhealthy','false healthy','true starting','true missing',''])assert.notEqual(check(status),0);assert.notEqual(check('true healthy','old-version'),0);
});
test('图形不把缺失日和缺金额变成0，并保留退货负值',()=>{
 const rows=chartDays([{date:dateAt(-2),qty:3,revenue:90,adCost:0,revenueMissing:0,costMissing:0},{date:day,qty:-1,revenue:-30,adCost:null,revenueMissing:0,costMissing:1}],dateAt(-2),day);
 assert.equal(rows[0].adCost,0);assert.equal(rows[1].qty,null);assert.equal(rows[2].revenue,-30);assert.equal(rows[2].adCost,null);assert.ok(chartScale([null,3,-1]).min<0);assert.ok(chartScale([null]).max>chartScale([null]).min);
});
