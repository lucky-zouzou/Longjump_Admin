import {completeSalesDates} from './sales-completeness.mjs';
import {financeRows} from './finance-periods.mjs';

// Reconcile against the current effective reports, even when the statement crosses a month.
// Index evidence by day once; a correction must not change the original statement or voucher.
export async function settlementSources(db,documents){
 if(!documents.length)return [];
 const from=documents.map(d=>d.data.from).sort()[0],to=documents.map(d=>d.data.to).sort().at(-1);
 const [imports,sales]=await Promise.all([
  financeRows(db,'SELECT site,channel,business_date,report_kind FROM sales_imports WHERE reversed_at IS NULL AND business_date BETWEEN ? AND ?',[from,to]),
  financeRows(db,'SELECT site,channel,business_date,sku,qty,import_id,currency,reported_amount FROM sales_records WHERE reversed_at IS NULL AND business_date BETWEEN ? AND ?',[from,to])]);
 const days=new Map(),key=(s,c,d)=>JSON.stringify([s,c,d]);
 function add(r,field){const k=key(r.site,r.channel,r.business_date);if(!days.has(k))days.set(k,{imports:[],sales:[]});days.get(k)[field].push(r);}
 for(const r of imports)add(r,'imports');for(const r of sales)add(r,'sales');
 return documents.map(d=>{
  const missingDates=[];let total=0,unknown=false;
  for(let t=Date.parse(d.data.from);t<=Date.parse(d.data.to);t+=86400000){
   const date=new Date(t).toISOString().slice(0,10),day=days.get(key(d.site,d.channel,date));
   if(!day||!completeSalesDates(day.imports,day.sales).length)missingDates.push(date);
   for(const s of day?.sales||[]){if(!s.currency||s.currency==='UNKNOWN')unknown=true;else if(s.currency===d.currency){if(s.reported_amount==null)unknown=true;else total+=Math.round(s.reported_amount*100);}}
  }
  const sourceRevenueMinor=unknown||missingDates.length?null:total;
  return {reference:d.business_key,site:d.site,channel:d.channel,currency:d.currency,from:d.data.from,to:d.data.to,originalDifferenceMinor:d.data.difference??null,sourceRevenueMinor,differenceMinor:sourceRevenueMinor===null?null:d.data.gross-sourceRevenueMinor,missingDates};
 });
}
