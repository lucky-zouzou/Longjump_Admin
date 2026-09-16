import { translateWholesale } from "./wholesale-i18n.mjs";
const sum=(list,key="amount")=>list.reduce((total,row)=>total+Number(row[key]||0),0);
export const WHOLESALE_STATUS={pending:"待审批",approved:"待打包",packing:"打包中",partial:"部分发货",completed:"已完成发货",closed:"部分发货已结单",rejected:"已驳回",cancelled:"已取消"};
export const FINANCE_KIND={receipt:"回款",refund:"退款",invoice:"开票",invoice_void:"开票冲销",receipt_void:"回款冲正",refund_void:"退款冲正",receipt_unallocate:"撤销收款核销"};
export function financialPeriod(month,asOfDate){
  if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)||month>asOfDate.slice(0,7))throw new Error("请选择当前或过去的有效月份");
  const next=new Date(`${month}-01T00:00:00Z`);next.setUTCMonth(next.getUTCMonth()+1);
  const monthEnd=new Date(next.valueOf()-86400000).toISOString().slice(0,10);
  return {month,start:`${month}-01`,end:monthEnd,cutoff:monthEnd<asOfDate?monthEnd:asOfDate,isClosedMonth:monthEnd<asOfDate};
}
/** Sales follow actual shipment lines, never order status, invoice status or payment status. */
export function orderFinancials(order,include=()=>true){
  const shipments=(order.shipments||[]).filter(s=>include(s.business_date));
  const lines=shipments.flatMap(s=>s.items||[]),returns=(order.returns||[]).filter(r=>include(r.business_date));
  const entries=(order.entries||[]).filter(e=>include(e.business_date));
  const salesAmount=sum(lines),shippedQty=sum(lines,"qty"),returnAmount=sum(returns),returnQty=sum(returns,"qty");
  const receipts=sum(entries.filter(e=>e.kind==="receipt"))-sum(entries.filter(e=>["receipt_void","receipt_unallocate"].includes(e.kind))),refunds=sum(entries.filter(e=>e.kind==="refund"))-sum(entries.filter(e=>e.kind==="refund_void")),invoices=sum(entries.filter(e=>e.kind==="invoice")),invoiceVoids=sum(entries.filter(e=>e.kind==="invoice_void"));
  const netSales=salesAmount-returnAmount,netReceipts=receipts-refunds,balance=netSales-netReceipts;
  return {salesAmount,shippedQty,returnAmount,returnQty,netSales,netQty:shippedQty-returnQty,receipts,refunds,netReceipts,invoices,invoiceVoids,netInvoiced:invoices-invoiceVoids,balance,
    receivable:Math.max(0,balance),advance:Math.max(0,-balance),
    settlementStatus:balance<0?"预收或待退款":shippedQty===0?"未出库":balance===0?"已结清":netReceipts<=0?"未结算":"部分结算"};
}
export function monthlyReconciliation(orders,month,asOfDate){
  const period=financialPeriod(month,asOfDate);
  const data=orders.filter(o=>o.business_date<=period.cutoff).map(o=>{
    const opening=orderFinancials(o,date=>date<period.start),activity=orderFinancials(o,date=>date>=period.start&&date<=period.cutoff),closing=orderFinancials(o,date=>date<=period.cutoff);
    return {id:o.id,orderNo:o.order_no,customerId:o.customer_id,customerName:o.customer?.name||"",salesName:o.sales_name||"",openingBalance:opening.balance,openingReceivable:opening.receivable,openingAdvance:opening.advance,...activity,
      closingBalance:closing.balance,closingReceivable:closing.receivable,closingAdvance:closing.advance,closingNetInvoiced:closing.netInvoiced,closingNetSales:closing.netSales,closingNetReceipts:closing.netReceipts,settlementStatus:closing.settlementStatus};
  });
  const keys=["openingBalance","openingReceivable","openingAdvance","salesAmount","shippedQty","returnAmount","returnQty","netSales","receipts","refunds","netReceipts","invoices","invoiceVoids","closingBalance","closingReceivable","closingAdvance"];
  const totals=Object.fromEntries(keys.map(key=>[key,sum(data,key)]));
  return {...period,rows:data,totals,orderCount:data.length};
}

function customerCells(o){return [o.customer?.code||"",o.customer?.name||"",o.customer?.contact||"",o.customer?.phone||"",o.customer?.city||"",o.customer?.address||"",o.sales_name||""];}
const customerHeaders=["客户编号","客户名称","联系人","电话或WhatsApp","城市","收货地址","销售负责人"];
const parsed=value=>{if(Array.isArray(value))return value;try{return JSON.parse(value||"[]");}catch{return [];}};
export function wholesaleExportSheets(snapshot,{mode="all",month,asOfDate,exportedAt,language="zh"}){
  const report=monthlyReconciliation(snapshot.orders,month,asOfDate),monthly=mode==="month";
  const orders=snapshot.orders.filter(o=>!monthly||o.business_date<=report.cutoff);
  const inPeriod=date=>!monthly||(date>=report.start&&date<=report.cutoff);
  const byId=new Map(orders.map(o=>[o.id,o]));
  const orderHeaders=["序号","订单号","订单日期",...customerHeaders,"国家","币种","当前履约状态","当前完成或结单时间UTC","供应链负责人","SKU种类数","申请件数","当前原订单金额IDR","当前取消未发金额IDR","已出库件数","出库销售额IDR","退货件数","退货金额IDR","净销售额IDR","累计回款IDR","累计退款IDR","结算金额净回款IDR","已出库待收款IDR","预收或待退余额IDR","结算状态按已出库","付款条件","回款到期日","是否需开票","累计开票IDR","累计开票冲销IDR","有效开票金额IDR","开票记录状态","当前合同待收款IDR","当前合同回款状态","备注"];
  const orderRows=orders.map((o,index)=>{
    const f=orderFinancials(o,date=>!monthly||date<=report.cutoff);
    return [index+1,o.order_no,o.business_date,...customerCells(o),"印尼","IDR",WHOLESALE_STATUS[o.status]||o.status,o.completed_at||"",o.supply_name||"",o.items.length,Number(o.total_qty),Number(o.total_amount),Number(o.cancelled_amount||0),f.shippedQty,f.salesAmount,f.returnQty,f.returnAmount,f.netSales,f.receipts,f.refunds,f.netReceipts,f.receivable,f.advance,f.settlementStatus,o.payment_terms==="credit"?"赊销账期":"先款后货",o.due_date||"",o.invoice_required?"是":"否",f.invoices,f.invoiceVoids,f.netInvoiced,f.netInvoiced>0?"有有效开票记录":o.invoice_required?"未开票":"不需开票",Number(o.outstanding||0),o.paymentStatus||"",o.note||""];
  });
  const monthlyHeaders=["序号","订单号",...customerHeaders,"币种","对账月份","统计截止日","期初余额IDR正为应收负为预收","期初应收IDR","期初预收或待退IDR","本月出库件数","本月出库销售额IDR","本月退货件数","本月退货金额IDR","本月净销售额IDR","本月回款IDR","本月退款IDR","本月结算金额净回款IDR","本月开票IDR","本月开票冲销IDR","期末余额IDR正为应收负为预收","期末应收IDR","期末预收或待退IDR","截至期末累计净销售IDR","截至期末累计净回款IDR","截至期末有效开票IDR","期末结算状态","当前履约状态"];
  const monthlyRows=report.rows.map((r,index)=>{const o=byId.get(r.id);return [index+1,r.orderNo,...customerCells(o),"IDR",month,report.cutoff,r.openingBalance,r.openingReceivable,r.openingAdvance,r.shippedQty,r.salesAmount,r.returnQty,r.returnAmount,r.netSales,r.receipts,r.refunds,r.netReceipts,r.invoices,r.invoiceVoids,r.closingBalance,r.closingReceivable,r.closingAdvance,r.closingNetSales,r.closingNetReceipts,r.closingNetInvoiced,r.settlementStatus,WHOLESALE_STATUS[o.status]||o.status];});
  const shipments=[],payments=[],invoices=[],returns=[];
  for(const o of orders){
    for(const s of o.shipments.filter(s=>inPeriod(s.business_date)))for(const i of s.items){const item=o.items.find(x=>x.id===i.order_item_id);shipments.push([o.order_no,...customerCells(o),"IDR",s.shipment_no,s.business_date,item?.sku||"",item?.name||"",Number(i.qty),Number(item?.unit_price||0),Number(i.amount),s.warehouse,s.carrier,s.tracking_no||"",parsed(i.allocations_json).map(a=>`${a.channel}: ${a.qty}`).join("; "),s.created_at||""]);}
    for(const e of o.entries.filter(e=>inPeriod(e.business_date))){const row=[o.order_no,...customerCells(o),"IDR",e.business_date,FINANCE_KIND[e.kind]||e.kind,Number(e.amount),e.reference,e.actor_name||e.actor_id,e.created_at||"",e.note||""];(["receipt","refund","receipt_void","refund_void","receipt_unallocate"].includes(e.kind)?payments:invoices).push(row);}
    for(const r of o.returns.filter(r=>inPeriod(r.business_date))){const item=o.items.find(i=>i.id===r.order_item_id);returns.push([o.order_no,...customerCells(o),"IDR",r.business_date,item?.sku||"",item?.name||"",Number(r.qty),Number(r.amount),r.resellable?"可售入库":"隔离入库",r.proof_ref,r.reason,r.created_at||""]);}
  }
  const summaryRows=[
    ["导出范围",monthly?`${month}月度对账；含截至截止日的全部权限内订单和期初结转`:`全部权限内订单，不受页面搜索、状态或月份筛选限制`],
    ["导出时间UTC",exportedAt],["导出人员",snapshot.actor.name],["导出角色",snapshot.actor.role],["币种","IDR 印尼盾"],["订单总表行数",orders.length],["对账月份",month],["统计截止日",report.cutoff],
    ["出库销售口径","实际出库数量乘订单成交单价即计入销售额，包括部分出库、未回款和未开票订单；未出库数量不计销售额"],
    ["退货口径","原出库销售额保留，实际退货单独列示并冲减净销售额；退款以实际财务记录另行统计"],
    ["结算金额定义","结算金额为已核销净回款，即确认回款减确认退款，不自动把销售额当成已收款"],
    ["月度余额公式","期末余额 = 期初余额 + 本月出库销售额 - 本月退货金额 - 本月回款 + 本月退款"],
    ["余额符号","正数为已出库待收款；负数为客户预收或待退款。各订单应收和预收分别汇总，不跨客户抵消"],
    ["月度取数","月份按印尼西部时间业务日期；月度对账中的金额按截止日重算，不带入之后回款或之后退货"],
    ["状态说明","订单总表的当前履约状态、取消金额、合同待收和合同回款状态为导出时状态；月度余额及期末结算状态为截止日口径"],
    ["完整性","每笔订单在订单总表只占一行，SKU出库、收款退款、开票和退货分表记录，不用订单与多个流水直接联表累加"],
    ["期初应收IDR",report.totals.openingReceivable],["期初预收或待退IDR",report.totals.openingAdvance],["本月出库销售额IDR",report.totals.salesAmount],["本月退货金额IDR",report.totals.returnAmount],["本月回款IDR",report.totals.receipts],["本月退款IDR",report.totals.refunds],["期末应收IDR",report.totals.closingReceivable],["期末预收或待退IDR",report.totals.closingAdvance],
  ];
  const sheets=[
    {name:monthly?"截至期末订单总表":"全部订单总表",headers:orderHeaders,rows:orderRows},
    {name:"月度对账",headers:monthlyHeaders,rows:monthlyRows},
    {name:"SKU出库明细",headers:["订单号",...customerHeaders,"币种","出库单号","出库日期","SKU","商品","出库件数","成交单价IDR","出库销售额IDR","发货仓库","承运商","物流单号","库存扣减来源","登记时间UTC"],rows:shipments},
    {name:"收款退款明细",headers:["订单号",...customerHeaders,"币种","业务日期","类型","金额IDR","银行流水或凭证编号","核销人","登记时间UTC","说明"],rows:payments},
    {name:"开票明细",headers:["订单号",...customerHeaders,"币种","业务日期","类型","金额IDR","票据或冲销编号","登记人","登记时间UTC","说明"],rows:invoices},
    {name:"退货明细",headers:["订单号",...customerHeaders,"币种","退货实收日期","SKU","商品","退货件数","退货金额IDR","库存处理","验收凭证","退货原因","登记时间UTC"],rows:returns},
    {name:"对账说明与汇总",headers:["项目","内容或金额"],rows:summaryRows},
  ];
  if((snapshot.bankReceipts||[]).length){
    const banks=(snapshot.bankReceipts||[]).filter(b=>!monthly||b.business_date<=report.cutoff),events=snapshot.bankEvents||[];
    const balances=banks.map(b=>{const entries=orders.flatMap(o=>o.entries||[]).filter(e=>e.bank_receipt_id===b.id&&(!monthly||e.business_date<=report.cutoff));const allocated=entries.reduce((s,e)=>s+(e.kind==='receipt'?e.amount:e.kind==='receipt_unallocate'?-e.amount:0),0),ev=events.filter(e=>e.receipt_id===b.id&&(!monthly||e.business_date<=report.cutoff)),refund=sum(ev.filter(e=>e.kind==='refund')),voided=sum(ev.filter(e=>e.kind==='receipt_void'));return [b.reference,b.customer_name||'',b.bank_account,b.business_date,b.amount,allocated,refund,voided,b.amount-allocated-refund-voided,'IDR'];});
    sheets.push({name:'银行收款余额',headers:['银行流水或凭证编号','客户名称','公司收款账户','业务日期','原收款IDR','已核销IDR','已退预收IDR','冲正IDR','未分配余额IDR','币种'],rows:balances});
    const cash=banks.filter(b=>inPeriod(b.business_date)).map(b=>[b.business_date,b.reference,b.customer_name||'',b.bank_account,'银行到账',b.amount,0,b.id,b.note]);
    for(const e of events.filter(e=>inPeriod(e.business_date))){const b=banks.find(b=>b.id===e.receipt_id);if(b)cash.push([e.business_date,e.reference,b.customer_name||'',b.bank_account,FINANCE_KIND[e.kind]||e.kind,e.kind==='receipt_void'?-e.amount:0,e.kind==='refund'?e.amount:0,b.id,e.note]);}
    for(const o of orders)for(const e of o.entries.filter(e=>!e.bank_receipt_id&&inPeriod(e.business_date)&&['receipt','refund','receipt_void','refund_void'].includes(e.kind)))cash.push([e.business_date,e.reference,o.customer?.name||'','',FINANCE_KIND[e.kind],e.kind==='receipt'?e.amount:e.kind==='receipt_void'?-e.amount:0,e.kind==='refund'?e.amount:e.kind==='refund_void'?-e.amount:0,o.order_no,e.note]);
    sheets.push({name:'银行收支流水',headers:['业务日期','银行流水或凭证编号','客户名称','公司收款账户','类型','实际收款净额IDR','实际退款净额IDR','关联单据','说明'],rows:cash.sort((a,b)=>String(a[0]).localeCompare(String(b[0])))});
    summaryRows.push(['收款与核销','银行收款余额和银行收支流水记录实际资金；收款退款明细按订单记录核销。同一笔银行到账分配多订单时，不可重复累加为银行收款。'],['关账状态',snapshot.closedMonth===month?'已关账快照':'未关账实时数据']);
  }
  if(monthly)[sheets[0],sheets[1]]=[sheets[1],sheets[0]];
  return localizeWholesaleSheets(sheets,language);
}

export function localizeWholesaleSheets(sheets,language){
  if(language!=="id")return sheets;
  const t=value=>translateWholesale(language,value);
  const enums=new Set(["国家","当前履约状态","结算状态按已出库","付款条件","是否需开票","开票记录状态","当前合同回款状态","期末结算状态","类型","库存处理"]);
  return sheets.map(sheet=>({...sheet,name:t(sheet.name),headers:sheet.headers.map(t),rows:sheet.rows.map(row=>row.map((value,index)=>{
    if(sheet.name==="对账说明与汇总")return index===0||row[0]!=="导出人员"?t(value):value;
    return enums.has(sheet.headers[index])?t(value):value;
  }))}));
}

export function toWholesaleWorkbook(XLSX,sheets,language="zh"){
  const t=value=>translateWholesale(language,value);
  const book=XLSX.utils.book_new();book.Props={Title:t("印尼线下批发财务对账"),Subject:t("实际出库确认销售 IDR"),Author:"LOONG JUMP"};
  for(const sheet of sheets){
    // aoa_to_sheet keeps phone/order identifiers as literal strings (never formulas).
    const ws=XLSX.utils.aoa_to_sheet([sheet.headers,...sheet.rows]);
    ws["!cols"]=sheet.headers.map(h=>({wch:language==="id"?Math.min(46,Math.max(18,h.length+2)):/地址|备注|说明|名称/.test(h)?32:/IDR|金额|时间|订单号/.test(h)?24:18}));
    ws["!autofilter"]={ref:ws["!ref"]};
    for(const [key,cell] of Object.entries(ws))if(!key.startsWith("!")&&cell.t==="n")cell.z="#,##0;[Red]-#,##0";
    XLSX.utils.book_append_sheet(book,ws,sheet.name);
  }return book;
}
