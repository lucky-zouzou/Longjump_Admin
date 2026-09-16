import {WholesaleError,settlement,canReadWholesaleOrder,indonesiaDate} from './wholesale.mjs';
import {loadWholesaleExportSnapshot} from './wholesale-export.mjs';
import {monthlyReconciliation} from './wholesale-finance.mjs';
const fail=(status,message)=>{throw new WholesaleError(status,message);};
const clean=(v,n=500)=>String(v??'').trim().slice(0,n),id=p=>p+'_'+crypto.randomUUID();
const positive=v=>{const n=Number(v);if(!Number.isSafeInteger(n)||n<=0||n>1e12)fail(400,'金额或数量必须是有效正整数');return n;};
const all=async(db,sql,args=[])=>{const r=await db.prepare(sql).bind(...args).all();if(!r.success)fail(500,'数据读取失败');return r.results||[];};
const first=(db,sql,args=[])=>db.prepare(sql).bind(...args).first();
const date=value=>{const s=clean(value,10);if(!/^\d{4}-\d{2}-\d{2}$/.test(s)||Number.isNaN(Date.parse(s))||new Date(s).toISOString().slice(0,10)!==s||s>indonesiaDate())fail(400,'业务日期无效');return s;};
const roles=(actor,allowed)=>{if(!allowed.includes(actor.role))fail(403,'当前岗位无权执行此操作');};
const version=(actual,input)=>{if(Number(input)!==Number(actual))fail(409,'记录已更新，请刷新后重试');};
async function orderMoney(db,order){return settlement(order,await all(db,'SELECT * FROM wholesale_finance_entries WHERE order_id=?',[order.id]),await all(db,'SELECT * FROM wholesale_returns WHERE order_id=?',[order.id]));}
export const MANAGEMENT_ACTIONS=new Set(['customerUpdate','customerTransfer','bankReceiptCreate','bankReceiptAllocate','bankReceiptRefund','bankReceiptVoid','financeReverse','financePeriodClose','financePeriodReopen']);
export async function manageWholesale(db,actor,p,commit){
  const now=new Date().toISOString(),action=p.action,statements=[];
  if(action==='customerUpdate'||action==='customerTransfer'){
    roles(actor,['管理员','销售','运营']);if(actor.role==='运营'&&actor.site!=='印尼')fail(403,'仅印尼业务可维护客户');
    const customer=await first(db,'SELECT * FROM wholesale_customers WHERE id=?',[clean(p.customerId,100)]);
    if(!customer||(actor.role!=='管理员'&&customer.sales_user_id!==actor.id))fail(403,'无权维护该客户');version(customer.version,p.version);
    let owner=customer.sales_user_id;
    if(action==='customerTransfer'){
      roles(actor,['管理员']);if(clean(p.reason).length<4)fail(400,'客户交接必须填写原因');
      const target=await first(db,"SELECT * FROM users WHERE id=? AND active=1 AND (role IN ('销售','管理员') OR (role='运营' AND site='印尼'))",[clean(p.salesUserId,100)]);
      if(!target)fail(400,'请选择已启用的印尼销售负责人');owner=target.id;
      // Sales contribution and original customer snapshots remain historical; service ownership moves.
      statements.push(db.prepare('UPDATE wholesale_customers SET sales_user_id=?,version=version+1,updated_at=? WHERE id=?').bind(owner,now,customer.id),db.prepare('UPDATE wholesale_orders SET service_user_id=?,version=version+1,updated_at=? WHERE customer_id=?').bind(owner,now,customer.id));
    }else{
      const values=['name','contact','phone','city','address'].map(k=>clean(p[k],k==='address'?600:120));if(values.some(v=>!v))fail(400,'客户名称、联系人、电话、城市和地址必须完整');
      if(clean(p.reason).length<4)fail(400,'修改客户资料需填写原因');
      const duplicate=await first(db,"SELECT id FROM wholesale_customers WHERE id<>? AND active=1 AND lower(trim(name))=lower(trim(?)) AND replace(replace(phone,' ',''),'-','')=replace(replace(?,' ',''),'-','')",[customer.id,values[0],values[2]]);
      if(duplicate&&p.active!==false)fail(409,'已有同名同电话客户，请管理员核对，避免重复建档');
      statements.push(db.prepare('UPDATE wholesale_customers SET name=?,contact=?,phone=?,city=?,address=?,note=?,active=?,version=version+1,updated_at=? WHERE id=?').bind(...values,clean(p.note,600),p.active===false?0:1,now,customer.id));
    }
    return commit(db,actor,p,customer.id,statements,'EXISTS (SELECT 1 FROM wholesale_customers WHERE id=? AND version=?)',[customer.id,customer.version]);
  }
  roles(actor,['管理员','财务']);
  if(action==='financePeriodClose'||action==='financePeriodReopen'){
    const month=clean(p.month,7),note=clean(p.reason,1000);
    if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)||month>=indonesiaDate().slice(0,7)||note.length<4)fail(400,'请选择已结束月份并填写关账或反关账原因');
    const period=await first(db,'SELECT * FROM wholesale_finance_periods WHERE month=?',[month]);
    if(action==='financePeriodReopen'){
      roles(actor,['管理员']);if(!period||period.status!=='closed')fail(409,'该月尚未关账');
      if(await first(db,"SELECT month FROM wholesale_finance_periods WHERE status='closed' AND month>?",[month]))fail(409,'请从最近的已关账月份开始逐月反关账');
      return commit(db,actor,p,month,[db.prepare("UPDATE wholesale_finance_periods SET status='open',version=version+1,note=?,actor_id=?,updated_at=? WHERE month=?").bind(note,actor.id,now,month)],"EXISTS (SELECT 1 FROM wholesale_finance_periods WHERE month=? AND status='closed' AND version=?) AND NOT EXISTS (SELECT 1 FROM wholesale_finance_periods WHERE status='closed' AND month>?)",[month,period.version,month]);
    }
    if(period?.status==='closed')fail(409,'该月已经关账');
    if(await first(db,"SELECT month FROM wholesale_finance_periods WHERE status='closed' AND month>?",[month]))fail(409,'该月份已包含在后续关账截止日内');
    const snapshot=await loadWholesaleExportSnapshot(db,actor),report=monthlyReconciliation(snapshot.orders,month,indonesiaDate());
    const frozen={...snapshot,closedMonth:month,closedAt:now,closedBy:actor.id,report};
    statements.push(db.prepare("INSERT INTO wholesale_finance_periods(month,status,version,snapshot_json,note,actor_id,updated_at) VALUES (?,'closed',1,?,?,?,?) ON CONFLICT(month) DO UPDATE SET status='closed',version=wholesale_finance_periods.version+1,snapshot_json=excluded.snapshot_json,note=excluded.note,actor_id=excluded.actor_id,updated_at=excluded.updated_at").bind(month,JSON.stringify(frozen),note,actor.id,now));
    return commit(db,actor,p,month,statements,"COALESCE((SELECT version FROM wholesale_finance_clock WHERE id='global'),0)=? AND COALESCE((SELECT version FROM wholesale_finance_periods WHERE month=?),0)=?",[snapshot.financeVersion||0,month,period?.version||0]);
  }
  if(action==='bankReceiptCreate'){
    const c=await first(db,'SELECT * FROM wholesale_customers WHERE id=? AND active=1',[clean(p.customerId,100)]);if(!c)fail(400,'请选择有效客户');
    const amount=positive(p.amount),reference=clean(p.reference,160),businessDate=date(p.businessDate),note=clean(p.note,1000),bankAccount=clean(p.bankAccount,200);if(!reference||!bankAccount||note.length<4)fail(400,'请填写银行流水号、公司收款账户和核对说明');
    const receiptId=id('bank');
    statements.push(db.prepare('INSERT INTO wholesale_bank_receipts(id,customer_id,reference,bank_account,business_date,amount,note,actor_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)').bind(receiptId,c.id,reference,bankAccount,businessDate,amount,note,actor.id,now));
    return commit(db,actor,p,receiptId,statements,"NOT EXISTS (SELECT 1 FROM wholesale_finance_entries WHERE bank_receipt_id IS NULL AND kind='receipt' AND reference=?)",[reference]);
  }
  if(action==='financeReverse'){
    const entry=await first(db,'SELECT * FROM wholesale_finance_entries WHERE id=?',[clean(p.entryId,100)]);if(!entry||!['receipt','refund'].includes(entry.kind))fail(400,'请选择原始回款或退款记录');
    if(await first(db,'SELECT id FROM wholesale_finance_entries WHERE reverses_id=?',[entry.id]))fail(409,'该记录已经冲正');
    const order=await first(db,'SELECT * FROM wholesale_orders WHERE id=?',[entry.order_id]);version(order.version,p.version);
    const current=await orderMoney(db,order);if(entry.kind==='receipt'&&current.paid<entry.amount)fail(409,'请先核对并冲正相关退款，再撤销原回款');
    const businessDate=date(p.businessDate),reference=clean(p.reference,160),note=clean(p.note,1000);if(businessDate<entry.business_date||!reference||note.length<4)fail(400,'冲正日期不能早于原记录，必须填写凭证和原因');
    const kind=entry.kind==='receipt'?(entry.bank_receipt_id?'receipt_unallocate':'receipt_void'):'refund_void';
    statements.push(db.prepare('INSERT INTO wholesale_finance_entries(id,order_id,kind,amount,reference,business_date,note,actor_id,created_at,bank_receipt_id,reverses_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)').bind(id('whfin'),order.id,kind,entry.amount,reference,businessDate,note,actor.id,now,entry.bank_receipt_id||null,entry.id),db.prepare('UPDATE wholesale_orders SET version=version+1,updated_at=? WHERE id=?').bind(now,order.id));
    let guard='EXISTS (SELECT 1 FROM wholesale_orders WHERE id=? AND version=?)',args=[order.id,order.version];
    if(entry.bank_receipt_id){
      const bank=await first(db,'SELECT * FROM wholesale_bank_receipts WHERE id=?',[entry.bank_receipt_id]);if(!bank||bank.allocated_amount<entry.amount)fail(409,'原收款分配余额异常');
      guard+=' AND EXISTS(SELECT 1 FROM wholesale_bank_receipts WHERE id=? AND version=?)';args.push(bank.id,bank.version);
      statements.push(db.prepare('UPDATE wholesale_bank_receipts SET allocated_amount=allocated_amount-?,version=version+1 WHERE id=?').bind(entry.amount,bank.id));
    }
    return commit(db,actor,p,order.id,statements,guard,args);
  }
  const bank=await first(db,'SELECT * FROM wholesale_bank_receipts WHERE id=?',[clean(p.receiptId,100)]);if(!bank)fail(404,'收款单不存在');version(bank.version,p.version);
  const businessDate=date(p.businessDate);if(businessDate<bank.business_date)fail(400,'业务日期不能早于银行收款日期');
  let guard='EXISTS(SELECT 1 FROM wholesale_bank_receipts WHERE id=? AND version=?)',args=[bank.id,bank.version];
  const remaining=bank.amount-bank.allocated_amount-bank.refunded_amount-bank.voided_amount;
  if(action==='bankReceiptAllocate'){
    if(!Array.isArray(p.allocations)||!p.allocations.length||p.allocations.length>50)fail(400,'请选择1至50张订单进行核销');
    const seen=new Set();let total=0;
    for(const allocation of p.allocations){
      const order=await first(db,'SELECT * FROM wholesale_orders WHERE id=?',[clean(allocation.orderId,100)]),amount=positive(allocation.amount);
      if(!order||order.customer_id!==bank.customer_id||seen.has(order.id))fail(400,'核销订单须属于同一客户，且不能重复');seen.add(order.id);version(order.version,allocation.version);
      if(['pending','rejected','cancelled'].includes(order.status)||businessDate<order.business_date)fail(409,'订单尚未批准、已取消或核销日期早于订单');
      const money=await orderMoney(db,order);if(amount>money.outstanding)fail(409,'核销金额超过订单待收金额');total+=amount;
      guard+=' AND EXISTS(SELECT 1 FROM wholesale_orders WHERE id=? AND version=?)';args.push(order.id,order.version);
      statements.push(db.prepare('INSERT INTO wholesale_finance_entries(id,order_id,kind,amount,reference,business_date,note,actor_id,created_at,bank_receipt_id) VALUES(?,?,\'receipt\',?,?,?,?,?,?,?)').bind(id('whfin'),order.id,amount,bank.reference,businessDate,clean(p.note)||'银行收款分配核销',actor.id,now,bank.id),db.prepare('UPDATE wholesale_orders SET version=version+1,updated_at=? WHERE id=?').bind(now,order.id));
    }
    if(total>remaining)fail(409,'核销合计超过该银行收款的未分配余额');
    statements.push(db.prepare('UPDATE wholesale_bank_receipts SET allocated_amount=allocated_amount+?,version=version+1 WHERE id=?').bind(total,bank.id));
  }else if(action==='bankReceiptRefund'||action==='bankReceiptVoid'){
    const amount=positive(p.amount),reference=clean(p.reference,160),note=clean(p.note,1000);
    if(amount>remaining||!reference||note.length<4)fail(409,'金额不能超过未分配余额，且需填写凭证和原因；已核销金额请先撤销核销');
    const kind=action==='bankReceiptRefund'?'refund':'receipt_void';
    statements.push(db.prepare('INSERT INTO wholesale_bank_events(id,receipt_id,kind,amount,business_date,reference,note,actor_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)').bind(id('bankevt'),bank.id,kind,amount,businessDate,reference,note,actor.id,now),db.prepare(`UPDATE wholesale_bank_receipts SET ${kind==='refund'?'refunded_amount':'voided_amount'}=${kind==='refund'?'refunded_amount':'voided_amount'}+?,version=version+1 WHERE id=?`).bind(amount,bank.id));
  }else fail(400,'未知财务操作');
  return commit(db,actor,p,bank.id,statements,guard,args);
}
