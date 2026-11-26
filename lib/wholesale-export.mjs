import { wholesaleScope, releaseEligibility } from './wholesale-workflow.mjs';
import { canWholesale, settlement, WholesaleError } from "./wholesale.mjs";
const parse=(value,fallback={})=>{try{return JSON.parse(value);}catch{return fallback;}};
export async function loadWholesaleExportSnapshot(db,actor,series=null){
  if(!canWholesale(actor))throw new WholesaleError(403,"无权导出印尼线下订单");
  const {sql:scope,args}=wholesaleScope(actor);
  const orderScope=series===null?scope:scope+" AND EXISTS(SELECT 1 FROM wholesale_order_items wi JOIN sku_settings sk ON sk.sku=wi.sku WHERE wi.order_id=o.id AND sk.product_series=?)";
  if(series!==null)args.push(series);
  const queries=[
    `SELECT o.*,u.name sales_name,v.name supply_name,w.settlement_mode wf_mode,w.contract_reference wf_contract,w.reservation_expires_at wf_expiry,w.customer_confirmed_at wf_confirmed,w.warehouse wf_warehouse,w.pack_proof_json wf_proofs,r.id release_id,r.instruction_no release_no,r.issued_at release_at,r.issued_by release_by,r.basis_json release_basis,r.items_json release_items FROM wholesale_orders o LEFT JOIN wholesale_workflows w ON w.order_id=o.id LEFT JOIN wholesale_release_instructions r ON r.order_id=o.id LEFT JOIN users u ON u.id=o.sales_user_id LEFT JOIN users v ON v.id=o.supply_user_id WHERE ${orderScope} ORDER BY o.business_date,o.order_no`,
    `SELECT i.* FROM wholesale_order_items i JOIN wholesale_orders o ON o.id=i.order_id WHERE ${orderScope} ORDER BY i.order_id,i.sku`,
    `SELECT s.*,u.name actor_name FROM wholesale_shipments s LEFT JOIN users u ON u.id=s.actor_id JOIN wholesale_orders o ON o.id=s.order_id WHERE ${orderScope} ORDER BY s.business_date,s.shipment_no`,
    `SELECT i.* FROM wholesale_shipment_items i JOIN wholesale_shipments s ON s.id=i.shipment_id JOIN wholesale_orders o ON o.id=s.order_id WHERE ${orderScope} ORDER BY s.business_date,s.shipment_no,i.id`,
    `SELECT e.*,u.name actor_name FROM wholesale_finance_entries e JOIN wholesale_orders o ON o.id=e.order_id LEFT JOIN users u ON u.id=e.actor_id WHERE ${orderScope} ORDER BY e.business_date,e.created_at,e.id`,
    `SELECT r.* FROM wholesale_returns r JOIN wholesale_orders o ON o.id=r.order_id WHERE ${orderScope} ORDER BY r.business_date,r.created_at,r.id`,
    `SELECT c.* FROM wholesale_consignment_sales c JOIN wholesale_orders o ON o.id=c.order_id WHERE ${orderScope} ORDER BY c.business_date,c.created_at`,
  ];
  const financialGlobal=series===null&&["管理员","财务"].includes(actor.role);
  // A single read-only D1 batch gives all sheets the same database snapshot.
  const extra=[db.prepare("SELECT version FROM wholesale_finance_clock WHERE id='global'"),db.prepare(financialGlobal?"SELECT b.*,c.name customer_name FROM wholesale_bank_receipts b LEFT JOIN wholesale_customers c ON c.id=b.customer_id ORDER BY b.business_date,b.id":"SELECT * FROM wholesale_bank_receipts WHERE 1=0"),db.prepare(financialGlobal?"SELECT * FROM wholesale_bank_events ORDER BY business_date,id":"SELECT * FROM wholesale_bank_events WHERE 1=0")];
  const results=await db.batch([...queries.map(sql=>db.prepare(sql).bind(...args)),...extra]);
  if(results.length!==queries.length+extra.length||results.some(r=>r.success!==true||!Array.isArray(r.results)))throw new WholesaleError(500,"订单数据读取不完整，请重新导出");
  const [orders,items,shipments,shipmentItems,entries,returns,consignmentSales]=results.map(r=>r.results||[]);
  const group=(list,key)=>{const map=new Map();for(const row of list){const values=map.get(row[key])||[];values.push(row);map.set(row[key],values);}return map;};
  const itemMap=group(items,"order_id"),shipmentMap=group(shipments,"order_id"),lineMap=group(shipmentItems,"shipment_id"),entryMap=group(entries,"order_id"),returnMap=group(returns,"order_id");
  return {actor,financeVersion:Number(results[7].results[0]?.version||0),bankReceipts:results[8].results,bankEvents:results[9].results,orders:orders.map(o=>{const payments=entryMap.get(o.id)||[],back=returnMap.get(o.id)||[],consignment=consignmentSales.filter(s=>s.order_id===o.id);const money=settlement(o,payments,back,consignment),workflow=o.workflow_version===2?{mode:o.wf_mode,contractReference:o.wf_contract,reservationExpiresAt:o.wf_expiry,customerConfirmedAt:o.wf_confirmed,warehouse:o.wf_warehouse,packProofs:parse(o.wf_proofs,[]),releaseInstruction:o.release_id?{id:o.release_id,no:o.release_no,issuedAt:o.release_at,issuedBy:o.release_by,basis:parse(o.release_basis),items:parse(o.release_items,[])}:null,releaseReason:releaseEligibility(o,{settlement_mode:o.wf_mode,contract_reference:o.wf_contract,customer_confirmed_at:o.wf_confirmed},money)}:null;return {...o,workflow,consignmentSales:consignment,customer:parse(o.customer_json),items:itemMap.get(o.id)||[],shipments:(shipmentMap.get(o.id)||[]).map(s=>({...s,items:lineMap.get(s.id)||[]})),entries:payments,returns:back,...settlement(o,payments,back,consignment)};})};
}
