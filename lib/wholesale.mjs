import { manageWholesale, MANAGEMENT_ACTIONS } from "./wholesale-management.mjs";
import { assertWritable } from "./atomic.mjs";
import { hasPermission } from "./permissions.mjs";
import { monthlyReconciliation, orderFinancials } from "./wholesale-finance.mjs";

export class WholesaleError extends Error {
  constructor(status, message) { super(message); this.status=status; }
}
const fail=(status,message)=>{throw new WholesaleError(status,message);};
const text=(value,max=240)=>String(value??"").trim().slice(0,max);
const json=(value,fallback=[])=>{try{return JSON.parse(value);}catch{return fallback;}};
const uid=(prefix)=>`${prefix}_${crypto.randomUUID()}`;
const stamp=()=>new Date().toISOString();
export const indonesiaDate=()=>new Date(Date.now()+7*3600000).toISOString().slice(0,10);
const positive=(value,label)=>{const n=Number(value);if(!Number.isSafeInteger(n)||n<=0||n>1000000000000)fail(400,`${label}必须是有效的正整数`);return n;};
const date=(value)=>{const d=text(value,10);if(!/^\d{4}-\d{2}-\d{2}$/.test(d)||Number.isNaN(Date.parse(d))||new Date(d).toISOString().slice(0,10)!==d||d>indonesiaDate())fail(400,"业务日期无效或晚于印尼今天");return d;};
const stmt=(db,sql,args=[])=>db.prepare(sql).bind(...args);
const rows=async(db,sql,args=[]) => (await stmt(db,sql,args).all()).results??[];
const first=(db,sql,args=[])=>stmt(db,sql,args).first();
export const canWholesale=(actor)=>hasPermission(actor.role,"wholesale.read")&&(actor.role!=="运营"||actor.site==="印尼");
function permission(actor,key){if(!canWholesale(actor)||!hasPermission(actor.role,key))fail(403,"当前岗位或站点无权处理印尼线下批发业务");}
export function canReadWholesaleOrder(actor,order){return canWholesale(actor)&&(["管理员","财务"].includes(actor.role)||(actor.role==="供应链"?order.supply_user_id===actor.id:(order.service_user_id||order.sales_user_id)===actor.id));}
export function allocateAverage(qty,tiktok,shopee){
  positive(qty,"出库数量");
  const a=Math.max(0,Math.floor(Number(tiktok)||0)),b=Math.max(0,Math.floor(Number(shopee)||0));
  if(a+b<qty)fail(409,`库存不足：需要${qty}件，两个平台合计可用${a+b}件`);
  let x=Math.floor(qty/2)+(qty%2&&a>=b?1:0),y=qty-x;
  if(x>a){y+=x-a;x=a;}if(y>b){x+=y-b;y=b;}
  return [{channel:"TikTok",qty:x},{channel:"Shopee",qty:y}].filter(r=>r.qty>0);
}
export function settlement(order,entries,returns=[]){
  const sum=kind=>entries.filter(r=>r.kind===kind).reduce((s,r)=>s+Number(r.amount),0);
  const returned=returns.reduce((s,r)=>s+Number(r.amount),0);
  const payable=["cancelled","rejected"].includes(order.status)?0:Math.max(0,Number(order.total_amount)-Number(order.cancelled_amount||0)-returned);
  const paid=sum("receipt")-sum("receipt_void")-sum("receipt_unallocate")-sum("refund")+sum("refund_void"),invoiced=sum("invoice")-sum("invoice_void");
  return {payable,paid,invoiced,returned,outstanding:Math.max(0,payable-paid),refundDue:Math.max(0,paid-payable),invoiceRemaining:Math.max(0,payable-invoiced),
    paymentStatus:paid>payable?"待退款":payable===0?"无待收款":paid<=0?"未回款":paid<payable?"部分回款":"已回款",
    invoiceStatus:invoiced>payable?"待冲销":!order.invoice_required&&invoiced===0?"不需开票":invoiced===0?"待开票":invoiced<payable?"部分开票":"已开票"};
}
const audit=(db,actor,action,id,detail)=>stmt(db,"INSERT INTO audit_logs (id,action,entity_type,entity_id,detail_json,actor_id,actor_name,created_at) VALUES (?,?,?,?,?,?,?,?)",[uid("audit"),action,"印尼线下批发",id,JSON.stringify(detail),actor.id,actor.name,stamp()]);
const movement=(db,actor,channel,sku,delta,type,ref,note)=>stmt(db,"INSERT INTO inventory_movements (id,site,channel,sku,name,movement_type,qty_delta,balance_after,reference_type,reference_id,note,actor_id,created_at) SELECT ?,'印尼',channel,sku,name,?,?,qty,'线下批发',?,?,?,? FROM inventory_balances WHERE site='印尼' AND channel=? AND sku=?",[uid("move"),type,delta,ref,note,actor.id,stamp(),channel,sku]);
function visibleScope(actor,alias="o"){
  if(["管理员","财务"].includes(actor.role))return {sql:"1=1",args:[]};
  return {sql:actor.role==="供应链"?`${alias}.supply_user_id=?`:`COALESCE(${alias}.service_user_id,${alias}.sales_user_id)=?`,args:[actor.id]};
}
async function orderFor(db,actor,id){const order=await first(db,"SELECT * FROM wholesale_orders WHERE id=?",[text(id,100)]);if(!order)fail(404,"订单不存在");if(!canReadWholesaleOrder(actor,order))fail(403,"该订单不在本人责任范围内");return order;}
async function commit(db,actor,payload,id,statements,guard="1=1",args=[]){
  const operationId=text(payload.operationId,100);
  const insertion=stmt(db,`INSERT INTO wholesale_operations (id,order_id,action,actor_id,request_json,guard,created_at) VALUES (?,?,?,?,?,CASE WHEN (${guard}) THEN 1 ELSE 0 END,?)`,[operationId,id,payload.action,actor.id,JSON.stringify(payload),...args,stamp()]);
  try{await db.batch([insertion,...statements,audit(db,actor,payload.action,id,{operationId,version:payload.version??null})]);}
  catch(error){
    const old=await first(db,"SELECT * FROM wholesale_operations WHERE id=?",[operationId]);
    if(old&&old.actor_id===actor.id&&old.request_json===JSON.stringify(payload))return {ok:true,id:old.order_id,replayed:true};
    if(/CHECK|UNIQUE|closed finance|finance period|guard_|immutable/.test(String(error)))fail(409,"订单或库存已变化，或凭证编号重复；请刷新核对后重试，本次未重复扣库");
    throw error;
  }
  return {ok:true,id};
}
function orderGuard(order){return {sql:"EXISTS (SELECT 1 FROM wholesale_orders WHERE id=? AND version=? AND status=?)",args:[order.id,order.version,order.status]};}
const touch=(db,order)=>stmt(db,"UPDATE wholesale_orders SET version=version+1,updated_at=? WHERE id=?",[stamp(),order.id]);

export async function mutateWholesale(db,actor,payload){
  if(!canWholesale(actor))fail(403,"当前账号无权使用印尼线下批发");
  await assertWritable(db);
  if(!/^[a-zA-Z0-9_-]{16,100}$/.test(text(payload.operationId,110)))fail(400,"缺少有效操作编号，请刷新后重试");
  const previous=await first(db,"SELECT * FROM wholesale_operations WHERE id=?",[payload.operationId]);
  if(previous){if(previous.actor_id!==actor.id||previous.request_json!==JSON.stringify(payload))fail(409,"操作编号已用于其他请求");return {ok:true,id:previous.order_id,replayed:true};}
  if(MANAGEMENT_ACTIONS.has(payload.action))return manageWholesale(db,actor,payload,commit);
  const action=payload.action,now=stamp();
  if(action==="customerCreate"){
    permission(actor,"wholesale.customer");
    const salesId=actor.role==="管理员"?text(payload.salesUserId,100):actor.id;
    const owner=await first(db,"SELECT * FROM users WHERE id=? AND active=1",[salesId]);
    if(!owner||!["销售","运营","管理员"].includes(owner.role)||(owner.role==="运营"&&owner.site!=="印尼"))fail(400,"请选择印尼销售负责人");
    const c={name:text(payload.name,120),contact:text(payload.contact,100),phone:text(payload.phone,60),city:text(payload.city,100),address:text(payload.address,600)};
    if(Object.values(c).some(v=>!v))fail(400,"请完整填写客户名称、联系人、电话、城市和收货地址");
    if(await first(db,"SELECT id FROM wholesale_customers WHERE active=1 AND lower(trim(name))=lower(trim(?)) AND replace(replace(phone,' ',''),'-','')=replace(replace(?,' ',''),'-','')",[c.name,c.phone]))fail(409,"已有同名同电话客户，请管理员核对，避免重复建档");
    const id=uid("customer"),code=`ID-C-${crypto.randomUUID().slice(0,8).toUpperCase()}`;
    return commit(db,actor,payload,id,[stmt(db,"INSERT INTO wholesale_customers (id,code,name,contact,phone,city,address,note,sales_user_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",[id,code,c.name,c.contact,c.phone,c.city,c.address,text(payload.note,600),salesId,now,now])],"NOT EXISTS (SELECT 1 FROM wholesale_customers WHERE active=1 AND lower(trim(name))=lower(trim(?)) AND replace(replace(phone,' ',''),'-','')=replace(replace(?,' ',''),'-',''))",[c.name,c.phone]);
  }
  if(action==="orderCreate"){
    permission(actor,"wholesale.create");
    if(payload.site&&payload.site!=="印尼")fail(400,"线下批发首期仅开放印尼");
    const customer=await first(db,"SELECT * FROM wholesale_customers WHERE id=? AND active=1",[text(payload.customerId,100)]);
    if(!customer||(actor.role!=="管理员"&&customer.sales_user_id!==actor.id))fail(403,"请选择本人负责的有效客户");
    if(!Array.isArray(payload.items)||!payload.items.length||payload.items.length>20)fail(400,"每单需要1至20个SKU");
    const seen=new Set(),items=[];
    for(const input of payload.items){const sku=text(input.sku,100).toUpperCase(),qty=positive(input.qty,"件数"),price=positive(input.unitPrice,"IDR成交单价");if(seen.has(sku))fail(400,"同一SKU请合并为一行");seen.add(sku);const setting=await first(db,"SELECT sku,name FROM sku_settings WHERE sku=?",[sku]);if(!setting)fail(400,`${sku}尚未建立SKU档案`);const amount=qty*price;if(!Number.isSafeInteger(amount)||amount>1000000000000)fail(400,"订单金额超出允许范围");items.push({id:uid("whitem"),sku,name:setting.name,qty,price,amount});}
    const businessDate=date(payload.businessDate),terms=payload.paymentTerms==="credit"?"credit":"prepaid",due=text(payload.dueDate,10);
    if(terms==="credit"&&(!/^\d{4}-\d{2}-\d{2}$/.test(due)||!Number.isFinite(Date.parse(due))||due<businessDate))fail(400,"赊销订单需填写有效且不早于订单日期的到期日");
    const id=uid("whorder"),no=`ID-WH-${businessDate.replaceAll("-","")}-${crypto.randomUUID().slice(0,8).toUpperCase()}`,total=items.reduce((s,r)=>s+r.amount,0);
    if(total>1000000000000)fail(400,"订单金额超出允许范围");
    const statements=[stmt(db,"INSERT INTO wholesale_orders (id,order_no,business_date,customer_id,customer_json,sales_user_id,creator_id,total_qty,total_amount,invoice_required,payment_terms,due_date,note,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",[id,no,businessDate,customer.id,JSON.stringify(customer),customer.sales_user_id,actor.id,items.reduce((s,r)=>s+r.qty,0),total,payload.invoiceRequired?1:0,terms,terms==="credit"?due:null,text(payload.note,1000),now,now])];
    for(const i of items)statements.push(stmt(db,"INSERT INTO wholesale_order_items (id,order_id,sku,name,qty,unit_price,amount) VALUES (?,?,?,?,?,?,?)",[i.id,id,i.sku,i.name,i.qty,i.price,i.amount]));
    return commit(db,actor,payload,id,statements,"EXISTS (SELECT 1 FROM wholesale_customers WHERE id=? AND version=? AND active=1 AND sales_user_id=?)",[customer.id,customer.version,customer.sales_user_id]);
  }
  const order=await orderFor(db,actor,payload.orderId);
  if(Number(payload.version)!==Number(order.version))fail(409,"订单已被其他人更新，请刷新后重试");
  const guard=orderGuard(order),statements=[];
  const items=await rows(db,"SELECT * FROM wholesale_order_items WHERE order_id=?",[order.id]);
  const allocations=await rows(db,"SELECT a.*,i.sku FROM wholesale_allocations a JOIN wholesale_order_items i ON i.id=a.order_item_id WHERE i.order_id=? ORDER BY a.channel",[order.id]);
  const entries=await rows(db,"SELECT * FROM wholesale_finance_entries WHERE order_id=?",[order.id]);
  const returns=await rows(db,"SELECT * FROM wholesale_returns WHERE order_id=?",[order.id]);
  const money=settlement(order,entries,returns);
  if(action==="orderApprove"||action==="orderReject"){
    permission(actor,"wholesale.approve");
    if(order.creator_id===actor.id||(order.service_user_id||order.sales_user_id)===actor.id)fail(403,"申请人或本单销售负责人不能审批自己的订单");
    if(order.status!=="pending")fail(409,"仅待审批订单可以处理");
    if(action==="orderReject"){
      if(text(payload.reason).length<4)fail(400,"请填写驳回原因");
      statements.push(stmt(db,"UPDATE wholesale_orders SET status='rejected',decision_note=?,approved_by=?,version=version+1,updated_at=? WHERE id=?",[text(payload.reason,600),actor.id,now,order.id]));
    }else{
      const supply=await first(db,"SELECT * FROM users WHERE id=? AND role='供应链' AND active=1",[text(payload.supplyUserId,100)]);
      if(!supply)fail(400,"请选择系统中已启用的供应链负责人");
      if(payload.stockBasisConfirmed!==true)fail(400,"请先确认两个平台库存是可分别扣减的独立账面份额，未重复映射同一批实物");
      if(order.payment_terms==="credit"&&text(payload.reason).length<4)fail(400,"赊销审批须记录放行原因和账期依据");
      for(const item of items){
        const stock=await rows(db,"SELECT channel,qty,reserved_qty FROM inventory_balances WHERE site='印尼' AND sku=? AND channel IN ('TikTok','Shopee')",[item.sku]);
        const available=ch=>{const s=stock.find(r=>r.channel===ch);return Number(s?.qty??0)-Number(s?.reserved_qty??0);};
        for(const a of allocateAverage(Number(item.qty),available("TikTok"),available("Shopee"))){
          guard.sql+=" AND EXISTS (SELECT 1 FROM inventory_balances WHERE site='印尼' AND channel=? AND sku=? AND qty-reserved_qty>=?)";guard.args.push(a.channel,item.sku,a.qty);
          statements.push(stmt(db,"INSERT INTO wholesale_allocations (id,order_item_id,channel,qty) VALUES (?,?,?,?)",[uid("whalloc"),item.id,a.channel,a.qty]),stmt(db,"UPDATE inventory_balances SET reserved_qty=reserved_qty+?,updated_at=? WHERE site='印尼' AND channel=? AND sku=?",[a.qty,now,a.channel,item.sku]),movement(db,actor,a.channel,item.sku,0,"线下审批锁库",order.id,`${order.order_no} 锁定${a.qty}件；双平台独立份额已确认`));
        }
      }
      statements.push(stmt(db,"UPDATE wholesale_orders SET status='approved',supply_user_id=?,approved_by=?,approved_at=?,decision_note=?,version=version+1,updated_at=? WHERE id=?",[supply.id,actor.id,now,text(payload.reason,600),now,order.id]));
    }
  }else if(action==="orderCloseRemainder"){
    permission(actor,"wholesale.approve");
    if(order.status!=="partial"||text(payload.reason).length<4)fail(400,"仅部分发货订单可关闭未发余量，并需填写原因");
    for(const a of allocations){const remaining=a.qty-a.shipped_qty-a.released_qty;if(remaining>0){guard.sql+=" AND EXISTS (SELECT 1 FROM inventory_balances WHERE site='印尼' AND channel=? AND sku=? AND reserved_qty>=?)";guard.args.push(a.channel,a.sku,remaining);statements.push(stmt(db,"UPDATE inventory_balances SET reserved_qty=reserved_qty-?,updated_at=? WHERE site='印尼' AND channel=? AND sku=?",[remaining,now,a.channel,a.sku]),stmt(db,"UPDATE wholesale_allocations SET released_qty=released_qty+? WHERE id=?",[remaining,a.id]),movement(db,actor,a.channel,a.sku,0,"线下余量取消",order.id,`取消未发${remaining}件；${text(payload.reason)}`));}}
    const cancelledAmount=items.reduce((sum,i)=>sum+(i.qty-i.shipped_qty)*i.unit_price,0);
    statements.push(stmt(db,"UPDATE wholesale_orders SET status='closed',cancelled_amount=?,decision_note=?,completed_at=?,version=version+1,updated_at=? WHERE id=?",[cancelledAmount,text(payload.reason,600),now,now,order.id]));
  }else if(action==="orderCancel"){
    if(!hasPermission(actor.role,"wholesale.create")&&!hasPermission(actor.role,"wholesale.approve"))fail(403,"无权取消该订单");
    if(items.some(i=>i.shipped_qty>0)||!["pending","approved","packing"].includes(order.status))fail(409,"已发货订单应办理退货，不能直接取消");
    if(order.status!=="pending"&&actor.role!=="管理员")fail(403,"审批后的订单由管理员取消并释放库存");
    if(text(payload.reason).length<4)fail(400,"请填写取消原因");
    for(const a of allocations){const remaining=a.qty-a.shipped_qty-a.released_qty;if(remaining>0){guard.sql+=" AND EXISTS (SELECT 1 FROM inventory_balances WHERE site='印尼' AND channel=? AND sku=? AND reserved_qty>=?)";guard.args.push(a.channel,a.sku,remaining);statements.push(stmt(db,"UPDATE inventory_balances SET reserved_qty=reserved_qty-?,updated_at=? WHERE site='印尼' AND channel=? AND sku=?",[remaining,now,a.channel,a.sku]),stmt(db,"UPDATE wholesale_allocations SET released_qty=released_qty+? WHERE id=?",[remaining,a.id]),movement(db,actor,a.channel,a.sku,0,"线下取消释放",order.id,`释放${remaining}件；${text(payload.reason)}`));}}
    statements.push(stmt(db,"UPDATE wholesale_orders SET status='cancelled',decision_note=?,version=version+1,updated_at=? WHERE id=?",[text(payload.reason,600),now,order.id]));
  }else if(action==="orderReassign"){
    permission(actor,"wholesale.approve");
    if(!["approved","packing","partial"].includes(order.status)||text(payload.reason).length<4)fail(400,"只能重新分配待履约订单，并需填写原因");
    const target=await first(db,"SELECT id FROM users WHERE id=? AND role='供应链' AND active=1",[text(payload.supplyUserId,100)]);if(!target)fail(400,"供应链负责人无效");
    statements.push(stmt(db,"UPDATE wholesale_orders SET supply_user_id=?,decision_note=?,version=version+1,updated_at=? WHERE id=?",[target.id,text(payload.reason,600),now,order.id]));
  }else if(action==="orderPack"||action==="orderShip"){
    permission(actor,"wholesale.ship");
    if(actor.role!=="管理员"&&actor.id!==order.supply_user_id)fail(403,"仅指定供应链负责人可发货");
    if(!["approved","packing","partial"].includes(order.status))fail(409,"订单尚未审批或已经结束");
    if(action==="orderPack"){
      if(order.status!=="approved")fail(409,"该订单已进入打包或发货阶段");
      statements.push(stmt(db,"UPDATE wholesale_orders SET status='packing',version=version+1,updated_at=? WHERE id=?",[now,order.id]));
    }else{
      if(order.payment_terms==="prepaid"&&money.outstanding>0)fail(409,"该单为先款后货，请财务确认回款后发货");
      if(payload.handoverConfirmed!==true)fail(400,"请确认货物已经实际交付承运人或客户");
      const tracking=text(payload.trackingNo,160),carrier=text(payload.carrier,120),warehouse=text(payload.warehouse,160),businessDate=date(payload.businessDate);
      if(businessDate<order.business_date)fail(400,"发货日期不能早于订单日期");
      if(!carrier||!warehouse)fail(400,"请填写承运方式和实际发货仓库");
      const proofIds=Array.isArray(payload.proofIds)?[...new Set(payload.proofIds.map(v=>text(v,100)))]:[];
      if(proofIds.length>10)fail(400,"每次发货最多选择10个凭证");
      const proofs=[];for(const id of proofIds){const f=await first(db,"SELECT id,name,content_type FROM wholesale_files WHERE id=? AND order_id=?",[id,order.id]);if(!f)fail(400,"出库凭证不存在或不属于此订单");proofs.push(f);}
      if(!tracking&&!proofs.length)fail(400,"发货必须提供物流单号，或上传出库照片／视频");
      if(!Array.isArray(payload.items)||!payload.items.length)fail(400,"请选择本次实际发货SKU及数量");
      const selected=[],seen=new Set();for(const row of payload.items){const item=items.find(i=>i.id===row.itemId);if(!item||seen.has(item.id))fail(400,"发货SKU无效或重复");seen.add(item.id);const qty=positive(row.qty,"本次发货件数");if(qty>item.qty-item.shipped_qty)fail(409,`${item.sku}发货超过剩余订单量`);selected.push({item,qty});}
      const shipmentId=uid("whship"),shipmentNo=`${order.order_no}-S-${crypto.randomUUID().slice(0,6).toUpperCase()}`;
      statements.push(stmt(db,"INSERT INTO wholesale_shipments (id,order_id,shipment_no,business_date,tracking_no,carrier,warehouse,proof_json,note,actor_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",[shipmentId,order.id,shipmentNo,businessDate,tracking,carrier,warehouse,JSON.stringify(proofs),text(payload.note,600),actor.id,now]));
      for(const {item,qty} of selected){
        const available=allocations.filter(a=>a.order_item_id===item.id),source=[];let left=qty;
        // Consume the saved reservation; never recalculate a new 50/50 split for partial shipments.
        for(const a of available){const n=Math.min(left,a.qty-a.shipped_qty-a.released_qty);if(n<=0)continue;source.push({channel:a.channel,qty:n});left-=n;
          guard.sql+=" AND EXISTS (SELECT 1 FROM inventory_balances WHERE site='印尼' AND channel=? AND sku=? AND qty>=reserved_qty AND reserved_qty>=?)";guard.args.push(a.channel,item.sku,n);
          statements.push(stmt(db,"UPDATE inventory_balances SET qty=qty-?,reserved_qty=reserved_qty-?,updated_at=? WHERE site='印尼' AND channel=? AND sku=?",[n,n,now,a.channel,item.sku]),stmt(db,"UPDATE wholesale_allocations SET shipped_qty=shipped_qty+? WHERE id=?",[n,a.id]),movement(db,actor,a.channel,item.sku,-n,"线下批发出库",shipmentId,`${order.order_no} / ${shipmentNo}；渠道为线下分销`));
        }if(left)fail(409,"订单预留库存不足，请核对分配记录");
        statements.push(stmt(db,"INSERT INTO wholesale_shipment_items (id,shipment_id,order_item_id,qty,amount,allocations_json) VALUES (?,?,?,?,?,?)",[uid("whsi"),shipmentId,item.id,qty,qty*item.unit_price,JSON.stringify(source)]),stmt(db,"UPDATE wholesale_order_items SET shipped_qty=shipped_qty+? WHERE id=?",[qty,item.id]));
      }
      const complete=items.reduce((s,i)=>s+i.shipped_qty,0)+selected.reduce((s,r)=>s+r.qty,0)===order.total_qty;
      statements.push(stmt(db,"UPDATE wholesale_orders SET status=?,completed_at=?,version=version+1,updated_at=? WHERE id=?",[complete?"completed":"partial",complete?now:null,now,order.id]));
    }
  }else if(action==="financeAdd"){
    permission(actor,"wholesale.finance");
    const kind=text(payload.kind,30),amount=positive(payload.amount,"金额"),reference=text(payload.reference,160),businessDate=date(payload.businessDate);
    if(!["receipt","refund","invoice","invoice_void"].includes(kind)||!reference||text(payload.note).length<4)fail(400,"请选择结算类型，并填写唯一银行流水号／票号及核对说明");
    if(businessDate<order.business_date)fail(400,"结算日期不能早于订单日期");
    if(kind==="receipt"&&await first(db,"SELECT id FROM wholesale_bank_receipts WHERE reference=?",[reference]))fail(409,"该银行流水已登记，请在收款台账分配核销");
    if(kind==="receipt"&&(order.status==="pending"||["rejected","cancelled"].includes(order.status)||amount>money.outstanding))fail(409,"请先审批订单，收款金额不能超过待收金额");
    if(kind==="refund"&&amount>money.refundDue)fail(409,"退款不能超过取消或退货形成的待退款金额");
    if(kind==="invoice"&&(!order.invoice_required||amount>money.invoiceRemaining||["pending","rejected","cancelled"].includes(order.status)))fail(409,"该单未审批、不需开票或金额超过待开票金额");
    if(kind==="invoice_void"&&amount>money.invoiced)fail(409,"冲销金额不能超过现有有效开票金额");
    statements.push(stmt(db,"INSERT INTO wholesale_finance_entries (id,order_id,kind,amount,reference,business_date,note,actor_id,created_at) VALUES (?,?,?,?,?,?,?,?,?)",[uid("whfin"),order.id,kind,amount,reference,businessDate,text(payload.note,600),actor.id,now]),touch(db,order));
  }else if(action==="orderReturn"){
    permission(actor,"wholesale.return");
    const item=items.find(i=>i.id===payload.itemId),qty=positive(payload.qty,"退货件数"),reason=text(payload.reason,600),proof=text(payload.proofRef,240),businessDate=date(payload.businessDate);
    if(!item||qty>item.shipped_qty-item.returned_qty)fail(409,"退货数量超过实际已发且未退数量");
    if(reason.length<4||!proof||payload.receivedConfirmed!==true)fail(400,"须确认仓库实际收回，填写退货原因及验收凭证");
    const latestShipment=await first(db,"SELECT MAX(s.business_date) last_date FROM wholesale_shipments s JOIN wholesale_shipment_items si ON si.shipment_id=s.id WHERE si.order_item_id=?",[item.id]);
    if(businessDate<(latestShipment?.last_date??order.business_date))fail(400,"退货登记日期不能早于该SKU最近发货日期");
    const id=uid("whreturn"),resellable=payload.resellable===true,source=[];let left=qty;
    for(const a of allocations.filter(a=>a.order_item_id===item.id)){const n=Math.min(left,a.shipped_qty-a.returned_qty);if(n<=0)continue;left-=n;source.push({channel:a.channel,qty:n});statements.push(stmt(db,"UPDATE wholesale_allocations SET returned_qty=returned_qty+? WHERE id=?",[n,a.id]),stmt(db,`UPDATE inventory_balances SET ${resellable?"qty=qty+?":"quarantine_qty=quarantine_qty+?"},updated_at=? WHERE site='印尼' AND channel=? AND sku=?`,[n,now,a.channel,item.sku]),movement(db,actor,a.channel,item.sku,resellable?n:0,resellable?"线下退货入库":"线下退货隔离",id,`${order.order_no} 实收${n}件；${proof}`));}
    if(left)fail(409,"原始扣库分配不足，退货未入库");
    statements.push(stmt(db,"INSERT INTO wholesale_returns (id,order_id,order_item_id,qty,amount,resellable,allocations_json,business_date,proof_ref,reason,actor_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",[id,order.id,item.id,qty,qty*item.unit_price,resellable?1:0,JSON.stringify(source),businessDate,proof,reason,actor.id,now]),stmt(db,"UPDATE wholesale_order_items SET returned_qty=returned_qty+? WHERE id=?",[qty,item.id]),touch(db,order));
  }else fail(400,"未知的线下批发操作");
  return commit(db,actor,payload,order.id,statements,guard.sql,guard.args);
}

export async function wholesaleTasks(db,actor){
  if(!canWholesale(actor))return [];
  const scope=visibleScope(actor),orders=await rows(db,`SELECT o.* FROM wholesale_orders o WHERE ${scope.sql} AND o.status NOT IN ('rejected','cancelled') ORDER BY o.created_at`,scope.args),tasks=[];
  for(const o of orders){
    if(actor.role==="管理员"&&o.status==="pending")tasks.push({level:"red",title:"审批线下出库",detail:o.order_no,tab:"wholesale"});
    if(actor.id===o.supply_user_id&&["approved","packing","partial"].includes(o.status))tasks.push({level:"amber",title:"安排线下打包发货",detail:o.order_no,tab:"wholesale"});
  }return tasks;
}

export async function wholesaleSalesSummary(db,actor,from,to){
  if(!["管理员","供应链","运营主管"].includes(actor.role))return {todayQty:0,periodQty:0,topSkus:[]};
  const events=await rows(db,`SELECT i.sku,s.business_date,si.qty FROM wholesale_shipment_items si JOIN wholesale_shipments s ON s.id=si.shipment_id JOIN wholesale_order_items i ON i.id=si.order_item_id WHERE s.business_date BETWEEN ? AND ?
    UNION ALL SELECT i.sku,r.business_date,-r.qty FROM wholesale_returns r JOIN wholesale_order_items i ON i.id=r.order_item_id WHERE r.business_date BETWEEN ? AND ?`,[from,to,from,to]);
  const bySku=new Map();for(const e of events)bySku.set(e.sku,(bySku.get(e.sku)??0)+e.qty);
  return {todayQty:events.filter(e=>e.business_date===to).reduce((s,e)=>s+e.qty,0),periodQty:events.reduce((s,e)=>s+e.qty,0),topSkus:[...bySku].map(([sku,qty])=>({site:"印尼",channel:"线下分销",sku,qty}))};
}

export async function readWholesale(db,actor,month){
  if(!canWholesale(actor))fail(403,"当前账号无权使用印尼线下批发");
  if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)||month>indonesiaDate().slice(0,7))fail(400,"请选择当前或过去的有效月份");
  const scope=visibleScope(actor),orderRows=await rows(db,`SELECT o.*,u.name sales_name,v.name supply_name FROM wholesale_orders o LEFT JOIN users u ON u.id=o.sales_user_id LEFT JOIN users v ON v.id=o.supply_user_id WHERE ${scope.sql} ORDER BY o.created_at DESC`,scope.args);
  const scopedRows=(table,orderExpr="x.order_id")=>rows(db,`SELECT x.* FROM ${table} x JOIN wholesale_orders o ON o.id=${orderExpr} WHERE ${scope.sql}`,scope.args);
  const [items,allocations,shipments,shipmentItems,entries,returns,files,users,stock]=await Promise.all([
    scopedRows("wholesale_order_items"),rows(db,`SELECT x.* FROM wholesale_allocations x JOIN wholesale_order_items i ON i.id=x.order_item_id JOIN wholesale_orders o ON o.id=i.order_id WHERE ${scope.sql}`,scope.args),scopedRows("wholesale_shipments"),rows(db,`SELECT x.* FROM wholesale_shipment_items x JOIN wholesale_shipments s ON s.id=x.shipment_id JOIN wholesale_orders o ON o.id=s.order_id WHERE ${scope.sql}`,scope.args),scopedRows("wholesale_finance_entries"),scopedRows("wholesale_returns"),scopedRows("wholesale_files"),rows(db,"SELECT id,name,role,site,channel FROM users WHERE active=1 AND (role IN ('管理员','供应链','销售') OR (role='运营' AND site='印尼')) ORDER BY role,name"),rows(db,"SELECT b.*,s.name product_name FROM inventory_balances b LEFT JOIN sku_settings s ON s.sku=b.sku WHERE b.site='印尼' AND b.channel IN ('TikTok','Shopee') ORDER BY b.sku,b.channel")]);
  const customers=await rows(db,`SELECT c.* FROM wholesale_customers c WHERE ${["管理员","财务"].includes(actor.role)?"1=1":actor.role==="供应链"?"EXISTS (SELECT 1 FROM wholesale_orders o WHERE o.customer_id=c.id AND o.supply_user_id=?)":"c.sales_user_id=?"} ORDER BY c.name`,["管理员","财务"].includes(actor.role)?[]:[actor.id]);
  const orders=orderRows.map(o=>{const ownEntries=entries.filter(e=>e.order_id===o.id),ownReturns=returns.filter(r=>r.order_id===o.id);return {...o,customer:json(o.customer_json,{}),items:items.filter(i=>i.order_id===o.id).map(i=>({...i,allocations:allocations.filter(a=>a.order_item_id===i.id)})),shipments:shipments.filter(s=>s.order_id===o.id).map(s=>({...s,proofs:json(s.proof_json),items:shipmentItems.filter(i=>i.shipment_id===s.id)})),entries:ownEntries,returns:ownReturns,files:files.filter(f=>f.order_id===o.id).map(f=>({id:f.id,name:f.name,content_type:f.content_type,size:f.size,created_at:f.created_at})),...settlement(o,ownEntries,ownReturns)};});
  // Aggregate every shipment and return in the requested month, independently of the order list filters.
  const contribution=new Map(),skuMap=new Map(),salesMap=new Map(),daily=new Map(),monthlyOrderIds=new Set();
  let salesAmount=0,quantity=0,returnAmount=0,returnQty=0;
  const accumulate=(o,item,n,amount,businessDate)=>{
    const customer=contribution.get(o.customer_id)??{id:o.customer_id,name:o.customer.name,amount:0,qty:0,skus:new Set(),orders:new Set()};customer.amount+=amount;customer.qty+=n;customer.skus.add(item.sku);customer.orders.add(o.id);contribution.set(o.customer_id,customer);
    const sku=skuMap.get(item.sku)??{sku:item.sku,name:item.name,amount:0,qty:0,customers:new Set()};sku.amount+=amount;sku.qty+=n;sku.customers.add(o.customer_id);skuMap.set(item.sku,sku);
    const sales=salesMap.get(o.sales_user_id)??{id:o.sales_user_id,name:o.sales_name,amount:0,qty:0,customers:new Set(),skus:new Set()};sales.amount+=amount;sales.qty+=n;sales.customers.add(o.customer_id);sales.skus.add(item.sku);salesMap.set(o.sales_user_id,sales);
    daily.set(businessDate,(daily.get(businessDate)??0)+amount);
  };
  for(const o of orders){for(const s of o.shipments.filter(s=>s.business_date.startsWith(month))){monthlyOrderIds.add(o.id);for(const si of s.items){const item=o.items.find(i=>i.id===si.order_item_id);salesAmount+=si.amount;quantity+=si.qty;accumulate(o,item,si.qty,si.amount,s.business_date);}}
    for(const r of o.returns.filter(r=>r.business_date.startsWith(month))){returnAmount+=r.amount;returnQty+=r.qty;accumulate(o,o.items.find(i=>i.id===r.order_item_id),-r.qty,-r.amount,r.business_date);}}
  const net=salesAmount-returnAmount;
  const dashboard={month,salesAmount,returnAmount,netAmount:net,quantity,returnQty,netQty:quantity-returnQty,orderCount:monthlyOrderIds.size,customerCount:contribution.size,skuCount:skuMap.size,
    cashReceived:entries.filter(e=>e.business_date.startsWith(month)).reduce((s,r)=>s+(r.kind==="receipt"?r.amount:["receipt_void","receipt_unallocate"].includes(r.kind)?-r.amount:0),0),cashRefunded:entries.filter(e=>e.business_date.startsWith(month)).reduce((s,r)=>s+(r.kind==="refund"?r.amount:r.kind==="refund_void"?-r.amount:0),0),
    currentOutstanding:orders.reduce((s,o)=>s+o.outstanding,0),currentRefundDue:orders.reduce((s,o)=>s+o.refundDue,0),
    customers:[...contribution.values()].map(c=>({...c,skuCount:c.skus.size,orderCount:c.orders.size,skus:undefined,orders:undefined,contribution:net>0?c.amount/net:null})).sort((a,b)=>b.amount-a.amount),
    skus:[...skuMap.values()].map(s=>({...s,customerCount:s.customers.size,customers:undefined})).sort((a,b)=>b.amount-a.amount),
    salespeople:[...salesMap.values()].map(s=>({...s,customerCount:s.customers.size,skuCount:s.skus.size,customers:undefined,skus:undefined})).sort((a,b)=>b.amount-a.amount),daily:[...daily].sort().map(([date,amount])=>({date,amount}))};
  const checks=await checkWholesale(db,actor,orders);
  const finance=monthlyReconciliation(orders,month,indonesiaDate());
  for(const order of orders)order.financial=orderFinancials(order);
  const bankReceipts=["管理员","财务"].includes(actor.role)?await rows(db,"SELECT b.*,c.name customer_name FROM wholesale_bank_receipts b JOIN wholesale_customers c ON c.id=b.customer_id ORDER BY b.business_date DESC,b.created_at DESC"):[];
  const bankEvents=["管理员","财务"].includes(actor.role)?await rows(db,"SELECT * FROM wholesale_bank_events"):[];
  if(["管理员","财务"].includes(actor.role)){
    dashboard.cashReceived=entries.filter(e=>!e.bank_receipt_id&&e.business_date.startsWith(month)).reduce((s,e)=>s+(e.kind==='receipt'?e.amount:e.kind==='receipt_void'?-e.amount:0),0)+bankReceipts.filter(e=>e.business_date.startsWith(month)).reduce((s,e)=>s+e.amount,0)-bankEvents.filter(e=>e.kind==='receipt_void'&&e.business_date.startsWith(month)).reduce((s,e)=>s+e.amount,0);
    dashboard.cashRefunded+=bankEvents.filter(e=>e.kind==='refund'&&e.business_date.startsWith(month)).reduce((s,e)=>s+e.amount,0);
  }
  const periods=await rows(db,"SELECT month,status,version,note,actor_id,updated_at FROM wholesale_finance_periods ORDER BY month DESC");
  return {actor,month,orders,customers,users,stock,bankReceipts,bankEvents,periods,skus:await rows(db,"SELECT sku,name FROM sku_settings ORDER BY sku"),dashboard,finance,checks};
}

async function checkWholesale(db,actor,orders){
  const issues=[];
  for(const o of orders){
    if(o.site!=="印尼")issues.push({order:o.order_no,type:"国家隔离异常"});
    if(o.total_qty!==o.items.reduce((s,i)=>s+i.qty,0)||o.total_amount!==o.items.reduce((s,i)=>s+i.qty*i.unit_price,0))issues.push({order:o.order_no,type:"订单明细合计不一致"});
    for(const i of o.items){if(["approved","packing","partial","completed"].includes(o.status)&&i.allocations.reduce((s,a)=>s+a.qty,0)!==i.qty)issues.push({order:o.order_no,type:`${i.sku}库存分配不守恒`});
      const shipped=o.shipments.flatMap(s=>s.items).filter(si=>si.order_item_id===i.id).reduce((s,si)=>s+si.qty,0);if(shipped!==i.shipped_qty)issues.push({order:o.order_no,type:`${i.sku}发货明细与累计不一致`});}
    if(o.status==="completed"&&o.items.some(i=>i.shipped_qty!==i.qty))issues.push({order:o.order_no,type:"未足量发货却已完成"});
    if(o.due_date&&o.due_date<indonesiaDate()&&o.outstanding>0&&!["pending","rejected","cancelled"].includes(o.status))issues.push({order:o.order_no,type:"回款逾期"});
    if(o.refundDue>0)issues.push({order:o.order_no,type:"存在待退款余额"});
  }
  // Global reconciliation is restricted to administrators; sales never receive other owners' records.
  if(actor.role==="管理员"){
    const stock=await rows(db,"SELECT b.*,COALESCE((SELECT SUM(a.qty-a.shipped_qty-a.released_qty) FROM wholesale_allocations a JOIN wholesale_order_items i ON i.id=a.order_item_id JOIN wholesale_orders o ON o.id=i.order_id WHERE o.site=b.site AND a.channel=b.channel AND i.sku=b.sku),0) wh_reserved FROM inventory_balances b WHERE b.site='印尼'");
    for(const s of stock){if(s.reserved_qty<s.wh_reserved)issues.push({order:s.sku,type:`${s.channel}预留余额少于线下订单锁定量`});if(s.qty<s.reserved_qty)issues.push({order:s.sku,type:`${s.channel}可售账面少于预留，请先处理销售或盘点差异`});}
    const bad=await rows(db,"SELECT s.shipment_no FROM wholesale_shipments s LEFT JOIN (SELECT shipment_id,SUM(qty) qty FROM wholesale_shipment_items GROUP BY shipment_id) i ON i.shipment_id=s.id LEFT JOIN (SELECT reference_id,-SUM(qty_delta) qty FROM inventory_movements WHERE movement_type='线下批发出库' GROUP BY reference_id) m ON m.reference_id=s.id WHERE COALESCE(i.qty,0)<>COALESCE(m.qty,0)");for(const s of bad)issues.push({order:s.shipment_no,type:"发货数量与库存扣减流水不一致"});
  }
  return {checkedAt:stamp(),scope:actor.role==="管理员"?"全部印尼线下订单及库存流水":"本人可见订单",issues};
}
