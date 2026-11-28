import {DomesticError,cnyMinor,domesticFinancial,domesticToday} from './domestic-distribution.mjs';
const fail=(s,m)=>{throw new DomesticError(s,m);};
const sql=(db,s,args=[])=>db.prepare(s).bind(...args);
const rows=async(db,s,args=[])=>(await sql(db,s,args).all()).results||[];
const first=(db,s,args=[])=>sql(db,s,args).first();
const id=p=>p+'_'+crypto.randomUUID();
const required=(v,label,max=600)=>{const s=String(v||'').trim();if(!s||s.length>max)fail(400,`请填写${label}（最多${max}字）`);return s;};
const date=v=>{const s=String(v||'');if(!/^\d{4}-\d{2}-\d{2}$/.test(s)||!Number.isFinite(Date.parse(s))||new Date(s).toISOString().slice(0,10)!==s||s>domesticToday())fail(400,'请选择有效实际日期，不能晚于中国今天');return s;};
export const domesticBankActions=new Set(['bankReceiptCreate','bankAllocate','bankUnallocate','bankRefund','bankRefundReverse','bankVoid','bankProofLink']);

export function domesticBankBalances(receipts,events,entries){
 return receipts.map(b=>{
  const es=events.filter(e=>e.receipt_id===b.id),allocations=entries.filter(e=>e.bank_receipt_id===b.id);
  const allocatedMinor=allocations.reduce((n,e)=>n+(e.kind==='receipt'?e.amount_minor:e.kind==='receipt_reverse'?-e.amount_minor:0),0);
  const refundsMinor=es.reduce((n,e)=>n+(e.kind==='refund'?e.amount_minor:e.kind==='refund_reverse'?-e.amount_minor:0),0);
  const voidedMinor=es.filter(e=>e.kind==='void').reduce((n,e)=>n+e.amount_minor,0);
  return {...b,allocations,events:es,allocatedMinor,refundsMinor,voidedMinor,unallocatedMinor:b.amount_minor-allocatedMinor-refundsMinor-voidedMinor};
 });
}
export async function readDomesticBank(db,{cutoff=domesticToday(),includeVersion=true}={}){
 const [bs,es,as]=await Promise.all([
  rows(db,'SELECT b.*,c.company_short_name customer_name FROM domestic_bank_receipts b JOIN domestic_customers c ON c.id=b.customer_id WHERE b.business_date<=? ORDER BY b.business_date DESC,b.created_at DESC',[cutoff]),
  rows(db,'SELECT * FROM domestic_bank_events WHERE business_date<=?',[cutoff]),
  rows(db,'SELECT e.*,o.order_no FROM domestic_finance_entries e JOIN domestic_orders o ON o.id=e.order_id WHERE e.bank_receipt_id IS NOT NULL AND e.business_date<=?',[cutoff])
 ]);
 const receipts=domesticBankBalances(bs,es,as).map(b=>{if(includeVersion)return b;const {version,...fact}=b;return fact;}),sum=k=>receipts.reduce((n,b)=>n+b[k],0);
 return {receipts,events:es,totals:{receivedMinor:sum('amount_minor'),allocatedMinor:sum('allocatedMinor'),unallocatedMinor:sum('unallocatedMinor'),refundedMinor:sum('refundsMinor'),voidedMinor:sum('voidedMinor')}};
}

// Uses the same optimistic operation/finance clock transaction as orders.
export async function mutateDomesticBank({db,a,p,commit,openPeriod,financeVersion}){
 if(a.role!=='财务')fail(403,'仅财务可登记银行到账、分配及退款；管理员可查看');
 const action=p.action,now=new Date().toISOString(),reason=required(p.reason,'财务核对说明');
 const persist=(entity,statements,guard='1=1',args=[])=>commit(db,a,p,entity,statements,null,guard,args,financeVersion);
 const bump=b=>sql(db,'UPDATE domestic_bank_receipts SET version=version+1 WHERE id=?',[b.id]);
 const bankGuard=b=>['EXISTS(SELECT 1 FROM domestic_bank_receipts WHERE id=? AND version=?)',[b.id,b.version]];
 const proof=async(customerId)=>{
  const f=await first(db,"SELECT f.* FROM domestic_files f JOIN domestic_orders o ON o.id=f.order_id WHERE f.id=? AND o.customer_id=? AND f.purpose='finance'",[String(p.proofId||''),customerId]);
  if(!f)fail(400,'请在该客户订单上传公司银行凭证，再选择凭证；客户截图不能代替到账');
  if(p.actualConfirmed!==true)fail(400,'请财务确认已核对公司银行实际流水');return f;
 };
 const link=async(b)=>{
  const s=await first(db,'SELECT s.*,o.customer_id FROM domestic_payment_submissions s JOIN domestic_orders o ON o.id=s.order_id WHERE s.id=?',[String(p.submissionId||'')]);
  if(!s||s.customer_id!==b.customer_id)fail(400,'付款凭证与银行收款须属于同一客户');
  if(s.actor_id===a.id)fail(403,'不能复核本人提交的付款凭证');
  if(await first(db,'SELECT id FROM domestic_payment_reviews WHERE submission_id=? UNION ALL SELECT id FROM domestic_bank_proof_links WHERE submission_id=?',[s.id,s.id]))fail(409,'付款凭证已核对，请查看原记录');
  return sql(db,'INSERT INTO domestic_bank_proof_links(id,submission_id,receipt_id,reason,actor_id,created_at) VALUES(?,?,?,?,?,?)',[id('domlink'),s.id,b.id,reason,a.id,now]);
 };
 if(action==='bankReceiptCreate'){
  const customerId=String(p.customerId||''),customer=await first(db,'SELECT * FROM domestic_customers WHERE id=? AND active=1',[customerId]);
  if(!customer)fail(400,'请选择有效客户');
  const amount=cnyMinor(p.amount),when=date(p.businessDate),reference=required(p.bankReference,'银行流水号',160),account=required(p.bankAccount,'公司收款账户',160);
  await openPeriod(when);await proof(customerId);
  if(await first(db,'SELECT id FROM domestic_bank_receipts WHERE bank_reference=? UNION ALL SELECT id FROM domestic_finance_entries WHERE bank_reference=?',[reference,reference]))fail(409,'该银行流水已登记，请选原收款分配，不能再次登记到账');
  // Same evidence already verified through either old or new workflow must not create another cash fact.
  if(p.submissionId){const duplicate=await first(db,"SELECT s.id FROM domestic_payment_submissions s WHERE s.id<>? AND s.digest=(SELECT digest FROM domestic_payment_submissions WHERE id=?) AND (EXISTS(SELECT 1 FROM domestic_bank_proof_links l WHERE l.submission_id=s.id) OR EXISTS(SELECT 1 FROM domestic_payment_reviews r WHERE r.submission_id=s.id AND r.outcome='confirmed'))",[p.submissionId,p.submissionId]);if(duplicate)fail(409,'相同付款图片已有核对记录，请核实原银行流水；如为重复提交，请关联已有收款');}
  const bank={id:id('dombank'),customer_id:customerId};
  const statements=[sql(db,'INSERT INTO domestic_bank_receipts(id,customer_id,amount_minor,business_date,bank_reference,bank_account,proof_id,reason,actor_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',[bank.id,customerId,amount,when,reference,account,p.proofId,reason,a.id,now])];
  if(p.submissionId)statements.push(await link(bank));
  return persist(bank.id,statements);
 }
 const bank=(await readDomesticBank(db)).receipts.find(b=>b.id===p.receiptId);
 if(!bank)fail(404,'客户银行收款不存在');if(Number(p.version)!==bank.version)fail(409,'收款余额已变化，请刷新核对');
 if(bank.voidedMinor)fail(409,'该到账记录已冲销，请查看更正后的银行记录');
 const [guard,args]=bankGuard(bank);
 if(action==='bankProofLink')return persist(bank.id,[await link(bank),bump(bank)],guard,args);
 const when=date(p.businessDate);if(when<bank.business_date)fail(400,'处理日期不能早于银行到账日');await openPeriod(when);
 const latest=[bank.business_date,...bank.events.map(e=>e.business_date),...bank.allocations.map(e=>e.business_date)].sort().at(-1);if(when<latest)fail(409,'该收款已有较晚的分配或退款，请在最近处理日期之后登记，保留历史余额');
 if(action==='bankAllocate'){
  if(!Array.isArray(p.allocations)||!p.allocations.length||p.allocations.length>100)fail(400,'请填写本次核销订单及金额');
  const seen=new Set(),statements=[];let total=0,orderGuard='';const orderArgs=[];
  for(const input of p.allocations){
   if(seen.has(input.orderId))fail(400,'同一订单请合并填写');seen.add(input.orderId);
   const o=await first(db,'SELECT * FROM domestic_orders WHERE id=?',[String(input.orderId||'')]);
   if(!o||o.customer_id!==bank.customer_id)fail(403,'仅可分配给同一客户的订单');
   if(o.status!=='approved')fail(409,'只可核销已批准合同；其他金额先保留客户余额');
   if(await first(db,"SELECT id FROM domestic_cancel_requests WHERE order_id=? AND status='pending'",[o.id]))fail(409,'订单正在取消审核，暂不分配；真实到账可先留客户余额');
   if(Number(input.version)!==o.version)fail(409,'订单已变化，请刷新核对');
   const approvedDate=new Date(Date.parse(o.reviewed_at)+8*3600000).toISOString().slice(0,10);
   if(when<o.business_date||when<approvedDate)fail(400,'核销日期不能早于订单及合同批准日');
   const [items,entries]=await Promise.all([rows(db,'SELECT * FROM domestic_order_items WHERE order_id=?',[o.id]),rows(db,'SELECT * FROM domestic_finance_entries WHERE order_id=?',[o.id])]);
   if(entries.some(e=>e.business_date>when))fail(409,'订单已有较晚财务记录，请按当前实际核销日期处理');
   const available=domesticFinancial(o,items,entries).contractOutstandingMinor,amount=cnyMinor(input.amount);total+=amount;
   if(amount>available)fail(409,`${o.order_no} 当前最多可核销 ${(available/100).toFixed(2)} 元；多余款项保留客户余额，寄售须先核对已售`);
   // A backdated allocation cannot use consignment sales confirmed after its business date.
   if(o.settlement_mode==='consignment'){
    const sold=await first(db,'SELECT COALESCE(SUM(amount_minor),0) n FROM domestic_consignment_sales WHERE order_id=? AND business_date<=?',[o.id,when]);
    if(amount>Number(sold.n)-domesticFinancial(o,items,entries).paidMinor)fail(409,'本次核销超过该日期已确认寄售售出余额');
   }
   const entry=id('domallocation');statements.push(sql(db,"INSERT INTO domestic_finance_entries(id,order_id,kind,amount_minor,business_date,bank_reference,bank_account,proof_id,reason,actor_id,created_at,bank_receipt_id) VALUES(?,?,'receipt',?,?,?,?,?,?,?,?,?)",[entry,o.id,amount,when,entry,bank.bank_account,bank.proof_id,reason,a.id,now,bank.id]),sql(db,'UPDATE domestic_orders SET version=version+1,updated_at=? WHERE id=?',[now,o.id]));
   orderGuard+=' AND EXISTS(SELECT 1 FROM domestic_orders WHERE id=? AND version=? AND status=?)';orderArgs.push(o.id,o.version,o.status);
  }
  if(total>bank.unallocatedMinor)fail(409,`本次分配超过客户可用余额 ${(bank.unallocatedMinor/100).toFixed(2)} 元`);
  // Do not spend a later unallocation/refund reversal on an earlier date.
  const historical=(await readDomesticBank(db,{cutoff:when})).receipts.find(b=>b.id===bank.id);
  if(total>(historical?.unallocatedMinor||0))fail(409,'该日期客户余额不足，不能使用较晚解配或退款冲销释放的余额');
  return persist(bank.id,[...statements,bump(bank)],guard+orderGuard,[...args,...orderArgs]);
 }
 if(action==='bankUnallocate'){
  const e=bank.allocations.find(e=>e.id===p.entryId&&e.kind==='receipt');
  if(!e||bank.allocations.some(r=>r.related_id===e.id))fail(409,'原分配不存在或已解除');
  if(when<e.business_date)fail(400,'解除日期不能早于原分配');
  const o=await first(db,'SELECT * FROM domestic_orders WHERE id=?',[e.order_id]);
  if(await first(db,'SELECT id FROM domestic_finance_entries WHERE order_id=? AND business_date>?',[o.id,when]))fail(409,'订单已有较晚财务记录，请按当前实际解除日期处理');
  const entry=id('domunallocate');
  return persist(bank.id,[sql(db,"INSERT INTO domestic_finance_entries(id,order_id,kind,amount_minor,business_date,bank_reference,bank_account,related_id,proof_id,reason,actor_id,created_at,bank_receipt_id) VALUES(?,?,'receipt_reverse',?,?,?,?,?,?,?,?,?,?)",[entry,o.id,e.amount_minor,when,entry,bank.bank_account,e.id,bank.proof_id,reason,a.id,now,bank.id]),sql(db,'UPDATE domestic_orders SET version=version+1,released_at=NULL,release_by=NULL,updated_at=? WHERE id=?',[now,o.id]),bump(bank)],guard+' AND EXISTS(SELECT 1 FROM domestic_orders WHERE id=? AND version=?)',[...args,o.id,o.version]);
 }
 await proof(bank.customer_id);
 const reference=required(p.bankReference,'银行退款或更正参考号',160);let amount,kind,related=null;
 if(action==='bankRefund'){amount=cnyMinor(p.amount);kind='refund';if(amount>bank.unallocatedMinor)fail(409,'退款超过未分配余额；订单内款项请先核实取消或解配');const historical=(await readDomesticBank(db,{cutoff:when})).receipts.find(b=>b.id===bank.id);if(amount>(historical?.unallocatedMinor||0))fail(409,'退款日期的未分配余额不足');}
 else if(action==='bankRefundReverse'){const e=bank.events.find(e=>e.id===p.entryId&&e.kind==='refund');if(!e||bank.events.some(x=>x.related_id===e.id))fail(409,'退款不存在或已经冲销');if(when<e.business_date)fail(400,'更正日期不能早于原退款');amount=e.amount_minor;kind='refund_reverse';related=e.id;}
 else if(action==='bankVoid'){if(bank.unallocatedMinor!==bank.amount_minor)fail(409,'请先解除全部分配并核对退款后，再冲销错误到账');amount=bank.amount_minor;kind='void';}
 else fail(400,'未知银行收款操作');
 return persist(bank.id,[sql(db,'INSERT INTO domestic_bank_events(id,receipt_id,kind,amount_minor,business_date,reference,related_id,proof_id,reason,actor_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',[id('dombankevent'),bank.id,kind,amount,when,reference,related,p.proofId,reason,a.id,now]),bump(bank)],guard,args);
}
