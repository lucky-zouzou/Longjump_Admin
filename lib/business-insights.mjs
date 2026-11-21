// Derived views only. Sources remain the authority; no automatic posting or assignment.
export function financeBrief(balances,rates={},cutoff=''){
 const groups=new Map();
 for(const r of balances){if(!['supplier_bill','supplier_payment','platform_settlement','platform_receipt'].includes(r.kind))continue;
  const key=r.kind+'|'+r.currency,g=groups.get(key)||{kind:r.kind,currency:r.currency,count:0,remainingMinor:0,agedMinor:0};
  if(r.remaining===0)continue;g.count++;g.remainingMinor+=r.remaining;
  if(cutoff&&Date.parse(cutoff)-Date.parse(r.business_date)>30*86400000)g.agedMinor+=r.remaining;
  groups.set(key,g);
 }
 return [...groups.values()].map(g=>{const rate=g.currency==='CNY'?1:rates[g.currency]?.rate;return {...g,cnyMinor:rate>0?Math.round(g.remainingMinor*rate):null,rate:rate>0?rate:null};});
}
export function distributionFunnel(stores){
 const active=stores.filter(s=>s.status==='active'),activated=active.filter(s=>s.activated),first=activated.filter(s=>s.valid_order_count>0),repeat=first.filter(s=>s.valid_order_count>1);
 return {registered:stores.length,active:active.length,activated:activated.length,first:first.length,repeat:repeat.length,
 activationRate:active.length?activated.length/active.length:null,firstOrderRate:activated.length?first.length/activated.length:null,repeatRate:first.length?repeat.length/first.length:null,
 segments:stores.map(s=>({customerId:s.customer_id,segment:s.status!=='active'?'review':!s.activated?'activate':!s.valid_order_count?'first':s.valid_order_count===1?'repeat':'retain'}))};
}
export function qualitySignals(records,today=new Date().toISOString().slice(0,10)){
 const groups=new Map();
 for(const r of records.filter(r=>!['draft','void'].includes(r.status))){
  const d=r.data||{},key=JSON.stringify([r.sku,d.reason,r.site]),g=groups.get(key)||{key,sku:r.sku,reason:d.reason,site:r.site,count:0,qty:0,overdue:0,failed:0,caseIds:[],weekly:{}};
  g.count++;g.qty+=Number(d.qty||0);g.caseIds.push(r.id);
  const day=new Date(r.business_date+'T00:00:00Z'),week=new Date(+day-((day.getUTCDay()+6)%7)*86400000).toISOString().slice(0,10);
  g.weekly[week]=(g.weekly[week]||0)+1;
  if(d.rectification){g.failed+=Number(d.rectification.outcome==='failed');g.overdue+=Number(d.rectification.outcome!=='effective'&&d.rectification.reviewDate<today);}
  groups.set(key,g);
 }
 return [...groups.values()].sort((a,b)=>b.overdue-a.overdue||b.failed-a.failed||b.count-a.count);
}
