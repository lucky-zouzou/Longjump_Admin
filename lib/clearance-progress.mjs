import {dates,localDay,round} from './clearance-model.mjs';
import {completeSalesDates} from './sales-completeness.mjs';

export const clearanceReportLabels={complete:'完整日报',missing:'缺报',partial:'部分日报／待确认',in_progress:'今日进行中',overlap:'报表重叠待核实'};

// Read the importer's existing stock ledger. Clearance never writes a second
// stock movement. Business dates govern attribution; import timestamps do not.
export function clearanceProgress(line,{sales,imports,movements,now=new Date()}){
 const scope=r=>r.site===line.site&&r.channel===line.channel,own=r=>scope(r)&&r.sku===line.sku;
 const today=localDay(now,line.site),through=[line.ended_on||line.data.end,today].sort()[0];
 const allDays=line.started_on?dates(line.started_on,through):[];
 const inPeriod=r=>allDays.includes(r.business_date);
 const scopeSales=sales.filter(r=>scope(r)&&inPeriod(r)),scopeImports=imports.filter(r=>scope(r)&&inPeriod(r));
 const active=scopeSales.filter(r=>!r.reversed_at),complete=new Set(completeSalesDates(scopeImports,active));
 const ownSales=scopeSales.filter(own),flows=movements.filter(r=>own(r)&&inPeriod(r));
 const byImport=new Map(scopeImports.map(r=>[r.id,r]));
 const batches=[...new Set([...ownSales.filter(r=>r.qty>0).map(r=>r.import_id),...flows.map(r=>r.reference_id)])].map(id=>{
  const source=byImport.get(id),records=ownSales.filter(r=>r.import_id===id),moves=flows.filter(r=>r.reference_id===id);
  const originalQty=records.reduce((n,r)=>n+r.qty,0),qty=records.filter(r=>!r.reversed_at).reduce((n,r)=>n+r.qty,0);
  const deductedQty=-moves.filter(r=>r.reference_type==='销售导入').reduce((n,r)=>n+r.qty_delta,0);
  const reversedQty=moves.filter(r=>r.reference_type==='销售冲销').reduce((n,r)=>n+r.qty_delta,0);
  const matched=!!source&&records.length>0&&deductedQty===originalQty&&reversedQty===originalQty-qty&&records.every(r=>!!r.reversed_at===!!source.reversed_at)&&moves.every(r=>r.reference_type==='销售导入'?r.qty_delta<=0:r.qty_delta>=0);
  return {id,date:source?.business_date||moves[0]?.business_date,ref:source?.source_batch_ref||id,file:source?.file_name||'',importedAt:source?.created_at||null,
   originalQty,qty,deductedQty,reversedQty,netDeductedQty:deductedQty-reversedQty,matched,reversedAt:source?.reversed_at||null,
   movements:moves.map(m=>({id:m.id,kind:m.reference_type,delta:m.qty_delta,balanceAfter:m.balance_after,at:m.created_at}))};
 }).sort((a,b)=>a.date.localeCompare(b.date)||a.id.localeCompare(b.id));
 const daily=allDays.map(date=>{
  const daySales=active.filter(r=>r.business_date===date),dayImports=scopeImports.filter(r=>r.business_date===date&&!r.reversed_at);
  const rows=daySales.filter(own),dayBatches=batches.filter(r=>r.date===date);
  const skuBatches=new Map();for(const r of daySales.filter(r=>r.qty>0)){const ids=skuBatches.get(r.sku)||new Set();ids.add(r.import_id);skuBatches.set(r.sku,ids);}
  const overlap=[...skuBatches.values()].some(ids=>ids.size>1),ongoing=date===today;
  const status=overlap?'overlap':ongoing?'in_progress':complete.has(date)?'complete':dayImports.some(r=>r.report_kind!=='cost')||rows.some(r=>r.qty>0)?'partial':'missing';
  const reportedQty=rows.reduce((n,r)=>n+r.qty,0),hasQty=rows.some(r=>r.qty>0)||complete.has(date);
  return {date,status,reportedQty,qty:hasQty?reportedQty:null,stockMatched:dayBatches.every(r=>r.matched),
   deductedQty:dayBatches.reduce((n,r)=>n+r.deductedQty,0),reversedQty:dayBatches.reduce((n,r)=>n+r.reversedQty,0),
   netDeductedQty:dayBatches.reduce((n,r)=>n+r.netDeductedQty,0),batchIds:dayBatches.map(r=>r.id)};
 });
 const qty=daily.reduce((n,r)=>n+r.reportedQty,0),stockMatched=batches.every(r=>r.matched),overlapDays=daily.filter(r=>r.status==='overlap').map(r=>r.date);
 const knownRemaining=line.started_on&&stockMatched&&!overlapDays.length?Math.max(0,line.data.targetQty-qty):null;
 return {from:line.started_on||null,through:line.started_on?through:null,qty,daily,batches,stockMatched,overlapDays,
  deductedQty:batches.reduce((n,r)=>n+r.deductedQty,0),reversedQty:batches.reduce((n,r)=>n+r.reversedQty,0),netDeductedQty:batches.reduce((n,r)=>n+r.netDeductedQty,0),
  completeDays:daily.filter(r=>r.status==='complete').length,missingDays:daily.filter(r=>r.status==='missing').map(r=>r.date),partialDays:daily.filter(r=>r.status==='partial').map(r=>r.date),
  knownRemaining,completionPct:knownRemaining==null?null:round(qty/line.data.targetQty*100),
  verified:daily.length>0&&stockMatched&&daily.every(r=>r.status==='complete')};
}
