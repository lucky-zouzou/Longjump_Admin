import {effectiveCost} from './effective-cost.mjs';

// Product costs use ten-thousandths of CNY. Never substitute a landed total
// for the supplier's purchase price, or silently treat an unknown cost as zero.
export function matchReplenishmentCost(costs,site,sku,date){
 const c=effectiveCost(costs,site,sku,date);
 return {site,sku,currency:'CNY',costId:c?.id||null,version:c?.version||null,effectiveDate:c?.effective_date||null,
  purchase:c?.purchase==null?null:Number(c.purchase)/10000,total:c?.total==null?null:Number(c.total)/10000,
  basis:c?.basis||'unconfirmed',matched:!!c,complete:c?.basis==='landed'&&c?.total!=null};
}
export async function loadReplenishmentCosts(db,site,date){
 const costs=(await db.prepare('SELECT * FROM product_cost_versions WHERE site=? AND effective_date<=? ORDER BY sku,effective_date DESC,version DESC').bind(site,date).all()).results||[];
 return [...new Set(costs.map(c=>c.sku))].map(sku=>matchReplenishmentCost(costs,site,sku,date));
}
export function procurementCostReference(costs,item,date){
 const references=item.allocations.map(a=>({...matchReplenishmentCost(costs,a.site,item.sku,date),qty:a.qty,channel:a.channel}));
 const values=[...new Set(references.map(c=>c.purchase))];
 const purchaseReference=values.length===1&&values[0]!=null?values[0]:null;
 return {references,purchaseReference,reason:purchaseReference!=null?'已匹配采购成本；请核对本单不含税采购价':references.some(c=>c.purchase!=null)?'各站采购成本不一致，请供应链核价':'未提供采购成本明细，请供应链核价；综合成本不可当作采购价'};
}
export function costSummary(items){
 let known=0,missing=0,unconfirmed=0;
 for(const i of items){if(i.cost?.total==null)missing++;else {known+=Math.round(i.cost.total*10000)*Number(i.qty);if(!i.cost.complete)unconfirmed++;}}
 return {knownAmount:known/10000,missing,unconfirmed,complete:missing===0&&unconfirmed===0};
}
// Factory documents contain approved purchase prices only. Internal landed
// costs and destination cost comparisons remain with operations/management.
export function factoryPurchaseDocument(document){
 return {...document,items:(document.items||[]).map(({costReference,...item})=>item)};
}
