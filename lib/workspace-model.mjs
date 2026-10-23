import {navigationForRole} from './permissions.mjs';

export const MODULE_FIELDS = {
  overview:['metrics','monthlyStatus','issues'],
  suggestions:['metrics','suggestions','submissions','skuSettings','supplyPolicies','forecastHistory','businessPartners','purchaseOrders','productionOrders','approvals','planChanges'],
  'new-products':['metrics','newProductProjects','skuSettings','users'],
  sales:['metrics','salesScopeStatus','skuSettings','adSpend','imports','salesTopSkus'],
  inventory:['inventory','countRequests','skuSettings'],
  receipt:['inboundDocuments','receipts','skuSettings','warehouses','batches','shipmentBatches','transportBatches'],
  monthly:['submissions','monthlyStatus','suggestions','skuSettings','supplyPolicies','currentMonth','approvals','users','planChanges','purchaseOrders','productionOrders'],
  approval:['approvals','submissions','monthlyStatus','skuSettings','inventory','users','purchaseOrders','productionOrders','planChanges'],
  fulfillment:['metrics','purchaseOrders','productionOrders','shipmentBatches','transportBatches','skuSettings','users','businessPartners','planChanges'],
  'production-tracking':['productionTracking'],
  batches:['metrics','batches','shipmentBatches','shipmentReceipts','transportBatches','transportReceipts','productionOrders','skuSettings','businessPartners','warehouses','users'],
  master:['businessPartners','warehouses','skuSettings','users'],
  audit:[],users:['users'],permissions:['users'],wholesale:[],reviews:[],'after-sales':[],'quality-incidents':[],promotions:[],'business-actions':[],
};
export function moduleSnapshot(snapshot,module,trend=''){
  if(!module)return snapshot; // Legacy clients remain compatible; permissions still apply.
  const allowed=new Set(['actor','currentMonth','generatedAt','myTasks',...(MODULE_FIELDS[module]||[])]);
  const result=Object.fromEntries(Object.entries(snapshot).map(([key,value])=>[key,allowed.has(key)?value:Array.isArray(value)?[]:key==='metrics'?{}:undefined]));
  if(result.suggestions)result.suggestions=result.suggestions.map(row=>{
    if(`${row.site}|${row.channel}|${row.sku}`===trend)return row;
    const {dailySeries,dailySales,adjustedDailySales,onlineDailySales,offlineDailySales,projection,simulation,...summary}=row;return summary;
  });
  if(module==='overview')result.issues=(result.issues||[]).slice(0,12);
  return {...result,module};
}

export const NAV_GROUPS=[
  {label:'日常工作',keys:['overview','business-actions','wholesale','sales','reviews','after-sales','promotions']},
  {label:'供应与履约',keys:['suggestions','monthly','approval','fulfillment','production-tracking','batches','inventory','receipt','quality-incidents']},
  {label:'产品与系统',keys:['new-products','master','users','audit','permissions']},
];
export function mobileModules(role){
  const main={管理员:['overview','approval','wholesale','inventory'],财务:['wholesale','overview','reviews','production-tracking'],销售:['wholesale','production-tracking'],运营:['sales','overview','after-sales','reviews'],供应链:['overview','fulfillment','batches','inventory'],工厂:['fulfillment','production-tracking','sales','after-sales'],海运:['batches','production-tracking','overview']}[role]||['overview','new-products','reviews'];
  return main.filter(key=>navigationForRole(role).includes(key)).slice(0,4);
}
export function readWorkspaceRoute(search=''){
  const q=new URLSearchParams(search);
  return {page:q.get('page')||'home',entity:q.get('entity')||'',view:q.get('view')||'',month:q.get('month')||'',search:q.get('search')||'',status:q.get('status')||'all'};
}
export function workspaceUrl(route){
  const q=new URLSearchParams();
  for(const key of ['page','entity','view','month','search','status'])if(route[key]&&!(key==='status'&&route[key]==='all'))q.set(key,String(route[key]));
  return '/?'+q.toString();
}
export const draftKey=(actor,key)=>`lj-draft:v1:${encodeURIComponent(actor)}:${key}`;
export function readDraft(storage,actor,key,now=Date.now()){
  try{const item=JSON.parse(storage.getItem(draftKey(actor,key))||'null');if(item&&item.actor===actor&&item.version===1&&Number.isFinite(item.savedAt)&&now>=item.savedAt&&now-item.savedAt<7*86400000)return item.value;}catch{}return null;
}
export function writeDraft(storage,actor,key,value,now=Date.now()){
  storage.setItem(draftKey(actor,key),JSON.stringify({actor,version:1,savedAt:now,value}));
}

export function validOrderDraft(value){
  if(!value||typeof value!=='object'||!value.form||!Array.isArray(value.items)||!value.items.length)return false;
  const form=value.form;
  return ['customerId','businessDate','paymentTerms','saleType','businessCode','dueDate','note'].every(k=>typeof form[k]==='string')&&typeof form.invoiceRequired==='boolean'&&value.items.every(row=>row&&['sku','qty','unitPrice','productColor','productSize'].every(k=>typeof row[k]==='string'));
}
