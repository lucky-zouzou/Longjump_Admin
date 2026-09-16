import { canWholesale, settlement, WholesaleError } from "./wholesale.mjs";
const parse=(value,fallback={})=>{try{return JSON.parse(value);}catch{return fallback;}};
export async function loadWholesaleExportSnapshot(db,actor){
  if(!canWholesale(actor))throw new WholesaleError(403,"无权导出印尼线下订单");
  const global=["管理员","财务"].includes(actor.role),scope=global?"1=1":(actor.role==="供应链"?"o.supply_user_id=?":"COALESCE(o.service_user_id,o.sales_user_id)=?"),args=global?[]:[actor.id];
  const queries=[
    `SELECT o.*,u.name sales_name,v.name supply_name FROM wholesale_orders o LEFT JOIN users u ON u.id=o.sales_user_id LEFT JOIN users v ON v.id=o.supply_user_id WHERE ${scope} ORDER BY o.business_date,o.order_no`,
    `SELECT i.* FROM wholesale_order_items i JOIN wholesale_orders o ON o.id=i.order_id WHERE ${scope} ORDER BY i.order_id,i.sku`,
    `SELECT s.* FROM wholesale_shipments s JOIN wholesale_orders o ON o.id=s.order_id WHERE ${scope} ORDER BY s.business_date,s.shipment_no`,
    `SELECT i.* FROM wholesale_shipment_items i JOIN wholesale_shipments s ON s.id=i.shipment_id JOIN wholesale_orders o ON o.id=s.order_id WHERE ${scope} ORDER BY s.business_date,s.shipment_no,i.id`,
    `SELECT e.*,u.name actor_name FROM wholesale_finance_entries e JOIN wholesale_orders o ON o.id=e.order_id LEFT JOIN users u ON u.id=e.actor_id WHERE ${scope} ORDER BY e.business_date,e.created_at,e.id`,
    `SELECT r.* FROM wholesale_returns r JOIN wholesale_orders o ON o.id=r.order_id WHERE ${scope} ORDER BY r.business_date,r.created_at,r.id`,
  ];
  const financialGlobal=["管理员","财务"].includes(actor.role);
  // A single read-only D1 batch gives all sheets the same database snapshot.
  const extra=[db.prepare("SELECT version FROM wholesale_finance_clock WHERE id='global'"),db.prepare(financialGlobal?"SELECT b.*,c.name customer_name FROM wholesale_bank_receipts b LEFT JOIN wholesale_customers c ON c.id=b.customer_id ORDER BY b.business_date,b.id":"SELECT * FROM wholesale_bank_receipts WHERE 1=0"),db.prepare(financialGlobal?"SELECT * FROM wholesale_bank_events ORDER BY business_date,id":"SELECT * FROM wholesale_bank_events WHERE 1=0")];
  const results=await db.batch([...queries.map(sql=>db.prepare(sql).bind(...args)),...extra]);
  if(results.length!==queries.length+extra.length||results.some(r=>r.success!==true||!Array.isArray(r.results)))throw new WholesaleError(500,"订单数据读取不完整，请重新导出");
  const [orders,items,shipments,shipmentItems,entries,returns]=results.map(r=>r.results||[]);
  const group=(list,key)=>{const map=new Map();for(const row of list){const values=map.get(row[key])||[];values.push(row);map.set(row[key],values);}return map;};
  const itemMap=group(items,"order_id"),shipmentMap=group(shipments,"order_id"),lineMap=group(shipmentItems,"shipment_id"),entryMap=group(entries,"order_id"),returnMap=group(returns,"order_id");
  return {actor,financeVersion:Number(results[6].results[0]?.version||0),bankReceipts:results[7].results,bankEvents:results[8].results,orders:orders.map(o=>{const payments=entryMap.get(o.id)||[],back=returnMap.get(o.id)||[];return {...o,customer:parse(o.customer_json),items:itemMap.get(o.id)||[],shipments:(shipmentMap.get(o.id)||[]).map(s=>({...s,items:lineMap.get(s.id)||[]})),entries:payments,returns:back,...settlement(o,payments,back)};})};
}
