import {localDay,shiftDay,zeroSalesSites} from './promotion-model.mjs';
import {SITE_CURRENCIES} from './sales-data.mjs';

export const actionKinds={loss:'越卖越亏',stockout:'盈利款快断货',weakening:'积压款动销变弱'};
export const actionStates={open:'待处理',in_progress:'跟进中',review_pending:'待复查',resolved:'复查已解决'};
export const financeFields={landed:'已售商品到岸采购成本',ads:'可归属本 SKU 的广告费用',platform:'平台、佣金及支付费用',fulfillment:'履约费用',returns:'未在销售额中扣除的退货退款及售后净成本'};
export const diagnosisFields={traffic:'流量：曝光、访客及变化依据',conversion:'转化：点击、成交及变化依据',price:'价格：折扣、竞品及变化依据',quality:'质量：退货原因、评价及变化依据'};
export const actionKey=r=>JSON.stringify([r.site,r.channel,r.sku,r.kind]);
export const scopeKey=r=>JSON.stringify([r.site,r.channel]);
export const skuKey=r=>JSON.stringify([r.site,r.channel,r.sku]);
export const round=n=>Math.round((n+Number.EPSILON)*100)/100;
export const actionRoles=kind=>kind==='stockout'?{primary:'供应链',assist:['运营']}:{primary:'运营',assist:kind==='loss'?['财务']:['供应链','财务']};
export function canReadActions(a){return ['管理员','财务','供应链','运营主管'].includes(a.role)||a.role==='运营'&&zeroSalesSites.includes(a.site)&&['TikTok','Shopee'].includes(a.channel);}
export const actionScope=(a,r)=>a.role!=='运营'||a.site===r.site&&a.channel===r.channel;
export function actionWindow(site,now=new Date()){
 const today=localDay(now,site),cutoff=shiftDay(today,-1),start=shiftDay(cutoff,-6),previousStart=shiftDay(start,-7);
 return {today,cutoff,start,previousStart,days:Array.from({length:14},(_,i)=>shiftDay(previousStart,i))};
}

// Evidence first, then the last safe action date, then near-term avoidable
// contribution in one currency. A large later risk cannot displace tomorrow.
export function compareActions(a,b){
 const x=a.snapshot||a,y=b.snapshot||b;
 const tier=(r,s)=>r.status==='resolved'?3:s.condition==='clear'?2:s.condition==='verify'?1:0;
 const urgency=s=>Number.isFinite(s.mustActInDays)?Math.max(0,s.mustActInDays):Infinity;
 return tier(a,x)-tier(b,y) || urgency(x)-urgency(y) || y.reliability-x.reliability
  || (y.recoverableCny!=null?1:0)-(x.recoverableCny!=null?1:0) || (y.recoverableCny??0)-(x.recoverableCny??0)
  || String(a.opened_at||'').localeCompare(String(b.opened_at||'')) || actionKey(x).localeCompare(actionKey(y));
}

// Monetary inputs are the sum of seven independently confirmed daily revisions.
export function evaluateActions(x){
 const {site,channel,sku,name,window:w,available,sales,complete,availability,observations,finance,forecast,setting,fx,afterCount}=x;
 const currency=SITE_CURRENCIES[site],recent=sales.filter(r=>r.business_date>=w.start&&r.business_date<=w.cutoff&&r.qty>0);
 const previous=sales.filter(r=>r.business_date>=w.previousStart&&r.business_date<w.start);
 const sumQty=rs=>rs.reduce((s,r)=>s+Math.max(0,r.qty),0),qty=sumQty(recent),previousQty=sumQty(previous);
 const missing=w.days.filter(d=>!complete.includes(d)),missing7=missing.filter(d=>d>=w.start),full7=!missing7.length,full14=!missing.length;
 const invalidMoney=recent.some(r=>r.reported_amount==null||!Number.isFinite(r.reported_amount)||r.reported_amount<0||r.currency!==currency);
 const revenue=full7&&!invalidMoney?round(recent.reduce((s,r)=>s+r.reported_amount,0)):null;
 const costs=finance?.data,profit=revenue!=null&&costs&&Object.keys(financeFields).every(k=>Number.isFinite(costs[k]))?round(revenue-Object.keys(financeFields).reduce((s,k)=>s+costs[k],0)):null;
 const unit=profit!=null&&qty>0?profit/qty:null,velocity=forecast?.forecastReady===true?forecast.forecastDaily:null;
 const verifiedDays=w.days.filter(d=>availability&&availability.listed_since<=d&&availability.available_since<=d&&availability.verified_through>=d&&!observations.some(o=>o.day===d&&o.min_available<=0));
 const covered14=verifiedDays.length===14;
 const lead=Number(forecast?.policy?.production_days??setting?.production_lead_days),sea=Number(forecast?.policy?.transport_days??setting?.sea_lead_days),review=Number(forecast?.policy?.review_days??setting?.review_cycle_days);
 const validLead=[lead,sea,review].every(n=>Number.isFinite(n)&&n>=0&&n<=365)&&lead+sea>0&&lead+sea+review<=730;
 const horizon=forecast?.horizonDays??(validLead?lead+sea+review:null);
 const projection=full7&&forecast?.forecastReady===true&&Number.isFinite(available)?forecast.projection:null;
 const arrivals=(forecast?.arrivalLots||[]).map(a=>({...a,date:a.etaDate||(Number.isFinite(a.days)?shiftDay(w.today,a.days):'待核实')}));
 const unknownArrival=Number(projection?.unknownArrivalQty||0);
 const shortage=projection?.firstShortageDay!=null;
 const production=Number(forecast?.productionInProgress||0);
 const mixedDemand=(forecast?.offlineDailySales||[]).some(q=>q>0);
 const pricedShortage=projection&&available>=0&&!unknownArrival&&!mixedDemand&&unit>0;
 const suggestedQty=full7&&available>=0&&!unknownArrival&&forecast?.recommendationReady===true?forecast.suggestedProduction:null;
 const stockDeadline=shortage&&validLead?Math.max(0,projection.firstShortageDay-(forecast.leadDays??lead+sea)):null;
 const risk7=projection?projection.curve.slice(1,8).reduce((n,d)=>n+Number(d.unmetDemand||0),0):null;
 const riskTomorrow=projection?.curve[1]?.unmetDemand??null;
 const cover=full7&&qty>0?round(Math.max(0,available)/(qty/7)):null;
 const weakSignal=available>0&&(qty===0||previousQty>0&&qty<=previousQty*.7)&&(qty===0||cover>=60);
 const growth=full14&&previousQty>0?round((qty-previousQty)/previousQty*100):null;
 const gaps=[];
 if(missing7.length)gaps.push(`近7天缺${missing7.length}天完整日报`);
 if(invalidMoney)gaps.push('销售金额或站点原币待核对');
 if(!finance)gaps.push(`每日成本尚有${(x.financeDays||[]).filter(d=>d.status!=='confirmed').length||7}天待录入或复核（只核对新增及变化日期）`);
 const rate=currency==='CNY'?1:fx?.rates?.[currency],usableRate=rate>0&&fx?.status!=='unavailable';
 const common={site,channel,sku,name,currency,window:w,qty:full7?qty:null,observedQty:qty,previousQty:full14?previousQty:null,revenue,profit,unitContribution:unit==null?null:round(unit),available,coverage:7-missing7.length,missing,covered14,growth,cover,afterCount,
  costs:costs||null,financeSource:finance?.source||null,financeAt:finance?.created_at||null,financeDays:x.financeDays||[],
  supply:{lead,sea,review,horizon,arrivals,unknownArrival,production,forecastDaily:velocity,forecastVersion:forecast?.forecastVersion,missingDates:forecast?.missingDates||[],projection:projection?{firstShortageDate:projection.firstShortageDate,maxShortage:projection.maxShortage,curve:projection.curve}:null,suggestedQty},
  fx:usableRate?{effectiveAt:fx.effectiveAt,status:fx.status,rate}:null,ruleVersion:'daily-actions-v2'};
 const result=(kind,condition,title,today,gap,delay=null,recoverable=null)=>({...common,kind,roles:actionRoles(kind),condition,title,today,gaps:gap,
  reliability:condition==='verify'?1:profit!=null&&full7?3:2,
  mustActInDays:condition==='clear'?null:kind==='stockout'?stockDeadline:0,
  mustActDate:condition==='clear'||kind==='stockout'&&stockDeadline==null?null:shiftDay(w.today,kind==='stockout'?stockDeadline:0),
  delayCny:delay!=null&&usableRate?round(delay/rate):null,recoverableCny:recoverable!=null&&usableRate?round(recoverable/rate):null,
  delayAmount:delay,recoverableAmount:recoverable,
  moneyMethod:kind==='loss'?'按当前7天核实贡献测算：拖延一天损失＝亏损÷7；未来7天可避免亏损情景上限＝当前亏损。销量成本不变假设，不是已挽回利润。':kind==='stockout'?'与补货模块共用完整日7/21/56天需求预测。逐日按当日可售＋有效到货－需求算未满足量，丢失销量不结转为欠单；到货恢复覆盖即停止计损。近7天风险贡献＝逐日未满足量合计×近7天核实单位贡献；为及时补救的情景上限，不是已挽回利润。':'不预设降价或销量提升幅度，未核实措施效果时不估算可挽回利润。'});
 const out=[];
 const lossCondition=profit!=null?(profit<0?'active':'clear'):qty>0||!full7?'verify':'clear';
 out.push(result('loss',lossCondition,lossCondition==='active'?'核实贡献为负，优先排查损失来源':lossCondition==='verify'?'利润待核实，先补齐经营证据':'本期未触发亏损条件',lossCondition==='verify'?'运营核对折扣与实际成交额；财务补齐商品、广告、平台、履约、售后成本。':'运营逐项核查折扣叠加、无效投放和高退货原因，提出暂停或调整方案；财务复算止损边界。',gaps,profit<0?round(-profit/7):null,profit<0?-profit:null));
 const stockGaps=[...gaps];if(mixedDemand)stockGaps.push('共用预测含线下实发需求，线上单位贡献不能代替线下利润；库存缺口保留，金额待分别核算');if(forecast?.forecastReady!==true)stockGaps.push(`需求预测待核实：${(forecast?.readinessReasons||forecast?.missingDates||[]).join('、')||'无有效预测'}`);if(!validLead)stockGaps.push('补货周期未有效配置');if(unknownArrival)stockGaps.push(`${unknownArrival}件在途缺有效ETA或已逾期，未计入及时到货`);if(available==null)stockGaps.push('可售库存缺失');if(available<0)stockGaps.push('可售库存为负，先核销差异，不据此下补货结论');
 const stockCondition=available==null||available<0||!full7||forecast?.forecastReady!==true?'verify':projection?shortage?(profit==null||unknownArrival||mixedDemand?'verify':profit>0?'active':'clear'):'clear':qty>0?'verify':'clear';
 out.push(result('stockout',stockCondition,stockCondition==='active'?'盈利商品存在到货前缺口':stockCondition==='verify'?'断货与盈利证据待核实':'当前未触发盈利断货条件',stockCondition==='verify'?'供应链核对可售、预留、各批ETA和补货周期，运营补齐日报，财务确认盈利。':`供应链先核对可调拨库存与到仓时间，再评估补货${suggestedQty==null?'数量待核实':`参考量 ${suggestedQty} 件`}；已有生产量已扣除，仍需核对其交期，不能自动消除近期缺口。`,stockGaps,pricedShortage&&shortage?round(riskTomorrow*unit):null,pricedShortage&&shortage?round(risk7*unit):null));
 const weakGaps=[];if(!full14)weakGaps.push(`两期共缺${missing.length}天完整日报`);if(!covered14)weakGaps.push('两期连续上架且有货证据不足，先排除断货或未上架');
 const weakCondition=available==null?'verify':available<=0?'clear':!full14||!covered14?'verify':weakSignal?'active':'clear';
 out.push(result('weakening',weakCondition,weakCondition==='active'?'有库存且动销变弱，先诊断再处置':weakCondition==='verify'?'动销原因待核实，不能直接视为滞销':'当前未触发动销减弱条件','站点运营对比两期流量、转化、成交价与质量反馈；写明证据后选择改素材、调整投放、修正描述或申请清货。',weakGaps));
 return out;
}
