import {projectInventory} from './inventory-projection.mjs';
import {shiftDay,validDay} from './promotion-model.mjs';

const openStages=new Set(['awaiting_factory','pending','in_production']);
const levels={urgent:0,soon:1,verify:2,normal:3};
const key=(line,sku)=>[line.site,line.channel,sku].join('|');

function openLines(order){
  if(!openStages.has(order.status))return [];
  return order.items.filter(item=>item.visiblePlanned>item.visibleProduced);
}

export function queueForecastKeys(orders){
  const keys=new Set();
  for(const order of orders)for(const item of openLines(order)){
    for(const allocation of item.allocations)if(allocation.qty>0)keys.add(key(allocation,item.sku));
  }
  return keys;
}

function assess(order,row){
  if(!row?.recommendationReady||!row.projection){
    return {level:'verify',reason:row?.readinessReasons?.join('；')||'缺少本站 SKU 的库存或有效销量'};
  }
  const asOf=row.projection.curve[0].date, daily=row.forecastDaily;
  const promised=validDay(order.promised_completion_date)?Math.round((Date.parse(order.promised_completion_date)-Date.parse(asOf))/86400000):null;
  const pending=order.status!=='in_production';
  const lead=promised===null?row.leadDays:
    row.seaLeadDays+Math.max(pending?row.productionLeadDays:0,promised);
  const horizon=lead+row.reviewCycleDays;
  const projection=horizon<=row.horizonDays?row.projection:projectInventory({asOf,currentQty:row.qty,dailyDemand:daily,arrivals:row.arrivalLots,horizonDays:horizon});
  const gap=projection.firstShortageDay;
  const slack=gap===null?null:gap-lead;
  const level=slack===null?'normal':slack<0?'urgent':slack<=row.reviewCycleDays?'soon':'normal';
  return {level,slack,daily,stock:row.qty,cover:row.stockCoverDays,shortage:projection.firstShortageDate,lead,cutoff:shiftDay(asOf,-1),
    overdue:promised!==null&&promised<0,
    reason:level==='urgent'?'预计补到前会缺货':level==='soon'?'排期余量已进入复查周期':daily===0?'当前预测日销为零':'当前补货周期内库存可覆盖'};
}

function compareRisk(a,b){
  return levels[a.level]-levels[b.level]||(a.slack??Infinity)-(b.slack??Infinity);
}

export function rankProductionOrders(orders,forecasts,role){
  const forecast=new Map(forecasts.map(row=>[key(row,row.sku),row]));
  const active=[],other=[];
  for(const order of orders){
    const lines=openLines(order);
    if(!lines.length){other.push(order);continue;}
    const risks=[];
    for(const item of lines){
      const allocations=item.allocations.filter(a=>a.qty>0);
      if(!allocations.length)risks.push({sku:item.sku,level:'verify',reason:'生产单缺少站点分配'});
      for(const allocation of allocations){
        const result=assess(order,forecast.get(key(allocation,item.sku)));
        risks.push({...result,sku:item.sku,site:allocation.site,channel:allocation.channel});
      }
    }
    risks.sort((a,b)=>compareRisk(a,b)||a.sku.localeCompare(b.sku));
    const first=risks[0];
    active.push({order,first,unverified:risks.filter(r=>r.level==='verify').length});
  }
  active.sort((a,b)=>compareRisk(a.first,b.first)||String(a.order.created_at).localeCompare(String(b.order.created_at))||a.order.id.localeCompare(b.order.id));
  return [...active.map(({order,first,unverified},index)=>{
    const {level,sku,site,channel,shortage}=first;
    const evidence=role==='工厂'?{level,sku,site,channel,shortage}:first;
    return {...order,priority:{...evidence,rank:index+1,unverified}};
  }),...other];
}
