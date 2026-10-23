import {SITE_CURRENCIES} from './sales-data.mjs';
import {localDay,shiftDay} from './promotion-model.mjs';
export const targetSites=Object.keys(SITE_CURRENCIES),targetChannels=['TikTok','Shopee'];
export const round=n=>Math.round((n+Number.EPSILON)*100)/100;
export const scopeKey=r=>`${r.site}|${r.channel}`;
export const targetFail=(message,status=400)=>{const e=new Error(message);e.status=status;throw e;};
export function targetAccess(a){
 if(!['管理员','财务','运营主管','运营'].includes(a.role)||a.role==='运营'&&(!targetSites.includes(a.site)||!targetChannels.includes(a.channel)))targetFail('当前账号无权查看月度任务与贡献',403);
}
export function targetMonth(value){if(typeof value!=='string'||!/^20\d{2}-(0[1-9]|1[0-2])$/.test(value))targetFail('请选择有效月份');return value;}
export function monthWindow(month,site,now=new Date()){
 const from=month+'-01',end=new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5)),0)).toISOString().slice(0,10);
 const yesterday=shiftDay(localDay(now,site),-1),to=end<yesterday?end:yesterday;
 const days=[];for(let d=from;d<=to;d=shiftDay(d,1))days.push(d);
 return {from,to:to<from?null:to,end,days,expectedDays:days.length,monthDays:Number(end.slice(-2))};
}
const knownSum=(rs,k)=>{const values=rs.map(r=>r[k]).filter(v=>v!=null);return values.length?round(values.reduce((n,v)=>n+v,0)):null;};
export function summarizeTargets(rows){
 const total={scopeCount:rows.length,assigned:rows.filter(r=>r.target).length,qty:knownSum(rows,'qty'),revenueCny:knownSum(rows,'revenueCny'),adCostCny:knownSum(rows,'adCostCny'),targetRevenue:rows.filter(r=>r.target).reduce((n,r)=>n+r.target.revenue_cny,0),targetQty:rows.filter(r=>r.target).reduce((n,r)=>n+r.target.quantity,0),budgetCny:rows.filter(r=>r.target).reduce((n,r)=>n+r.target.budget_cny,0)};
 for(const k of ['held','available','reserved','pending','quarantine','inventoryAnomalies','expectedDays','completeDays','adDays'])total[k]=rows.reduce((n,r)=>n+r[k],0);
 total.revenueComplete=rows.length>0&&rows.every(r=>r.revenueComplete);total.costComplete=rows.length>0&&rows.every(r=>r.costComplete);total.qtyComplete=rows.length>0&&rows.every(r=>r.qtyComplete);
 total.targetRevenue=round(total.targetRevenue);total.budgetCny=round(total.budgetCny);
 // An unassigned scope must never improve another person's target attainment.
 total.targetActual=knownSum(rows.filter(r=>r.target),'revenueCny');total.targetActualQty=knownSum(rows.filter(r=>r.target),'qty');total.targetSpend=knownSum(rows.filter(r=>r.target),'adCostCny');
 total.achievement=total.targetRevenue>0&&total.targetActual!=null?total.targetActual/total.targetRevenue:null;
 total.quantityAchievement=total.targetQty>0&&total.targetActualQty!=null?total.targetActualQty/total.targetQty:null;
 total.budgetUse=total.budgetCny>0&&total.targetSpend!=null?total.targetSpend/total.budgetCny:null;
 total.overBudget=total.targetSpend==null?null:Math.max(0,round(total.targetSpend-total.budgetCny));
 total.roas=total.revenueComplete&&total.costComplete&&total.adCostCny>0?total.revenueCny/total.adCostCny:null;
 return total;
}

export function buildTargetReport({month,scopes,raw,spend,coverage,inventory,targets,users,fx,now=new Date()}){
 const targetMap=new Map(targets.map(r=>[scopeKey(r),r]));
 const rows=scopes.map(scope=>{
  const key=scopeKey(scope),window=monthWindow(month,scope.site,now),within=r=>scopeKey(r)===key&&r.date>=window.from&&window.to&&r.date<=window.to;
  const records=raw.filter(within),costs=spend.filter(within),complete=new Set(coverage.filter(within).map(r=>r.date));
  const cny=(value,currency)=>value==null||!fx.rates[currency]?null:value/fx.rates[currency];
  const original=new Map(),getOriginal=c=>{if(!original.has(c))original.set(c,{currency:c,qty:0,revenue:null,adCost:null,revenueMissing:0,costMissing:0});return original.get(c);};
  let qty=0,revenue=0,adCost=0,revenueValues=0,costValues=0,revenueMissing=0,costMissing=0,adDays=0,unconverted=0,repeatedDays=0;
  for(const date of window.days){
   const sales=records.filter(r=>r.date===date),ads=costs.filter(r=>r.date===date),currencies=new Set([...sales.map(r=>r.currency),...ads.map(r=>r.currency)]);
   let costOk=currencies.size>0,repeat=false;
   if(!sales.length){if(complete.has(date))revenueValues++;else revenueMissing++;}
   if(!currencies.size){costMissing++;costOk=false;}
   for(const currency of currencies){
    const s=sales.find(r=>r.currency===currency),ad=ads.find(r=>r.currency===currency),o=getOriginal(currency);
    const rv=s?.revenue??null,cv=ad?.amount??s?.adCost??null;
    if(s){qty+=s.qty;o.qty+=s.qty;}
    if(rv!=null){o.revenue=(o.revenue??0)+rv;const v=cny(rv,currency);if(v==null)unconverted++;else{revenue+=v;revenueValues++;}}
    const rm=Number(s?.revenueMissing||0);revenueMissing+=rm;o.revenueMissing+=rm;
    if(cv!=null){o.adCost=(o.adCost??0)+cv;const v=cny(cv,currency);if(v==null){unconverted++;costOk=false;}else{adCost+=v;costValues++;}}
    const repeated=!ad&&Boolean(s?.repeated);if(repeated){repeat=true;costOk=false;}
    const missing=ad?0:s?Number(s.costMissing):cv==null?1:0;
    if(missing||cv==null){costOk=false;costMissing+=Math.max(1,missing);o.costMissing+=Math.max(1,missing);}
   }
   if(costOk)adDays++;if(repeat)repeatedDays++;
  }
  // Match the existing CNY sales dashboard: round each scope/currency subtotal,
  // then sum. Never round every sale or mix unconverted original currencies.
  revenue=[...original.values()].reduce((sum,o)=>sum+(o.revenue!=null&&fx.rates[o.currency]?round(o.revenue/fx.rates[o.currency]):0),0);
  adCost=[...original.values()].reduce((sum,o)=>sum+(o.adCost!=null&&fx.rates[o.currency]?round(o.adCost/fx.rates[o.currency]):0),0);
  const stock=inventory.find(r=>scopeKey(r)===key)||{},target=targetMap.get(key)||null,owner=target?users.find(u=>u.id===target.owner_id):null;
  const qtyComplete=window.expectedDays>0&&complete.size===window.expectedDays;
  const row={...scope,key,window,target,ownerName:target?.owner_name||'待分配',ownerValid:target?Boolean(owner?.active&&owner.role==='运营'&&owner.site===scope.site&&owner.channel===scope.channel):false,
   qty:records.length||complete.size?qty:null,revenueCny:revenueValues?round(revenue):null,adCostCny:costValues?round(adCost):null,
   qtyComplete,revenueComplete:qtyComplete&&!revenueMissing&&!unconverted,costComplete:window.expectedDays>0&&adDays===window.expectedDays&&!unconverted&&!repeatedDays,
   completeDays:complete.size,expectedDays:window.expectedDays,adDays,revenueMissing,costMissing,unconverted,repeatedDays,
   original:[...original.values()].map(o=>({...o,revenue:o.revenue==null?null:round(o.revenue),adCost:o.adCost==null?null:round(o.adCost)})),
   held:Number(stock.held||0),available:Number(stock.available||0),reserved:Number(stock.reserved||0),pending:Number(stock.pending||0),quarantine:Number(stock.quarantine||0),inventoryAnomalies:Number(stock.anomalies||0),
  };
  row.achievement=target?.revenue_cny>0&&row.revenueCny!=null?row.revenueCny/target.revenue_cny:null;
  row.quantityAchievement=target?.quantity>0&&row.qty!=null?row.qty/target.quantity:null;
  row.budgetUse=target?.budget_cny>0&&row.adCostCny!=null?row.adCostCny/target.budget_cny:null;
  row.overBudget=target&&row.adCostCny!=null?Math.max(0,round(row.adCostCny-target.budget_cny)):null;
  row.roas=row.revenueComplete&&row.costComplete&&row.adCostCny>0?row.revenueCny/row.adCostCny:null;
  return row;
 });
 const total=summarizeTargets(rows),share=r=>({...r,revenueShare:total.revenueCny>0&&r.revenueCny!=null?r.revenueCny/total.revenueCny:null,quantityShare:total.qty>0&&r.qty!=null?r.qty/total.qty:null,inventoryShare:total.held>0?r.held/total.held:null});
 const group=key=>[...new Set(rows.map(key))].map(name=>{const members=rows.filter(r=>key(r)===name);return share({name,scopes:members.map(r=>r.key),...summarizeTargets(members)});});
 return {month,rows:rows.map(share),total,groups:group(r=>r.channel),sites:group(r=>r.site),people:group(r=>r.target?r.target.owner_id:'unassigned').map(p=>({...p,name:p.name==='unassigned'?'未分配任务':rows.find(r=>r.target?.owner_id===p.name)?.ownerName,id:p.name})),fx,generatedAt:now.toISOString(),inventoryAt:now.toISOString()};
}
