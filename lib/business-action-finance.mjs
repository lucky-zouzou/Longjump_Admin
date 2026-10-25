import {SITE_CURRENCIES} from './sales-data.mjs';
import {financeFields,round} from './business-action-model.mjs';
import {completeSalesDates} from './sales-completeness.mjs';
export async function digest(value){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value))))].map(x=>x.toString(16).padStart(2,'0')).join('');}

// The basis belongs to one business day, never to a sliding window. Keep only
// latest revisions for calculations; all earlier evidence remains immutable.
export async function financeDays({dates,site,sales,imports,ads,afters,entries}){
 const complete=new Set(completeSalesDates(imports,sales)),currency=SITE_CURRENCIES[site];
 return Promise.all(dates.map(async date=>{
  const rs=sales.filter(r=>r.business_date===date),ss=ads.filter(r=>r.business_date===date&&!r.deleted_at),aa=afters.filter(r=>r.business_date===date);
  const valid=complete.has(date)&&rs.filter(r=>r.qty>0).every(r=>r.reported_amount!=null&&Number.isFinite(r.reported_amount)&&r.reported_amount>=0&&r.currency===currency);
  const revenue=valid?round(rs.reduce((sum,r)=>sum+(r.qty>0?r.reported_amount:0),0)):null;
  const basis={date,currency,complete:complete.has(date),sales:rs,shopAds:ss,afters:aa};
  const basisHash=await digest(basis),history=entries.filter(e=>e.business_date===date).sort((a,b)=>b.revision-a.revision),latest=history[0];
  const status=!valid?'sales_pending':!latest?'missing':latest.basis_hash!==basisHash?'stale':'confirmed';
  return {date,currency,revenue,qty:rs.reduce((sum,r)=>sum+r.qty,0),basisHash,basis,status,revision:latest?.revision||0,
   costs:latest?JSON.parse(latest.data_json):null,source:latest?.source||'',note:latest?.note||'',at:latest?.created_at||null,
   history:history.map(e=>({id:e.id,revision:e.revision,costs:JSON.parse(e.data_json),source:e.source,note:e.note,at:e.created_at,actorId:e.actor_id,basis:JSON.parse(e.basis_json)}))};
 }));
}
export function rollingFinance(days){
 if(days.length!==7||days.some(d=>d.status!=='confirmed'))return null;
 const data=Object.fromEntries(Object.keys(financeFields).map(k=>[k,round(days.reduce((s,d)=>s+d.costs[k],0))]));
 return {data,source:days.map(d=>`${d.date} v${d.revision} ${d.source}`).join('；'),created_at:days.map(d=>d.at).sort().at(-1)};
}
export const financeDaySummary=({basis,history,...day})=>day;
