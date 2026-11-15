import {COST_SITES,fail} from './product-cost-model.mjs';
import {SITE_CHANNELS} from './site-product-classification.mjs';
import {localDay,shiftDay} from './promotion-model.mjs';
import {financeRows as rows,financeClock} from './finance-periods.mjs';
import {costViewContribution} from './cost-view-contribution.mjs';
import {loadWholesaleExportSnapshot} from './wholesale-export.mjs';
import {seriesBooks} from './series-finance.mjs';
import {navigationForRole} from './permissions.mjs';
import {productionStageLabel} from './production-workflow.mjs';
import {loadTransitLots} from './transit-stock.mjs';
import {offlineSalesSql} from './sales-window.mjs';
import {effectiveCost} from './effective-cost.mjs';
import {profileMissing} from './product-information-model.mjs';

const seriesSkus='SELECT sku FROM sku_settings WHERE product_series=?';
const key=(...parts)=>JSON.stringify(parts);

async function requireManagement(db,actor){
 if(!actor||!['管理员','财务'].includes(actor.role))fail('跨站款式档案限管理员和财务查看',403);
 const live=await db.prepare('SELECT role,active FROM users WHERE id=?').bind(actor.id).first();
 if(!live?.active||live.role!==actor.role)fail('账号权限已变化，请重新登录',403);
}

// A complete report covers absent SKU rows. An overlapping import invalidates
// the whole platform-day, including styles outside the conflicting SKU.
async function salesCoverage(db,start,end){
 return rows(db,`SELECT DISTINCT site,channel,business_date FROM sales_imports
 WHERE reversed_at IS NULL AND report_kind IN ('complete','zero') AND business_date BETWEEN ? AND ?
 EXCEPT SELECT site,channel,business_date FROM sales_records
 WHERE reversed_at IS NULL AND qty>0 AND business_date BETWEEN ? AND ?
 GROUP BY site,channel,business_date,sku HAVING COUNT(DISTINCT import_id)>1`,[start,end,start,end]);
}
function siteMetrics(site,{sales,balances,costs,lots,covered},now){
 const today=localDay(now,site),cutoff=shiftDay(today,-1);
 const dates=Array.from({length:28},(_,i)=>shiftDay(cutoff,i-27));
 const siteSales=sales.filter(r=>r.site===site&&r.business_date>=dates[0]&&r.business_date<=cutoff);
 const stock=balances.filter(r=>r.site===site),inTransit=lots.filter(r=>r.site===site);
 const bySku=new Map();
 for(const {sku} of [...siteSales,...stock,...inTransit]){
  if(!bySku.has(sku))bySku.set(sku,{sku,week:0,fourWeeks:0,available:null,knownStock:0,transit:0,inventoryValueCny:null,missingCost:0});
 }
 const channels=SITE_CHANNELS.map(channel=>{
  const reports=dates.filter(day=>covered.has(key(site,channel,day)));
  const week={days:7,completeDays:reports.filter(day=>day>=dates[21]).length,qty:0};
  const fourWeeks={days:28,completeDays:reports.length,qty:0};
  for(const r of siteSales){
   if(r.channel!==channel||!covered.has(key(site,channel,r.business_date)))continue;
   const item=bySku.get(r.sku);
   item.fourWeeks+=r.qty;fourWeeks.qty+=r.qty;
   if(r.business_date>=dates[21]){item.week+=r.qty;week.qty+=r.qty;}
  }
  return {channel,week:{...week,qty:week.completeDays?week.qty:null},fourWeeks:{...fourWeeks,qty:fourWeeks.completeDays?fourWeeks.qty:null}};
 });
 const costsBySku=new Map();
 for(const cost of costs.filter(r=>r.site===site)){
  if(!costsBySku.has(cost.sku))costsBySku.set(cost.sku,[]);
  costsBySku.get(cost.sku).push(cost);
 }
 for(const {sku,qty,reserved_qty:reserved} of stock){
  if(!Number.isSafeInteger(qty)||!Number.isSafeInteger(reserved)||reserved<0||qty<reserved)continue;
  const item=bySku.get(sku),units=qty-reserved;
  item.knownStock++;item.available=(item.available??0)+units;
  const cost=effectiveCost(costsBySku.get(sku)||[],site,sku,today);
  if(units===0||cost?.basis==='landed'&&cost.total!=null){
   item.inventoryValueCny=(item.inventoryValueCny??0)+units*(cost?.total||0)/10000;
  }else item.missingCost++;
 }
 for(const lot of inTransit)bySku.get(lot.sku).transit+=lot.qty;
 const hasWeek=channels.some(c=>c.week.completeDays),hasFourWeeks=channels.some(c=>c.fourWeeks.completeDays);
 const variants=[...bySku.values()].map(({knownStock,...r})=>({...r,week:hasWeek?r.week:null,fourWeeks:hasFourWeeks?r.fourWeeks:null,missingStock:SITE_CHANNELS.length-knownStock})).sort((a,b)=>a.sku.localeCompare(b.sku));
 const sumKnown=field=>{
  const present=variants.filter(row=>row[field]!=null);
  return present.length?present.reduce((n,r)=>n+r[field],0):null;
 };
 return {site,start:dates[0],cutoff,channels,variants,available:sumKnown('available'),inventoryValueCny:sumKnown('inventoryValueCny'),
  missingStock:sumKnown('missingStock')??0,missingCost:sumKnown('missingCost')??0,transit:sumKnown('transit')??0};
}

export async function readStyleOperations(db,actor,query={},now=new Date()){
 await requireManagement(db,actor);
 if(query.view==='finance-history')return financeHistory(db,query.month);
 const options=await rows(db,"SELECT product_series name,COUNT(*) qty FROM sku_settings WHERE trim(product_series) NOT IN ('','待归类') GROUP BY product_series ORDER BY product_series");
 const requested=query.series,series=requested??(options.find(o=>o.name==='H001')||options[0])?.name;
 if(!series&&!requested&&!options.length)return {options,series:null};
 if(typeof series!=='string'||!options.some(o=>o.name===series))fail('商品主数据中没有这个系列',404);
 if(query.view==='finance')return styleFinance(db,actor,series,now);
 const start=shiftDay(localDay(now,'印尼'),-28),end=shiftDay(localDay(now,'菲律宾'),-1);
 const allowed=navigationForRole(actor.role);
 const manufacturing=allowed.includes('fulfillment')&&allowed.includes('batches');
 const sourceRows=(sql,args)=>manufacturing?rows(db,sql,args):Promise.resolve([]);
 const [profiles,balances,sales,reports,costs,lots,production,purchases,notices,legs,issues,offline]=await Promise.all([
  rows(db,`SELECT s.sku,s.name,s.factory_name,p.version,p.actor_name,p.data_json FROM sku_settings s LEFT JOIN product_profiles p ON p.sku=s.sku WHERE s.product_series=? ORDER BY s.sku`,[series]),
  rows(db,`SELECT sku,site,channel,qty,reserved_qty FROM inventory_balances WHERE sku IN (${seriesSkus}) AND channel IN ('TikTok','Shopee')`,[series]),
  rows(db,`SELECT sku,site,channel,business_date,SUM(qty) qty FROM sales_records WHERE sku IN (${seriesSkus}) AND channel IN ('TikTok','Shopee') AND reversed_at IS NULL AND business_date BETWEEN ? AND ? GROUP BY sku,site,channel,business_date`,[series,start,end]),
  salesCoverage(db,start,end),
  rows(db,`SELECT sku,site,total,basis,version,effective_date FROM product_cost_versions WHERE sku IN (${seriesSkus}) AND currency='CNY'`,[series]),
  loadTransitLots(db,series),
  rows(db,`SELECT p.id,p.month,p.factory_name,p.status,p.qc_status,p.promised_completion_date,
   SUM(i.planned_qty) planned,SUM(i.produced_qty) produced FROM series_production_order_items i
   JOIN series_production_orders p ON p.id=i.production_order_id WHERE i.sku IN (${seriesSkus})
   GROUP BY p.id ORDER BY p.updated_at DESC,p.id`,[series]),
  sourceRows(`SELECT o.id,o.order_ref,o.month,o.supplier_name,p.promised_completion_date,p.qc_status,u.name owner,SUM(i.ordered_qty) qty
   FROM series_purchase_order_items i JOIN series_purchase_orders o ON o.id=i.purchase_order_id
   LEFT JOIN series_production_orders p ON p.purchase_order_id=o.id LEFT JOIN users u ON u.id=p.assigned_user_id
   WHERE i.sku IN (${seriesSkus}) GROUP BY o.id ORDER BY o.created_at DESC,o.id DESC`,[series]),
  sourceRows(`SELECT n.notice_no,n.purchase_order_id,n.packing_no,n.transport_batch_id,b.batch_no,n.site,n.channel,n.approval_status,n.status,
    u.name owner,json_extract(item.value,'$.sku') sku,json_extract(item.value,'$.qty') qty,json_extract(item.value,'$.profileVersion') profileVersion
   FROM factory_dispatch_notices n JOIN json_each(n.items_json) item
   LEFT JOIN transport_batches b ON b.id=n.transport_batch_id LEFT JOIN users u ON u.id=n.supply_user_id
   WHERE json_extract(item.value,'$.sku') IN (${seriesSkus}) ORDER BY n.created_at DESC,n.notice_no,sku`,[series]),
  sourceRows(`SELECT l.id,l.batch_id,l.leg_no,l.site,l.channel,l.stage,l.eta,l.stage_owner,u.name owner,SUM(i.qty) qty,SUM(i.received_qty) received
   FROM transport_leg_items i JOIN transport_legs l ON l.id=i.leg_id LEFT JOIN users u ON u.id=l.assigned_user_id
   WHERE i.sku IN (${seriesSkus}) GROUP BY l.id ORDER BY l.updated_at DESC,l.id DESC`,[series]),
  rows(db,`SELECT id,case_no,record_kind,sku,site,channel,business_date,owner_name,data_json FROM after_sales
   WHERE sku IN (${seriesSkus}) AND status NOT IN ('draft','void') AND business_date BETWEEN ? AND ?
   ORDER BY business_date DESC,case_no,sku`,[series,start,end]),
  rows(db,`SELECT date,SUM(qty) qty FROM (${offlineSalesSql}) WHERE sku IN (${seriesSkus}) GROUP BY date`,
   [start,end,start,end,start,end,series])
 ]);
 const covered=new Set(reports.map(r=>key(r.site,r.channel,r.business_date)));
 const sites=COST_SITES.map(site=>siteMetrics(site,{sales,balances,costs,lots,covered},now));
 const currentIssues=issues.filter(r=>{const cutoff=shiftDay(localDay(now,r.site),-1);return r.business_date<=cutoff&&r.business_date>=shiftDay(cutoff,-27)});
 const cases=currentIssues.map(({data_json,...record})=>{
  const d=JSON.parse(data_json),fix=d.rectification;
  return {...record,reason:d.reason,qty:d.qty,factory:d.factoryName||d.factory,
   owner:fix?.ownerName||record.owner_name,validationBatch:fix?.validationBatch||'',reviewDate:fix?.reviewDate||'',outcome:fix?.outcome||'',
   responsibility:d.responsibility,currency:d.currency,claim:d.responsibility==='工厂'?d.claimCents:null,
   paid:d.responsibility==='工厂'?(d.payments||[]).filter(p=>!p.reversed).reduce((n,p)=>n+p.amountCents,0):null};
 });
 const ranked=new Map();
 for(const r of cases.filter(r=>r.record_kind==='quality'||r.reason==='商品质量问题')){
  const reason=r.reason||'原因待核实',item=ranked.get(reason)||{reason,count:0,qty:0};
  item.count++;item.qty+=r.qty;ranked.set(reason,item);
 }
 const idCutoff=shiftDay(localDay(now,'印尼'),-1);
 const offlineNet=days=>offline.filter(r=>r.date>=shiftDay(idCutoff,1-days)&&r.date<=idCutoff).reduce((n,r)=>n+r.qty,0);
 return {series,options,sites,manufacturing,production:production.map(p=>({...p,stageLabel:productionStageLabel(p)})),purchases,notices,legs,cases,offline:{week:offlineNet(7),fourWeeks:offlineNet(28),cutoff:idCutoff},ranking:[...ranked.values()].sort((a,b)=>b.qty-a.qty||b.count-a.count),
  profiles:profiles.map(({data_json,...r})=>{const data=JSON.parse(data_json||'{}');return {...r,material:data.material,cartonQty:data.cartonQty,missing:profileMissing(data).length};})};
}

async function styleFinance(db,actor,series,now){
 const asOf=localDay(now,'印尼'),from=asOf.slice(0,7)+'-01',month=asOf.slice(0,7);
 const version=await financeClock(db);
 const frozen=await db.prepare(`SELECT status,json_extract(snapshot_json,'$.seriesFinance') books FROM finance_period_events WHERE month=? ORDER BY revision DESC LIMIT 1`).bind(month).first();
 if(frozen?.status==='closed'){
  const books=JSON.parse(frozen.books||'[]');
  const book=books.find(b=>b.series===series);
  return book?{...book,from,asOf:book.asOf,frozen:true}:{series,unavailable:true};
 }
 const [skuRows,wholesale]=await Promise.all([
  rows(db,seriesSkus,[series]),loadWholesaleExportSnapshot(db,actor,series)
 ]);
 const skus=new Set(skuRows.map(r=>r.sku));
 const contribution=await costViewContribution(db,actor,{from,to:asOf},[],skus);
 const [book]=seriesBooks(skuRows.map(r=>({...r,product_series:series})),[],wholesale.orders,from,asOf);
 if(await financeClock(db)!==version)fail('财务数据已更新，请重新读取',409);
 if(!book)fail('系列归属已更新，请重新读取',409);
 return {...book,confirmedCny:contribution.confirmed==null?null:contribution.confirmed/100,covered:contribution.covered,pending:contribution.pending};
}

async function financeHistory(db,requested){
 const months=(await rows(db,`SELECT e.month FROM finance_period_events e WHERE status='closed'
  AND revision=(SELECT MAX(x.revision) FROM finance_period_events x WHERE x.month=e.month) ORDER BY month DESC`)).map(r=>r.month);
 const month=requested??months[0];
 if(!month)return {months,month:null,books:null};
 if(!months.includes(month))fail('请选择已关账月份',400);
 const snapshot=await db.prepare(`SELECT status,json_extract(snapshot_json,'$.seriesFinance') books
  FROM finance_period_events WHERE month=? ORDER BY revision DESC LIMIT 1`).bind(month).first();
 if(snapshot?.status!=='closed')fail('关账状态已变更，请刷新',409);
 return {month,months,books:snapshot.books?JSON.parse(snapshot.books):null};
}
