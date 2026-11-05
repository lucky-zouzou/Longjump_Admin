import {financeRows as rows,financeClock} from './finance-periods.mjs';
import {completeSalesDates} from './sales-completeness.mjs';
import {evaluateZeroSales,localDay,shiftDay} from './promotion-model.mjs';
import {effectiveCost} from './effective-cost.mjs';
import {clearanceProgress} from './clearance-progress.mjs';
import {canClearance,clearanceSites,monthEnd,fail,round} from './clearance-model.mjs';
import {SITE_CURRENCIES} from './sales-data.mjs';

const key=r=>`${r.site}|${r.channel}`;
const groupBy=(list,fn)=>{const map=new Map();for(const r of list){const k=fn(r);if(!map.has(k))map.set(k,[]);map.get(k).push(r);}return map;};
const validStock=s=>!!s&&Number.isSafeInteger(s.qty)&&Number.isSafeInteger(s.reserved_qty)&&s.reserved_qty>=0&&s.qty>=s.reserved_qty;

// Candidate discovery is read-only. Both channels must have complete reports
// before a manager may call a SKU zero-selling across the whole country.
export async function readClearanceZeroSales(db,actor,month,now=new Date(),detail=/** @type {any} */(null),visit=/** @type {any} */(null)){
 if(!canClearance(actor))fail('当前账号无清仓权限',403);
 monthEnd(month);
 const operator=actor.role==='运营';
 if(operator&&(!clearanceSites.includes(actor.site)||!['TikTok','Shopee'].includes(actor.channel)))fail('运营账号尚未绑定有效站点和平台',403);
 const clock=await financeClock(db),from=shiftDay(localDay(now,'印尼'),-30),through=localDay(now,'马来西亚');
 const filter=operator?' AND site=? AND channel=?':'',args=operator?[actor.site,actor.channel]:[];
 const supported="site IN ('马来西亚','印尼','泰国','越南','菲律宾') AND channel IN ('TikTok','Shopee')";
 const [stocks,sales,imports,movements,availability,observations,costs,plans,promotions,users]=await Promise.all([
  rows(db,'SELECT *, (SELECT name FROM sku_settings s WHERE s.sku=inventory_balances.sku) AS name FROM inventory_balances WHERE '+supported+filter,args),
  rows(db,'SELECT * FROM sales_records WHERE '+supported+' AND business_date BETWEEN ? AND ?'+filter,[from,through,...args]),
  rows(db,'SELECT * FROM sales_imports WHERE '+supported+' AND business_date BETWEEN ? AND ?'+filter,[from,through,...args]),
  rows(db,`SELECT m.*,i.business_date FROM inventory_movements m JOIN sales_imports i ON i.id=m.reference_id AND i.site=m.site AND i.channel=m.channel WHERE m.reference_type IN ('销售导入','销售冲销') AND i.business_date BETWEEN ? AND ?${operator?' AND m.site=? AND m.channel=?':''}`,[from,through,...args]),
  rows(db,'SELECT * FROM promotion_availability WHERE '+supported+filter,args),
  rows(db,'SELECT * FROM promotion_stock_days WHERE '+supported+' AND day>=?'+filter,[from,...args]),
  rows(db,'SELECT * FROM product_cost_versions WHERE effective_date<=?'+(operator?' AND site=?':''),[through,...(operator?[actor.site]:[])]),
  rows(db,"SELECT id,month,site,channel,sku,status FROM clearance_lines WHERE status<>'cancelled' AND (month=? OR status='active')"+filter,[month,...args]),
  rows(db,"SELECT id,site,channel,sku,status FROM promotions WHERE status IN ('approved','active','stop_required','review_pending')"+filter,args),
  rows(db,"SELECT id,name,site,channel FROM users WHERE active=1 AND role='运营' AND "+supported+filter,args)
 ]);
 const sm=groupBy(sales,key),im=groupBy(imports,key),um=groupBy(users,key);
 const skuKey=r=>key(r)+"|"+r.sku;
 const bySku=groupBy(sales,skuKey),flowSku=groupBy(movements,skuKey),obsSku=groupBy(observations,skuKey),costSku=groupBy(costs,r=>r.site+"|"+r.sku),planSku=groupBy(plans,skuKey),promoSku=groupBy(promotions,skuKey),availSku=new Map(availability.map(r=>[skuKey(r),r]));
 const complete=new Map([...im].map(([k,rs])=>[k,completeSalesDates(rs,(sm.get(k)||[]).filter(r=>!r.reversed_at))]));
 const stockGroups=groupBy(stocks,r=>`${r.site}|${r.sku}`),result=[];let found=null;
 for(const [groupId,stockRows] of stockGroups){
  const first=stockRows[0],site=first.site,sku=first.sku;
  if(detail&&(site!==detail.site||sku!==detail.sku))continue;
  const today=localDay(now,site),cutoff=shiftDay(today,-1),start=shiftDay(cutoff,-6);
  const cost=effectiveCost(costSku.get(groupId)||[],site,sku,today),unitCny=cost?.total==null?null:cost.total/10000;
  const referenceCost=cost?{id:cost.id,version:cost.version,effectiveDate:cost.effective_date,basis:cost.basis,unitCny,complete:cost.basis==='landed'&&unitCny!=null}:null;
  const channels=(operator?[actor.channel]:['TikTok','Shopee']).map(channel=>{
   const scope={site,channel,sku},scopeKey=key(scope),stock=stockRows.find(s=>s.channel===channel),stockValid=validStock(stock);
   const sk=skuKey(scope),scopeSales=bySku.get(sk)||[],scopeImports=im.get(scopeKey)||[];
   const alert=evaluateZeroSales({stock:stock||{...scope,qty:0,reserved_qty:0},sales:scopeSales.filter(r=>r.sku===sku&&!r.reversed_at),completeDates:complete.get(scopeKey)||[],availability:availSku.get(sk),observations:obsSku.get(sk)||[]},now);
   const progress=clearanceProgress({...scope,started_on:start,data:{end:today,targetQty:1}},{sales:detail?(sm.get(scopeKey)||[]):scopeSales,imports:scopeImports,movements:flowSku.get(sk)||[],now});
   const available=stockValid?stock.qty-stock.reserved_qty:null,todayQty=scopeSales.filter(r=>r.sku===sku&&!r.reversed_at&&r.business_date===today&&r.qty>0).reduce((n,r)=>n+r.qty,0);
   const reportZero=alert.coverage===7&&alert.recent===0,plan=(planSku.get(sk)||[]).find(r=>r.month===month)||planSku.get(sk)?.[0];
   const promotion=promoSku.get(sk)?.[0];
   const row={...scope,currency:SITE_CURRENCIES[site],available,book:stock?.qty??null,reserved:stock?.reserved_qty??null,stockAt:stock?.updated_at||null,stockValid,reportZero,recentQty:alert.coverage===7?alert.recent:null,knownRecentQty:alert.recent,todayQty,coverage:alert.coverage,missing:alert.missing,zeroDays:alert.zeroDays,historyVerified:alert.status==='open',reasons:alert.reasons,stockMatched:progress.stockMatched,netDeductedQty:progress.netDeductedQty,plan:plan||null,promotion:promotion||null,owners:um.get(scopeKey)||[],
    canApply:reportZero&&todayQty===0&&stockValid&&available>0&&progress.stockMatched&&!plan&&!promotion};
   if(detail?.channel===channel)found={...row,name:first.name||sku,start,cutoff,today,referenceCost,progress,generatedAt:now.toISOString()};
   return row;
  });
  const knownAvailable=channels.reduce((n,c)=>n+(c.available??0),0);
  if(!knownAvailable&&channels.every(c=>c.stockValid))continue;
  const allReports=channels.every(c=>c.coverage===7),knownRecentQty=channels.reduce((n,c)=>n+c.knownRecentQty,0),todayQty=channels.reduce((n,c)=>n+c.todayQty,0);
  const reportZero=allReports&&knownRecentQty===0,stockKnown=channels.every(c=>c.stockValid),matched=channels.every(c=>c.stockMatched);
  const verified=reportZero&&stockKnown&&matched&&channels.filter(c=>c.available>0).every(c=>c.historyVerified);
  const status=reportZero&&todayQty>0?'recovering':knownRecentQty>0?(channels.some(c=>c.reportZero&&c.available>0)?'channel_zero':'selling'):!allReports||!stockKnown||!matched?'pending':verified?'zero':'verify';
  (visit||((row)=>result.push(row)))({id:groupId,site,sku,name:first.name||sku,start,cutoff,today,channels,knownAvailable,available:stockKnown?knownAvailable:null,stockKnown,stockMatched:matched,reportZero,status,knownRecentQty,recentQty:allReports?knownRecentQty:null,todayQty,referenceCost,knownValueCny:unitCny==null?null:round(knownAvailable*unitCny)});
 }
 if(clock!==await financeClock(db))fail('读取期间销量、库存或成本已变化，请刷新后核对',409);
 if(detail){if(!found)fail('商品不存在或不在权限范围',404);return found;}
 const priority={zero:0,verify:1,pending:2,channel_zero:3,recovering:4,selling:5};
 result.sort((a,b)=>priority[a.status]-priority[b.status]||(b.knownValueCny??-1)-(a.knownValueCny??-1)||b.knownAvailable-a.knownAvailable||a.id.localeCompare(b.id));
 const sites=operator?[actor.site]:clearanceSites;
 return {scope:operator?'channel':'site',generatedAt:now.toISOString(),month,items:result,sites:sites.map(site=>{
  const group=result.filter(r=>r.site===site),zero=group.filter(r=>['zero','verify'].includes(r.status));
  return {site,start:shiftDay(localDay(now,site),-7),cutoff:shiftDay(localDay(now,site),-1),zeroSkus:zero.length,confirmedSkus:zero.filter(r=>r.status==='zero').length,pendingSkus:group.filter(r=>r.status==='pending').length,recoveringSkus:group.filter(r=>r.status==='recovering').length,available:zero.reduce((n,r)=>n+r.knownAvailable,0),knownValueCny:round(zero.reduce((n,r)=>n+(r.knownValueCny??0),0)),missingCosts:zero.filter(r=>r.referenceCost?.unitCny==null).length};})};
}
