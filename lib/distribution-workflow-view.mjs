// Read-only presentation of existing facts. Mutations still enforce server permissions.
const sum=(items,key)=>items.reduce((n,i)=>n+Number(i[key]||0),0);
export function domesticActions(o,c,actor){
 const items=o.items||[],f=o.financial||{},entries=o.entries||[],packed=sum(items,'packed_qty'),shipped=sum(items,'shipped_qty'),received=sum(items,'received_qty'),total=sum(items,'qty'),out=[];
 const independent=actor.id!==o.creator_id&&actor.id!==o.supply_user_id;
 if(c.manage){if(['draft','rejected'].includes(o.status))out.push('quoteConfirm','orderRevise');if(o.status==='quoted')out.push('contractSubmit');if(o.status==='approved'&&shipped>received)out.push('receive');}
 if(c.approve&&independent&&o.status==='contract_pending')out.push('contractDecide');
 if(c.finance&&o.status==='approved'){
  if(f.contractOutstandingMinor>0)out.push('financeConfirm');
  if(!o.canShip&&shipped<total&&independent)out.push('releaseConfirm');
  if(o.settlement_mode==='consignment'&&received>sum(items,'sold_qty'))out.push('consignmentSale');
 }
 if(c.execute&&o.status==='approved'){
  if(o.canShip&&packed>shipped)out.push('ship');
  if(packed<total)out.push('pack');
 }
 if(c.approve&&independent){if(['quoted','contract_pending','approved'].includes(o.status)&&!packed)out.push('orderReturn');if(o.status!=='cancelled'&&!shipped)out.push('orderCancel');}
 if(c.finance){
  if((o.paymentSubmissions||[]).some(s=>s.status==='pending'&&s.actor_id!==actor.id))out.push('paymentProofReject');
  if(entries.some(e=>e.kind==='receipt'&&!entries.some(r=>r.related_id===e.id)))out.push('financeReverse');
  if((['draft','rejected','cancelled'].includes(o.status)?f.paidMinor:f.refundDueMinor)>0)out.push('financeRefund');
  if(entries.some(e=>e.kind==='refund'&&!entries.some(r=>r.related_id===e.id)))out.push('financeRefundReverse');
 }
 return out;
}
export function domesticStage(o){
 if(o.status==='cancelled')return 'cancelled';
 if(['draft','rejected'].includes(o.status))return 'quote';
 if(o.status==='quoted')return 'contract';
 if(o.status==='contract_pending')return 'review';
 const f=o.fulfillment;
 if(f.packed<f.total)return 'pack';
 if(f.shipped<f.total)return o.canShip?'ship':'release';
 if(f.received<f.shipped)return 'receive';
 return o.financial?.unsettledConsignmentQty>0?'consignment':o.financial?.contractOutstandingMinor>0?'collection':o.financial?.refundDueMinor>0?'refund':'delivered';
}
export function wholesaleFollowup(o,today=new Date(Date.now()+7*3600000).toISOString().slice(0,10)){
 const mode=o.workflow?.mode||o.sale_type;
 const unsold=mode==='consignment'?Math.max(0,sum(o.items||[],'shipped_qty')-sum(o.items||[],'returned_qty')-sum(o.consignmentSales||[],'qty')+sum(o.returns||[],'consignment_sold_qty')):0;
 const actionable=!['pending','rejected','cancelled'].includes(o.status);
 return {unsold,overdue:Boolean(actionable&&o.due_date&&o.due_date<today&&(Number(o.outstanding)>0||unsold>0)),receiptPending:Number(o.customerReceipt?.pending||0),settled:actionable&&Number(o.outstanding)===0&&Number(o.refundDue)===0&&unsold===0};
}
export function sampleWorkKinds(o,{warehouseReady=true,followContent=false}={}){
 if(['rejected','cancelled'].includes(o.status))return [];
 const c=o.capabilities||{},ships=o.shipments||[],kinds=[];
 if(c.review)kinds.push('review');
 if(c.assign&&(o.status==='approved'||!warehouseReady))kinds.push('assign');
 if(c.ship&&warehouseReady)kinds.push('ship');
 if(c.receipt&&ships.some(s=>!s.receipt))kinds.push('receipt');
 if(c.cost&&ships.some(s=>['sample','freight'].some(k=>!(s.costs||[]).some(v=>v.kind===k))))kinds.push('cost');
 if(followContent&&o.terms?.sampleOnly!==true&&['approved','executing'].includes(o.contentStatus))kinds.push('content');
 return kinds;
}
