import test from "node:test";
import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import { financialPeriod,orderFinancials,monthlyReconciliation,wholesaleExportSheets,toWholesaleWorkbook } from "../lib/wholesale-finance.mjs";

const order=(id,extra={})=>({id,order_no:`000${id}`,business_date:"2026-08-01",customer_id:`c${id}`,customer:{code:`00${id}`,name:"测试客户",contact:"联系人",phone:"08120000000",city:"Jakarta",address:"仓库地址"},sales_name:"销售甲",status:"approved",total_qty:5,total_amount:500000,invoice_required:1,payment_terms:"credit",items:[{id:`i${id}`,sku:"SKU-01",name:"背包",unit_price:100000}],shipments:[],entries:[],returns:[],...extra});
const ship=(id,date,qty)=>({shipment_no:`S${id}`,business_date:date,warehouse:"印尼仓",carrier:"承运商",tracking_no:"001234",items:[{order_item_id:`i${id}`,qty,amount:qty*100000,allocations_json:'[{"channel":"TikTok","qty":1}]'}]});
const entry=(kind,date,amount)=>({kind,business_date:date,amount,reference:"000bank",actor_name:"财务",note:"核对公司银行账户"});
const opts={mode:"all",month:"2026-08",asOfDate:"2026-09-12",exportedAt:"2026-09-12T10:00:00Z"};
const snapshot=orders=>({actor:{name:"财务",role:"财务"},orders});
const column=(sheet,header)=>sheet.headers.indexOf(header);

test("实际出库即销售，部分未回款未开票订单也计入，申请数量不计入",()=>{
  const partial=orderFinancials(order("1",{status:"partial",shipments:[ship("1","2026-08-31",2)]}));
  assert.equal(partial.salesAmount,200000);assert.equal(partial.shippedQty,2);assert.equal(partial.netInvoiced,0);assert.equal(partial.receivable,200000);assert.equal(partial.settlementStatus,"未结算");
  const prepaid=orderFinancials(order("2",{entries:[entry("receipt","2026-08-02",500000)]}));
  assert.equal(prepaid.salesAmount,0);assert.equal(prepaid.receivable,0);assert.equal(prepaid.advance,500000);assert.equal(prepaid.settlementStatus,"预收或待退款");
  assert.equal(orderFinancials(order("3",{status:"cancelled",cancelled_amount:500000})).salesAmount,0);
});

test("跨月出库回款和退货退款独立归属，各月期初期末余额连续",()=>{
  const o=order("1",{shipments:[ship("1","2026-08-31",2),ship("1","2026-09-01",3)],entries:[entry("receipt","2026-09-02",500000),entry("refund","2026-10-01",100000)],returns:[{business_date:"2026-09-10",qty:1,amount:100000}]});
  const august=monthlyReconciliation([o],"2026-08","2026-10-12").rows[0];
  const september=monthlyReconciliation([o],"2026-09","2026-10-12").rows[0];
  const october=monthlyReconciliation([o],"2026-10","2026-10-12").rows[0];
  assert.equal(august.salesAmount,200000);assert.equal(august.receipts,0);assert.equal(august.closingReceivable,200000);
  assert.equal(september.openingBalance,august.closingBalance);assert.equal(september.salesAmount,300000);assert.equal(september.returnAmount,100000);assert.equal(september.refunds,0);assert.equal(september.closingAdvance,100000);
  assert.equal(october.openingBalance,-100000);assert.equal(october.refunds,100000);assert.equal(october.closingBalance,0);assert.equal(october.settlementStatus,"已结清");
  for(const r of [august,september,october])assert.equal(r.closingBalance,r.openingBalance+r.salesAmount-r.returnAmount-r.receipts+r.refunds);
});

test("应收和预收逐订单分别汇总，不跨客户抵消；当前月截至今天",()=>{
  const a=order("1",{shipments:[ship("1","2026-08-31",5)]}),b=order("2",{entries:[entry("receipt","2026-08-02",500000)]});
  const report=monthlyReconciliation([a,b],"2026-09","2026-09-12");
  assert.equal(report.totals.openingBalance,0);assert.equal(report.totals.openingReceivable,500000);assert.equal(report.totals.openingAdvance,500000);assert.equal(report.totals.closingReceivable,500000);assert.equal(report.totals.closingAdvance,500000);assert.equal(report.cutoff,"2026-09-12");
  assert.equal(financialPeriod("2024-02","2026-09-12").end,"2024-02-29");assert.throws(()=>financialPeriod("2026-13","2026-09-12"));assert.throws(()=>financialPeriod("2026-10","2026-09-12"));
});

test("全部订单跨月份保留所有状态，月度导出保留旧单结转并排除截止日后流水",()=>{
  const a=order("1",{shipments:[ship("1","2026-08-31",2),ship("1","2026-09-01",3)],entries:[entry("receipt","2026-09-02",200000),entry("receipt","2026-09-03",300000),entry("invoice","2026-09-04",500000)]});
  const b=order("2",{business_date:"2026-09-02",status:"cancelled"}),c=order("3",{business_date:"2026-07-01",status:"rejected"});
  const sheets=wholesaleExportSheets(snapshot([a,b,c]),opts),all=sheets[0];
  assert.equal(all.rows.length,3);assert.equal(all.rows[0][column(all,"出库销售额IDR")],500000);assert.equal(all.rows[0][column(all,"结算金额净回款IDR")],500000);assert.equal(sheets.find(s=>s.name==="收款退款明细").rows.length,2);assert.equal(sheets.find(s=>s.name==="SKU出库明细").rows.length,2);
  const monthly=wholesaleExportSheets(snapshot([a,b,c]),{...opts,mode:"month"}),end=monthly.find(s=>s.name==="截至期末订单总表");
  assert.equal(monthly[0].name,"月度对账");assert.equal(end.rows.length,2);assert.equal(end.rows[0][column(end,"出库销售额IDR")],200000);assert.equal(end.rows[0][column(end,"累计回款IDR")],0);assert.equal(end.rows[0][column(end,"已出库待收款IDR")],200000);assert.equal(monthly.find(s=>s.name==="收款退款明细").rows.length,0);
});

test("Excel七张表完整往返，金额为数值，电话和公式样文本按原文保存",()=>{
  const o=order("1",{customer:{code:"0001",name:"=HYPERLINK(\"https://example.test\")",phone:"08120000000"},shipments:[ship("1","2026-08-31",5)],entries:[entry("receipt","2026-09-02",500000),entry("invoice","2026-09-04",500000)],returns:[{order_item_id:"i1",business_date:"2026-09-10",qty:1,amount:100000,resellable:1,proof_ref:"000ret",reason:"客户退回"}]});
  const sheets=wholesaleExportSheets(snapshot([o]),opts);
  for(const s of sheets)for(const r of s.rows)assert.equal(r.length,s.headers.length,`${s.name}列数不一致`);
  const buffer=XLSX.write(toWholesaleWorkbook(XLSX,sheets),{type:"buffer",bookType:"xlsx"});
  const book=XLSX.read(buffer,{type:"buffer"});assert.equal(book.SheetNames.length,7);
  for(const s of sheets){const rows=XLSX.utils.sheet_to_json(book.Sheets[s.name],{header:1,defval:""});assert.equal(rows.length,s.rows.length+1);}
  const ws=book.Sheets["全部订单总表"],first=sheets[0];
  const cell=h=>ws[XLSX.utils.encode_cell({r:1,c:column(first,h)})];
  assert.equal(cell("电话或WhatsApp").v,"08120000000");assert.equal(cell("电话或WhatsApp").t,"s");assert.equal(cell("客户名称").v,o.customer.name);assert.equal(cell("客户名称").f,undefined);assert.equal(cell("出库销售额IDR").t,"n");assert.equal(cell("出库销售额IDR").v,500000);assert.equal(cell("退货金额IDR").v,100000);assert.equal(cell("净销售额IDR").v,400000);assert.equal(cell("订单号").t,"s");
});

test("无订单时仍可导出完整表头及零金额汇总",()=>{
  const sheets=wholesaleExportSheets(snapshot([]),opts),book=toWholesaleWorkbook(XLSX,sheets);assert.equal(book.SheetNames.length,7);
  for(const s of sheets.filter(s=>s.name!=="对账说明与汇总"))assert.equal(s.rows.length,0);
  assert.equal(monthlyReconciliation([],"2026-08","2026-09-12").totals.closingReceivable,0);
});
