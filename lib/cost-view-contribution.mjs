import {monthProfit} from './month-profit.mjs';
import {financeRows as rows,financialRates} from './finance-periods.mjs';
import {costContext} from './cost-source-context.mjs';
import {skuContributions} from './cost-profit-allocation.mjs';
// Ticket filters select a particular cost lot. Daily SKU totals cannot be attributed
// to one lot, so that drilldown continues to use the original batch evidence.
export async function costViewContribution(db,a,{from,to,site,channel,sku,ticket},frozen){
 if(ticket)return null;
 const inScope=r=>(a.role!=='运营'||r.site===a.site&&r.channel===a.channel)&&(!site||r.site===site)&&(!channel||r.channel===channel)&&(!sku||r.sku===sku);
 const dates=await rows(db,`SELECT DISTINCT substr(business_date,1,7) month FROM (
 SELECT business_date FROM sales_records UNION ALL SELECT business_date FROM business_action_finance_days UNION ALL SELECT business_date FROM cost_records WHERE kind='order'
 UNION ALL SELECT business_date FROM wholesale_shipments UNION ALL SELECT business_date FROM wholesale_consignment_sales)`);
 const periods=new Set([...dates.map(r=>r.month),...frozen.map(f=>f.month)]),lines=[];
 let context;
 for(const month of periods){
  if(!month||(from&&from.slice(0,7)>month)||(to&&to.slice(0,7)<month))continue;
  const closed=frozen.find(f=>f.month===month),first=month+'-01',last=new Date(Date.UTC(+month.slice(0,4),+month.slice(5),0)).toISOString().slice(0,10);
  let items;
  if(closed){
   items=closed.data.profitSummary?.lines;
   // Older snapshots contain batch orders but no daily facts. Never use live data to fill them.
   if(!items){const src=new Map(closed.data.sales.map(r=>[r.id,r]));items=closed.data.orders.flatMap(o=>skuContributions(o,src).rows.map(r=>({site:o.site,channel:o.channel,sku:r.sku,date:o.business_date,confirmed:o.estimated?null:r.contribution,estimated:o.estimated?r.contribution:null,reason:r.contribution==null?'旧快照费用待核实':'',basis:'历史关账批次'})));}
  }else{
   context??=await costContext(db);
   items=(await monthProfit(db,context,await financialRates(db,month),from&&from>first?from:first,to&&to<last?to:last)).profitSummary.lines;
  }
  lines.push(...items.filter(r=>inScope(r)&&(!from||r.date>=from)&&(!to||r.date<=to)));
 }
 const known=lines.filter(r=>r.confirmed!=null),pending=lines.filter(r=>r.reason).length;
 return {confirmed:known.length?known.reduce((s,r)=>s+r.confirmed,0):null,estimated:lines.reduce((s,r)=>s+(r.estimated||0),0),pending,covered:known.length,groups:lines.length};
}
