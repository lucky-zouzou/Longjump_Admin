import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import {systemFixture,svc,seedMonthly} from './system-fixture.mjs';
import {managePlan} from '../lib/plan-changes.mjs';
import {replenishmentOrderSheets,replenishmentOrderWorkbook,replenishmentOrderName} from '../lib/replenishment-order-export.mjs';
const read=async actor=>{svc.setActor(actor);return (await svc.GET(new Request('http://localhost/api/system'))).json();};
const total=sheets=>sheets[0].rows.find(r=>r[0]==='备货总数量')[1];

test('订单导出来自对应已保存计划，不受库存、测算、其他月份和未批准需求影响',async()=>{
 const f=systemFixture(),id=seedMonthly(f);try{
 await svc.decideApproval(f.users.admin,{approvalId:id,version:1,decision:'approve',comment:'核对备货订单'});
 for(const actor of [f.users.admin,f.users.supply]){
 const data=await read(actor);data.suggestions=[{sku:'WRONG',suggestedProduction:99999}];data.submissions=[{items:[{sku:'WRONG',qty:9999}]}];data.inventory=[];
 data.purchaseOrders.push({...data.purchaseOrders[0],id:'other-month',approval_id:'other-plan',month:'2026-10'});
 const before=JSON.stringify(data),sheets=replenishmentOrderSheets(data,id);assert.equal(total(sheets),10);assert.equal(sheets[1].rows.length,1);assert.equal(sheets[3].rows.length,1);assert.equal(sheets[1].rows[0][4],'BAG-A');assert.equal(sheets[1].rows[0][9],10);assert.equal(sheets[2].rows[0][9],10);assert.equal(sheets[3].rows[0][9],10);assert.equal(JSON.stringify(data),before);
 const book=XLSX.read(XLSX.write(replenishmentOrderWorkbook(XLSX,sheets),{type:'buffer',bookType:'xlsx'}),{type:'buffer'});
 assert.deepEqual(book.SheetNames,['备货订单总览','SKU备货订单明细','站点渠道分配','采购执行明细']);assert.equal(book.Sheets['SKU备货订单明细'].J2.t,'n');
 assert.equal(replenishmentOrderName(data.approvals[0]),'备货订单明细-2026-09-V2-已批准.xlsx');
 }
 }finally{f.sqlite.close();}
});
test('计划变更后导出当前批准量，排除被替换的旧采购单；已执行原单与追加单均追溯',async()=>{
 const f=systemFixture(),id=seedMonthly(f);try{
 await svc.decideApproval(f.users.admin,{approvalId:id,version:1,decision:'approve',comment:'核对备货订单'});
 const change=async qty=>{const base=f.sqlite.prepare('SELECT * FROM approval_requests').get();const c=await managePlan(f.db,f.users.supply,{action:'planChangeSubmit',approvalId:id,version:base.version,reason:'按业务需要调整数量',rows:[{sku:'BAG-A',site:'印尼',channel:'TikTok',qty}]},{buildSeriesOrders:svc.buildSeriesOrders});await managePlan(f.db,f.users.admin,{action:'planChangeDecide',changeId:c.id,version:1,decision:'approve',reason:'核对后批准变更',supplyUserId:f.users.supply.id},{buildSeriesOrders:svc.buildSeriesOrders});};
 await change(15);let sheets=replenishmentOrderSheets(await read(f.users.admin),id);assert.equal(total(sheets),15);assert.deepEqual(sheets[3].rows.map(r=>r[9]),[15]);
 const po=f.sqlite.prepare("SELECT id FROM series_purchase_orders WHERE status='draft'").get();await svc.confirmPurchaseOrder(f.users.supply,{purchaseOrderId:po.id,orderRef:'ACTUAL-PO',expectedCompletionDate:'2027-01-01'});
 await change(20);sheets=replenishmentOrderSheets(await read(f.users.admin),id);assert.equal(total(sheets),20);assert.deepEqual(sheets[3].rows.map(r=>r[9]).sort((a,b)=>a-b),[5,15]);assert.ok(sheets[3].rows.some(r=>r[3]==='ACTUAL-PO'));
 }finally{f.sqlite.close();}
});
test('未审批、零需求、缺计划、越权、分配失配均明确区分，不回退导出预测数据',async()=>{
 const f=systemFixture(),id=seedMonthly(f);try{
 const data=await read(f.users.admin);assert.equal(total(replenishmentOrderSheets(data,id)),10);assert.equal(replenishmentOrderSheets(data,id)[3].rows.length,0);
 for(const role of ['运营','工厂','财务','销售'])assert.throws(()=>replenishmentOrderSheets({...data,actor:{role}},id),/仅管理员和供应链/);
 assert.throws(()=>replenishmentOrderSheets(data,'missing'),/请选择/);
 data.approvals[0].payload.items[0].total=11;assert.throws(()=>replenishmentOrderSheets(data,id),/分配与备货总数不一致/);
 data.approvals[0].payload={items:[],seriesOrders:[]};assert.equal(total(replenishmentOrderSheets(data,id)),0);
 }finally{f.sqlite.close();}
});
test('导出保留文本SKU与数值数量，超过20个SKU不截断，公式文本不执行',()=>{
 const items=Array.from({length:25},(_,i)=>({sku:i===0?'0001':String(i),name:'=1+1',total:2,allocations:[{site:'印尼',channel:'TikTok',qty:2}]}));
 const data={actor:{role:'管理员'},generatedAt:'2026-10-11',approvals:[{id:'A',type:'monthly_plan',month:'2026-10',version:1,status:'pending',updated_at:'2026-10-11',payload:{items,seriesOrders:[{seriesName:'系列',items}]}}]};
 const sheets=replenishmentOrderSheets(data,'A'),wb=replenishmentOrderWorkbook(XLSX,sheets);assert.equal(sheets[1].rows.length,25);assert.equal(total(sheets),50);assert.equal(wb.Sheets['SKU备货订单明细'].E2.v,'0001');assert.equal(wb.Sheets['SKU备货订单明细'].F2.f,undefined);
 data.approvals[0].status='approved';assert.throws(()=>replenishmentOrderSheets(data,'A'),/采购执行单数量不一致/);
});
