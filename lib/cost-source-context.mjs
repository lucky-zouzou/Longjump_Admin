import {costState} from './cost-profit.mjs';
import {costSalesSources} from './cost-sale-sources.mjs';
import {skuContributions} from './cost-profit-allocation.mjs';
import {financialRates,financeRows as rows} from './finance-periods.mjs';
// One read model supplies provenance to daily finance and wholesale repricing.
// No reference value is silently promoted to an actual accounting cost.
export async function costContext(db){
 const [records,products,sales,rates]=await Promise.all([
 rows(db,'SELECT c.*,r.tax_treatment,r.created_at reviewed_at FROM cost_records c LEFT JOIN cost_reviews r ON r.record_id=c.id ORDER BY c.created_at,c.id'),rows(db,'SELECT * FROM product_cost_versions ORDER BY version'),costSalesSources(db,{role:'管理员'}),rows(db,'SELECT r.* FROM finance_rates r WHERE revision=(SELECT MAX(x.revision) FROM finance_rates x WHERE x.month=r.month AND x.currency=r.currency)')]);
 const parsed=records.map(r=>({...r,data:JSON.parse(r.data_json)}));
 const state=costState(parsed,sales);return {records:parsed,products,sales,state,rates};
}
export function sourceBasis(context,{site,channel,sku,date}){
 const product=context.products.filter(r=>r.site===site&&r.sku===sku&&r.effective_date<=date).sort((a,b)=>b.version-a.version)[0];
 const tickets=context.state.lots.filter(l=>l.sku===sku&&l.ticket.site===site&&l.ticket.channel===channel&&l.ticket.data.effectiveAt<=date).map(l=>({id:l.ticket.id,revision:l.ticket.revision,reviewedAt:l.ticket.reviewed_at||null}));
 const orders=context.state.orders.filter(o=>o.site===site&&o.channel===channel&&o.business_date===date&&o.evidence.some(e=>e.sku===sku)).map(o=>({id:o.id,revision:o.revision,missing:o.missing,estimated:o.estimated}));
 return {rates:context.rates.filter(r=>r.month===date.slice(0,7)&&r.currency===({印尼:'IDR',马来西亚:'MYR',菲律宾:'PHP',泰国:'THB',越南:'VND'})[site]).map(r=>r.id),product:product?{id:product.id,version:product.version,basis:product.basis}:null,tickets:[...new Map(tickets.map(t=>[t.id,t])).values()].sort((a,b)=>a.id.localeCompare(b.id)),orders:orders.sort((a,b)=>a.id.localeCompare(b.id))};
}
export async function dailyCostSuggestion(db,context,scope){
 const {site,channel,sku,date}=scope,basis=sourceBasis(context,scope),sources=context.sales.filter(s=>!s.reversed_at&&s.qty>0&&s.site===site&&s.channel===channel&&s.sku===sku&&s.business_date===date);
 const rows=context.state.orders.filter(o=>o.site===site&&o.channel===channel&&o.business_date===date).flatMap(o=>skuContributions(o,context.sales).rows).filter(r=>r.sku===sku);
 const complete=sources.length>0&&sources.every(s=>(context.state.usedSales.get(s.id)||0)===s.qty)&&rows.length>0&&rows.every(r=>r.contribution!=null&&!r.estimated);
 const currency=scope.currency,rates=await financialRates(db,date.slice(0,7)),rate=rates[currency];
 const product=context.products.find(r=>r.id===basis.product?.id);
 const fields={landed:['product','sea','tax','inbound'],platform:['platform'],fulfillment:['warehouse'],ads:['advertising'],returns:['refund']};
 const costs=complete&&rate?Object.fromEntries(Object.entries(fields).map(([key,parts])=>[key,Math.round(rows.reduce((s,r)=>s+parts.reduce((n,k)=>n+(r.costs[k]||0),0),0)/rate.rate)/100])):null;
 return {basis,costs,currency,rateVersion:rate?.id||null,status:costs?'actual_linked':'pending',note:!complete?'销售尚未完整关联实际且已复核的批次与结算':!rate?'缺少本月财务固定汇率':'建议来自已复核批次和结算；核对后确认，不重复新增费用',reference:product?{unitCny:product.total==null?null:product.total/10000,basis:product.basis,version:product.version,label:'商品参考成本，不能直接充当实际核算'}:null};
}
