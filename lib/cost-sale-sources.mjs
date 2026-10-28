// A read model only: wholesale events must never be inserted into online sales
// records, because their shipment has already reduced physical inventory.
const rows=async(db,sql,args=[])=>(await db.prepare(sql).bind(...args).all()).results||[];
export async function costSalesSources(db,actor){
 const scoped=actor.role==='运营';
 const online=await rows(db,'SELECT id,site,channel,sku,qty,reported_amount,currency,reversed_at,business_date,source_ref FROM sales_records'+(scoped?' WHERE site=? AND channel=?':''),scoped?[actor.site,actor.channel]:[]);
 if(scoped)return online.map(r=>({...r,sourceKind:'online'}));
 const [shipments,consignment,returns,allocations]=await Promise.all([
  rows(db,`SELECT si.id,i.id item_id,i.sku,si.qty,si.amount,si.allocations_json,s.business_date,s.shipment_no,o.order_no,o.sale_type FROM wholesale_shipment_items si JOIN wholesale_shipments s ON s.id=si.shipment_id JOIN wholesale_order_items i ON i.id=si.order_item_id JOIN wholesale_orders o ON o.id=i.order_id WHERE o.sale_type<>'consignment' ORDER BY s.business_date,s.created_at,si.id`),
  rows(db,`SELECT c.*,i.sku,o.order_no FROM wholesale_consignment_sales c JOIN wholesale_order_items i ON i.id=c.order_item_id JOIN wholesale_orders o ON o.id=c.order_id ORDER BY c.business_date,c.created_at,c.id`),
  rows(db,`SELECT r.*,o.sale_type FROM wholesale_returns r JOIN wholesale_orders o ON o.id=r.order_id ORDER BY r.business_date,r.created_at,r.id`),
  rows(db,`SELECT order_item_id,channel,SUM(shipped_qty-returned_qty) qty FROM wholesale_allocations GROUP BY order_item_id,channel`)
 ]);
 const events=[...shipments.map(r=>({...r,item_id:r.item_id,id:'whs:'+r.id,sourceKind:'wholesale',source_ref:r.order_no+' / '+r.shipment_no})),...consignment.filter(r=>r.qty>0).map(r=>({...r,item_id:r.order_item_id,id:'whc:'+r.id,sourceKind:'consignment',source_ref:r.order_no+' / '+r.reference}))].map(r=>({id:r.id,item_id:r.item_id,sku:r.sku,site:'印尼',channel:'线下分销',qty:r.qty,originalQty:r.qty,reported_amount:r.amount,originalAmount:r.amount,currency:'IDR',business_date:r.business_date,source_ref:r.source_ref,sourceKind:r.sourceKind,stockSourceKey:r.sourceKind==='consignment'?'consigned:'+r.item_id:r.id,stockChannels:r.sourceKind==='consignment'?allocations.filter(a=>a.order_item_id===r.item_id).map(a=>({channel:a.channel,qty:a.qty})):JSON.parse(r.allocations_json||'[]'),adjustments:[]}));
 // Returns and negative sell-through corrections invalidate only the affected
 // positive sources. Preserve evidence so a cost-link replacement is explicit.
 const corrections=[...returns.map(r=>({id:r.id,item:r.order_item_id,qty:r.sale_type==='consignment'?r.consignment_sold_qty:r.qty,date:r.business_date})),...consignment.filter(r=>r.qty<0).map(r=>({id:r.id,item:r.order_item_id,qty:-r.qty,date:r.business_date}))].sort((a,b)=>a.date.localeCompare(b.date)||a.id.localeCompare(b.id));
 for(const correction of corrections){let left=correction.qty;for(const e of events.filter(e=>e.item_id===correction.item&&e.business_date<=correction.date).sort((a,b)=>a.business_date.localeCompare(b.business_date)||a.id.localeCompare(b.id))){const n=Math.min(left,e.qty);if(!n)continue;e.qty-=n;left-=n;e.adjustments.push({id:correction.id,qty:n,date:correction.date});e.reported_amount=Math.round(e.originalAmount*e.qty/e.originalQty);}}
 return [...online.map(r=>({...r,sourceKind:'online'})),...events.map(e=>({...e,reversed_at:e.qty===0?'fully_returned':null}))];
}
