// Shipment confirmation is independent of dispatch, stock and financial settlement.
export function customerReceiptSummary(shipments,receipts){
 const active=new Set(receipts.filter(r=>!r.revoked_at).map(r=>r.shipment_id));
 const confirmed=shipments.filter(s=>active.has(s.id)).length;
 return {total:shipments.length,confirmed,pending:shipments.length-confirmed,
  status:!shipments.length?"尚未发货":confirmed===shipments.length?"已发批次全部收货":confirmed?"部分批次已收货":"待客户收货"};
}
