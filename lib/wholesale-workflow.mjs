import { WholesaleError, settlement } from './wholesale.mjs';
import { assertWritable, guardStatement } from './atomic.mjs';
const fail=(status,message)=>{throw new WholesaleError(status,message);};
const clean=(v,n=600)=>String(v??'').trim().slice(0,n);
const uid=p=>p+'_'+crypto.randomUUID();
const parse=(v,fallback=[])=>{try{return JSON.parse(v);}catch{return fallback;}};
const first=(db,sql,args=[])=>db.prepare(sql).bind(...args).first();
const rows=async(db,sql,args=[])=> (await db.prepare(sql).bind(...args).all()).results||[];
export const isModernOrder=o=>Number(o.workflow_version)===2;
export function wholesaleScope(actor,alias='o'){
 if(['管理员','财务'].includes(actor.role))return {sql:'1=1',args:[]};
 if(actor.role==='供应链')return {sql:`(${alias}.supply_user_id=? OR (${alias}.workflow_version=2 AND (${alias}.status='pending' OR ${alias}.logistics_user_id=? OR ${alias}.warehouse_user_id=?)))`,args:[actor.id,actor.id,actor.id]};
 return {sql:`COALESCE(${alias}.service_user_id,${alias}.sales_user_id)=?`,args:[actor.id]};
}
export function normalizeSettlement(payload){
 const mode=clean(payload.settlementMode|| (payload.saleType==='consignment'?'consignment':'prepaid'),30);
 if(!['prepaid','credit','consignment'].includes(mode))fail(400,'请选择现款、账期或寄卖结算');
 if((mode==='consignment')!==(payload.saleType==='consignment'))fail(400,'寄卖结算须对应寄售业务类型');
 return mode;
}
export function reviewedTerms(payload,order,workflow,now=new Date().toISOString()){
 const contract=clean(payload.contractReference===undefined?workflow.contract_reference:payload.contractReference);
 const due=clean(payload.dueDate===undefined?order.due_date:payload.dueDate,10);
 if(workflow.settlement_mode!=='prepaid'&&(!contract||!/^\d{4}-\d{2}-\d{2}$/.test(due)||!Number.isFinite(Date.parse(due))||new Date(due).toISOString().slice(0,10)!==due||due<new Date(Date.parse(now)+7*3600000).toISOString().slice(0,10)))fail(400,'账期和寄卖须明确合同结算依据及未过期的到期日');
 const expiry=clean(payload.reservationExpiresAt,40);
 if(!expiry||!Number.isFinite(Date.parse(expiry))||Date.parse(expiry)<=Date.parse(now))fail(400,'请填写晚于当前时间的库存锁定截止时间');
 return {contract,due:workflow.settlement_mode==='prepaid'?null:due,expiry:new Date(expiry).toISOString()};
}
export const workflowRow=(db,id)=>first(db,'SELECT * FROM wholesale_workflows WHERE order_id=?',[id]);
export function releaseEligibility(order,w,money,now=new Date().toISOString()){
 if(!w||!['approved','packing','partial'].includes(order.status))return '订单尚未审核或已经结束';
 if(!w.customer_confirmed_at)return '销售尚未确认客户接受商品、价格及结算约定';
 if(w.settlement_mode==='prepaid'&&Number(money.paid)<Number(money.payable))return '先款后货：财务实际净到账尚未足额，付款截图不能代替到账';
 if(w.settlement_mode!=='prepaid'&&(!w.contract_reference||!order.due_date||order.due_date<new Date(Date.parse(now)+7*3600000).toISOString().slice(0,10)))return '账期或寄卖的合同依据、到期日待核对';
 return '';
}
// Bank allocation and direct receipt append this statement in their existing guarded
// transaction. The money predicate is evaluated after the new entry, not a stale read.
export async function autoReleaseStatements(db,actor,order){
 if(!isModernOrder(order))return [];
 const w=await workflowRow(db,order.id);if(!w)return [];
 const items=await rows(db,'SELECT sku,name,qty,unit_price,amount FROM wholesale_order_items WHERE order_id=? ORDER BY sku',[order.id]);
 const now=new Date().toISOString(),today=new Date(Date.parse(now)+7*3600000).toISOString().slice(0,10);
 return [db.prepare(`INSERT INTO wholesale_release_instructions(id,order_id,instruction_no,issued_at,issued_by,basis_json,items_json)
 SELECT ?,o.id,o.order_no||'-OUT-01',?,?,?,? FROM wholesale_orders o JOIN wholesale_workflows w ON w.order_id=o.id
 WHERE o.id=? AND o.workflow_version=2 AND o.status IN ('approved','packing','partial') AND w.customer_confirmed_at IS NOT NULL
 AND NOT EXISTS(SELECT 1 FROM wholesale_release_instructions r WHERE r.order_id=o.id)
 AND ((w.settlement_mode='prepaid' AND COALESCE((SELECT SUM(CASE WHEN kind IN ('receipt','refund_void') THEN amount WHEN kind IN ('receipt_void','receipt_unallocate','refund') THEN -amount ELSE 0 END) FROM wholesale_finance_entries WHERE order_id=o.id),0)>=o.total_amount-o.cancelled_amount-COALESCE((SELECT SUM(amount) FROM wholesale_returns WHERE order_id=o.id),0))
 OR (w.settlement_mode IN ('credit','consignment') AND length(w.contract_reference)>0 AND o.due_date>=?))`).bind(uid('whrelease'),now,actor.id,JSON.stringify({mode:w.settlement_mode,contractReference:w.contract_reference,dueDate:order.due_date,approvedBy:order.approved_by,approvedAt:order.approved_at,financeBasis:'发货时再次核对当前净回款'}),JSON.stringify(items),order.id,today)];
}
// Only internal SQL expressions are passed here. Candidate selection and the
// committing guard must use the same definition of an untouched order.
function pristineSql(orderRef){
 return `NOT EXISTS(SELECT 1 FROM wholesale_finance_entries WHERE order_id=${orderRef}) AND NOT EXISTS(SELECT 1 FROM wholesale_files WHERE order_id=${orderRef} AND purpose='finance') AND NOT EXISTS(SELECT 1 FROM distributor_payments WHERE order_id=${orderRef} AND status='submitted') AND NOT EXISTS(SELECT 1 FROM wholesale_shipments WHERE order_id=${orderRef}) AND NOT EXISTS(SELECT 1 FROM wholesale_order_items WHERE order_id=${orderRef} AND (shipped_qty<>0 OR returned_qty<>0))`;
}
export function pristineGuard(id){return {sql:pristineSql('?'),args:Array(5).fill(id)};}
export async function assertPristine(db,order){const p=pristineGuard(order.id);if(!(await first(db,`SELECT (${p.sql}) ok`,p.args))?.ok)fail(409,'本单已有财务记录、待核付款凭证或履约事实，请财务核对后处理，不能直接退回重建');return p;}
export function releaseReservationStatements(db,order,allocations,actor,reason,now){
 const statements=[];
 for(const a of allocations){const n=a.qty-a.shipped_qty-a.released_qty;if(n<=0)continue;
  statements.push(guardStatement(db,actor,'wholesale.release.reservation',"EXISTS(SELECT 1 FROM inventory_balances WHERE site='印尼' AND channel=? AND sku=? AND reserved_qty>=?)",[a.channel,a.sku,n]),db.prepare("UPDATE inventory_balances SET reserved_qty=reserved_qty-?,updated_at=? WHERE site='印尼' AND channel=? AND sku=?").bind(n,now,a.channel,a.sku),db.prepare('UPDATE wholesale_allocations SET released_qty=released_qty+? WHERE id=?').bind(n,a.id),db.prepare("INSERT INTO inventory_movements(id,site,channel,sku,name,movement_type,qty_delta,balance_after,reference_type,reference_id,note,actor_id,created_at) SELECT ?,'印尼',channel,sku,name,'线下预留释放',0,qty,'线下批发',?,?,?,? FROM inventory_balances WHERE site='印尼' AND channel=? AND sku=?").bind(uid('move'),order.id,reason,actor.id,now,a.channel,a.sku));
 }
 return statements;
}
// Re-evaluate money inside the committing transaction as well as on the form.
export function currentReleaseGuard(orderId,businessDate=''){
 const cutoff=businessDate?` AND date(w.customer_confirmed_at,'+7 hours')<=? AND date(r.issued_at,'+7 hours')<=?
 AND (w.settlement_mode<>'prepaid' OR COALESCE((SELECT SUM(CASE WHEN kind IN ('receipt','refund_void') THEN amount WHEN kind IN ('receipt_void','receipt_unallocate','refund') THEN -amount ELSE 0 END) FROM wholesale_finance_entries WHERE order_id=o.id AND business_date<=?),0)>=o.total_amount-o.cancelled_amount-COALESCE((SELECT SUM(amount) FROM wholesale_returns WHERE order_id=o.id AND business_date<=?),0))`:'';
 return {sql:`EXISTS(SELECT 1 FROM wholesale_orders o JOIN wholesale_workflows w ON w.order_id=o.id JOIN wholesale_release_instructions r ON r.order_id=o.id WHERE o.id=? AND o.status IN ('approved','packing','partial') AND w.customer_confirmed_at IS NOT NULL AND ((w.settlement_mode='prepaid' AND COALESCE((SELECT SUM(CASE WHEN kind IN ('receipt','refund_void') THEN amount WHEN kind IN ('receipt_void','receipt_unallocate','refund') THEN -amount ELSE 0 END) FROM wholesale_finance_entries WHERE order_id=o.id),0)>=o.total_amount-o.cancelled_amount-COALESCE((SELECT SUM(amount) FROM wholesale_returns WHERE order_id=o.id),0)) OR (w.settlement_mode IN ('credit','consignment') AND length(w.contract_reference)>0 AND o.due_date>=?))${cutoff})`,args:[orderId,new Date(Date.now()+7*3600000).toISOString().slice(0,10),...(businessDate?Array(4).fill(businessDate):[])]};
}
export const WORKFLOW_ACTIONS=new Set(['orderCustomerConfirm','orderRelease','orderAssignWarehouse','orderReturnToSales']);
export async function handleWholesaleWorkflow(db,actor,p,order,money,allocations,commit){
 if(!isModernOrder(order))fail(409,'该操作仅适用于新版流程订单');
 const w=await workflowRow(db,order.id),now=new Date().toISOString(),statements=[];
 if(!w)fail(409,'订单流程资料缺失，请核对');
 const guard={sql:'EXISTS(SELECT 1 FROM wholesale_orders WHERE id=? AND version=? AND status=?)',args:[order.id,order.version,order.status]};
 const sales=actor.id===(order.service_user_id||order.sales_user_id),admin=actor.role==='管理员';
 if(p.action==='orderCustomerConfirm'){
  if(!sales&&!admin)fail(403,'仅本单销售负责人可登记客户确认');
  if(!['approved','packing'].includes(order.status)||w.customer_confirmed_at)fail(409,'请在审核后完成一次客户确认；约定变化须退回重申');
  if(clean(p.proofRef).length<4)fail(400,'请填写客户确认商品、金额及结算约定的依据');
  statements.push(db.prepare('UPDATE wholesale_workflows SET customer_confirmed_at=?,customer_confirmed_by=?,customer_confirmation_ref=?,updated_at=? WHERE order_id=?').bind(now,actor.id,clean(p.proofRef),now,order.id));
  // A salesperson confirms the customer's agreement, not credit release authority.
  if(w.settlement_mode==='prepaid')statements.push(...await autoReleaseStatements(db,actor,order));
 }else if(p.action==='orderRelease'){
  if(!admin&&!(actor.role==='财务')&&!(actor.id===order.supply_user_id&&w.settlement_mode!=='prepaid'))fail(403,'请由财务核实实际到账，或由本单供应链按已批准账期约定放货');
  const reason=releaseEligibility(order,w,money);if(reason)fail(409,reason);
  if(await first(db,'SELECT id FROM wholesale_release_instructions WHERE order_id=?',[order.id]))fail(409,'正式出库指令已生成，请勿重复');
  statements.push(...await autoReleaseStatements(db,actor,order));
 }else if(p.action==='orderAssignWarehouse'){
  if(!admin&&actor.id!==order.logistics_user_id)fail(403,'仅本单物流协调人可派仓');
  const reason=releaseEligibility(order,w,money);if(reason)fail(409,reason);
  const releaseGuard=currentReleaseGuard(order.id);guard.sql+=' AND '+releaseGuard.sql;guard.args.push(...releaseGuard.args);
  if(!await first(db,'SELECT id FROM wholesale_release_instructions WHERE order_id=?',[order.id]))fail(409,'尚未生成正式出库指令');
  if(w.packed_at||order.status==='partial')fail(409,'已打包或发货，不能直接替换执行仓库');
  const target=await first(db,"SELECT id FROM users WHERE id=? AND active=1 AND role='供应链'",[clean(p.warehouseUserId,100)]);
  if(!target||!clean(p.warehouse,160)||clean(p.reason).length<4)fail(400,'请指定有效仓库执行人、实际仓库和派仓说明');
  guard.sql+=" AND EXISTS(SELECT 1 FROM users WHERE id=? AND active=1 AND role='供应链')";guard.args.push(target.id);
  statements.push(db.prepare('UPDATE wholesale_orders SET warehouse_user_id=? WHERE id=?').bind(target.id,order.id),db.prepare('UPDATE wholesale_workflows SET warehouse=?,updated_at=? WHERE order_id=?').bind(clean(p.warehouse,160),now,order.id));
 }else if(p.action==='orderReturnToSales'){
  if(!admin&&actor.id!==order.supply_user_id&&actor.id!==order.logistics_user_id)fail(403,'仅本单供应链或物流协调人可退回销售');
  if(!['approved','packing'].includes(order.status)||clean(p.reason).length<4)fail(400,'仅未发货订单可退回，并需填写原因');
  const pristine=await assertPristine(db,order);guard.sql+=' AND '+pristine.sql;guard.args.push(...pristine.args);
  statements.push(...releaseReservationStatements(db,order,allocations,actor,clean(p.reason),now),db.prepare("UPDATE wholesale_orders SET status='rejected',decision_note=? WHERE id=?").bind(clean(p.reason),order.id),db.prepare('UPDATE wholesale_workflows SET returned_reason=?,returned_at=?,updated_at=? WHERE order_id=?').bind(clean(p.reason),now,now,order.id));
 }
 statements.push(db.prepare('UPDATE wholesale_orders SET version=version+1,updated_at=? WHERE id=?').bind(now,order.id));
 return commit(db,actor,p,order.id,statements,guard.sql,guard.args);
}
export async function validateModernDispatch(db,actor,p,order,money){
 const w=await workflowRow(db,order.id);
 if(!order.warehouse_user_id||actor.id!==order.warehouse_user_id)fail(403,'仅本单指定仓库执行人可确认打包和实际发货');
 if(!await first(db,"SELECT id FROM users WHERE id=? AND active=1 AND role='供应链'",[actor.id]))fail(403,'仓库执行账号已停用或岗位变化');
 const reason=releaseEligibility(order,w,money);if(reason)fail(409,reason);
 const instruction=await first(db,'SELECT * FROM wholesale_release_instructions WHERE order_id=?',[order.id]);
 if(!instruction)fail(409,'尚无正式出库指令，不能打包发货');
 if(p.action==='orderShip'){
  const day=clean(p.businessDate,10),today=new Date(Date.now()+7*3600000).toISOString().slice(0,10);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(day)||!Number.isFinite(Date.parse(day))||new Date(day).toISOString().slice(0,10)!==day||day>today)fail(400,'业务日期无效或晚于印尼今天');
  const localDate=value=>{const n=Date.parse(value);return Number.isFinite(n)?new Date(n+7*3600000).toISOString().slice(0,10):'';};
  const confirmedDate=localDate(w.customer_confirmed_at),releasedDate=localDate(instruction.issued_at);
  if(!confirmedDate||!releasedDate||day<confirmedDate||day<releasedDate)fail(409,'出库业务日期不能早于客户确认或正式放货指令日期');
  if(w.settlement_mode==='prepaid'){
   const entries=await rows(db,'SELECT * FROM wholesale_finance_entries WHERE order_id=? AND business_date<=?',[order.id,day]),returns=await rows(db,'SELECT * FROM wholesale_returns WHERE order_id=? AND business_date<=?',[order.id,day]);
   const atShipment=settlement(order,entries,returns);
   if(atShipment.paid<atShipment.payable)fail(409,'截至出库业务日期的实际净到账不足，不能用之后到账补记之前出库');
  }
 }
 if(p.action==='orderShip'&&!w.packed_at)fail(409,'请先完成打包并上传照片');
 const ids=p.action==='orderPack'?p.proofIds:parse(w.pack_proof_json).map(f=>f.id);
 if(!Array.isArray(ids)||!ids.length||ids.length>10)fail(400,'请上传并选择1至10张本单打包照片');
 const used=order.status==='partial'&&p.action==='orderPack'?await rows(db,'SELECT proof_json FROM wholesale_shipments WHERE order_id=?',[order.id]):[];
 const usedIds=new Set(used.flatMap(s=>parse(s.proof_json).map(f=>f.id)));
 const proofs=[];for(const id of new Set(ids)){const f=await first(db,"SELECT id,name,content_type FROM wholesale_files WHERE id=? AND order_id=? AND purpose='shipment' AND content_type LIKE 'image/%'",[id,order.id]);if(!f||usedIds.has(id))fail(400,'打包凭证须为本订单本批次尚未使用的有效照片');proofs.push(f);}
 if(p.action==='orderShip'&&!clean(p.trackingNo,160))fail(400,'请填写实际运单号；Lalamove也须填写订单号，照片不能替代');
 if(p.action==='orderShip'&&clean(p.warehouse,160)!==w.warehouse)fail(409,'实际仓库须与派仓指令一致，请核对');
 return {w,proofs};
}
export async function attachWholesaleWorkflows(db,orders,actor){
 if(!orders.length)return;
 const scope=wholesaleScope(actor);
 const workflows=await rows(db,`SELECT w.* FROM wholesale_workflows w JOIN wholesale_orders o ON o.id=w.order_id WHERE ${scope.sql}`,scope.args),releases=await rows(db,`SELECT r.* FROM wholesale_release_instructions r JOIN wholesale_orders o ON o.id=r.order_id WHERE ${scope.sql}`,scope.args);
 const evidence=await rows(db,`SELECT o.id, EXISTS(SELECT 1 FROM wholesale_files f WHERE f.order_id=o.id AND f.purpose='finance') OR EXISTS(SELECT 1 FROM distributor_payments d WHERE d.order_id=o.id AND d.status='submitted') AS has_proof FROM wholesale_orders o WHERE ${scope.sql}`,scope.args);
 for(const o of orders){if(!isModernOrder(o))continue;const w=workflows.find(w=>w.order_id===o.id);if(!w)continue;const r=releases.find(r=>r.order_id===o.id),reason=releaseEligibility(o,w,o),expired=Boolean(w.reservation_expires_at&&w.reservation_expires_at<new Date().toISOString()&&['approved','packing'].includes(o.status));
  o.workflow={mode:w.settlement_mode,contractReference:w.contract_reference,dueDate:o.due_date,reservationExpiresAt:w.reservation_expires_at,customerConfirmedAt:w.customer_confirmed_at,customerConfirmedBy:w.customer_confirmed_by,customerConfirmationRef:w.customer_confirmation_ref,logisticsUserId:o.logistics_user_id,warehouseUserId:o.warehouse_user_id,warehouse:w.warehouse,packedAt:w.packed_at,packProofs:parse(w.pack_proof_json),returnedReason:w.returned_reason,originalOrderId:w.original_order_id,replacementOrderId:w.replacement_order_id,releaseValid:Boolean(r)&&!reason,releaseInstruction:r?{id:r.id,no:r.instruction_no,issuedAt:r.issued_at,issuedBy:r.issued_by,basis:parse(r.basis_json,{}),items:parse(r.items_json)}:null,canRelease:!reason,releaseReason:reason,expiredReviewReason:expired?(o.entries?.length||evidence.find(e=>e.id===o.id)?.has_proof?'锁库已到期，有财务记录或付款凭证，请财务与供应链核对':w.settlement_mode==='prepaid'?'锁库已到期，等待释放未付款预留':'锁库已到期，请核对账期或寄卖约定'):'',phase:['rejected','cancelled','completed','closed'].includes(o.status)?o.status:!o.approved_at?'supply_review':!w.customer_confirmed_at?'customer_confirm':!r||reason?'release_pending':!o.warehouse_user_id?'warehouse_assign':!w.packed_at?'packing':'shipping'};
  o.capabilities={review:['管理员','供应链'].includes(actor.role)&&o.status==='pending'&&actor.id!==o.creator_id&&actor.id!==(o.service_user_id||o.sales_user_id),customerConfirm:(actor.role==='管理员'||actor.id===(o.service_user_id||o.sales_user_id))&&o.status==='approved'&&!w.customer_confirmed_at,release:!reason&&!r&&(['管理员','财务'].includes(actor.role)||(actor.id===o.supply_user_id&&w.settlement_mode!=='prepaid')),assignWarehouse:!reason&&Boolean(r)&&!w.packed_at&&(actor.role==='管理员'||actor.id===o.logistics_user_id),pack:!reason&&Boolean(r)&&actor.id===o.warehouse_user_id&&['approved','partial'].includes(o.status)&&!w.packed_at,ship:!reason&&Boolean(r)&&Boolean(w.packed_at)&&actor.id===o.warehouse_user_id,returnToSales:['approved','packing'].includes(o.status)&&!o.entries?.length&&!evidence.find(e=>e.id===o.id)?.has_proof&&(actor.role==='管理员'||actor.id===o.supply_user_id||actor.id===o.logistics_user_id),resubmit:o.status==='rejected'&&(actor.role==='管理员'||actor.id===(o.service_user_id||o.sales_user_id))};
 }
}
export async function expireWholesaleReservations(db,{now=new Date().toISOString(),limit=100}={}){
 await assertWritable(db);const actor={id:'system:wholesale-expiry',name:'未付款预留到期检查'};
 const scope="FROM wholesale_orders o JOIN wholesale_workflows w ON w.order_id=o.id WHERE o.workflow_version=2 AND o.status IN ('approved','packing') AND w.settlement_mode='prepaid' AND w.reservation_expires_at<=?",eligible=pristineSql('o.id');
 // Review-only orders must never consume the release batch. Count them without
 // changing their records; existing workflow reminders continue to expose them.
 const [candidates,blocked]=await Promise.all([
  rows(db,`SELECT o.* ${scope} AND (${eligible}) ORDER BY w.reservation_expires_at,o.id LIMIT ?`,[now,Math.min(500,Math.max(1,limit))]),
  first(db,`SELECT COUNT(*) count ${scope} AND NOT (${eligible})`,[now])
 ]);
 const initialReview=Number(blocked?.count||0);let released=0,review=initialReview,conflicts=0;
 for(const o of candidates){const pristine=pristineGuard(o.id);if(!(await first(db,`SELECT (${pristine.sql}) ok`,pristine.args))?.ok){review++;continue;}
  const allocations=await rows(db,'SELECT a.*,i.sku FROM wholesale_allocations a JOIN wholesale_order_items i ON i.id=a.order_item_id WHERE i.order_id=?',[o.id]);const reason='未付款锁库超时，自动释放预留；原订单保留审计';
  try{await db.batch([guardStatement(db,actor,'wholesale.reservation.expired',`EXISTS(SELECT 1 FROM wholesale_orders WHERE id=? AND version=? AND status IN ('approved','packing')) AND ${pristine.sql}`,[o.id,o.version,...pristine.args]),...releaseReservationStatements(db,o,allocations,actor,reason,now),db.prepare("UPDATE wholesale_orders SET status='cancelled',decision_note=?,version=version+1,updated_at=? WHERE id=?").bind(reason,now,o.id),db.prepare("INSERT INTO audit_logs(id,action,entity_type,entity_id,detail_json,actor_id,actor_name,created_at) VALUES (?,'wholesale.reservation.expired','印尼线下批发',?,?,?,?,?)").bind(uid('audit'),o.id,JSON.stringify({orderNo:o.order_no,reason}),actor.id,actor.name,now)]);released++;}catch(e){if(/guard_|CHECK|constraint/i.test(String(e)))conflicts++;else throw e;}
 }
 return {checked:candidates.length+initialReview,released,review,conflicts};
}
