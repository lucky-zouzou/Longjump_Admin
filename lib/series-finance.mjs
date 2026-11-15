import {orderFinancials} from './wholesale-finance.mjs';

// Freeze membership and the figures attributed to it together in the finance close.
export function seriesBooks(members,lines,orders,from,asOf){
 const bySku=new Map(),books=new Map();
 for(const {sku,product_series:series} of members){
  if(!series?.trim()||series.trim()==='待归类')continue;
  bySku.set(sku,series);
  if(!books.has(series))books.set(series,{series,from,asOf,skus:[],confirmedCny:null,covered:0,pending:0,orders:0,mixed:0,mixedRefs:[],receivableIdr:null,netReceiptsIdr:null});
  books.get(series).skus.push(sku);
 }
 for(const line of lines){
  const book=books.get(bySku.get(line.sku));
  if(!book)continue;
  if(line.confirmed!=null){book.confirmedCny=(book.confirmedCny??0)+line.confirmed;book.covered++;}
  if(line.reason)book.pending++;
 }
 for(const order of orders){
  if(['pending','rejected','cancelled'].includes(order.status)||order.business_date>asOf)continue;
  const groups=new Set(order.items.map(i=>bySku.get(i.sku)));
  for(const series of groups){
   const book=books.get(series);
   if(!book)continue;
   if(groups.size>1){book.mixed++;book.mixedRefs.push(order.order_no);continue;}
   book.orders++;
   book.receivableIdr=(book.receivableIdr??0)+orderFinancials(order,d=>d<=asOf).receivable;
   book.netReceiptsIdr=(book.netReceiptsIdr??0)+orderFinancials(order,d=>d>=from&&d<=asOf).netReceipts;
  }
 }
 for(const book of books.values())if(book.confirmedCny!=null)book.confirmedCny/=100;
 return [...books.values()];
}
