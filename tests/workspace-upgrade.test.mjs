import test from 'node:test';
import assert from 'node:assert/strict';
import {systemFixture,svc} from './system-fixture.mjs';
import {readHistory,historyCsv} from '../lib/history-query.mjs';
import {publicSystemSnapshot} from '../lib/system-response.mjs';
import {readSalesDashboard,reportToday} from '../lib/sales-dashboard.mjs';
import {moduleSnapshot,mobileModules,readWorkspaceRoute,workspaceUrl,readDraft,writeDraft,draftKey,validOrderDraft} from '../lib/workspace-model.mjs';
import {wholesaleTasks} from '../lib/wholesale.mjs';
const day=reportToday(),factory={id:'factory-1',role:'工厂',name:'工厂'};
function sales(f,n=1){for(let i=0;i<n;i++)f.sqlite.prepare('INSERT INTO sales_records(id,import_id,business_date,site,channel,sku,qty,unit_price,amount,reported_amount,ad_cost,currency,actor_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('r'+String(i).padStart(5,'0'),'i'+i,day,i===0?'马来西亚':'印尼','TikTok','SKU-'+i,2,919191,1838382,1838382,454545,'IDR',f.users.indonesia.id,day);}
test('工厂销售所有响应只含数量；金额、均价、成本及其派生指标不可恢复',async()=>{const f=systemFixture();try{
 sales(f,3);f.sqlite.prepare("UPDATE sku_settings SET unit_price=919191").run();svc.setActor(factory);
 const snapshot=await(await svc.GET(new Request('http://localhost/api/system'))).json();
 for(const value of ['919191','1838382','454545','unit_price','reported_amount','ad_cost','adCost'])assert.equal(JSON.stringify(snapshot).includes(value),false,value);
 const r=await readSalesDashboard(f.db,factory,{from:day,to:day});assert.equal(r.totalQty,6);assert.equal(r.skuRanking.reduce((n,r)=>n+r.qty,0),6);assert.equal(r.daily[0].qty,6);assert.equal(r.financialVisible,false);
 for(const key of ['revenue','averagePrice','adCost','roas','amount'])assert.equal(JSON.stringify(r).includes('"'+key+'"'),false,key);
 const history=await readHistory(f.db,factory,{history:'sales',export:'1'});assert.equal(history.rows.length,3);const csv=historyCsv(history);assert.ok(csv.includes('销量'));for(const value of ['单价','销售金额','广告成本','919191','1838382','454545'])assert.ok(!csv.includes(value),value);
 const admin=await readSalesDashboard(f.db,f.users.admin,{from:day,to:day});assert.equal(admin.currencies[0].revenue,5515146);
 }finally{f.sqlite.close();}});
test('递归响应过滤保留业务数量，内部JSON与工厂财务字段不穿透嵌套',()=>{
 const source={items:[{sku:'A',qty:12,unit_price:99,amount:88,adCost:5,evidence_json:'PRIVATE',data:{reported_amount:80,qty:4}}]};
 assert.deepEqual(publicSystemSnapshot(source,'工厂'),{items:[{sku:'A',qty:12,data:{qty:4}}]});assert.equal(publicSystemSnapshot(source,'管理员').items[0].unit_price,99);
});
test('历史分页和完整筛选导出跨越旧1000条上限，运营不能跨站查询',async()=>{const f=systemFixture();try{
 sales(f,1101);const first=await readHistory(f.db,f.users.admin,{history:'sales',pageSize:'50'}),last=await readHistory(f.db,f.users.admin,{history:'sales',page:'23'});
 assert.equal(first.total,1101);assert.equal(last.rows.length,1);assert.notEqual(first.rows[0].id,last.rows[0].id);
 const all=await readHistory(f.db,f.users.indonesia,{history:'sales',export:'1',from:day,to:day});assert.equal(all.rows.length,1100);assert.ok(all.rows.every(r=>r.site==='印尼'));
 await assert.rejects(readHistory(f.db,f.users.indonesia,{history:'sales',site:'马来西亚'}),e=>e.status===403);
 await assert.rejects(readHistory(f.db,f.users.sales,{history:'sales'}),e=>e.status===403);
 await assert.rejects(readHistory(f.db,f.users.supply,{history:'audit'}),e=>e.status===403);
 for(const input of [{from:'2026-02-30'},{from:'2026-10-02',to:'2026-10-01'}])await assert.rejects(readHistory(f.db,f.users.admin,{history:'sales',...input}),e=>e.status===400);
 const old=await readHistory(f.db,f.users.admin,{history:'sales',search:'i0'});assert.equal(old.total,1);assert.equal(old.rows[0].id,'r00000');
 svc.setActor(f.users.indonesia);const via=await svc.GET(new Request('http://localhost/api/system?history=sales'));assert.equal(via.status,200);assert.equal((await via.json()).total,1100);
 }finally{f.sqlite.close();}});
test('事件流水可查询早期凭证并按北京时间跨日筛选；导出转义公式',async()=>{const f=systemFixture();try{
 const insert=f.sqlite.prepare('INSERT INTO audit_logs(id,action,entity_type,entity_id,actor_id,actor_name,detail_json,created_at) VALUES(?,?,?,?,?,?,?,?)');
 for(let i=0;i<530;i++)insert.run('a'+String(i).padStart(4,'0'),'=SUM(1,2)','audit','ref'+i,'admin-1','管理员','{}',i?'2026-10-05T00:00:00Z':'2026-10-01T16:01:00Z');
 const r=await readHistory(f.db,f.users.admin,{history:'audit',from:'2026-10-02',to:'2026-10-02'});assert.equal(r.total,1);assert.equal(r.rows[0].entity_id,'ref0');assert.ok(historyCsv(r).includes('2026-10-02 00:01:00'));assert.ok(historyCsv(r).includes("'=SUM(1,2)"));
 }finally{f.sqlite.close();}});
test('独立工作区不读取全站预测，入口仍受岗位权限约束',async()=>{const f=systemFixture();try{
 svc.setActor(f.users.admin);const full=await(await svc.GET(new Request('http://localhost/api/system'))).json();assert.ok(full.suggestions.length);
 const fast=await(await svc.GET(new Request('http://localhost/api/system?module=wholesale'))).json();assert.equal(fast.module,'wholesale');assert.deepEqual(fast.myTasks,full.myTasks);assert.deepEqual(fast.suggestions,[]);assert.deepEqual(fast.productionOrders,[]);assert.ok(JSON.stringify(fast).length<JSON.stringify(full).length/2);
 svc.setActor(f.users.sales);assert.equal((await svc.GET(new Request('http://localhost/api/system?module=audit'))).status,403);const home=await(await svc.GET(new Request('http://localhost/api/system?module=home'))).json();assert.equal(home.module,'wholesale');
 svc.setActor(factory);assert.equal((await svc.GET(new Request('http://localhost/api/system?history=audit'))).status,403);
 }finally{f.sqlite.close();}});
test('模块摘要不携带其他页面或所有SKU日曲线；趋势按选中SKU另行加载',()=>{
 const input={actor:{role:'管理员'},myTasks:[],metrics:{inventoryQty:8},inventory:[{qty:8}],suggestions:[{site:'印尼',channel:'TikTok',sku:'A',qty:8,dailySeries:Array(56).fill({qty:1}),projection:{days:Array(90).fill(1)}}]};
 assert.equal(moduleSnapshot(input,'overview').inventory.length,0);assert.deepEqual(moduleSnapshot(input,'suggestions').suggestions,[{site:'印尼',channel:'TikTok',sku:'A',qty:8}]);assert.equal(moduleSnapshot(input,'suggestions','印尼|TikTok|A').suggestions[0].dailySeries.length,56);
});
test('任务携带具体订单定位，路由保留过滤并正确转义',async()=>{const f=systemFixture();try{
 const id=await f.create();const tasks=await wholesaleTasks(f.db,f.users.finance);assert.equal(tasks[0].entity,id);assert.equal(tasks[0].view,'orders');
 const route={page:'wholesale',entity:id,view:'orders',month:'2026-10',search:'客户 & SKU/1',status:'pending'};assert.deepEqual(readWorkspaceRoute(workspaceUrl(route).split('?')[1]),route);
 assert.deepEqual(mobileModules('销售'),['wholesale','quality-incidents','production-tracking']);assert.ok(mobileModules('管理员').length<=4);
 }finally{f.sqlite.close();}});
test('订单草稿按账号隔离、过期和损坏安全处理，多SKU内容原样恢复',()=>{
 const map=new Map(),store={getItem:k=>map.get(k),setItem:(k,v)=>map.set(k,v)};
 const value={form:{customerId:'c1',saleType:'consignment',businessDate:day,paymentTerms:'credit',businessCode:'',dueDate:'',note:'',invoiceRequired:false},items:Array.from({length:25},(_,i)=>({sku:'SKU'+i,qty:'3',unitPrice:'88000',productColor:'',productSize:''}))};writeDraft(store,'sales-a','wholesale-order',value,1000);
 assert.deepEqual(readDraft(store,'sales-a','wholesale-order',2000),value);assert.equal(readDraft(store,'sales-b','wholesale-order',2000),null);assert.equal(readDraft(store,'sales-a','wholesale-order',1000+8*86400000),null);
 assert.equal(validOrderDraft(value),true);assert.equal(validOrderDraft({form:{},items:[null]}),false);assert.equal(validOrderDraft({...value,items:'broken'}),false);
 map.set(draftKey('sales-a','wholesale-order'),'{broken');assert.equal(readDraft(store,'sales-a','wholesale-order'),null);
});
