export const forecastVersion='dated-demand-7-21-56-v3';
const qty=v=>Math.max(0,Number(v)||0);
export function transportSummary(legacy=[],shipments=[],legs=[]){
  const entries=[...legacy.map(r=>({...r,key:'legacy:'+r.id})),...shipments.map(r=>({...r,key:'shipment:'+r.id})),...legs.map(r=>({...r,key:'leg:'+r.id}))];
  const unique=[...new Map(entries.map(r=>[r.key,r])).values()];
  return {stalledBatchCount:unique.filter(r=>r.stalled||r.exceptions?.some(e=>e.type==='节点停滞')).length,
    pendingShelfCount:unique.filter(r=>r.stage==='shelf_pending'||qty(r.pendingShelfQty)>0).length};
}
export function datedDemand(base,policy,horizon,asOf){
  const lifecycle=policy.lifecycle==='declining'?.6:policy.lifecycle==='discontinued'?0:1;
  const baseline=qty(base)*qty(policy.season_factor??1)*lifecycle;
  return Array.from({length:horizon},(_,i)=>{
    const date=new Date(Date.parse(asOf)+(i+1)*86400000).toISOString().slice(0,10);
    const campaign=Boolean(policy.campaign_start&&policy.campaign_end&&date>=policy.campaign_start&&date<=policy.campaign_end);
    return {date,demand:baseline*(campaign?qty(policy.campaign_factor??1):1),baseline,campaign};
  });
}
export function supplyActions(row){
  const actions=[];
  if(row.recommendationReady===false)actions.push({kind:'verify',label:'补齐测算资料',reason:(row.readinessReasons||[]).join('；'),page:'business-actions',view:'evidence'});
  if(row.suggestedProduction>0)actions.push({kind:'produce',label:'评审新增生产',qty:row.suggestedProduction,reason:'净新增缺口；下单前需核对交期与预算',page:'monthly'});
  if(row.projection?.firstShortageDate){
    actions.push({kind:'expedite',label:'催交或拆批发运',date:row.projection.firstShortageDate,reason:'预计在这天出现缺货，新增生产不一定赶得上',page:'fulfillment'});
    actions.push({kind:'transfer',label:'核查可调拨库存',reason:'仅建议核查，未确认其他仓库有可调库存',page:'inventory'});
  }
  if(!actions.length)actions.push({kind:'watch',label:'维持当前计划',reason:'按当前已知需求和供应测算；持续跟踪实际交付',page:'suggestions'});
  return actions;
}
