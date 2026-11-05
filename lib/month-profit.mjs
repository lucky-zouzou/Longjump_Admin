import {financeRows as rows} from './finance-periods.mjs';
import {financeDays} from './business-action-finance.mjs';
import {skuContributions} from './cost-profit-allocation.mjs';
import {completeSalesDates} from './sales-completeness.mjs';
const dateKey=r=>JSON.stringify([r.site,r.channel,r.business_date]);
const key=r=>JSON.stringify([r.site,r.channel,r.business_date,r.sku]);
function groups(rs,id){const m=new Map();for(const r of rs){const k=id(r);if(!m.has(k))m.set(k,[]);m.get(k).push(r);}return m;}
// The unit of reconciliation is site/channel/day/SKU, not a rolling window.
// Fully verified daily entries cover the whole unit. Batch contributions are a fallback,
// never a second profit on the same sale. Unattributable order totals stay pending.
export async function monthProfit(db,context,rates,from,to){
 const read=(sql)=>rows(db,sql+' AND business_date BETWEEN ? AND ? ORDER BY id',[from,to]);
 const [raw,imports,ads,afters,entries,clearance]=await Promise.all([
 read('SELECT id,import_id,site,channel,sku,business_date,qty,currency,reported_amount,ad_cost FROM sales_records WHERE reversed_at IS NULL'),
 read('SELECT id,site,channel,business_date,report_kind FROM sales_imports WHERE reversed_at IS NULL'),
 read('SELECT * FROM sales_ad_spend WHERE deleted_at IS NULL'),
 read("SELECT id,site,channel,sku,business_date,status,version,data_json FROM after_sales WHERE record_kind='after_sale' AND status NOT IN ('void','draft')"),
 read('SELECT * FROM business_action_finance_days WHERE 1=1'),
 rows(db,"SELECT site,channel,sku,started_on,ended_on,data_json FROM clearance_lines WHERE started_on IS NOT NULL AND started_on<=? AND (ended_on IS NULL OR ended_on>=?)",[to,from])]);
 const campaigns=groups(clearance,r=>JSON.stringify([r.site,r.channel,r.sku]));
 const sales=context.sales.filter(r=>!r.reversed_at&&r.qty>0&&r.business_date>=from&&r.business_date<=to);
 const source=groups(sales,key),salesByDay=groups(raw,dateKey),salesBySku=groups(raw,key),importsByDay=groups(imports,dateKey),shop=groups(ads,dateKey),after=groups(afters,key),bySku=groups(entries,key),byDay=groups(entries,dateKey);
 const orders=context.state.orders.filter(o=>o.business_date>=from&&o.business_date<=to);
 const lines=[],issues=[],batch=new Map(),saleMap=new Map(context.sales.map(s=>[s.id,s]));
 for(const o of orders){
  const shares=skuContributions(o,saleMap).rows;
  if(!shares.length||shares.some(s=>s.allocationPending))issues.push({order:o.id,reason:'订单费用尚未分摊至 SKU'});
  for(const s of shares){const k=key({...o,sku:s.sku});if(!batch.has(k))batch.set(k,[]);batch.get(k).push({...s,order:o.id});}
 }
 let confirmed=0,estimated=0,uncovered=0;
 const allocations=new Map(),missingDailyRates=new Set();
 const assign=(d,c,n)=>{const k=d+c;allocations.set(k,(allocations.get(k)||0)+n);};
 for(const k of new Set([...source.keys(),...batch.keys(),...bySku.keys()])){
  const [site,channel,date,sku]=JSON.parse(k),d=dateKey({site,channel,business_date:date}),ss=source.get(k)||[],bs=batch.get(k)||[],versions=bySku.get(k)||[],ids=ss.map(s=>s.id);
  const day=versions.length?(await financeDays({dates:[date],site,channel,sku,sales:salesBySku.get(k)||[],scopeSales:salesByDay.get(d)||[],imports:importsByDay.get(d)||[],ads:shop.get(d)||[],afters:after.get(k)||[],entries:versions,scopeEntries:byDay.get(d)||[],context}))[0]:null;
  if(day?.status==='confirmed'&&(campaigns.get(JSON.stringify([site,channel,sku]))||[]).some(c=>date>=c.started_on&&date<=(c.ended_on||JSON.parse(c.data_json).end))&&!Number.isFinite(day.costs?.other))day.status='additional_pending';
  if(day?.status==='confirmed'&&!rates[day.currency])missingDailyRates.add(day.currency);
  const completeBatch=ss.length>0&&ss.every(s=>context.state.usedSales.get(s.id)===s.qty)&&bs.length>0&&bs.every(s=>s.contribution!=null&&!s.estimated);
  const actual=bs.filter(b=>b.contribution!=null&&!b.estimated).reduce((n,b)=>n+b.contribution,0),quote=bs.filter(b=>b.contribution!=null&&b.estimated).reduce((n,b)=>n+b.contribution,0);
  let basis='批次成本账',value=actual,estimate=quote,reason='';
  if(day?.status==='confirmed'&&rates[day.currency]){
   basis='财务逐日核算';value=Math.round((day.revenue-Object.values(day.costs).reduce((n,x)=>n+Number(x),0))*rates[day.currency].rate*100);estimate=0;
   assign(d,day.currency,Math.round(day.costs.ads*100));
   if(completeBatch&&actual!==value)reason='日核算与批次贡献存在差额，采用日核算，需对账';
  }else{
   const unmatched=ss.filter(s=>s.qty>(context.state.usedSales.get(s.id)||0));uncovered+=unmatched.length;
   if(day||!completeBatch)reason=day?'日核算'+(day.status==='confirmed'?'缺财务汇率':'需重新核对：'+day.status):'销售或批次成本尚未核齐';
   for(const b of bs)if(b.contribution!=null&&b.costs.advertising!=null&&rates[day?.currency||ss[0]?.currency]){
    const fx=rates[day?.currency||ss[0]?.currency].rate;assign(d,day?.currency||ss[0].currency,Math.round(b.costs.advertising/fx));
   }
  }
  const line={site,channel,date,sku,saleIds:ids,batchIds:bs.map(b=>b.order),dailyRevision:day?.revision||null,rateId:day?rates[day.currency]?.id:null,basis,confirmed:basis==='财务逐日核算'||bs.some(b=>b.contribution!=null&&!b.estimated)?value:null,estimated:estimate,reason};
  lines.push(line);if(reason)issues.push({site,channel,date,sku,reason});confirmed+=value;estimated+=estimate;
 }
 const pendingSalesAmounts={};for(const line of lines.filter(r=>r.reason)){for(const r of source.get(key({...line,business_date:line.date}))||[]){const v=pendingSalesAmounts[r.currency]??={knownAmount:0,missingAmountRows:0};if(r.reported_amount==null)v.missingAmountRows++;else v.knownAmount+=r.reported_amount;}}
 const adGaps=[];
 for(const [d,rs] of shop)for(const [currency,cs] of groups(rs,r=>r.currency)){const total=cs.reduce((n,r)=>n+Math.round(r.amount*100),0),allocated=allocations.get(d+currency)||0;if(total!==allocated)adGaps.push({scope:JSON.parse(d),currency,totalMinor:total,allocatedMinor:allocated});}
 const coverage=new Set();for(const [d,rs] of importsByDay)if(completeSalesDates(rs,salesByDay.get(d)||[]).length)coverage.add(d);
 return {profitSummary:{confirmed,estimated,pending:issues.length,pendingSalesAmounts,lines,issues},uncoveredSales:uncovered,adGaps,missingDailyRates:[...missingDailyRates],coverage};
}
