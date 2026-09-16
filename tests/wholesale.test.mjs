import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readdirSync,readFileSync } from "node:fs";
import { allocateAverage,canWholesale,indonesiaDate,mutateWholesale,readWholesale,wholesaleTasks,wholesaleSalesSummary } from "../lib/wholesale.mjs";
import { countStatements,reversalStatements } from "../lib/inventory-guard.mjs";
import { loadWholesaleExportSnapshot } from "../lib/wholesale-export.mjs";
import { wholesaleExportSheets } from "../lib/wholesale-finance.mjs";

import {fixture} from "./fixtures.mjs";

test("均分、单数、单边短缺和总量不足按数量守恒处理",()=>{
  assert.deepEqual(allocateAverage(6,8,9),[{channel:"TikTok",qty:3},{channel:"Shopee",qty:3}]);
  assert.deepEqual(allocateAverage(5,10,8),[{channel:"TikTok",qty:3},{channel:"Shopee",qty:2}]);
  assert.deepEqual(allocateAverage(5,8,10),[{channel:"TikTok",qty:2},{channel:"Shopee",qty:3}]);
  assert.deepEqual(allocateAverage(6,1,10),[{channel:"TikTok",qty:1},{channel:"Shopee",qty:5}]);
  assert.throws(()=>allocateAverage(5,2,2),/库存不足/);
  assert.throws(()=>allocateAverage(2.5,4,4),/正整数/);
});
test("申请不扣库，审批只预留，分批发货总扣减等于实发，完成不等于回款或开票",async()=>{
  const f=fixture(),id=await f.create();assert.equal(f.sqlite.prepare("SELECT SUM(reserved_qty) n FROM inventory_balances").get().n,0);
  await f.approve(id);assert.equal(f.sqlite.prepare("SELECT SUM(qty) n FROM inventory_balances WHERE site='印尼' AND sku='BAG-A'").get().n,20);assert.equal(f.sqlite.prepare("SELECT SUM(reserved_qty) n FROM inventory_balances").get().n,5);
  await f.ship(id,2);assert.equal(f.orderRow(id).status,"partial");await f.ship(id,3);assert.equal(f.orderRow(id).status,"completed");
  assert.equal(f.sqlite.prepare("SELECT SUM(qty) n FROM inventory_balances WHERE site='印尼' AND sku='BAG-A'").get().n,15);assert.equal(f.sqlite.prepare("SELECT SUM(reserved_qty) n FROM inventory_balances").get().n,0);
  const view=await readWholesale(f.db,f.users.sales,indonesiaDate().slice(0,7));assert.equal(view.orders[0].paymentStatus,"未回款");assert.equal(view.orders[0].invoiceStatus,"待开票");assert.equal(view.dashboard.netQty,5);assert.equal(view.dashboard.skuCount,1);assert.equal(view.checks.issues.length,0);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM sales_records").get().n,0);assert.equal(f.sqlite.prepare("SELECT SUM(qty) n FROM inventory_balances WHERE site='马来西亚'").get().n,165);
});
test("相同请求重试、同版并发操作与银行凭证重复不能重复扣库存或回款",async()=>{
  const f=fixture(),id=await f.create();await f.approve(id);
  const item=f.sqlite.prepare("SELECT id FROM wholesale_order_items WHERE order_id=?").get(id);
  const payload={action:"orderShip",orderId:id,version:f.orderRow(id).version,operationId:crypto.randomUUID(),items:[{itemId:item.id,qty:5}],businessDate:indonesiaDate(),carrier:"carrier",warehouse:"warehouse",trackingNo:"track",handoverConfirmed:true};
  await mutateWholesale(f.db,f.users.supply,payload);const replay=await mutateWholesale(f.db,f.users.supply,payload);assert.equal(replay.replayed,true);
  await assert.rejects(mutateWholesale(f.db,f.users.supply,{...payload,operationId:crypto.randomUUID()}),/已被其他人更新/);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM wholesale_shipments").get().n,1);
  await f.change(f.users.finance,id,"financeAdd",{kind:"receipt",amount:200000,reference:"BANK001",businessDate:indonesiaDate(),note:"核对公司账户到账"});
  await assert.rejects(f.change(f.users.finance,id,"financeAdd",{kind:"receipt",amount:200000,reference:"BANK001",businessDate:indonesiaDate(),note:"核对公司账户到账"}),/凭证编号重复/);
  assert.equal(f.sqlite.prepare("SELECT SUM(amount) n FROM wholesale_finance_entries").get().n,200000);
});
test("先款后货须财务实际确认，销售不能确认回款，申请人不能自审",async()=>{
  const f=fixture(),id=await f.create({terms:"prepaid"});await f.approve(id);await assert.rejects(f.ship(id,5),/财务确认回款/);
  await assert.rejects(f.change(f.users.sales,id,"financeAdd",{kind:"receipt",amount:500000,reference:"BANK002",businessDate:indonesiaDate(),note:"销售自行确认到账"}),/无权/);
  await f.change(f.users.finance,id,"financeAdd",{kind:"receipt",amount:500000,reference:"BANK002",businessDate:indonesiaDate(),note:"财务核对实际到账"});await f.ship(id,5);
  const own=await f.create({who:f.users.admin});await assert.rejects(f.approve(own),/不能审批自己的订单/);
});
test("取消释放预留，已发货不能直接取消，退款与实物退货分离",async()=>{
  const f=fixture(),id=await f.create();await f.approve(id);await f.change(f.users.admin,id,"orderCancel",{reason:"客户取消本次订单"});assert.equal(f.sqlite.prepare("SELECT SUM(reserved_qty) n FROM inventory_balances").get().n,0);
  const id2=await f.create();await f.approve(id2);await f.ship(id2,5);await assert.rejects(f.change(f.users.admin,id2,"orderCancel",{reason:"客户取消本次订单"}),/办理退货/);
  await f.change(f.users.finance,id2,"financeAdd",{kind:"receipt",amount:500000,reference:"BANK003",businessDate:indonesiaDate(),note:"实际对公到账确认"});
  const item=f.sqlite.prepare("SELECT * FROM wholesale_order_items WHERE order_id=?").get(id2);
  await f.change(f.users.supply,id2,"orderReturn",{itemId:item.id,qty:2,businessDate:indonesiaDate(),reason:"客户退回两件商品",proofRef:"RETURN001",receivedConfirmed:true,resellable:false});
  const view=await readWholesale(f.db,f.users.admin,indonesiaDate().slice(0,7));const o=view.orders.find(o=>o.id===id2);assert.equal(o.refundDue,200000);assert.equal(o.paymentStatus,"待退款");assert.equal(view.dashboard.netQty,3);assert.equal(f.sqlite.prepare("SELECT SUM(quarantine_qty) n FROM inventory_balances").get().n,2);
  await f.change(f.users.finance,id2,"financeAdd",{kind:"refund",amount:200000,reference:"REFUND001",businessDate:indonesiaDate(),note:"按实收退货对公退款"});assert.equal(f.sqlite.prepare("SELECT SUM(quarantine_qty) n FROM inventory_balances").get().n,2);
});
test("两订单争抢库存、多SKU任一不足与批准前库存变化均完整回滚",async()=>{
  const f=fixture();f.stock("BAG-A",3,3);const one=await f.create({qty:5}),two=await f.create({qty:5});await f.approve(one);await assert.rejects(f.approve(two),/库存不足/);assert.equal(f.orderRow(two).status,"pending");
  const another=await f.create({items:[{sku:"BAG-B",qty:3,unitPrice:100000},{sku:"BAG-A",qty:5,unitPrice:100000}]});await assert.rejects(f.approve(another),/库存不足/);assert.equal(f.sqlite.prepare("SELECT SUM(reserved_qty) n FROM inventory_balances WHERE sku='BAG-B'").get().n,0);
  const g=fixture(),id=await g.create(),original=g.db.batch;g.db.batch=async statements=>{g.sqlite.prepare("UPDATE inventory_balances SET qty=0 WHERE site='印尼' AND channel='Shopee' AND sku='BAG-A'").run();return original(statements);};
  await assert.rejects(g.approve(id),/库存已变化/);assert.equal(g.orderRow(id).status,"pending");assert.equal(g.sqlite.prepare("SELECT COUNT(*) n FROM wholesale_allocations").get().n,0);assert.equal(g.sqlite.prepare("SELECT SUM(reserved_qty) n FROM inventory_balances").get().n,0);
});
test("平台已售或盘点造成预留缺货保留差异，阻止线下发货且自动检查提示",async()=>{
  const f=fixture(),id=await f.create();await f.approve(id);f.stock("BAG-A",1,1);await assert.rejects(f.ship(id,5),/库存已变化/);assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM wholesale_shipments").get().n,0);
  const view=await readWholesale(f.db,f.users.admin,indonesiaDate().slice(0,7));assert.ok(view.checks.issues.some(i=>i.type.includes("可售账面少于预留")));
});
test("无单号时必须有属于当前订单的影像，且必须确认实物已交付",async()=>{
  const f=fixture(),id=await f.create();await f.approve(id);await assert.rejects(f.ship(id,5,indonesiaDate(),{trackingNo:""}),/照片／视频/);await assert.rejects(f.ship(id,5,indonesiaDate(),{handoverConfirmed:false}),/实际交付/);await assert.rejects(f.ship(id,5,indonesiaDate(),{trackingNo:"",proofIds:["another-order-file"]}),/不属于此订单/);
  f.sqlite.prepare("INSERT INTO wholesale_files (id,order_id,object_key,name,content_type,size,actor_id,created_at) VALUES (?,?,?,?,?,?,?,?)").run("proof1",id,"test/key","photo.jpg","image/jpeg",100,f.users.supply.id,indonesiaDate());await f.ship(id,5,indonesiaDate(),{trackingNo:"",proofIds:["proof1"]});assert.equal(f.orderRow(id).status,"completed");
});
test("客户与责任人权限隔离，只有被分配的供应链看到待办",async()=>{
  const f=fixture(),id=await f.create();await f.approve(id);assert.equal(canWholesale(f.users.malaysia),false);assert.equal(canWholesale(f.users.indonesia),true);
  const other=await readWholesale(f.db,f.users.sales2,"2026-08");assert.equal(other.orders.length,0);assert.equal(other.customers.length,0);assert.equal(other.dashboard.netAmount,0);
  await assert.rejects(f.change(f.users.supply2,id,"orderPack"),/责任范围/);assert.equal((await wholesaleTasks(f.db,f.users.supply)).length,1);assert.equal((await wholesaleTasks(f.db,f.users.supply2)).length,0);
});
test("跨月分批销售与客户/SKU去重，不把回款月份冒充销售月份",async()=>{
  const f=fixture(),id=await f.create({qty:5});await f.approve(id);await f.ship(id,2,"2026-08-31");await f.ship(id,3,"2026-09-01");
  await f.change(f.users.finance,id,"financeAdd",{kind:"receipt",amount:500000,reference:"BANK004",businessDate:"2026-09-02",note:"财务已核实对公账户"});
  const aug=(await readWholesale(f.db,f.users.sales,"2026-08")).dashboard,sep=(await readWholesale(f.db,f.users.sales,"2026-09")).dashboard;
  assert.equal(aug.netAmount,200000);assert.equal(aug.cashReceived,0);assert.equal(sep.netAmount,300000);assert.equal(sep.cashReceived,500000);assert.equal(sep.skuCount,1);assert.equal(sep.customerCount,1);assert.equal(sep.customers[0].contribution,1);
  assert.equal((await wholesaleSalesSummary(f.db,f.users.admin,"2026-09-01","2026-09-02")).periodQty,3);
  assert.equal((await wholesaleSalesSummary(f.db,f.users.malaysia,"2026-09-01","2026-09-02")).periodQty,0);
});

test("旧盘点写入遇到线下发货变化须回滚，预留不会被盘点覆盖",async()=>{
  const f=fixture(),id=await f.create();await f.approve(id);
  const params={site:"印尼",channel:"TikTok",sku:"BAG-A",name:"bag",from:10,to:12,reference:"COUNT1",actorId:f.users.admin.id,reason:"管理员盘点",timestamp:indonesiaDate()};
  const prepared=countStatements(f.db,params);await f.ship(id,5);await assert.rejects(f.db.batch(prepared),/NOT NULL/);
  assert.equal(f.sqlite.prepare("SELECT qty FROM inventory_balances WHERE site='印尼' AND channel='TikTok' AND sku='BAG-A'").get().qty,7);
  const id2=await f.create();await f.approve(id2);const before=f.sqlite.prepare("SELECT reserved_qty FROM inventory_balances WHERE site='印尼' AND channel='TikTok' AND sku='BAG-A'").get().reserved_qty;await f.db.batch(countStatements(f.db,{...params,from:7,to:9}));assert.equal(f.sqlite.prepare("SELECT reserved_qty FROM inventory_balances WHERE site='印尼' AND channel='TikTok' AND sku='BAG-A'").get().reserved_qty,before);
});

test("旧销售冲销仅归还一次库存，且不会释放线下预留",async()=>{
  const f=fixture(),id=await f.create();await f.approve(id);
  const source={id:"import1",site:"印尼",channel:"TikTok"};f.sqlite.prepare("INSERT INTO sales_imports (id,import_key,business_date,site,channel,row_count,total_qty,actor_id,created_at) VALUES (?,?,?,?,?,?,?,?,?)").run(source.id,"test-import-key",indonesiaDate(),source.site,source.channel,1,2,f.users.indonesia.id,indonesiaDate());
  const statements=()=>[...reversalStatements(f.db,{source,records:[{sku:"BAG-A",name:"bag",qty:2}],reason:"测试冲销归还库存",actorId:f.users.admin.id,timestamp:indonesiaDate()}),f.db.prepare("UPDATE sales_imports SET reversed_at=? WHERE id=?").bind(indonesiaDate(),source.id)];
  await f.db.batch(statements());await assert.rejects(f.db.batch(statements()),/NOT NULL/);
  const stock=f.sqlite.prepare("SELECT qty,reserved_qty FROM inventory_balances WHERE site='印尼' AND channel='TikTok' AND sku='BAG-A'").get();assert.equal(stock.qty,12);assert.equal(stock.reserved_qty,3);
});

test("部分发货取消余量时释放锁库、只保留实发应收和销售",async()=>{
  const f=fixture(),id=await f.create();await f.approve(id);await f.ship(id,2);await f.change(f.users.admin,id,"orderCloseRemainder",{reason:"客户确认取消剩余三件"});
  const o=(await readWholesale(f.db,f.users.admin,indonesiaDate().slice(0,7))).orders[0];assert.equal(o.status,"closed");assert.equal(o.payable,200000);assert.equal(o.cancelled_amount,300000);assert.equal(f.sqlite.prepare("SELECT SUM(reserved_qty) n FROM inventory_balances").get().n,0);
  await assert.rejects(f.ship(id,3),/已经结束/);
});

test("财务导出单一数据库快照包含全部订单，责任人和其他国家权限隔离",async()=>{
  const f=fixture(),a=await f.create(),b=await f.create({who:f.users.sales2,businessDate:"2026-09-02"});await f.approve(a);await f.ship(a,2,"2026-08-31");await f.ship(a,3,"2026-09-01");
  await f.change(f.users.finance,a,"financeAdd",{kind:"receipt",amount:200000,reference:"EXPORTBANK1",businessDate:"2026-09-02",note:"财务核对到账一"});
  await f.change(f.users.finance,a,"financeAdd",{kind:"receipt",amount:300000,reference:"EXPORTBANK2",businessDate:"2026-09-03",note:"财务核对到账二"});
  const original=f.db.batch;let batches=0;f.db.batch=async statements=>{batches++;return original(statements);};
  const all=await loadWholesaleExportSnapshot(f.db,f.users.finance);assert.equal(batches,1);assert.equal(all.orders.length,2);const o=all.orders.find(o=>o.id===a);assert.equal(o.shipments.length,2);assert.equal(o.entries.length,2);assert.equal(o.paid,500000);assert.equal(o.entries[0].actor_name,f.users.finance.name);
  const sheets=wholesaleExportSheets(all,{mode:"all",month:"2026-08",asOfDate:"2026-09-12",exportedAt:"2026-09-12T00:00:00Z"});assert.equal(sheets[0].rows.length,2);assert.equal(sheets[0].rows[0][sheets[0].headers.indexOf("出库销售额IDR")],500000);
  assert.deepEqual((await loadWholesaleExportSnapshot(f.db,f.users.sales)).orders.map(o=>o.id),[a]);assert.deepEqual((await loadWholesaleExportSnapshot(f.db,f.users.sales2)).orders.map(o=>o.id),[b]);assert.deepEqual((await loadWholesaleExportSnapshot(f.db,f.users.supply)).orders.map(o=>o.id),[a]);assert.equal((await loadWholesaleExportSnapshot(f.db,f.users.supply2)).orders.length,0);
  const before=batches;await assert.rejects(loadWholesaleExportSnapshot(f.db,f.users.malaysia),/无权/);assert.equal(batches,before);
  const view=await readWholesale(f.db,f.users.finance,"2026-08");assert.equal(view.finance.totals.closingReceivable,200000);assert.equal(view.finance.totals.receipts,0);assert.equal(view.orders.find(o=>o.id===a).financial.salesAmount,500000);
});

test("导出查询不完整时直接失败，不能静默生成缺少流水的报表",async()=>{
  const f=fixture();await f.create();f.db.batch=async()=>[{success:true,results:[]}];await assert.rejects(loadWholesaleExportSnapshot(f.db,f.users.finance),/不完整/);
});
