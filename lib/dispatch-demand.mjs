import {loadForecast} from './forecast.ts';
// Read the same complete-day forecast used by the replenishment cockpit.
// The plan's unshipped allocation is an approval ceiling, not today's demand.
export async function dispatchDemand(db,site,channel,skus){
 const forecast=await loadForecast(db,{role:'运营',site,channel});
 const at=new Date().toISOString();
 return skus.map(sku=>{
  const r=forecast.suggestions.find(r=>r.sku===sku);
  return {sku,site,channel,at,availableStock:r?.qty??null,seaInTransit:r?.seaInTransit??null,
   nextSeaEta:r?.nextSeaEta||null,forecastReady:r?.forecastReady===true,
   dailyDemand:r?.forecastReady?r.forecastDaily:null,
   suggestedProduction:r?.forecastReady?r.suggestedProduction:null,
   missingDays:r?.dailySeries?.slice(-7).filter(d=>!d.complete).map(d=>d.date)||[],
   note:r?.readinessReasons?.join('；')||r?.alertReason||'请核对实际订单与库存'};
 });
}
export function deliveryStep(order,available,notices,asOf){
 const due=order.promised_completion_date||order.expected_completion_date||'';
 const days=due?Math.ceil((Date.parse(due)-Date.parse(asOf))/86400000):null;
 if(order.productionStatus==='awaiting_factory')return {due,days,dueLabel:'采购要求交期',label:'工厂导出订单、核对采购单并回复交期',attention:true};
 if(order.qc_status!=='passed')return {due,days,label:['completed','completed_with_variance'].includes(order.productionStatus)?'供应链完成质检；通过后提交发货通知':'工厂更新生产进度；完工后转质检',attention:days!=null&&days<=3};
 const remaining=available.reduce((s,i)=>s+i.available,0);
 if(remaining>0)return {due,days,label:'供应链核对各站最新需求，提交发货通知给管理员审核',attention:days==null||days<=3};
 if(notices.some(n=>n.approval_status==='pending'&&n.status!=='cancelled'))return {due,days,label:'管理员审核发货数量及站点；通过后工厂收到通知',attention:true};
 if(notices.some(n=>n.status==='issued'))return {due,days,label:'工厂按已批准通知发货并提交签字装箱清单',attention:true};
 if(notices.some(n=>n.status==='packing_submitted'))return {due,days,label:'供应链复核工厂装箱数量及附件',attention:true};
 if(notices.some(n=>n.status==='confirmed'))return {due,days,label:'供应链按已复核装箱清单建立海运批次',attention:true};
 const enteredTransport=notices.some(n=>n.status==='linked');
 return {due,days,label:enteredTransport?'已进入运输；在海运批次跟进到港、到仓和上架':'等待供应链发货安排与管理员审核',attention:false};
}
