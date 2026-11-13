import {canDistribution,canEnroll,distFail,manageStore} from './distributor-accounts.mjs';
import {rejectDistributorPayment} from './distributor-payments.mjs';
import {mutateWholesale,indonesiaDate,readWholesale} from './wholesale.mjs';
const all=async(db,sql,args=[])=>(await db.prepare(sql).bind(...args).all()).results;
export async function readDistribution(db,a,{section='',month=indonesiaDate().slice(0,7)}={}){
 if(!canDistribution(a))distFail(403,'无权查看分销管理');
 if(section==='orders')return readWholesale(db,a,month,'distribution');
 const global=['管理员','财务'].includes(a.role),scope=global?'1=1':'c.sales_user_id=?',args=global?[]:[a.id];
 const [stores,customers,payments,counts]=await Promise.all([
 all(db,`SELECT s.customer_id,s.slug,s.username,s.status,s.version,s.password_hash IS NOT NULL activated,s.created_at,s.review_note,c.name,c.contact,c.phone,c.city,c.address,c.active,c.sales_user_id,u.name owner_name,
 (SELECT COUNT(*) FROM distributor_orders d WHERE d.customer_id=c.id) order_count,
 (SELECT COALESCE(SUM(o.total_qty),0) FROM distributor_orders d JOIN wholesale_orders o ON o.id=d.order_id WHERE d.customer_id=c.id AND o.status NOT IN ('rejected','cancelled')) ordered_qty,
 (SELECT COALESCE(SUM(i.shipped_qty-i.returned_qty),0) FROM distributor_orders d JOIN wholesale_order_items i ON i.order_id=d.order_id WHERE d.customer_id=c.id) delivered_qty,
 (SELECT COALESCE(SUM(CASE e.kind WHEN 'receipt' THEN e.amount WHEN 'refund_void' THEN e.amount WHEN 'refund' THEN -e.amount WHEN 'receipt_void' THEN -e.amount WHEN 'receipt_unallocate' THEN -e.amount ELSE 0 END),0) FROM distributor_orders d JOIN wholesale_finance_entries e ON e.order_id=d.order_id WHERE d.customer_id=c.id) net_receipts
 FROM distributor_stores s JOIN wholesale_customers c ON c.id=s.customer_id LEFT JOIN users u ON u.id=c.sales_user_id WHERE ${scope} ORDER BY s.created_at DESC`,args),
 canEnroll(a)?all(db,`SELECT c.id,c.name,c.code FROM wholesale_customers c WHERE c.active=1 AND ${scope} AND NOT EXISTS(SELECT 1 FROM distributor_stores s WHERE s.customer_id=c.id) ORDER BY c.name`,args):[],
 global?all(db,`SELECT p.*,c.name customer_name,o.order_no,o.status order_status,o.version order_version,f.finance_entry_id,EXISTS(SELECT 1 FROM wholesale_finance_entries e WHERE e.reverses_id=f.finance_entry_id) reversed FROM distributor_payments p JOIN wholesale_customers c ON c.id=p.customer_id JOIN wholesale_orders o ON o.id=p.order_id JOIN wholesale_files f ON f.id=p.file_id ORDER BY p.created_at DESC LIMIT 200`):[],
 all(db,`SELECT status,COUNT(*) n FROM website_leads WHERE source='distributor-application' ${global?'':'AND owner_id=?'} GROUP BY status`,args)
 ]);
 const users=a.role==='管理员'?await all(db,"SELECT id,name FROM users WHERE active=1 AND (role IN ('管理员','销售') OR (role='运营' AND site='印尼')) ORDER BY name"):[];
 return {actor:{id:a.id,role:a.role,site:a.site},stores,customers,payments:payments.map(({fingerprint,...p})=>p),users,applications:counts.reduce((n,r)=>n+(['new','following','quoted'].includes(r.status)?r.n:0),0)};
}
export async function mutateDistribution(db,a,p){
 if(!canDistribution(a))distFail(403,'无权操作分销管理');
 if(p.action==='create'){
  if(!canEnroll(a))distFail(403,'无权录入分销商家');
  const phone=String(p.phone||'').trim().replace(/[\s()-]/g,'').replace(/^(?:\+?62|0)/,'+62');
  if(!/^\+62[1-9]\d{7,12}$/.test(phone))distFail(400,'请填写有效的印尼联系电话（08… 或 +62…）');
  return mutateWholesale(db,a,{...p,phone,action:'customerCreate',distributor:true});
 }
 if(p.action==='paymentReject')return rejectDistributorPayment(db,a,p);
 if(p.action==='paymentConfirm'){
  if(!['管理员','财务'].includes(a.role))distFail(403,'仅财务或管理员可核实到账');
  const row=await db.prepare("SELECT p.*,o.version order_version,f.finance_entry_id,EXISTS(SELECT 1 FROM wholesale_finance_entries e WHERE e.reverses_id=f.finance_entry_id) reversed FROM distributor_payments p JOIN wholesale_orders o ON o.id=p.order_id JOIN wholesale_files f ON f.id=p.file_id WHERE p.id=?").bind(p.id).first();
  const previous=await db.prepare('SELECT request_json FROM wholesale_operations WHERE id=?').bind(String(p.operationId||'')).first();
  if(!row||!previous&&(row.version!==p.version||row.status!=='submitted'||row.finance_entry_id))distFail(409,'凭证已被处理，请刷新');
  return mutateWholesale(db,a,{action:'financeAdd',operationId:p.operationId,orderId:row.order_id,version:previous?JSON.parse(previous.request_json).version:row.order_version,kind:'receipt',amount:p.amount,reference:p.reference,businessDate:p.businessDate,note:p.note,proofIds:[row.file_id],distributorPaymentId:row.id,distributorPaymentVersion:p.version});
 }
 return manageStore(db,a,p);
}
export async function distributionTasks(db,a){
 if(!canDistribution(a))return [];
 const tasks=[];
 if(a.role==='管理员'){
  const r=await db.prepare("SELECT COUNT(*) n FROM distributor_stores WHERE status='pending'").first();if(r.n)tasks.push({level:'amber',title:'分销商家待审核',detail:String(r.n),tab:'distribution',view:'stores'});
  const leads=await db.prepare("SELECT COUNT(*) n FROM website_leads WHERE source='distributor-application' AND status IN ('new','following','quoted')").first();if(leads.n)tasks.push({level:'amber',title:'分销入驻申请待审核',detail:String(leads.n),tab:'distribution',view:'applications'});
 }
 if(['管理员','财务'].includes(a.role)){
  const p=await db.prepare("SELECT COUNT(*) n FROM distributor_payments p JOIN wholesale_files f ON f.id=p.file_id WHERE p.status='submitted' AND f.finance_entry_id IS NULL").first();if(p.n)tasks.push({level:'amber',title:'分销结算凭证待核验',detail:String(p.n),tab:'distribution',view:'payments'});
 }
 return tasks;
}
