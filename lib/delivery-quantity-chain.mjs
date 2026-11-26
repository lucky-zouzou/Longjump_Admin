const parse=x=>{try{return typeof x==='string'?JSON.parse(x):x;}catch{return null;}};
const scopeQty=(items,site,channel)=>{if(!Array.isArray(items))return null;const matches=items.filter(x=>x.site===site&&x.channel===channel);return matches.length?matches.reduce((n,x)=>n+Number(x.qty||0),0):null;};
// Project quantities only. Purchase prices, contract text and other site allocations stay private.
export function deliveryQuantityChain({leg,item,production,purchase,document,effectiveDocument}){
 const original=parse(document)?.items?.find(x=>x.sku===item.sku),effective=parse(effectiveDocument)?.items?.find(x=>x.sku===item.sku);
 const demand=scopeQty(original?.demandAllocations||original?.allocations,leg.site,leg.channel),approved=scopeQty(parse(production?.dispatch_allocations_json||purchase?.allocations_json),leg.site,leg.channel);
 return {demandQty:demand,factoryQty:approved,cartonQty:effective?.cartonQty||original?.cartonQty||null,adjustment:demand==null||approved==null?null:approved-demand,ticketQty:Number(item.qty),receivedQty:Number(item.received_qty),shelvedQty:Number(item.sellable_qty),pendingQty:Number(item.pending_shelf_qty),quarantineQty:Number(item.quarantine_qty),unreceivedQty:Number(item.qty)-Number(item.received_qty),basis:'参考及工厂数量为本站点渠道整张原订单；发运、实收和上架为当前票次，分批发运不要求单票等于整单。'};
}
