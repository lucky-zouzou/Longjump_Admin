import {financialPeriod} from './wholesale-finance.mjs';

// Native wholesale amounts are IDR units, not finance_documents' minor units.
// Allocations change receivables, never the cash journal.
export function wholesaleBankSnapshot(snapshot,month,asOfDate){
 const period=financialPeriod(month,asOfDate),before=d=>d<=period.cutoff,inMonth=d=>d>=period.start&&before(d);
 const entries=snapshot.orders.flatMap(o=>(o.entries||[]).map(e=>({...e,orderNo:o.order_no,customerName:o.customer?.name||''}))).filter(e=>before(e.business_date));
 const events=(snapshot.bankEvents||[]).filter(e=>before(e.business_date)),receipts=(snapshot.bankReceipts||[]).filter(b=>before(b.business_date));
 const balances=receipts.map(b=>{
  const allocated=entries.filter(e=>e.bank_receipt_id===b.id).reduce((s,e)=>s+(e.kind==='receipt'?e.amount:e.kind==='receipt_unallocate'?-e.amount:0),0);
  const ev=events.filter(e=>e.receipt_id===b.id),refunded=ev.filter(e=>e.kind==='refund').reduce((s,e)=>s+e.amount,0),reversed=ev.filter(e=>e.kind==='receipt_void').reduce((s,e)=>s+e.amount,0);
  return {id:b.id,reference:b.reference,customerName:b.customer_name||'',bankAccount:b.bank_account||null,legalEntity:b.legal_entity||null,date:b.business_date,currency:'IDR',amount:b.amount,allocated,refunded,reversed,unallocated:b.amount-allocated-refunded-reversed};
 });
 const cash=receipts.filter(b=>inMonth(b.business_date)).map(b=>({sourceId:b.id,date:b.business_date,reference:b.reference,bankAccount:b.bank_account||null,legalEntity:b.legal_entity||null,kind:'receipt',received:b.amount,refunded:0,currency:'IDR'}));
 for(const e of events.filter(e=>inMonth(e.business_date))){const b=receipts.find(b=>b.id===e.receipt_id);if(b)cash.push({sourceId:e.id,receiptId:b.id,date:e.business_date,reference:e.reference,bankAccount:b.bank_account||null,legalEntity:b.legal_entity||null,kind:e.kind,received:e.kind==='receipt_void'?-e.amount:0,refunded:e.kind==='refund'?e.amount:0,currency:'IDR'});}
 for(const e of entries.filter(e=>!e.bank_receipt_id&&inMonth(e.business_date)&&['receipt','refund','receipt_void','refund_void'].includes(e.kind)))cash.push({sourceId:e.id,orderNo:e.orderNo,date:e.business_date,reference:e.reference,bankAccount:null,legalEntity:null,kind:e.kind,received:e.kind==='receipt'?e.amount:e.kind==='receipt_void'?-e.amount:0,refunded:e.kind==='refund'?e.amount:e.kind==='refund_void'?-e.amount:0,currency:'IDR'});
 return {version:1,...period,currency:'IDR',unit:'native',balances,cash:cash.sort((a,b)=>a.date.localeCompare(b.date)),totals:{received:cash.reduce((s,e)=>s+e.received,0),refunded:cash.reduce((s,e)=>s+e.refunded,0),unallocated:balances.reduce((s,b)=>s+b.unallocated,0)},unclassified:balances.filter(b=>!b.legalEntity||!b.bankAccount).length,method:'银行日统计实际收退；订单分配不重复计现金。历史缺法人或账户保留待归类。'};
}
