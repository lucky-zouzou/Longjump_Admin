import {completeSalesDates} from './sales-completeness.mjs';
import {localDay,shiftDay,validDay} from './promotion-model.mjs';
import {transitLots} from './transit-stock.mjs';

// These are review thresholds for the pilot, not spending authority or company KPIs.
export const operatingPilotDefaults={stockCoverDays:3,adIncreasePct:50,refundCaseCount:3};
const array=v=>Array.isArray(v)?v:[];
const number=v=>v!==null&&v!==undefined&&v!==''&&Number.isFinite(Number(v))?Number(v):null;
const round=n=>Math.round((n+Number.EPSILON)*100)/100;
const text=v=>String(v??'').trim();
const key=(config,kind,entity='')=>JSON.stringify(['operating',config.shopId,kind,entity]);
const evidence=(label,value,source,url,at)=>({label,value,source,...(url?{url}:{}),...(at?{at}:{})});
const read=async(db,sql,args=[])=>array((await db.prepare(sql).bind(...args).all()).results);
const parse=v=>{try{return JSON.parse(v)}catch{return {}}};
const sameShop=(r,config)=>r.shopId===config.shopId&&r.site==='印尼'&&r.channel==='TikTok';
const current=r=>!r.reversed_at&&!r.deleted_at;

export function operatingScopeConfirmed(config,now=new Date()){
 return Boolean(text(config.shopId)&&config.site==='印尼'&&config.channel==='TikTok'&&config.scopeMode==='exclusive_site_channel'&&config.scopeVerified===true&&(!config.scopeVerifiedUntil||Date.parse(config.scopeVerifiedUntil)>+now));
}

function responsible(data,config,role){
 const id=role==='供应链'?config.supplyOwnerId:config.operatorId;
 const user=array(data.users).find(u=>u.id===id&&u.active!==0&&u.role===role&&(role!=='运营'||u.site==='印尼'&&u.channel==='TikTok'));
 return {ownerId:user?.id||null,ownerName:user?.name||'待指定',ownerRole:role};
}

/**
 * Pure daily evaluation. Every accepted row carries the single confirmed shopId.
 * A missing/unknown result never proves an old issue resolved. Callers may close
 * a task only on an explicit `clear` result for its stable key.
 */
export function evaluateOperatingPilot(data={},config={},now=new Date()){
 const today=localDay(now,'印尼'),cutoff=shiftDay(today,-1),days=Array.from({length:7},(_,i)=>shiftDay(cutoff,i-6));
 const previousStart=shiftDay(days[0],-7),findings=[];
 const metrics={today,cutoff,from:days[0],shopId:config.shopId||null,shopName:config.shopName||'',salesQty:null,adSpend:[],refundOrdersObserved:null,inventory:[]};
 const coverage={scopeVerified:false,complete:false,checks:{reports:false,stock:false,ads:false,refunds:false},reason:''};
 const finding=(kind,entity,state,title,items,impact,role='运营',priority='medium')=>({key:key(config,kind,entity),kind,title,evidence:items,impact,...responsible(data,config,role),reviewDate:shiftDay(today,1),priority,state});
 if(!operatingScopeConfirmed(config,now)||data.scopeVerified!==true||data.scopeInvalidReason){
  coverage.reason=data.scopeInvalidReason||'单店归属尚未确认；现有经营台账按印尼 / TikTok 汇总，不能当作一家店的数据。';
  findings.push(finding('scope','', 'unknown','先核对试点店铺的数据归属',[evidence('店铺',config.shopName||'待指定','试点配置'),evidence('数据粒度','历史经营台账为站点＋平台；未按录入人猜测店铺','sales_imports / sales_ad_spend / inventory_balances')],coverage.reason));
  return {findings,metrics,coverage};
 }
 coverage.scopeVerified=true;
 findings.push(finding('scope','','clear','试点店铺数据归属已确认',[evidence('店铺',config.shopName||config.shopId,'已确认的单店试点配置')],'仅对这家店的经营来源巡检，确认范围变化时暂停结论。'));
 const take=rows=>array(rows).filter(r=>sameShop(r,config)&&current(r));
 const imports=take(data.imports),sales=take(data.sales),ads=take(data.ads),stocks=take(data.stocks),arrivals=take(data.arrivals),refunds=take(data.refunds).filter(r=>!['draft','void'].includes(r.status));
 const complete=new Set(completeSalesDates(imports,sales)),missing=days.filter(d=>!complete.has(d)),latestReports=imports.filter(r=>days.includes(r.business_date));
 coverage.checks.reports=missing.length===0;
 metrics.salesQty=missing.length?null:sales.filter(r=>days.includes(r.business_date)&&r.qty>0).reduce((n,r)=>n+Number(r.qty),0);
 const reportEvidence=[evidence('营业日期',`${days[0]} 至 ${cutoff}（Asia/Jakarta，今天未计入）`,'印尼营业日'),evidence('完整日报',`${7-missing.length}/7 天；缺 ${missing.join('、')||'无'}`,'sales_imports.report_kind + sales_records 重叠校验','/?page=sales'),evidence('导入依据',latestReports.map(r=>`${r.id}：${r.report_kind}`).join('；')||'没有完整日报来源','sales_imports')];
 findings.push(finding('missing_report','',missing.length?'active':'clear',missing.length?'补齐已结束营业日的销售日报':'近7天销售日报完整',reportEvidence,missing.length?'缺报日期不按零销量处理；库存可售天数及经营判断暂不完整。':'可以使用这7天的销量作为巡检参考；不代表所有财务数据已核实。'));

 const thresholds={...operatingPilotDefaults,...config.thresholds};
 const stockThreshold=number(thresholds.stockCoverDays),adThreshold=number(thresholds.adIncreasePct),refundThreshold=number(thresholds.refundCaseCount);
 const skus=[...new Set(array(config.prioritySkus).map(text).filter(Boolean))];
 let stockComplete=skus.length>0;
 if(!skus.length)findings.push(finding('priority_skus','','unknown','先圈定主推款',[evidence('重点SKU','尚未配置；没有自动把全店商品当作主推款','试点配置')],'主推款名单确认后才做库存预警；供应链和运营可以据此核对重点商品。','供应链'));
 else findings.push(finding('priority_skus','','clear','重点SKU名单已配置',[evidence('重点SKU',skus.join('、'),'试点配置')],'按已配置名单逐款检查库存。','供应链'));
 for(const sku of skus){
  const row=stocks.find(r=>r.sku===sku),qty=number(row?.qty),reserved=number(row?.reserved_qty),available=qty==null||reserved==null?null:qty-reserved;
  const qty7=sales.filter(r=>r.sku===sku&&days.includes(r.business_date)&&r.qty>0).reduce((n,r)=>n+Number(r.qty),0),daily=missing.length?null:qty7/7;
  const inbound=arrivals.filter(r=>r.sku===sku&&number(r.qty)>0),dated=inbound.filter(r=>validDay(r.eta)&&r.eta>=today),unknown=inbound.filter(r=>!validDay(r.eta)||r.eta<today);
  const unknownQty=unknown.reduce((n,r)=>n+Number(r.qty),0),cover=daily>0&&available!=null?available/daily:null;
  let shortfallDate=null;
  const valid=available!=null&&available>=0&&daily!=null&&stockThreshold!=null&&stockThreshold>=0&&stockThreshold<=60;
  if(valid&&daily>0){
   let stock=available;
   for(let offset=0;offset<=Math.ceil(stockThreshold);offset++){
    const day=shiftDay(today,offset);
    // ETA is only an estimate: do not make same-day receipts available at midnight.
    if(stock<daily-1e-8){shortfallDate=day;break;}
    stock-=daily;stock+=dated.filter(r=>r.eta===day).reduce((n,r)=>n+Number(r.qty),0);
   }
  }
  const state=!valid?'unknown':shortfallDate?'active':unknownQty?'unknown':'clear';
  if(state==='unknown')stockComplete=false;
  metrics.inventory.push({sku,available,averageDailySales:daily==null?null:round(daily),stockOnlyCoverDays:cover==null?null:round(cover),firstShortageDate:shortfallDate,undatedArrivalQty:unknownQty});
  const items=[evidence('可售库存',available==null?'待核实':`${available} 件（库存 ${qty}－预留 ${reserved}；待上架、隔离未算可售）`,row?'inventory_balances:'+sku:'inventory_balances 缺记录','/?page=suggestions',row?.updated_at),evidence('日销依据',daily==null?`近7天缺 ${missing.length} 份完整日报，未计算日均`:`${qty7} 件 ÷ 7 个完整营业日 = ${round(daily)} 件/天`,'sales_records / sales_imports','/?page=sales'),evidence('在途到仓',inbound.length?inbound.map(r=>`${r.source||r.id||'在途批次'}：${r.qty} 件，${validDay(r.eta)?r.eta:'日期未确认'}${validDay(r.eta)&&r.eta<today?'（已过期）':''}`).join('；'):'没有登记在途批次；不等于已确认无需补货','运输台账 ETA','/?page=batches'),evidence('试点提醒阈值',`${stockThreshold??'待配置'} 天；维持近7天日均的情景，未预设大促增长`,'试点配置')];
  const impact=!valid?'库存或完整日销量不足，先补齐证据，不能给出确定断货日期。':shortfallDate?`按当前日均和登记到仓日的保守情景，${shortfallDate} 起可能出现缺口${unknownQty?`；另有 ${unknownQty} 件缺有效到仓日，未抵减缺口`:''}。请供应链核实批次和交期，再由业务决定是否调整。`:unknownQty?`${unknownQty} 件在途到仓时间待核实，当前不能确认供应安全。`:daily===0?'近7天完整日报为零销量，暂不计算可售天数。':'在当前试点观察范围内未出现缺口；ETA仍需按实际到货复查。';
  findings.push(finding('stockout',sku,state,`${sku}：${state==='active'?'到货前可能缺货':state==='unknown'?'库存依据待核实':'观察期内未发现缺口'}`,items,impact,'供应链',state==='active'?'high':'medium'));
 }
 coverage.checks.stock=stockComplete;

 // Whole-store actual consumption replaces SKU allocations. Budget applications
 // and prepaid wallet top-ups are deliberately absent from this data contract.
 const previousAdDays=Array.from({length:7},(_,i)=>shiftDay(cutoff,i-7)),adToday=ads.filter(r=>r.business_date===cutoff);
 const currencies=[...new Set(ads.filter(r=>r.business_date>=previousAdDays[0]&&r.business_date<=cutoff).map(r=>r.currency).filter(Boolean))].sort();
 let adComplete=adToday.length>0;
 findings.push(finding('ad_reporting','',adToday.length?'clear':'unknown',adToday.length?'昨日广告实际消耗已有来源':'核对昨日广告实际消耗',[evidence('营业日',cutoff,'Asia/Jakarta'),evidence('实际消耗来源',adToday.map(r=>r.id).join('、')||'没有登记；申请额度、充值和预算未代替实际消耗','sales_ad_spend','/?page=finance-workbench&view=advertising-trend')],adToday.length?'各币种消耗及其比较依据分别核对。':'请运营核对平台实际扣费并补报；没有记录不能当作没有投放。'));
 if(!currencies.length){
  adComplete=false;
 }
 for(const currency of currencies){
  const dailyRows=adToday.filter(r=>r.currency===currency),priorRows=ads.filter(r=>r.currency===currency&&previousAdDays.includes(r.business_date));
  const priorDays=new Set(priorRows.map(r=>r.business_date));
  const duplicates=new Set(priorRows.map(r=>r.business_date)).size!==priorRows.length||dailyRows.length>1;
  const validAmounts=[...dailyRows,...priorRows].every(r=>number(r.amount)!=null&&Number(r.amount)>=0);
  const amount=dailyRows.length===1&&validAmounts&&!duplicates?Number(dailyRows[0].amount):null,baseline=priorDays.size===7&&validAmounts&&!duplicates?priorRows.reduce((n,r)=>n+Number(r.amount),0)/7:null;
  const growth=amount!=null&&baseline>0?(amount/baseline-1)*100:null;
  const valid=amount!=null&&baseline!=null&&adThreshold!=null&&adThreshold>=0;
  const spike=valid&&(baseline===0?amount>0:growth>=adThreshold);
  const state=!valid?'unknown':spike?'active':'clear';
  if(!valid)adComplete=false;
  metrics.adSpend.push({currency,date:cutoff,amount,baselineDaily:baseline==null?null:round(baseline),increasePct:growth==null?null:round(growth)});
  const items=[evidence('昨日实际消耗',amount==null?'待核实':`${round(amount)} ${currency}`,dailyRows.map(r=>r.id).join('、')||'sales_ad_spend 缺记录','/?page=finance-workbench&view=advertising-trend'),evidence('前7日同币种日均',baseline==null?`仅 ${priorDays.size}/7 天有效来源${duplicates?'，存在同日重复记录':''}`:`${round(baseline)} ${currency}/天`,priorRows.map(r=>r.id).join('、')||'sales_ad_spend'),evidence('试点提醒阈值',`较前7日均值增加 ${adThreshold??'待配置'}%；分币种比较，不自动换汇混加`,'试点配置')];
  findings.push(finding('ad_spend',currency,state,`${currency} 广告消耗${spike?'需要复查':valid?'未触发增幅提醒':'依据待补齐'}`,items,!valid?'补齐同口径实际消耗后再判断；未把缺报或申请额度当实际费用。':spike?`昨日实际消耗${baseline===0?'由零转为正数':`较前7日均值增加 ${round(growth)}%`}，请运营结合活动和成交核对原因，暂不自动调整投放。`:'这里只确认未触发消耗增幅阈值，不据此认定投放盈利。','运营',spike?'high':'medium'));
 }
 coverage.checks.ads=adComplete;

 // after_sales is a manually maintained exception ledger, not a complete order
 // cohort. Report observed distinct orders and amounts, never a fabricated rate.
 const currentRefunds=refunds.filter(r=>days.includes(r.business_date)),priorRefunds=refunds.filter(r=>r.business_date>=previousStart&&r.business_date<days[0]);
 const refundData=r=>r.data||parse(r.data_json);
 const countOrders=rs=>new Set(rs.map(r=>text(refundData(r).orderNo)).filter(Boolean)).size;
 const orders=countOrders(currentRefunds),priorOrders=countOrders(priorRefunds),amounts={};
 const missingOrderIdentity=currentRefunds.filter(r=>!text(refundData(r).orderNo)).length;
 let missingAmounts=0;
 for(const r of currentRefunds){const d=refundData(r),n=number(d.refundCents);if(n==null||n<0||!d.currency)missingAmounts++;else amounts[d.currency]=(amounts[d.currency]||0)+n/100;}
 metrics.refundOrdersObserved=orders;
 metrics.refundAmountsObserved=Object.entries(amounts).map(([currency,amount])=>({currency,amount:round(amount)}));
 const refundComplete=data.refundsComplete===true&&missingAmounts===0&&missingOrderIdentity===0;
 coverage.checks.refunds=refundComplete;
 const refundAlert=refundThreshold!=null&&Number.isSafeInteger(refundThreshold)&&refundThreshold>0&&orders>=refundThreshold;
 const refundState=refundAlert?'active':refundComplete&&refundThreshold>0?'clear':'unknown';
 findings.push(finding('refunds','',refundState,refundAlert?'已登记退款订单达到复查阈值':'退款覆盖与异常核对',[evidence('近7日已登记退款订单',`${orders} 个（按订单号去重）；前7日登记 ${priorOrders} 个${missingOrderIdentity?`；另有 ${missingOrderIdentity} 条缺订单编号，未当作独立订单`:''}`,currentRefunds.map(r=>r.id).join('、')||'after_sales 未见已提交记录','/?page=after-sales'),evidence('登记退款金额',Object.entries(amounts).map(([currency,amount])=>`${round(amount)} ${currency}`).join('；')||'待核实','after_sales.data_json.refundCents'),evidence('数据覆盖',refundComplete?'已有当前窗口完整性核对':'手工售后台账，尚未取得平台全量退款覆盖；没有登记不等于零退款','退款完整性依据'),evidence('试点提醒阈值',`近7日登记退款订单 ≥ ${refundThreshold??'待配置'} 个；不以销售件数充当订单分母`,'试点配置')],refundAlert?'运营核对退款原因、对应订单及商品描述，财务按原凭据核销；登记金额不代表已实际支付或可直接归责。':'先核对平台退款明细是否完整；暂不输出真实退款率或“没有退款风险”的结论。','运营',refundAlert?'high':'medium'));
 coverage.complete=Object.values(coverage.checks).every(Boolean);
 return {findings,metrics,coverage};
}

/** Read-only adapter for the existing single-channel legacy tables. */
export async function loadOperatingPilotData(db,config,now=new Date()){
 if(!operatingScopeConfirmed(config,now))return {scopeVerified:false,scopeInvalidReason:'尚未确认该经营台账仅属于试点一家店；未读取站点汇总。'};
 const scopes=await read(db,"SELECT id,shop,site,platform,operator_id,version FROM creator_scopes WHERE site='印尼' AND platform='TikTok'");
 const scope=scopes.find(r=>r.id===config.shopId);
 if(!scope||scope.operator_id!==config.operatorId||scopes.length!==1||(config.scopeVersion!=null&&Number(config.scopeVersion)!==scope.version))return {scopeVerified:false,scopeInvalidReason:'店铺、运营负责人或单店范围已变化，需要重新核对经营数据归属。'};
 const sourceVersion=(await db.prepare("SELECT version FROM business_action_source_clock WHERE id='global'").first())?.version||0;
 const today=localDay(now,'印尼'),cutoff=shiftDay(today,-1),from=shiftDay(cutoff,-13),skuJson=JSON.stringify(array(config.prioritySkus));
 const scopeSql="site='印尼' AND channel='TikTok'";
 const [imports,sales,ads,stocks,refunds,users,batches,shipmentRows,shipmentItemRows,receipts,transportLegRows,transportLegItemRows]=await Promise.all([
  read(db,`SELECT id,site,channel,business_date,report_kind,created_at FROM sales_imports WHERE ${scopeSql} AND reversed_at IS NULL AND business_date BETWEEN ? AND ?`,[from,cutoff]),
  read(db,`SELECT id,import_id,site,channel,sku,business_date,qty,created_at FROM sales_records WHERE ${scopeSql} AND reversed_at IS NULL AND business_date BETWEEN ? AND ?`,[from,cutoff]),
  read(db,`SELECT id,site,channel,business_date,currency,amount,updated_at FROM sales_ad_spend WHERE ${scopeSql} AND deleted_at IS NULL AND business_date BETWEEN ? AND ?`,[from,cutoff]),
  read(db,`SELECT site,channel,sku,qty,reserved_qty,pending_shelf_qty,quarantine_qty,updated_at FROM inventory_balances WHERE ${scopeSql} AND sku IN (SELECT value FROM json_each(?))`,[skuJson]),
  read(db,`SELECT id,site,channel,business_date,case_no,sku,status,data_json,updated_at FROM after_sales WHERE ${scopeSql} AND record_kind='after_sale' AND status NOT IN ('draft','void') AND business_date BETWEEN ? AND ?`,[from,cutoff]),
  read(db,'SELECT id,name,role,site,channel,active FROM users WHERE id IN (?,?)',[config.operatorId||'',config.supplyOwnerId||'']),
  read(db,"SELECT * FROM production_batches WHERE sku IN (SELECT value FROM json_each(?)) AND EXISTS(SELECT 1 FROM json_each(allocations_json) WHERE json_extract(value,'$.site')='印尼' AND json_extract(value,'$.channel')='TikTok')",[skuJson]),
  read(db,"SELECT * FROM shipment_batches WHERE id IN (SELECT batch_id FROM shipment_batch_items WHERE sku IN (SELECT value FROM json_each(?)) AND EXISTS(SELECT 1 FROM json_each(allocations_json) WHERE json_extract(value,'$.site')='印尼' AND json_extract(value,'$.channel')='TikTok'))",[skuJson]),
  read(db,"SELECT * FROM shipment_batch_items WHERE sku IN (SELECT value FROM json_each(?)) AND EXISTS(SELECT 1 FROM json_each(allocations_json) WHERE json_extract(value,'$.site')='印尼' AND json_extract(value,'$.channel')='TikTok')",[skuJson]),
  read(db,'SELECT * FROM shipment_receipt_items WHERE batch_item_id IN (SELECT id FROM shipment_batch_items WHERE sku IN (SELECT value FROM json_each(?)))',[skuJson]),
  read(db,`SELECT * FROM transport_legs WHERE ${scopeSql}`),
  read(db,`SELECT * FROM transport_leg_items WHERE leg_id IN (SELECT id FROM transport_legs WHERE ${scopeSql}) AND sku IN (SELECT value FROM json_each(?))`,[skuJson])
 ]);
 const endVersion=(await db.prepare("SELECT version FROM business_action_source_clock WHERE id='global'").first())?.version||0;
 const endScope=await db.prepare('SELECT version FROM creator_scopes WHERE id=?').bind(config.shopId).first();
 if(endVersion!==sourceVersion||endScope?.version!==scope.version){const e=new Error('巡检读取期间来源数据发生变化，请重试');e.status=409;throw e;}
 const stamp=rs=>rs.map(r=>({...r,shopId:config.shopId}));
 const arrivals=transitLots({batches,shipmentRows,shipmentItemRows,receipts,transportLegRows,transportLegItemRows}).filter(r=>r.site==='印尼'&&r.channel==='TikTok');
 return {scopeVerified:true,sourceVersion,scopeVersion:scope.version,imports:stamp(imports),sales:stamp(sales),ads:stamp(ads),stocks:stamp(stocks),refunds:stamp(refunds),arrivals:stamp(arrivals),users,refundsComplete:false,generatedAt:now.toISOString()};
}
