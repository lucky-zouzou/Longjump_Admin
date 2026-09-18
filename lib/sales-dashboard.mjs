import {canReadDomain} from './permissions.mjs';
import {SITE_CURRENCIES} from './sales-data.mjs';
export class SalesReportError extends Error {constructor(status,message){super(message);this.status=status;}}
export const reportToday=()=>new Date(Date.now()+8*3600000).toISOString().slice(0,10);
const dateValid=s=>/^\d{4}-\d{2}-\d{2}$/.test(s)&&Number.isFinite(Date.parse(s))&&new Date(s).toISOString().slice(0,10)===s;
export function reportFilters(actor,input={},today=reportToday()){
  if(!canReadDomain(actor.role,'sales'))throw new SalesReportError(403,'当前账号无权查看销售看板');
  const from=input.from||new Date(Date.parse(today)-29*86400000).toISOString().slice(0,10),to=input.to||today;
  if(!dateValid(from)||!dateValid(to)||from>to||to>today||(Date.parse(to)-Date.parse(from))/86400000>365)throw new SalesReportError(400,'请选择有效的起止日期，单次最多查询366天，结束日期不能晚于今天');
  let site=input.site||'',channel=input.channel||'';
  if(site&&!Object.hasOwn(SITE_CURRENCIES,site)||channel&&!['TikTok','Shopee','线下分销'].includes(channel))throw new SalesReportError(400,'站点或渠道无效');
  if(actor.role==='运营'){
    if(!actor.site||!actor.channel||site&&site!==actor.site||channel&&channel!==actor.channel)throw new SalesReportError(403,'只能查看当前账号负责站点和渠道');
    site=actor.site;channel=actor.channel;
  }
  return {from,to,site,channel};
}
function metrics(row){
  const value={...row,revenue:row.revenue==null?null:Math.round(Number(row.revenue)*100)/100,adCost:row.adCost==null?null:Math.round(Number(row.adCost)*100)/100};
  value.roas=!Number(row.revenueMissing)&&!Number(row.costMissing)&&value.adCost>0?value.revenue/value.adCost:null;
  value.averagePrice=!Number(row.revenueMissing)&&row.qty>0?value.revenue/row.qty:null;
  return value;
}
export async function readSalesDashboard(db,actor,input={},today=reportToday()){
  const filters=reportFilters(actor,input,today),{from,to,site,channel}=filters;
  const args=[from,to],where=['r.reversed_at IS NULL','r.business_date BETWEEN ? AND ?'];
  if(site){where.push('r.site=?');args.push(site);}if(channel){where.push('r.channel=?');args.push(channel);}
  let source=`SELECT r.business_date date,r.site,r.channel,r.sku,r.qty,COALESCE(r.currency,'UNKNOWN') currency,r.reported_amount revenue,r.ad_cost adCost FROM sales_records r WHERE ${where.join(' AND ')}`;
  // Wholesale quantities and revenue arise from shipment/return events, never again from order creation.
  if(['管理员','运营主管','供应链'].includes(actor.role)&&(!site||site==='印尼')&&(!channel||channel==='线下分销')){
    source+=` UNION ALL SELECT s.business_date,'印尼','线下分销',i.sku,si.qty,'IDR',si.amount,NULL FROM wholesale_shipment_items si JOIN wholesale_shipments s ON s.id=si.shipment_id JOIN wholesale_order_items i ON i.id=si.order_item_id WHERE s.business_date BETWEEN ? AND ? UNION ALL SELECT r.business_date,'印尼','线下分销',i.sku,-r.qty,'IDR',-r.amount,NULL FROM wholesale_returns r JOIN wholesale_order_items i ON i.id=r.order_item_id WHERE r.business_date BETWEEN ? AND ?`;
    args.push(from,to,from,to);
  }
  const measures='SUM(qty) qty,SUM(revenue) revenue,SUM(adCost) adCost,COUNT(*) records,SUM(CASE WHEN revenue IS NULL THEN 1 ELSE 0 END) revenueMissing,SUM(CASE WHEN adCost IS NULL THEN 1 ELSE 0 END) costMissing';
  const query=(dimensions,extra='')=>db.prepare(`SELECT ${dimensions},${measures}${extra} FROM (${source}) GROUP BY ${dimensions}`).bind(...args);
  // No LIMIT from the recent-import list: every non-reversed record in the selected period participates.
  const result=await db.batch([
    query('currency'),query('sku,currency'),query('site,channel,currency'),query('date,currency'),
    db.prepare(`SELECT x.sku,COALESCE(s.name,'') name,SUM(x.qty) qty,COUNT(DISTINCT x.site) siteCount FROM (${source}) x LEFT JOIN sku_settings s ON s.sku=x.sku GROUP BY x.sku ORDER BY qty DESC,x.sku`).bind(...args),
  ]);
  const [currencies,roi,scopes,daily,skus]=result.map(r=>r.results||[]);
  const currencyTotals=currencies.map(metrics).sort((a,b)=>a.currency.localeCompare(b.currency));
  const roiRows=roi.map(metrics).sort((a,b)=>(b.roas??-Infinity)-(a.roas??-Infinity)||(b.revenue??0)-(a.revenue??0)||a.sku.localeCompare(b.sku));
  const totalQty=skus.reduce((s,r)=>s+Number(r.qty),0);
  const rankings=skus.map((r,i)=>({...r,rank:i+1,share:totalQty>0?r.qty/totalQty:null}));
  return {filters,totalQty,skuCount:skus.filter(r=>r.qty>0).length,currencies:currencyTotals,skuRanking:rankings,roiRanking:roiRows,scopes:scopes.map(metrics).sort((a,b)=>b.qty-a.qty),daily:daily.map(metrics).sort((a,b)=>a.date.localeCompare(b.date)),generatedAt:new Date().toISOString()};
}
