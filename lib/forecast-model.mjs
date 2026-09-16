import {calculateSupplyPlan,roundSupplyQuantity} from './rules.mjs';
export function forecastPlan(input,policy={},corrections=[],dates=[],asOf=new Date().toISOString().slice(0,10)){
 const source=Array(56).fill(0),covered=Array(56).fill(false);(input.dailySales||[]).slice(-56).forEach((n,i,a)=>source[56-a.length+i]=Math.max(0,Number(n)||0));(input.dailyCoverage||Array(56).fill(true)).slice(-56).forEach((v,i,a)=>covered[56-a.length+i]=Boolean(v));
 const copy=[...source],correctionMap=new Map(corrections.map(c=>[c.business_date,c]));let stockoutDays=0;
 for(let i=0;i<56;i++){const c=correctionMap.get(dates[i]);if(c){copy[i]=Math.max(0,copy[i]-Number(c.return_qty||0));if(c.stockout){covered[i]=false;stockoutDays++;}}}
 const baseline=copy.filter((n,i)=>covered[i]&&n>0).sort((a,b)=>a-b),median=baseline.length?baseline[Math.floor(baseline.length/2)]:0;
 let spikeDays=0;for(let i=0;i<56;i++){const c=correctionMap.get(dates[i]);if(c?.exclude_spike){covered[i]=false;spikeDays++;}else if(median>0&&copy[i]>median*Number(policy.outlier_multiple||4)){copy[i]=median*Number(policy.outlier_multiple||4);spikeDays++;}}
 const avg=n=>{const values=copy.slice(-n).filter((_,i)=>covered[56-n+i]);return values.length?values.reduce((s,x)=>s+x,0)/values.length:0};const avg7=avg(7),avg21=avg(21),avg56=avg(56);
 const p=Number(policy.production_days??input.productionLeadDays??21),sea=Number(policy.transport_days??input.seaLeadDays??35),review=Number(policy.review_days??input.reviewCycleDays??7),horizon=p+sea+review;
 const horizonEnd=new Date(Date.parse(asOf)+horizon*86400000).toISOString().slice(0,10),overlapStart=policy.campaign_start>asOf?policy.campaign_start:asOf,overlapEnd=policy.campaign_end<horizonEnd?policy.campaign_end:horizonEnd;
 const eventDays=policy.campaign_start&&policy.campaign_end&&overlapEnd>=overlapStart?Math.min(horizon,Math.floor((Date.parse(overlapEnd)-Date.parse(overlapStart))/86400000)+1):0;
 const eventFactor=1+eventDays/horizon*(Number(policy.campaign_factor??1)-1),lifecycle=policy.lifecycle||'normal',factor=Number(policy.season_factor??1)*eventFactor*(lifecycle==='declining'?.6:lifecycle==='discontinued'?0:1);
 const velocity=(avg7*.5+avg21*.3+avg56*.2)*factor;
 // Existing coverage/ETA rules are retained; daily curve is scaled to the explicit 7/21/56 forecast.
 const legacy=calculateSupplyPlan({...input,dailySales:copy.slice(-28),dailyCoverage:covered.slice(-28),productionLeadDays:p,seaLeadDays:sea,reviewCycleDays:review,serviceLevel:Number(policy.service_level??input.serviceLevel??.95),dataDays:covered.filter(Boolean).length});
 const std=Math.sqrt(copy.reduce((s,n,i)=>s+(covered[i]?(n-avg56)**2:0),0)/Math.max(1,covered.filter(Boolean).length));
 const z=Number(policy.service_level??input.serviceLevel??.95)>=.99?2.33:Number(policy.service_level??input.serviceLevel??.95)>=.98?2.05:Number(policy.service_level??input.serviceLevel??.95)>=.95?1.65:1.28;
 const safety=Math.ceil(Math.max(z*std*Math.sqrt(horizon)*factor,velocity*Number(policy.safety_days||0))),target=Math.ceil(velocity*horizon+safety),raw=Math.max(0,target-legacy.inventoryPosition);
 const moq=Number(policy.min_order_qty??input.minOrderQty??1),multiple=Number(policy.order_multiple??input.orderMultiple??1),unconstrained=roundSupplyQuantity(raw,moq,multiple);
 const caps=[['产能',policy.capacity_qty],['仓容',policy.warehouse_qty],['资金',policy.budget_amount==null?null:(Number(policy.unit_cost)>0?Math.floor(policy.budget_amount/policy.unit_cost):0)],['最大库存覆盖',velocity>0?Math.max(0,Math.floor(velocity*Number(policy.max_cover_days||120)-legacy.inventoryPosition)):0]].filter(([,v])=>v!=null);
 let qty=unconstrained;const limits=[];for(const [name,cap] of caps)if(qty>Number(cap)){qty=Math.max(0,Math.floor(Number(cap)/multiple)*multiple);limits.push(name)}if(qty>0&&qty<moq){qty=0;limits.push('上限不足MOQ')}if(lifecycle==='discontinued')qty=0;
 const cover=(n)=>velocity>0?Math.round(Math.max(0,n)/velocity*10)/10:null;
 let alertLevel='healthy',alertLabel='供应健康',alertReason='库存与供应链覆盖充足';
 const stockDays=cover(input.currentQty),seaQty=Number(input.seaInTransit||0),eta=input.daysToNextSea,wait=seaQty?Math.max(0,eta??sea):sea,stale=input.daysSinceLastImport;
 if(Number(input.currentQty)<0){alertLevel='critical';alertLabel='负库存';alertReason='账面库存已小于0，需核销差异并安排补货'}
 else if(velocity>0&&stockDays<wait){alertLevel='critical';alertLabel='断货风险';alertReason='当前库存不足以覆盖下一次到仓前的预计需求'}
 else if(seaQty>0&&eta!=null&&eta<0){alertLevel='eta';alertLabel='在途逾期';alertReason='预计到仓日已逾期，请更新ETA或确认收货'}
 else if(stale!=null&&stale>1){alertLevel='data';alertLabel='销量未更新';alertReason='销售数据未及时更新，请先补齐导入'}
 else if(covered.filter(Boolean).length<7){alertLevel='data';alertLabel='数据不足';alertReason='有效销量记录不足7天，建议仅供人工复核'}
 else if(limits.length){alertLevel='warning';alertLabel='备货受约束';alertReason=`建议${unconstrained}件，受${limits.join('、')}约束后${qty}件`}
 else if(seaQty>0&&eta==null){alertLevel='eta';alertLabel='在途缺ETA';alertReason='在途未填写预计到仓日期'}
 else if(qty>0){alertLevel='warning';alertLabel='需启动生产';alertReason='库存和在途生产合计低于目标库存位'}
 return {...legacy,dailySales:source,adjustedDailySales:copy,avg7,avg21,avg56,forecastDaily:velocity,forecastSales:velocity*30,forecastVersion:'7-21-56-v1',safetyStock:safety,targetQty:target,rawSuggestedProduction:raw,suggestedProduction:qty,unconstrainedQty:unconstrained,suggestedReplenishment:roundSupplyQuantity(Math.max(0,Math.ceil(velocity*(sea+review)+safety)-Number(input.currentQty||0)-Number(input.pendingShelf||0)-Number(input.seaInTransit||0)),moq,multiple),stockCoverDays:cover(input.currentQty),landedCoverDays:cover(Number(input.currentQty||0)+Number(input.pendingShelf||0)+Number(input.seaInTransit||0)),pipelineCoverDays:cover(legacy.inventoryPosition),stockoutDays,spikeDays,eventFactor,lifecycle,limits,policy,alertLevel,alertLabel,alertReason,projectedAtNextArrival:Math.floor(Number(input.currentQty||0)-velocity*wait+seaQty),productionStartInDays:velocity>0?Math.floor(Math.max(0,legacy.inventoryPosition/velocity-p-sea)):null};
}
export function forecastPerformance(rows){const actual=rows.reduce((s,r)=>s+Number(r.actual_sales||0),0),predicted=rows.reduce((s,r)=>s+Number(r.forecast_sales||0),0),error=rows.reduce((s,r)=>s+Math.abs(Number(r.actual_sales||0)-Number(r.forecast_sales||0)),0);return {actual,predicted,absoluteError:error,wape:actual?error/actual:null,accuracy:actual?Math.max(0,1-error/actual):null,bias:actual?(predicted-actual)/actual:null,zeroActual:actual===0};}
