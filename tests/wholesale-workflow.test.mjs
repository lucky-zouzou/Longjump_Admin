import test from "node:test";
import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import { fixture } from "./fixtures.mjs";
import { mutateWholesale,readWholesale,wholesaleTasks,indonesiaDate } from "../lib/wholesale.mjs";
import { loadWholesaleExportSnapshot } from "../lib/wholesale-export.mjs";
import { warehouseSheets,OUTBOUND_HEADERS } from "../lib/wholesale-outbound.mjs";
import { toWholesaleWorkbook,monthlyReconciliation,wholesaleExportSheets } from "../lib/wholesale-finance.mjs";

const day=indonesiaDate(),month=day.slice(0,7);
const approve=(f,id)=>f.change(f.users.finance,id,"orderApprove",{supplyUserId:f.users.supply.id,stockBasisConfirmed:true,priceExceptionConfirmed:true,reason:"财务核对业务类型与价格"});
const item=(f,id)=>f.sqlite.prepare("SELECT * FROM wholesale_order_items WHERE order_id=?").get(id);
const settle=(f,id,qty,extra={})=>f.change(f.users.finance,id,"consignmentSettle",{itemId:item(f,id).id,qty,kind:"sale",businessDate:day,reference:crypto.randomUUID(),note:"已核对客户实际售出对账单",...extra});

test("历史待审单核实后分类，寄售转换账期且要求说明，已批单不重分类",async()=>{
 const f=fixture(),id=await f.create({terms:"prepaid"});
 const options={supplyUserId:f.users.supply.id,stockBasisConfirmed:true,saleType:"consignment"};
 await assert.rejects(f.change(f.users.finance,id,"orderApprove",options),/价格及结算依据/);
 await f.change(f.users.finance,id,"orderApprove",{...options,reason:"核对合同采用寄售"});
 assert.equal(f.orderRow(id).sale_type,"consignment");assert.equal(f.orderRow(id).payment_terms,"credit");
 await f.ship(id,2);await settle(f,id,1);await f.ship(id,3);
 await assert.rejects(f.change(f.users.finance,id,"orderApprove",{...options,saleType:"cash",reason:"不能重分类已审批"}),/仅待审批/);
 const snapshot=await loadWholesaleExportSnapshot(f.db,f.users.finance);
 const sheets=wholesaleExportSheets(snapshot,{month,asOfDate:day,exportedAt:"TEST"});
 assert.equal(sheets[0].rows[0][sheets[0].headers.indexOf("付款条件")],"客户实际售出后结算");
 const credit=await f.create();await assert.rejects(f.change(f.users.finance,credit,"orderApprove",{...options,saleType:"cash",reason:"现金要求先收款"}),/先款后货/);
});

test("财务审批有待办，保留自审/库存/版本校验，供应链与销售不能审批",async()=>{
 const f=fixture(),id=await f.create({saleType:"consignment"});
 assert.equal((await wholesaleTasks(f.db,f.users.finance)).length,1);
 await assert.rejects(f.change(f.users.sales,id,"orderApprove"),/无权/);
 f.sqlite.prepare("UPDATE wholesale_orders SET supply_user_id=? WHERE id=?").run(f.users.supply.id,id);
 await assert.rejects(f.change(f.users.supply,id,"orderApprove"),/无权/);
 await assert.rejects(f.change(f.users.finance,id,"orderApprove",{supplyUserId:f.users.supply.id,reason:"核对真实订单"}),/独立账面/);
 const before=f.sqlite.prepare("SELECT SUM(qty) n FROM inventory_balances").get().n;
 await approve(f,id);assert.equal(f.orderRow(id).approved_by,f.users.finance.id);
 assert.equal(f.sqlite.prepare("SELECT SUM(qty) n FROM inventory_balances").get().n,before);
 assert.equal((await wholesaleTasks(f.db,f.users.finance)).length,0);
 const self=await f.create();f.sqlite.prepare("UPDATE wholesale_orders SET creator_id=? WHERE id=?").run(f.users.finance.id,self);
 await assert.rejects(approve(f,self),/不能审批自己的订单/);
 const reject=await f.create();await f.change(f.users.finance,reject,"orderReject",{reason:"客户资料需要补齐"});assert.equal(f.orderRow(reject).status,"rejected");
});

test("业务类型必须明确，现金两类由服务器强制先款后货，价格与分类保存在订单",async()=>{
 const f=fixture(),id=await f.create({saleType:"clearance_cash",items:[{sku:"BAG-A",qty:2,unitPrice:25000,productColor:"Black",productSize:"M"}]});
 assert.equal(f.orderRow(id).sale_type,"clearance_cash");assert.equal(f.orderRow(id).payment_terms,"prepaid");assert.equal(item(f,id).product_color,"Black");assert.equal(item(f,id).product_size,"M");
 await approve(f,id);await assert.rejects(f.ship(id,2),/财务确认回款/);
 const c=f.orderRow(id).customer_id;
 await assert.rejects(f.call(f.users.sales,"orderCreate",{customerId:c,businessDate:day,items:[{sku:"BAG-A",qty:1,unitPrice:5}]}),/请选择寄售/);
 await f.change(f.users.finance,id,"financeAdd",{kind:"receipt",amount:50000,reference:"PAID-CLEARANCE",businessDate:day,note:"核实账户实际到账"});await f.ship(id,2);
});

test("寄售出库不产生销售/应收，确认客户已售才结算，回款核销不二次扣库",async()=>{
 const f=fixture(),id=await f.create({saleType:"consignment"});await approve(f,id);await f.ship(id,5);
 let view=await readWholesale(f.db,f.users.finance,month),o=view.orders[0];assert.equal(o.outstanding,0);assert.equal(o.financial.salesAmount,0);assert.equal(view.dashboard.netAmount,0);assert.equal(o.financial.shippedQty,5);
 await assert.rejects(f.change(f.users.finance,id,"financeAdd",{kind:"receipt",amount:1,reference:"NOT-YET",businessDate:day,note:"尚未确认客户售出"}),/不能超过待收/);
 const before=f.sqlite.prepare("SELECT SUM(qty) n FROM inventory_balances").get().n;
 await settle(f,id,2);view=await readWholesale(f.db,f.users.finance,month);o=view.orders[0];assert.equal(o.outstanding,200000);assert.equal(o.financial.salesAmount,200000);assert.equal(view.dashboard.netAmount,200000);
 await f.change(f.users.finance,id,"financeAdd",{kind:"receipt",amount:200000,reference:"CONS-PAID",businessDate:day,note:"核实寄售已售回款"});
 assert.equal(f.sqlite.prepare("SELECT SUM(qty) n FROM inventory_balances").get().n,before);
 assert.equal((await readWholesale(f.db,f.users.finance,month)).orders[0].outstanding,0);
});

test("寄售重复提交和超售被阻止，冲正可追溯；退货按核实的已售与未售数量处理",async()=>{
 const f=fixture(),id=await f.create({saleType:"consignment"});await approve(f,id);await f.ship(id,5);
 const payload={action:"consignmentSettle",orderId:id,version:f.orderRow(id).version,operationId:crypto.randomUUID(),itemId:item(f,id).id,qty:3,kind:"sale",businessDate:day,reference:"SALE-REPORT",note:"核对实际售出三件"};
 await mutateWholesale(f.db,f.users.finance,payload);assert.equal((await mutateWholesale(f.db,f.users.finance,payload)).replayed,true);
 await assert.rejects(settle(f,id,3),/超过可确认/);
 await settle(f,id,1,{kind:"correction"});
 await f.change(f.users.supply,id,"orderReturn",{itemId:item(f,id).id,qty:4,consignmentSoldQty:1,businessDate:day,reason:"客户实际退回四件",proofRef:"R-CONS",receivedConfirmed:true,resellable:true});
 const o=(await readWholesale(f.db,f.users.finance,month)).orders[0];assert.equal(o.returns[0].consignment_sold_qty,1);assert.equal(o.financial.netSales,100000);assert.equal(o.outstanding,100000);
 await assert.rejects(settle(f,id,1),/超过可确认/);await assert.rejects(settle(f,id,2,{kind:"correction"}),/超过可确认/);
 assert.throws(()=>f.sqlite.prepare("UPDATE wholesale_consignment_sales SET qty=9").run(),/immutable/);
 assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM wholesale_operations WHERE action='consignmentSettle'").get().n,2);
});

test("寄售月度结算按已售确认日期，关账、权限、倒签日期均受保护",async()=>{
 const f=fixture(),id=await f.create({saleType:"consignment"});await approve(f,id);await f.ship(id,5,"2026-08-31");
 await assert.rejects(f.change(f.users.sales,id,"consignmentSettle",{itemId:item(f,id).id,qty:2,kind:"sale"}),/无权/);
 await assert.rejects(settle(f,id,1,{businessDate:"2026-08-30"}),/日期不能早于/);
 await settle(f,id,2,{businessDate:"2026-09-02"});const snap=await loadWholesaleExportSnapshot(f.db,f.users.finance);
 assert.equal(monthlyReconciliation(snap.orders,"2026-08",day).totals.closingReceivable,0);
 assert.equal(monthlyReconciliation(snap.orders,"2026-09",day).totals.salesAmount,200000);
 f.sqlite.prepare("INSERT INTO wholesale_finance_periods (month,status,version,snapshot_json,note,actor_id,updated_at) VALUES ('2026-09','closed',1,'{}','test',?,?)").run(f.users.finance.id,day);
 await assert.rejects(settle(f,id,1,{businessDate:"2026-09-03"}),/结算月份|库存已变化/);
});

test("仓库备货只包含审批后未发余量，导出不写库，角色/状态/版本隔离",async()=>{
 const f=fixture(),id=await f.create({saleType:"consignment"});let snapshot=await loadWholesaleExportSnapshot(f.db,f.users.finance);
 const options=()=>({mode:"prepare",orderId:id,version:f.orderRow(id).version,month,exportedAt:"TEST"});
 assert.throws(()=>warehouseSheets(snapshot,options()),/已审核/);await approve(f,id);await f.ship(id,2);
 snapshot=await loadWholesaleExportSnapshot(f.db,f.users.finance);const before=f.sqlite.prepare("SELECT COUNT(*) n FROM wholesale_operations").get().n;
 const sheets=warehouseSheets(snapshot,options());assert.equal(sheets[0].rows.length,1);assert.equal(sheets[0].rows[0][8],3);assert.equal(sheets[0].rows[0][1],"");assert.equal(sheets[0].rows[0][3],"");assert.equal(sheets[0].rows[0][17],"寄售");
 assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM wholesale_operations").get().n,before);
 assert.throws(()=>warehouseSheets(snapshot,{...options(),version:0}),/已更新/);
 const sales=await loadWholesaleExportSnapshot(f.db,f.users.sales);assert.throws(()=>warehouseSheets(sales,options()),/无权/);
 const other=await loadWholesaleExportSnapshot(f.db,f.users.supply2);assert.throws(()=>warehouseSheets(other,options()),/不存在/);
});

test("出库模板A:Q一致，三类业务可区分，分批数量守恒，数值/文本安全及双语一致",async()=>{
 const f=fixture();
 for(const saleType of ["consignment","cash","clearance_cash"]){const id=await f.create({saleType,qty:3,items:[{sku:"BAG-A",qty:3,unitPrice:20000,productColor:"=notFormula",productSize:"M"}]});await approve(f,id);if(saleType!=="consignment")await f.change(f.users.finance,id,"financeAdd",{kind:"receipt",amount:60000,reference:saleType,businessDate:day,note:"核对款项已到账"});await f.ship(id,1);await f.ship(id,2);}
 const snap=await loadWholesaleExportSnapshot(f.db,f.users.finance),zh=warehouseSheets(snap,{mode:"outbound",month}),id=warehouseSheets(snap,{mode:"outbound",month,language:"id"});
 assert.deepEqual(zh[0].headers.slice(0,17),OUTBOUND_HEADERS.slice(0,17));assert.equal(zh[0].rows.length,6);assert.equal(zh[0].rows.reduce((s,r)=>s+r[8],0),9);assert.equal(new Set(zh[0].rows.map(r=>r[3])).size,6);
 assert.deepEqual(zh[1].rows.map(r=>r[2]),[3,3,3,0]);assert.equal(zh[0].rows.find(r=>r[17]==="特价清仓现金销售")[11],"商品清仓");
 assert.ok(!/[\u3400-\u9fff]/.test(id[0].headers.join('')));assert.deepEqual(id[0].rows.map(r=>r[10]),zh[0].rows.map(r=>r[10]));
 const book=XLSX.read(XLSX.write(toWholesaleWorkbook(XLSX,zh),{type:"buffer",bookType:"xlsx"}),{type:"buffer"}),sheet=book.Sheets[book.SheetNames[0]];
 assert.equal(sheet.G3.t,"s");assert.equal(sheet.G3.v,"=notFormula");assert.equal(sheet.G3.f,undefined);assert.equal(sheet.I3.t,"n");assert.equal(sheet['!autofilter'].ref,"A2:Y8");assert.equal(sheet.I9.v,9);assert.equal(sheet.K9.v,180000);
});
