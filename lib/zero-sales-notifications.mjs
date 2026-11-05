import {financeClock} from './finance-periods.mjs';
const summaryCache=new WeakMap();
import {readClearanceZeroSales} from './clearance-zero-sales.mjs';
import {zeroSalesAlert} from './zero-sales-alert-model.mjs';
import {canClearance,clearanceSites} from './clearance-model.mjs';
import {localDay} from './promotion-model.mjs';

// Rebuilt from live business evidence, not appended as a new notice every day.
// No read receipt can suppress a still-unresolved inventory problem.
export async function zeroSalesNotifications(db,actor,now=new Date()){
 if(!canClearance(actor))return [];
 if(actor.role==='运营'&&(!clearanceSites.includes(actor.site)||!['TikTok','Shopee'].includes(actor.channel)))return [];
 const sites=actor.role==='运营'?[actor.site]:clearanceSites,tasks=[];
 const months=[...new Set(sites.map(site=>localDay(now,site).slice(0,7)))];
 const clock=await financeClock(db),k=JSON.stringify([actor.id,actor.role,actor.site,actor.channel,...sites.map(site=>localDay(now,site))]);
 const cache=summaryCache.get(db)||new Map();summaryCache.set(db,cache);
 if(cache.get(k)?.clock===clock)return cache.get(k).tasks;
 const next=actor.role==='运营'?'核对原因，申请促销价并登记行动':actor.role==='财务'?'核对成本、支持预算及去库存损益':'分配责任人，督办去库存与七天复查';
 for(const month of months){
 const bySite=new Map();
 const data=await readClearanceZeroSales(db,actor,month,now,null,row=>{const alert=zeroSalesAlert(row);if(!alert)return;const list=bySite.get(row.site)||[];list.push({alert});bySite.set(row.site,list);});
 for(const site of data.sites.filter(s=>localDay(now,s.site).slice(0,7)===month)){
  const candidates=bySite.get(site.site)||[];
  if(!candidates.length)continue;
  const count=kind=>candidates.filter(r=>r.alert.kind===kind).length;
  const confirmed=count('confirmed'),verify=count('verify'),pending=count('pending');
  tasks.push({id:`zero-sales:${site.site}`,kind:'zero-sales-alert',tab:'clearance',view:`zero-alerts:${site.site}`,month:localDay(now,site.site).slice(0,7),level:confirmed?'red':'amber',
   title:`${site.site} · 7天零动销提醒`,detail:`已确认 ${confirmed} · 连续有货待核实 ${verify} · 日报/库存待核实 ${pending}；${next}`,
   alert:{site:site.site,start:site.start,cutoff:site.cutoff,scope:data.scope,channel:actor.role==='运营'?actor.channel:'',confirmed,verify,pending,total:candidates.length,
    available:candidates.reduce((n,r)=>n+r.alert.available,0),unknownStocks:candidates.filter(r=>!r.alert.stockKnown).length,
    knownValueCny:Math.round(candidates.reduce((n,r)=>n+(r.alert.valueCny??0),0)*100)/100,missingCosts:candidates.filter(r=>r.alert.valueCny==null).length,
    partialCosts:candidates.filter(r=>r.alert.valueCny!=null&&!r.alert.costComplete).length,following:candidates.filter(r=>r.alert.following).length,next}
  });
 }
 }
 if(clock===await financeClock(db)){if(cache.size>=80)cache.delete(cache.keys().next().value);cache.set(k,{clock,tasks});}
 return tasks;
}
