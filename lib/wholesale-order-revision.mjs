import { WholesaleError } from './wholesale.mjs';
import { latestPrices, priceSnapshot } from './wholesale-catalog.mjs';

const fail=(status,message)=>{throw new WholesaleError(status,message);};
const id=prefix=>`${prefix}_${crypto.randomUUID()}`;

// A pending order may already have immutable quote snapshots. Keep that complete
// application and create its replacement atomically instead of deleting SKU rows.
export async function revisePendingWholesaleOrder(db,actor,payload,order,items,commit){
  if(actor.role!=="管理员")fail(403,"仅管理员可修改待审批订单");
  if(order.status!=="pending")fail(409,"仅未审批、未收款的订单可修改商品");
  const reason=String(payload.reason??"").trim().slice(0,600);
  if(reason.length<4)fail(400,"请填写商品调整原因，至少4个字");
  if(!Array.isArray(payload.items)||payload.items.length!==items.length)fail(400,"请逐项确认原订单商品，移除商品请将数量设为0");
  const seen=new Set(),retained=[],changes=[];
  for(const input of payload.items){
    const item=items.find(i=>i.id===input.itemId),qty=Number(input.qty);
    if(!item||seen.has(item.id)||!Number.isSafeInteger(qty)||qty<0||qty>item.qty||input.qty===""||input.qty==null)fail(400,"仅可减少原订单数量或移除商品，不可增加、替换或重复商品");
    if((input.unitPrice!==undefined&&Number(input.unitPrice)!==item.unit_price)||(input.sku!==undefined&&input.sku!==item.sku))fail(400,"修改商品不能变更SKU或成交单价");
    seen.add(item.id);changes.push({sku:item.sku,itemId:item.id,beforeQty:item.qty,afterQty:qty,unitPrice:item.unit_price});
    if(qty)retained.push({...item,id:id("whitem"),qty,amount:qty*item.unit_price});
  }
  if(!retained.length)fail(400,"至少保留一个商品；整单不需要请使用取消订单");
  if(changes.every(i=>i.beforeQty===i.afterQty))fail(400,"商品数量没有变化");
  // Check facts again inside the transaction: uploads and finance operations need
  // not share the same application version as the approval screen.
  const pristine=`NOT EXISTS(SELECT 1 FROM wholesale_finance_entries WHERE order_id=?)
    AND NOT EXISTS(SELECT 1 FROM wholesale_files WHERE order_id=? AND purpose='finance')
    AND NOT EXISTS(SELECT 1 FROM wholesale_shipments WHERE order_id=?)
    AND NOT EXISTS(SELECT 1 FROM wholesale_returns WHERE order_id=?)
    AND NOT EXISTS(SELECT 1 FROM wholesale_consignment_sales WHERE order_id=?)
    AND NOT EXISTS(SELECT 1 FROM wholesale_allocations a JOIN wholesale_order_items i ON i.id=a.order_item_id WHERE i.order_id=?)
    AND NOT EXISTS(SELECT 1 FROM wholesale_order_items WHERE order_id=? AND (shipped_qty<>0 OR returned_qty<>0))`;
  const pristineArgs=Array(7).fill(order.id);
  if(!(await db.prepare(`SELECT (${pristine}) ok`).bind(...pristineArgs).first()).ok)fail(409,"本单已有库存预留、履约或财务凭据，请先由财务核对，不能直接修改商品");
  const replacementId=id("whorder"),now=new Date().toISOString(),orderNo=`ID-WH-${order.business_date.replaceAll("-","")}-${crypto.randomUUID().slice(0,8).toUpperCase()}`;
  const totalQty=retained.reduce((s,i)=>s+i.qty,0),totalAmount=retained.reduce((s,i)=>s+i.amount,0);
  const statements=[db.prepare(`INSERT INTO wholesale_orders
    (id,order_no,business_date,customer_id,customer_json,sales_user_id,service_user_id,creator_id,total_qty,total_amount,invoice_required,payment_terms,due_date,note,decision_note,created_at,updated_at,sale_type,business_code,pricing_policy_version,website_lead_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(replacementId,orderNo,order.business_date,order.customer_id,order.customer_json,order.sales_user_id,order.service_user_id,order.creator_id,totalQty,totalAmount,order.invoice_required,order.payment_terms,order.due_date,order.note,`由原单 ${order.order_no} 调整：${reason}`,now,now,order.sale_type,order.business_code,order.pricing_policy_version,order.website_lead_id)];
  let guard=`EXISTS(SELECT 1 FROM wholesale_orders WHERE id=? AND version=? AND status='pending') AND ${pristine}`;
  const args=[order.id,order.version,...pristineArgs],prices=await latestPrices(db);
  for(const item of retained){
    statements.push(db.prepare("INSERT INTO wholesale_order_items (id,order_id,sku,name,qty,unit_price,amount,product_color,product_size,price_request_id) VALUES (?,?,?,?,?,?,?,?,?,?)").bind(item.id,replacementId,item.sku,item.name,item.qty,item.unit_price,item.amount,item.product_color,item.product_size,item.price_request_id));
    if(item.price_request_id){
      const request=await db.prepare("SELECT * FROM wholesale_price_requests WHERE id=? AND used_order_id=?").bind(item.price_request_id,order.id).first();
      if(!request||item.qty>request.qty||item.unit_price!==request.approved_price)fail(409,"特批价格关联已变化，请刷新核对");
      guard+=" AND EXISTS(SELECT 1 FROM wholesale_price_requests WHERE id=? AND version=? AND used_order_id=?)";args.push(request.id,request.version,order.id);
      statements.push(db.prepare("UPDATE wholesale_price_requests SET used_order_id=?,version=version+1 WHERE id=?").bind(replacementId,request.id));
    }
    if(order.pricing_policy_version===1){
      const price=prices.find(p=>p.sku===item.sku);
      statements.push(priceSnapshot(db,actor,replacementId,item,"request",price,`原单 ${order.order_no} 调整；成交单价不变`));
      guard+=" AND COALESCE((SELECT MAX(version) FROM wholesale_prices WHERE sku=?),0)=?";args.push(item.sku,price?.version||0);
    }
  }
  const distributor=await db.prepare("SELECT * FROM distributor_orders WHERE order_id=?").bind(order.id).first();
  if(distributor)statements.push(db.prepare("INSERT INTO distributor_orders(order_id,customer_id,request_id,fingerprint) VALUES (?,?,?,?)").bind(replacementId,distributor.customer_id,id("revision"),JSON.stringify({originalOrderId:order.id,changes})));
  const detail={originalOrderId:order.id,originalOrderNo:order.order_no,replacementOrderId:replacementId,replacementOrderNo:orderNo,reason,changes,beforeAmount:order.total_amount,afterAmount:totalAmount};
  statements.push(
    db.prepare("UPDATE wholesale_orders SET status='cancelled',decision_note=?,version=version+1,updated_at=? WHERE id=?").bind(`商品已调整，后续请处理新单 ${orderNo}：${reason}`,now,order.id),
    db.prepare("INSERT INTO audit_logs(id,action,entity_type,entity_id,detail_json,actor_id,actor_name,created_at) VALUES (?,'wholesale.order.revised','印尼线下批发',?,?,?,?,?)").bind(id("audit"),order.id,JSON.stringify(detail),actor.id,actor.name,now)
  );
  return commit(db,actor,payload,replacementId,statements,guard,args);
}
