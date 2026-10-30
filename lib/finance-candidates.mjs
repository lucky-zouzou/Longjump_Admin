import { localDay } from './promotion-model.mjs';
const rows=async(db,sql,args=[])=>(await db.prepare(sql).bind(...args).all()).results||[];
export function purchaseInvoiceCandidates(purchases,documents){
 return purchases.filter(p=>p.approved).map(p=>({...p,items:p.items.map(i=>{
  const billedQty=documents.filter(d=>d.kind==='supplier_bill'&&d.status==='active'&&d.data.purchaseOrderId===p.id).flatMap(d=>d.data.lines||[]).filter(l=>l.sku===i.sku).reduce((n,l)=>n+l.qty,0);
  return {...i,billedQty,candidateQty:Math.max(0,Math.min(i.ordered_qty,i.receivedQty)-billedQty)};
 })}));
}
export function saleLotCandidates(sales,tickets){
 return sales.filter(s=>s.availableQty>0).map(s=>({...s,options:tickets.filter(t=>t.site===s.site&&(t.channel===s.channel||s.channel==='线下分销'&&s.stockChannels?.some(c=>c.channel===t.channel&&c.qty>0))&&t.reviewed_at&&t.data.effectiveAt<=s.business_date).flatMap(t=>t.lots.filter(l=>l.sku===s.sku&&l.remainingQty>0&&!l.estimated&&!l.missing.length).map(l=>({ticketKey:t.business_key,lineKey:l.lineKey,remainingQty:l.remainingQty,batch:l.batch,source:t.data.source,revision:t.revision,channel:t.channel}))),note:'候选按同站点、SKU、日期、已复核成本筛选；须按出库凭据选择真实批次，多候选不自动分配'}));
}
export async function inboundCostCandidates(db,tickets){
 const linked=new Set(tickets.map(t=>t.data.legId).filter(Boolean));
 const legs=await rows(db,"SELECT * FROM transport_legs WHERE id IN (SELECT leg_id FROM transport_leg_items WHERE received_qty>0)");
 const receiptDates=await rows(db,'SELECT leg_id,MIN(received_at) first_receipt FROM transport_receipts GROUP BY leg_id');
 const lines=await rows(db,`SELECT li.id lineKey,li.leg_id,li.sku,li.qty,li.received_qty,bi.production_order_id,po.id poId,po.order_ref,po.document_json FROM transport_leg_items li JOIN transport_batch_items bi ON bi.id=li.batch_item_id JOIN series_production_orders pr ON pr.id=bi.production_order_id JOIN series_purchase_orders po ON po.id=pr.purchase_order_id`);
 return legs.filter(l=>!linked.has(l.id)).map(l=>({id:l.id,site:l.site,channel:l.channel,warehouse:l.warehouse_name,arrivedAt:(receiptDates.find(r=>r.leg_id===l.id)?.first_receipt?localDay(receiptDates.find(r=>r.leg_id===l.id).first_receipt,l.site):null),eta:l.eta,items:lines.filter(i=>i.leg_id===l.id).map(i=>{const doc=JSON.parse(i.document_json||'{}');return {lineKey:i.lineKey,sku:i.sku,qty:i.qty,receivedQty:i.received_qty,purchaseOrderId:i.poId,purchaseReference:i.order_ref,currency:doc.currency||null,approvedPurchasePrice:doc.items?.find(x=>x.sku===i.sku)?.purchasePrice??null,batch:i.production_order_id};}),note:'已收货运输来源候选；采购价是已批价，须核对发票，海运/税费/入仓凭据尚未填入。不自动入账或再次入库'}));
}
