import {prorateAllocations} from './rules.mjs';
const stages=new Set(['sea_freight','port_arrived','customs_clearance','last_mile_delivery','awaiting_receipt']);
const allocations=json=>{try{return JSON.parse(json||'[]')}catch{return []}};
export function transitLots({batches,shipmentRows,shipmentItemRows,receipts,transportLegRows,transportLegItemRows}){
 const result=[],ship=new Map(shipmentRows.map(b=>[b.id,b])),legs=new Map(transportLegRows.map(l=>[l.id,l])),received=new Map();
 for(const r of receipts){const group=received.get(r.batch_item_id)||[];group.push(...allocations(r.allocations_json));received.set(r.batch_item_id,group);}
 const add=(a,sku,eta,source)=>{if(a.site&&a.channel&&Number(a.qty)>0)result.push({...a,qty:Number(a.qty),sku,eta,source})};
 for(const b of batches)if(stages.has(b.stage))for(const a of allocations(b.allocations_json))add(a,b.sku,b.estimated_arrival_date,'production:'+b.id);
 for(const i of shipmentItemRows){const b=ship.get(i.batch_id);if(!b||!stages.has(b.stage))continue;
  const orig=allocations(i.allocations_json),rs=received.get(i.id)||[],remaining=orig.map(a=>({...a,qty:Math.max(0,a.qty-rs.filter(r=>r.site===a.site&&r.channel===a.channel).reduce((s,r)=>s+r.qty,0))}));
  for(const a of prorateAllocations(remaining,Math.max(0,i.shipped_qty-i.received_qty)))add(a,i.sku,b.estimated_arrival_date,'shipment:'+i.id);
 }
 for(const i of transportLegItemRows){const l=legs.get(i.leg_id);if(l&&stages.has(l.stage))add({site:l.site,channel:l.channel,qty:i.qty-i.received_qty},i.sku,l.eta,'transport:'+i.id);}
 return result;
}
export async function loadTransitLots(db,series=null){
 const tables={batches:'production_batches',shipmentRows:'shipment_batches',shipmentItemRows:'shipment_batch_items',receipts:'shipment_receipt_items',transportLegRows:'transport_legs',transportLegItemRows:'transport_leg_items'};
 const match='sku IN (SELECT sku FROM sku_settings WHERE product_series=?)';
 const filters={
  batches:match,shipmentItemRows:match,transportLegItemRows:match,
  shipmentRows:`id IN (SELECT batch_id FROM shipment_batch_items WHERE ${match})`,
  receipts:`batch_item_id IN (SELECT id FROM shipment_batch_items WHERE ${match})`,
  transportLegRows:`id IN (SELECT leg_id FROM transport_leg_items WHERE ${match})`,
 };
 const records=await Promise.all(Object.entries(tables).map(async ([key,table])=>{
  const sql='SELECT * FROM '+table;
  const query=series===null?db.prepare(sql):db.prepare(sql+' WHERE '+filters[key]).bind(series);
  return [key,(await query.all()).results];
 }));
 return transitLots(Object.fromEntries(records));
}
