import {financeRows as rows,financialRates,financeClock} from './finance-periods.mjs';
import {financeDays,digest,financeDaySummary} from './business-action-finance.mjs';
import {costContext} from './cost-source-context.mjs';
import {effectiveCost} from './effective-cost.mjs';
import {SITE_CURRENCIES} from './sales-data.mjs';
import {shiftDay} from './promotion-model.mjs';
import {clearanceProgress} from './clearance-progress.mjs';
import {canClearance,clearanceScope,clearanceSites,dates,periods,ownerOn,summarizeDays,monthEnd,localDay,round,fail} from './clearance-model.mjs';
export const unpack=r=>({...r,data:JSON.parse(r.data_json)});
export async function clearanceLine(db,a,id){if(!canClearance(a))fail('当前账号无清仓权限',403);const r=await db.prepare('SELECT * FROM clearance_lines WHERE id=?').bind(id).first();if(!r||!clearanceScope(a,r))fail('记录不存在或不在权限范围',404);return unpack(r);}
export async function clearanceEvidence(db,lines,now=new Date()){
 if(!lines.length)return [];
 const month=lines[0].month,from=month+'-01',to=monthEnd(month),clock=await financeClock(db),context=await costContext(db);
 const [allSales,allImports,ads,afters,entries,stocks,rawEvents,reviews,rates,movements]=await Promise.all([
  rows(db,'SELECT id,import_id,site,channel,sku,business_date,qty,currency,reported_amount,ad_cost,reversed_at FROM sales_records WHERE business_date BETWEEN ? AND ? ORDER BY id',[from,to]),
  rows(db,'SELECT id,site,channel,business_date,report_kind,source_batch_ref,file_name,created_at,reversed_at FROM sales_imports WHERE business_date BETWEEN ? AND ? ORDER BY id',[from,to]),
  rows(db,'SELECT * FROM sales_ad_spend WHERE business_date BETWEEN ? AND ? ORDER BY id',[from,to]),
  rows(db,"SELECT id,site,channel,sku,business_date,status,version,data_json FROM after_sales WHERE record_kind='after_sale' AND status NOT IN ('draft','void') AND business_date BETWEEN ? AND ? ORDER BY id",[from,to]),
  rows(db,'SELECT * FROM business_action_finance_days WHERE business_date BETWEEN ? AND ? ORDER BY business_date,revision DESC',[from,to]),
  rows(db,'SELECT * FROM inventory_balances'),rows(db,'SELECT e.*,u.name actor_name FROM clearance_events e LEFT JOIN users u ON e.actor_id=u.id JOIN clearance_lines l ON l.id=e.line_id WHERE l.month=? ORDER BY e.created_at,e.id',[month]),
  rows(db,'SELECT r.* FROM clearance_reviews r JOIN clearance_lines l ON l.id=r.line_id WHERE l.month=? ORDER BY r.revision DESC',[month]),financialRates(db,month),
  rows(db,`SELECT m.*,i.business_date FROM inventory_movements m JOIN sales_imports i ON i.id=m.reference_id AND i.site=m.site AND i.channel=m.channel
   WHERE m.reference_type IN ('销售导入','销售冲销') AND i.business_date BETWEEN ? AND ?
   AND EXISTS(SELECT 1 FROM clearance_lines l WHERE l.month=? AND l.site=m.site AND l.channel=m.channel AND l.sku=m.sku) ORDER BY m.created_at,m.id`,[from,to,month])
 ]);
 // Keep the shared finance basis shape stable; audit-only fields must not
 // invalidate previously confirmed daily cost evidence.
 const sales=allSales.filter(r=>!r.reversed_at).map(({reversed_at,...r})=>r),imports=allImports.filter(r=>!r.reversed_at);
 const results=[];
 for(const line of lines){
  const scope=r=>r.site===line.site&&r.channel===line.channel,own=r=>scope(r)&&r.sku===line.sku;
  const stock=stocks.find(own),available=stock&&Number.isSafeInteger(stock.qty)&&stock.qty>=Number(stock.reserved_qty||0)&&Number(stock.reserved_qty||0)>=0?stock.qty-Number(stock.reserved_qty||0):null;
  const events=rawEvents.filter(e=>e.line_id===line.id).map(e=>({...e,detail:JSON.parse(e.detail_json)}));
  const cutoff=[line.ended_on||line.data.end,shiftDay(localDay(now,line.site),-1)].sort()[0],dd=line.started_on?dates(line.started_on,cutoff):[];
  const ds=await financeDays({dates:dd,site:line.site,channel:line.channel,sku:line.sku,sales:sales.filter(own),scopeSales:sales.filter(scope),imports:imports.filter(scope),ads:ads.filter(scope),afters:afters.filter(own),entries:entries.filter(own),scopeEntries:entries.filter(scope),context});
  for(const d of ds)if(d.status==='confirmed'&&!Number.isFinite(d.costs?.other))d.status='additional_pending';
  const currency=SITE_CURRENCIES[line.site],rate=rates[currency],summary=summarizeDays(ds,rate),windows=[];
  for(const period of line.started_on?periods(line.started_on,line.ended_on||line.data.end):[]){
   const windowDays=ds.filter(d=>d.date>=period.from&&d.date<=period.to),windowSummary=summarizeDays(windowDays,rate);
   const evidenceHash=await digest({period,days:windowDays.map(d=>({date:d.date,basis:d.basisHash,status:d.status,revision:d.revision,costs:d.costs})),rate:rate?.id||null,assignments:events.filter(e=>e.action==='assign').map(e=>({date:e.business_date,detail:e.detail}))});
   const review=reviews.find(r=>r.line_id===line.id&&r.period_end===period.to);
   windows.push({...period,...windowSummary,dailyEvidence:windowDays.map(d=>({date:d.date,basisHash:d.basisHash,revision:d.revision,status:d.status,costs:d.costs,source:d.source})),evidenceHash,ready:period.to<=cutoff,review:review?{...review,snapshot:JSON.parse(review.snapshot_json),stale:review.evidence_hash!==evidenceHash}:null});
  }
  const contributions=[...new Set(ds.map(d=>ownerOn(line,events,d.date)))].map(ownerId=>({ownerId,...summarizeDays(ds.filter(d=>ownerOn(line,events,d.date)===ownerId),rate)}));
  const product=effectiveCost(context.products,line.site,line.sku,localDay(now,line.site)),unitCny=product?.total==null?null:product.total/10000;
  const finance=line.data.finance,alerts=[];
  const progress=clearanceProgress(line,{sales:allSales,imports:allImports,movements,now});
  if(available==null)alerts.push('当前库存缺失或异常，先核对');
  if(!progress.stockMatched)alerts.push('日报销量与扣库流水不一致，请核对具体批次，不要再次扣库');
  if(progress.overlapDays.length)alerts.push('存在重叠日报，清仓完成率待核实');
  if(summary.missingSales.length)alerts.push(`缺少 ${summary.missingSales.length} 天完整销售／金额`);
  if(summary.pendingFinance.length)alerts.push(`${summary.pendingFinance.length} 天成本待核实`);
  if(!rate)alerts.push('本月财务汇率未核定，不能汇总人民币损益');
  if(finance&&summary.knownSupportSpend>finance.supportBudget)alerts.push('已核实广告及其他直接费用超过支持预算，请停止追加并复审');
  if(finance&&summary.netLoss!=null&&summary.netLoss>finance.lossLimit)alerts.push('实际净亏损超过批准上限，请停止优惠并复审');
  if(line.status==='completed'&&(summary.profit==null||windows.some(w=>w.review?.stale)))alerts.push('结案依据已变化，须重新核算复盘并确认结案');
  if(line.status==='active'&&!line.ended_on&&line.data.end<localDay(now,line.site))alerts.push('计划已到期，请登记停止平台优惠并核清费用');
  if(windows.some(w=>w.ready&&(!w.review||w.review.stale)))alerts.push('7天复盘待处理');
  results.push({...line,currency,events,days:ds.map(financeDaySummary),summary,progress,windows,contributions,alerts,stock:{available,qty:stock?.qty??null,reserved:stock?.reserved_qty??null,at:stock?.updated_at||null},
   referenceCost:product?{id:product.id,version:product.version,basis:product.basis,unitCny}:null,rate:rate||null,
   targetRemaining:summary.completeDays===summary.days?Math.max(0,line.data.targetQty-summary.qty):null,estimate:unitCny!=null&&rate&&summary.revenue!=null?{productMarginCny:round(summary.revenue*rate.rate-summary.qty*unitCny),label:'销售额减参考商品成本，尚未扣齐广告、平台、履约等费用'}:null});
 }
 if(clock!==await financeClock(db))fail('读取期间销售或核算依据发生变化，请刷新',409);
 return results;
}
export async function readClearance(db,a,month,now=new Date()){
 if(!canClearance(a))fail('当前账号无清仓权限',403);monthEnd(month);
 const lines=(await rows(db,'SELECT * FROM clearance_lines WHERE month=? ORDER BY site,channel,sku',[month])).filter(r=>clearanceScope(a,r)).map(unpack);
 const [items,users,skus]=await Promise.all([clearanceEvidence(db,lines,now),rows(db,"SELECT id,name,role,site,channel FROM users WHERE active=1 AND role IN ('运营','管理员','财务','运营主管')"),rows(db,'SELECT sku,name FROM sku_settings ORDER BY sku')]);
 const sites=a.role==='运营'?[a.site].filter(s=>clearanceSites.includes(s)):clearanceSites;
 return {actor:{id:a.id,name:a.name,role:a.role,site:a.site,channel:a.channel},month,items,sites,skus,
  users:users.filter(u=>a.role!=='运营'||u.id===a.id||u.role==='运营'&&u.site===a.site&&u.channel===a.channel),generatedAt:now.toISOString(),
  coverage:sites.map(site=>({site,lines:items.filter(r=>r.site===site&&r.status!=='cancelled').length,active:items.filter(r=>r.site===site&&r.status==='active').length,pending:items.filter(r=>r.site===site&&r.windows.some(w=>w.ready&&(!w.review||w.review.stale))).length}))};
}
