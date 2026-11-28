import {domesticBankActions,mutateDomesticBank,readDomesticBank} from './domestic-bank.mjs';
import {domesticOverdue} from './domestic-followup.mjs';
import {assertWritable} from './atomic.mjs';
import {assertFinanceOpen,financeClock,financeGuardSql} from './finance-periods.mjs';
import {uniqueBusinessNumber} from './distribution-identifiers.mjs';

export class DomesticError extends Error { constructor(status,message){super(message);this.status=status;} }
const fail=(status,message)=>{throw new DomesticError(status,message);};
const text=(v,max=240)=>String(v??'').trim().slice(0,max), uid=p=>`${p}_${crypto.randomUUID()}`, stamp=()=>new Date().toISOString();
export const domesticToday=()=>new Date(Date.now()+8*3600000).toISOString().slice(0,10);
const stmt=(db,sql,args=[])=>db.prepare(sql).bind(...args), rows=async(db,sql,args=[])=>((await stmt(db,sql,args).all()).results??[]), first=(db,sql,args=[])=>stmt(db,sql,args).first();
const parse=(v,fallback={})=>{try{return JSON.parse(v);}catch{return fallback;}};
const positive=(v,label)=>{const n=Number(v);if(!Number.isSafeInteger(n)||n<=0||n>1000000000)fail(400,`${label}必须是有效正整数`);return n;};
export function cnyMinor(value){const s=String(value??'').trim();if(!/^(0|[1-9]\d{0,9})(\.\d{1,2})?$/.test(s))fail(400,'人民币金额须大于零且最多两位小数');const [a,b='']=s.split('.'),n=Number(a)*100+Number(b.padEnd(2,'0'));if(!Number.isSafeInteger(n)||n<=0||n>1000000000000)fail(400,'人民币金额超出范围');return n;}
function date(v,{future=false}={}){const s=String(v??'').trim();if(!/^\d{4}-\d{2}-\d{2}$/.test(s)||!Number.isFinite(Date.parse(s))||new Date(s).toISOString().slice(0,10)!==s||(!future&&s>domesticToday()))fail(400,'业务日期无效或晚于中国今天');return s;}
const required=(v,label,max=240)=>{const s=text(v,max);if(!s)fail(400,`请填写${label}`);return s;};
function settlementTerms(p,total,businessDate,previous=null){
 const mode=p.settlementMode??previous?.settlement_mode??'prepaid';
 if(!['prepaid','deposit','credit','consignment'].includes(mode))fail(400,'请选择现金结算、账期或其他合同结算方式');
 const raw=p.dueDate??previous?.due_date;
 const due=mode!=='prepaid'||raw?date(raw,{future:true}):null;
 if(due&&due<businessDate)fail(400,'约定回款或对账日期不能早于订单日期');
 const release=mode==='prepaid'?total:mode==='deposit'?cnyMinor(p.releaseAmount??(previous?.release_amount_minor/100)):0;
 if(mode==='deposit'&&release>=total)fail(400,'定金放货金额须小于合同总额；全款请选现金结算');
 return {mode,due,release};
}
export const domesticCapabilities=actor=>({read:['管理员','财务','供应链','工厂'].includes(actor.role),manage:['管理员','供应链'].includes(actor.role),approve:['管理员','财务'].includes(actor.role),execute:['管理员','供应链','工厂'].includes(actor.role),finance:actor.role==='财务'});
export function canReadDomesticOrder(actor,o){return domesticCapabilities(actor).read&&(['管理员','财务'].includes(actor.role)||actor.role==='供应链'&&o.supply_user_id===actor.id||actor.role==='工厂'&&o.factory_user_id===actor.id&&o.status==='approved');}
async function activeActor(db,actor){const a=await first(db,'SELECT id,role,name,active FROM users WHERE id=?',[actor.id]);if(!a||!a.active||a.role!==actor.role||!domesticCapabilities(a).read)fail(403,'当前账号无权使用国内线下分销');return {...actor,...a};}
function permission(actor,key){if(!domesticCapabilities(actor)[key])fail(403,'当前岗位无权执行此操作');}
export async function domesticOrderFor(db,actor,id){const o=await first(db,'SELECT * FROM domestic_orders WHERE id=?',[text(id,100)]);if(!o)fail(404,'国内订单不存在');if(!canReadDomesticOrder(actor,o))fail(403,'该国内订单不在本人责任范围内');return o;}
const itemsFor=(db,id)=>rows(db,'SELECT * FROM domestic_order_items WHERE order_id=? ORDER BY sku',[id]);
const entriesFor=(db,id)=>rows(db,'SELECT * FROM domestic_finance_entries WHERE order_id=? ORDER BY created_at',[id]);
export function domesticFinancial(o,items,entries){
 const paid=entries.reduce((s,e)=>s+(['receipt','refund_reverse'].includes(e.kind)?1:-1)*e.amount_minor,0);
 const soldMinor=items.reduce((s,i)=>s+i.sold_qty*i.unit_minor,0),shippedMinor=items.reduce((s,i)=>s+i.shipped_qty*i.unit_minor,0);
 const payable=o.status==='cancelled'?0:o.settlement_mode==='consignment'?soldMinor:o.total_minor;
 const unsettledConsignmentQty=o.settlement_mode==='consignment'?items.reduce((s,i)=>s+i.shipped_qty-i.sold_qty,0):0;
 const due=Math.max(0,payable-paid),receivable=Math.max(0,(o.settlement_mode==='consignment'?soldMinor:shippedMinor)-paid);
 return {...domesticOverdue({status:o.status,mode:o.settlement_mode,dueDate:o.due_date,remaining:due,receivable,unsold:unsettledConsignmentQty}),hasLedgerEntries:entries.length>0,unfulfilledMinor:o.status==='cancelled'?0:Math.max(0,o.total_minor-shippedMinor),advanceMinor:Math.max(0,paid-(o.settlement_mode==='consignment'?soldMinor:shippedMinor)),paidMinor:paid,payableMinor:payable,contractOutstandingMinor:due,receivableMinor:receivable,refundDueMinor:Math.max(0,paid-payable),soldMinor,shippedMinor,unsettledConsignmentQty,
  overdue:Boolean(o.due_date&&o.due_date<domesticToday()&&(due>0||unsettledConsignmentQty>0)&&o.status==='approved'),
  status:paid>payable?'refund_due':o.settlement_mode==='consignment'&&payable===0?'consignment_unsettled':due===0&&unsettledConsignmentQty>0?'consignment_partial_settled':due===0?'paid':paid>0?'partial':'unpaid'};
}
export function domesticFulfillment(o,items){const sum=k=>items.reduce((s,i)=>s+i[k],0),packed=sum('packed_qty'),shipped=sum('shipped_qty'),received=sum('received_qty');return {status:o.status!=='approved'?o.status:received===o.total_qty?'delivered':received>0?'partial_received':shipped===o.total_qty?'dispatched':shipped>0?'partial_dispatched':packed===o.total_qty?'packed':packed>0?'preparing':'awaiting_preparation',packed,shipped,received,total:o.total_qty};}
function releaseThreshold(o){return o.settlement_mode==='prepaid'?o.total_minor:o.settlement_mode==='deposit'?o.release_amount_minor:0;}
function gate(o,money){return !o.cancelPending&&o.status==='approved'&&Boolean(o.released_at)&&money.paidMinor>=releaseThreshold(o);}
const audit=(db,a,action,id,detail)=>stmt(db,'INSERT INTO audit_logs(id,action,entity_type,entity_id,detail_json,actor_id,actor_name,created_at) VALUES(?,?,?,?,?,?,?,?)',[uid('audit'),action,'国内线下分销',id,JSON.stringify(detail),a.id,a.name,stamp()]);
async function commit(db,a,p,id,statements,o=null,extraGuard='1=1',extraArgs=[],financeVersion=null){
 const fg=financeVersion===null?{sql:'1=1',args:[]}:financeGuardSql(financeVersion);extraGuard+=' AND '+fg.sql;extraArgs=[...extraArgs,...fg.args];
 const guard=`EXISTS(SELECT 1 FROM users WHERE id=? AND active=1 AND role=?)${o?' AND EXISTS(SELECT 1 FROM domestic_orders WHERE id=? AND version=? AND status=?)':''} AND (${extraGuard})`;
 const args=[a.id,a.role,...(o?[o.id,o.version,o.status]:[]),...extraArgs],now=stamp();
 const op=stmt(db,`INSERT INTO domestic_operations(id,entity_id,action,actor_id,request_json,guard,created_at) VALUES(?,?,?,?,?,CASE WHEN (${guard}) THEN 1 ELSE 0 END,?)`,[p.operationId,id,p.action,a.id,JSON.stringify(p),...args,now]);
 try{await db.batch([op,...statements,...(o?[stmt(db,'UPDATE domestic_orders SET version=version+1,updated_at=? WHERE id=?',[now,o.id])]:[]),audit(db,a,p.action,id,{operationId:p.operationId,version:p.version??null})]);}
 catch(e){if(/closed finance period/.test(String(e)))fail(409,'该期间已关账；请管理员先反关账，保留原快照后再修订');const old=await first(db,'SELECT * FROM domestic_operations WHERE id=?',[p.operationId]);if(old&&old.actor_id===a.id&&old.request_json===JSON.stringify(p))return {ok:true,id:old.entity_id,replayed:true};if(/CHECK|UNIQUE|guard_|immutable|FOREIGN KEY/i.test(String(e)))fail(409,'订单、凭证或数量已变化，或编号已使用；本次未保存，请刷新核对');throw e;}return {ok:true,id};
}
async function proof(db,o,id,purpose){const f=await first(db,'SELECT * FROM domestic_files WHERE id=? AND order_id=? AND purpose=?',[text(id,100),o.id,purpose]);if(!f)fail(400,'请先上传属于本订单及对应环节的凭证');if(['quote','contract'].includes(purpose)&&f.order_version!==o.version)fail(409,'报价或合同凭证属于旧版订单，请上传本版客户确认材料');return f;}
async function normalizedItems(db,input){if(!Array.isArray(input)||!input.length||input.length>300)fail(400,'请填写1至300个SKU');const seen=new Set(),out=[];for(const v of input){const sku=required(v.sku,'SKU',100).toUpperCase();if(seen.has(sku))fail(400,'同一SKU请合并为一行');seen.add(sku);const setting=await first(db,'SELECT sku,name FROM sku_settings WHERE sku=?',[sku]);if(!setting)fail(400,`${sku}尚未建立商品档案`);const qty=positive(v.qty,'数量'),unit=cnyMinor(v.unitPrice);out.push({id:uid('domitem'),sku,name:setting.name,qty,unit});}const total=out.reduce((s,i)=>s+i.qty*i.unit,0);if(!Number.isSafeInteger(total)||total>1e12)fail(400,'订单人民币金额超出范围');return {items:out,total,qty:out.reduce((s,i)=>s+i.qty,0)};}
const itemInserts=(db,id,items)=>items.map(i=>stmt(db,'INSERT INTO domestic_order_items(id,order_id,sku,name,qty,unit_minor) VALUES(?,?,?,?,?,?)',[i.id,id,i.sku,i.name,i.qty,i.unit]));
function snapshot(db,a,o,items,action,reason){return stmt(db,'INSERT INTO domestic_order_versions(id,order_id,order_version,snapshot_json,action,reason,actor_id,created_at) VALUES(?,?,?,?,?,?,?,?)',[uid('domversion'),o.id,o.version,JSON.stringify({order:o,items}),action,reason,a.id,stamp()]);}
function requestLines(input,key,allowed){if(!Array.isArray(input)||!input.length||input.length>300)fail(400,'请填写本次数量');const seen=new Set();return input.map(v=>{const id=text(v[key],100);if(seen.has(id))fail(400,'同一明细不能重复提交');seen.add(id);const line=allowed.find(i=>i.id===id);if(!line)fail(400,'明细不属于当前订单或批次');return {line,qty:positive(v.qty,'本次数量')};});}

export async function mutateDomesticDistribution(db,actor,p){
 const a=await activeActor(db,actor);await assertWritable(db);if(!p||!/^[A-Za-z0-9_-]{16,100}$/.test(text(p.operationId,110)))fail(400,'缺少有效操作编号');if(p.currency&&p.currency!=='CNY'||p.country&&p.country!=='CN')fail(400,'国内分销仅支持中国及人民币');
 const previous=await first(db,'SELECT * FROM domestic_operations WHERE id=?',[p.operationId]);if(previous){if(previous.actor_id!==a.id||previous.request_json!==JSON.stringify(p))fail(409,'操作编号已用于其他请求');if(domesticBankActions.has(previous.action)){permission(a,'finance');}else if(previous.action.startsWith('customer')){const c=await first(db,'SELECT * FROM domestic_customers WHERE id=?',[previous.entity_id]);if(!c||a.role==='供应链'&&c.supply_user_id!==a.id)fail(403,'客户不在本人责任范围内');}else await domesticOrderFor(db,a,previous.entity_id);return {ok:true,id:previous.entity_id,replayed:true};}
 const action=p.action,now=stamp(),financeVersion=await financeClock(db);
 const openPeriod=async when=>{try{await assertFinanceOpen(db,when);}catch(e){fail(e.status||409,e.message);}};
 if(domesticBankActions.has(action))return mutateDomesticBank({db,a,p,commit,openPeriod,financeVersion});
 if(action==='customerUpdate'){
  permission(a,'manage');const c=await first(db,'SELECT * FROM domestic_customers WHERE id=?',[text(p.customerId,100)]);
  if(!c||a.role==='供应链'&&c.supply_user_id!==a.id)fail(403,'客户不在本人责任范围内');if(Number(p.version)!==c.version)fail(409,'客户档案已变化，请刷新后修改');
  const owner=p.supplyUserId||c.supply_user_id;if(owner!==c.supply_user_id&&a.role!=='管理员')fail(403,'客户负责人交接须管理员确认');
  if(!await first(db,"SELECT id FROM users WHERE id=? AND role='供应链' AND active=1",[owner]))fail(400,'请选择有效供应链负责人');
  const name=required(p.companyName,'公司全称',180),short=required(p.companyShortName,'公司简称',60),phone=required(p.phone,'联系电话',60),reason=required(p.reason,'修改或交接原因',600);
  if(await first(db,'SELECT id FROM domestic_customers WHERE company_name=? AND phone=? AND id<>?',[name,phone,c.id]))fail(409,'同公司及电话已有档案，请核对，不能重复创建');
  return commit(db,a,p,c.id,[stmt(db,'INSERT INTO domestic_customer_versions(id,customer_id,version,snapshot_json,reason,actor_id,created_at) VALUES(?,?,?,?,?,?,?)',[uid('domcustver'),c.id,c.version,JSON.stringify(c),reason,a.id,now]),stmt(db,'UPDATE domestic_customers SET company_name=?,company_short_name=?,contact=?,phone=?,address=?,supply_user_id=?,version=version+1,updated_at=? WHERE id=?',[name,short,required(p.contact,'联系人',100),phone,required(p.address,'完整收货地址',600),owner,now,c.id])],null,'EXISTS(SELECT 1 FROM domestic_customers WHERE id=? AND version=?)',[c.id,c.version],financeVersion);
 }
 if(action==='customerCreate'){
  permission(a,'manage');const supplyId=a.role==='供应链'?a.id:required(p.supplyUserId,'供应链负责人',100),owner=await first(db,"SELECT id FROM users WHERE id=? AND active=1 AND role='供应链'",[supplyId]);if(!owner)fail(400,'请选择有效供应链负责人');
  const name=required(p.companyName,'公司全称',180),short=required(p.companyShortName,'公司简称',60),phone=required(p.phone,'联系电话',60);
  if(await first(db,'SELECT id FROM domestic_customers WHERE company_name=? AND phone=?',[name,phone]))fail(409,'同公司及电话客户已存在，请使用原档案');
  const id=uid('domcustomer'),code=await uniqueBusinessNumber(db,'domestic_customers','code','CN');return commit(db,a,p,id,[stmt(db,'INSERT INTO domestic_customers(id,code,company_name,company_short_name,contact,phone,address,supply_user_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)',[id,code,name,short,required(p.contact,'联系人',100),phone,required(p.address,'完整收货地址',600),supplyId,now,now])]);
 }
 if(action==='orderCreate'){
  permission(a,'manage');const c=await first(db,'SELECT * FROM domestic_customers WHERE id=? AND active=1',[text(p.customerId,100)]);if(!c||a.role==='供应链'&&c.supply_user_id!==a.id)fail(403,'客户不在本人责任范围内');const n=await normalizedItems(db,p.items),id=uid('domorder'),no=await uniqueBusinessNumber(db,'domestic_orders','order_no','CN');
  const when=date(p.businessDate),terms=settlementTerms(p,n.total,when);
  return commit(db,a,p,id,[stmt(db,'INSERT INTO domestic_orders(id,order_no,customer_id,customer_json,business_date,supply_user_id,creator_id,total_qty,total_minor,note,created_at,updated_at,settlement_mode,due_date,release_amount_minor) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',[id,no,c.id,JSON.stringify(c),when,c.supply_user_id,a.id,n.qty,n.total,text(p.note,1000),now,now,terms.mode,terms.due,terms.release]),...itemInserts(db,id,n.items)],null,'EXISTS(SELECT 1 FROM domestic_customers WHERE id=? AND version=? AND active=1)',[c.id,c.version],financeVersion);
 }
 const o=await domesticOrderFor(db,a,p.orderId);if(Number(p.version)!==o.version)fail(409,'订单已被其他人更新，请刷新核对');const items=await itemsFor(db,o.id),entries=await entriesFor(db,o.id),money=domesticFinancial(o,items,entries);
 const pendingCancel=await first(db,"SELECT * FROM domestic_cancel_requests WHERE order_id=? AND status='pending'",[o.id]);o.cancelPending=Boolean(pendingCancel);
 if(pendingCancel&&['pack','ship','releaseConfirm','financeConfirm','orderReturn','orderRevise','quoteConfirm','contractSubmit','contractDecide'].includes(action))fail(409,'该单正在申请取消，请先完成取消审核；到账核对仍可处理');
 const change=(statements,g='1=1',args=[])=>commit(db,a,p,o.id,statements,o,g,args,financeVersion);
 if(action==='orderVoid'){
  permission(a,'manage');if(!['draft','rejected'].includes(o.status)||items.some(i=>i.packed_qty)||entries.length)fail(409,'仅无履约、无收款的草稿或退回订单可自行作废；其他订单请申请取消');
  const reason=required(p.reason,'作废原因',600);return change([snapshot(db,a,o,items,'orderCancel',reason),stmt(db,"UPDATE domestic_orders SET status='cancelled',released_at=NULL,release_by=NULL WHERE id=?",[o.id])]);
 }
 if(action==='orderCancelRequest'){
  permission(a,'manage');if(!['quoted','contract_pending','approved'].includes(o.status)||items.some(i=>i.shipped_qty))fail(409,'仅未发货订单可申请取消；已发货须走退货或合同调整');if(pendingCancel)fail(409,'已有待审核取消申请');
  return change([stmt(db,'INSERT INTO domestic_cancel_requests(id,order_id,reason,actor_id,created_at) VALUES(?,?,?,?,?)',[uid('domcancel'),o.id,required(p.reason,'取消原因',600),a.id,now]),stmt(db,'UPDATE domestic_orders SET released_at=NULL,release_by=NULL WHERE id=?',[o.id])]);
 }
 if(action==='orderCancelDecide'){
  permission(a,'approve');if(!pendingCancel)fail(409,'没有待审核取消申请');if([o.creator_id,o.supply_user_id,pendingCancel.actor_id].includes(a.id))fail(403,'须另一位管理员或财务独立审核取消');if(typeof p.approved!=='boolean')fail(400,'请选择取消审核结果');if(items.some(i=>i.shipped_qty))fail(409,'订单已有发货，不能取消');
  const reason=required(p.reason,'取消审核意见',600),statements=[stmt(db,'UPDATE domestic_cancel_requests SET status=?,reviewer_id=?,review_reason=?,reviewed_at=? WHERE id=?',[p.approved?'approved':'rejected',a.id,reason,now,pendingCancel.id])];
  if(p.approved)statements.push(snapshot(db,a,o,items,'orderCancel',reason),stmt(db,"UPDATE domestic_orders SET status='cancelled',released_at=NULL,release_by=NULL WHERE id=?",[o.id]));return change(statements);
 }
 if(action==='collectionFollowup'){
  if(!['管理员','供应链','财务'].includes(a.role))fail(403,'当前岗位无权登记回款跟进');if(o.status!=='approved')fail(409,'合同批准后登记回款跟进');const next=date(p.nextDate,{future:true});if(next<domesticToday())fail(400,'复查日期不能早于今天');
  return change([stmt(db,'INSERT INTO domestic_collection_notes(id,order_id,note,next_date,actor_id,created_at) VALUES(?,?,?,?,?,?)',[uid('domfollow'),o.id,required(p.reason,'跟进事实与下一步',600),next,a.id,now])]);
 }
 if(action==='orderRevise'){
  permission(a,'manage');if(!['draft','rejected'].includes(o.status)||items.some(i=>i.packed_qty))fail(409,'请先退回未备货订单；已备货追加请新建订单');const n=await normalizedItems(db,p.items);if(money.paidMinor>n.total)fail(409,'已收款高于修改金额，请财务先处理退款');
  const terms=settlementTerms(p,n.total,o.business_date,o);
  return change([snapshot(db,a,o,items,action,required(p.reason,'修改原因',600)),stmt(db,'DELETE FROM domestic_order_items WHERE order_id=?',[o.id]),...itemInserts(db,o.id,n.items),stmt(db,"UPDATE domestic_orders SET status='draft',total_qty=?,total_minor=?,settlement_mode=?,due_date=?,release_amount_minor=?,quote_proof_id=NULL,contract_proof_id=NULL,released_at=NULL,release_by=NULL WHERE id=?",[n.qty,n.total,terms.mode,terms.due,terms.release,o.id])]);
 }
 if(action==='quoteConfirm'){
  permission(a,'manage');if(!['draft','rejected'].includes(o.status))fail(409,'请在草稿或退回状态确认报价');if(p.customerConfirmed!==true)fail(400,'请确认客户已认可本版SKU、数量及人民币报价');await proof(db,o,p.proofId,'quote');return change([stmt(db,"UPDATE domestic_orders SET status='quoted',quote_proof_id=? WHERE id=?",[p.proofId,o.id])]);
 }
 if(action==='contractSubmit'){
  permission(a,'manage');if(o.status!=='quoted')fail(409,'请先完成客户报价确认');if(p.contractSigned!==true)fail(400,'请确认客户已签署合同');await proof(db,o,p.proofId,'contract');const mode=text(p.settlementMode,30);if(!['prepaid','deposit','credit','consignment'].includes(mode))fail(400,'请选择结算方式');
  const {due,release}=settlementTerms(p,o.total_minor,o.business_date);
  const factory=await first(db,"SELECT id FROM users WHERE id=? AND active=1 AND role='工厂'",[text(p.factoryUserId,100)]);if(!factory)fail(400,'请选择实际负责的工厂账号');const terms=required(p.contractTerms,'合同结算与交付条款',2000),number=required(p.contractNumber,'合同编号',100);
  const next={...o,status:'contract_pending',settlement_mode:mode,due_date:due,release_amount_minor:release,contract_proof_id:p.proofId,contract_number:number,contract_terms:terms,factory_user_id:factory.id};return change([snapshot(db,a,next,items,action,'客户已签署，提交审核'),stmt(db,"UPDATE domestic_orders SET status='contract_pending',settlement_mode=?,due_date=?,release_amount_minor=?,contract_proof_id=?,contract_number=?,contract_terms=?,factory_user_id=?,reviewer_id=NULL,reviewed_at=NULL,released_at=NULL,release_by=NULL WHERE id=?",[mode,due,release,p.proofId,number,terms,factory.id,o.id])]);
 }
 if(action==='contractDecide'){
  permission(a,'approve');if(o.status!=='contract_pending')fail(409,'该合同不在待审核状态');if(a.id===o.creator_id||a.id===o.supply_user_id)fail(403,'申请人或负责供应链不能审批自己的合同');if(typeof p.approved!=='boolean')fail(400,'请选择审核结果');const reason=required(p.reason,'审核意见',600),next={...o,status:p.approved?'approved':'rejected',reviewer_id:a.id,reviewed_at:now,review_reason:reason};return change([snapshot(db,a,next,items,action,reason),stmt(db,'UPDATE domestic_orders SET status=?,reviewer_id=?,reviewed_at=?,review_reason=? WHERE id=?',[next.status,a.id,now,reason,o.id])]);
 }
 if(action==='orderReturn'){
  permission(a,'approve');if(!['approved','contract_pending','quoted'].includes(o.status)||items.some(i=>i.packed_qty||i.shipped_qty))fail(409,'仅未备货订单可退回修改；已备货追加请另建订单');if(a.id===o.creator_id||a.id===o.supply_user_id)fail(403,'不能自行审批退回自己的订单');return change([snapshot(db,a,o,items,action,required(p.reason,'退回原因',600)),stmt(db,"UPDATE domestic_orders SET status='draft',quote_proof_id=NULL,contract_proof_id=NULL,released_at=NULL,release_by=NULL WHERE id=?",[o.id])]);
 }
 if(action==='orderCancel'){
  permission(a,'approve');if(o.status==='cancelled'||items.some(i=>i.shipped_qty))fail(409,'已发货订单不能取消，须保留履约及回款事实');if(a.id===o.creator_id||a.id===o.supply_user_id)fail(403,'不能审批取消自己的订单');return change([snapshot(db,a,o,items,action,required(p.reason,'取消原因',600)),stmt(db,"UPDATE domestic_orders SET status='cancelled',released_at=NULL,release_by=NULL WHERE id=?",[o.id]),stmt(db,"UPDATE domestic_cancel_requests SET status='approved',reviewer_id=?,review_reason=?,reviewed_at=? WHERE order_id=? AND status='pending'",[a.id,p.reason,now,o.id])]);
 }
 if(action==='paymentProofReject'){
  permission(a,'finance');const reported=await first(db,'SELECT s.* FROM domestic_payment_submissions s LEFT JOIN domestic_payment_reviews r ON r.submission_id=s.id WHERE s.id=? AND s.order_id=? AND r.id IS NULL',[text(p.submissionId,100),o.id]);
  if(!reported)fail(409,'付款凭证不存在或已核对');if(reported.actor_id===a.id)fail(403,'不能复核本人提交的付款凭证');
  return change([stmt(db,"INSERT INTO domestic_payment_reviews(id,submission_id,outcome,reason,actor_id,created_at) VALUES(?,?,'rejected',?,?,?)",[uid('dompayreview'),reported.id,required(p.reason,'退回原因',600),a.id,now])]);
 }
 if(['financeConfirm','financeReverse','financeRefund','financeRefundReverse'].includes(action)){
  permission(a,'finance');const when=date(p.businessDate);if(entries.some(e=>e.bank_receipt_id)&&entries.some(e=>e.business_date>when))fail(409,'订单已有较晚核销记录，请按当前实际处理日期登记');await openPeriod(when);if(when<o.business_date)fail(400,'到账日期不能早于订单');await proof(db,o,p.proofId,'finance');if(p.actualConfirmed!==true)fail(400,'请财务核对公司银行实际流水后确认');const bankRef=required(p.bankReference,'银行流水号或冲销凭证号',160),account=required(p.bankAccount,'公司收付款账户',160),reason=required(p.reason,'财务核对说明',600);
  let kind,amount,related=null;
  if(action==='financeConfirm'){if(o.status!=='approved')fail(409,'合同批准后才能登记真实到账');kind='receipt';amount=cnyMinor(p.amount);if(amount>money.contractOutstandingMinor)fail(409,'本次到账超过当前合同或寄售已售待收款');}
  if(action==='financeRefund'){kind='refund';amount=cnyMinor(p.amount);const legacyPaid=entries.filter(e=>!e.bank_receipt_id).reduce((n,e)=>n+(['receipt','refund_reverse'].includes(e.kind)?e.amount_minor:-e.amount_minor),0);if(amount>legacyPaid)fail(409,'退款超过旧收款余额；客户收款分配请先解除，再从客户余额登记退款');const limit=['draft','rejected','cancelled'].includes(o.status)?money.paidMinor:money.refundDueMinor;if(amount>limit)fail(409,'退款超过可退余额；普通退货须先核对实物及合同变更，不能直接冲减销售');}
  if(action==='financeReverse'||action==='financeRefundReverse'){
   const target=entries.find(e=>e.id===p.entryId&&e.kind===(action==='financeReverse'?'receipt':'refund'));if(target?.bank_receipt_id)fail(409,'该记录是订单分配，请在客户收款中解除分配；不冲销银行实际到账');if(!target||entries.some(e=>e.related_id===target.id))fail(409,'原流水不存在或已经冲销');if(when<target.business_date)fail(400,'冲销日期不能早于原流水');kind=action==='financeReverse'?'receipt_reverse':'refund_reverse';amount=target.amount_minor;related=target.id;if(kind==='receipt_reverse'&&amount>Math.min(money.paidMinor,entries.filter(e=>!e.bank_receipt_id).reduce((n,e)=>n+(['receipt','refund_reverse'].includes(e.kind)?e.amount_minor:-e.amount_minor),0)))fail(409,'该到账已退款，先核对退款或撤销错误退款记录');
  }
  const entryId=uid('domfin'),review=[];
  if(p.submissionId){if(action!=='financeConfirm')fail(400,'客户付款凭证只能关联实际到账核销');const reported=await first(db,'SELECT s.* FROM domestic_payment_submissions s LEFT JOIN domestic_payment_reviews r ON r.submission_id=s.id WHERE s.id=? AND s.order_id=? AND r.id IS NULL',[text(p.submissionId,100),o.id]);if(!reported)fail(409,'付款凭证不存在或已核对');if(reported.actor_id===a.id)fail(403,'不能复核本人提交的付款凭证');review.push(stmt(db,"INSERT INTO domestic_payment_reviews(id,submission_id,outcome,entry_id,reason,actor_id,created_at) VALUES(?,?,'confirmed',?,?,?,?)",[uid('dompayreview'),reported.id,entryId,reason,a.id,now]));}
  return change([stmt(db,'INSERT INTO domestic_finance_entries(id,order_id,kind,amount_minor,business_date,bank_reference,bank_account,related_id,proof_id,reason,actor_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',[entryId,o.id,kind,amount,when,bankRef,account,related,p.proofId,reason,a.id,now]),...review,...(kind==='receipt_reverse'||kind==='refund'?[stmt(db,'UPDATE domestic_orders SET released_at=NULL,release_by=NULL WHERE id=?',[o.id])]:[])]);
 }
 if(action==='releaseConfirm'){
  permission(a,'finance');if(o.status!=='approved')fail(409,'请先完成合同审批');if(a.id===o.creator_id||a.id===o.supply_user_id)fail(403,'申请人不能确认自己订单的放货条件');if(money.paidMinor<releaseThreshold(o))fail(409,'财务确认的实际到账未达到合同放货金额');if(p.termsVerified!==true)fail(400,'请确认合同版本、到账或账期条件均已核对');return change([stmt(db,'UPDATE domestic_orders SET released_at=?,release_by=?,release_reason=? WHERE id=?',[now,a.id,required(p.reason,'放货依据',600),o.id])]);
 }
 if(action==='pack'){
  permission(a,'execute');if(o.status!=='approved')fail(409,'合同批准后才可记录备货打包');if(p.domesticSourceConfirmed!==true)fail(400,'请确认货物是本订单专属国内工厂直发实物，不使用跨境在途或海外库存');const source=required(p.sourceNo,'国内工厂来源单号或专属批次号',120);await proof(db,o,p.sourceProofId,'source');await proof(db,o,p.proofId,'packing');const when=date(p.businessDate);if(when<o.business_date)fail(400,'打包日期不能早于订单');const ls=requestLines(p.items,'itemId',items),id=uid('dompack');for(const {line,qty} of ls)if(qty>line.qty-line.packed_qty)fail(409,'打包数量超过合同未备货数量');
  const statements=[stmt(db,'INSERT INTO domestic_packs(id,order_id,source_no,source_proof_id,proof_id,business_date,actor_id,created_at) VALUES(?,?,?,?,?,?,?,?)',[id,o.id,source,p.sourceProofId,p.proofId,when,a.id,now])];for(const {line,qty} of ls)statements.push(stmt(db,'INSERT INTO domestic_pack_lines(id,pack_id,item_id,qty) VALUES(?,?,?,?)',[uid('dompackline'),id,line.id,qty]),stmt(db,'UPDATE domestic_order_items SET packed_qty=packed_qty+? WHERE id=?',[qty,line.id]));return change(statements);
 }
 if(action==='ship'){
  permission(a,'execute');if(!gate(o,money))fail(409,'尚未满足财务放货条件；付款截图不能代替实际到账确认');if(p.handoverConfirmed!==true)fail(400,'请确认实物已交承运商');await proof(db,o,p.proofId,'shipment');const when=date(p.businessDate);await openPeriod(when);if(!gate(o,domesticFinancial(o,items,entries.filter(e=>e.business_date<=when))))fail(409,'本次发货日期之前的实际到账尚未达到合同放货金额');const available=await rows(db,'SELECT l.*,p.business_date FROM domestic_pack_lines l JOIN domestic_packs p ON p.id=l.pack_id WHERE p.order_id=?',[o.id]),ls=requestLines(p.items,'packLineId',available);for(const {line,qty} of ls)if(qty>line.qty-line.shipped_qty||when<line.business_date)fail(409,'发货数量超出本批打包余量，或发货早于打包');
  const id=uid('domship'),n=Number((await first(db,'SELECT COUNT(*) n FROM domestic_shipments WHERE order_id=?',[o.id])).n)+1,no=`${o.order_no}-OUT-${String(n).padStart(3,'0')}`,statements=[stmt(db,'INSERT INTO domestic_shipments(id,order_id,shipment_no,business_date,carrier,tracking_no,proof_id,release_by,actor_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',[id,o.id,no,when,required(p.carrier,'承运商',100),required(p.trackingNo,'运单号或配送订单号',160),p.proofId,o.release_by,a.id,now])];
  for(const {line,qty} of ls)statements.push(stmt(db,'INSERT INTO domestic_shipment_lines(id,shipment_id,pack_line_id,item_id,qty) VALUES(?,?,?,?,?)',[uid('domshipline'),id,line.id,line.item_id,qty]),stmt(db,'UPDATE domestic_pack_lines SET shipped_qty=shipped_qty+? WHERE id=?',[qty,line.id]),stmt(db,'UPDATE domestic_order_items SET shipped_qty=shipped_qty+? WHERE id=?',[qty,line.item_id]));return change(statements);
 }
 if(action==='receive'){
  permission(a,'manage');if(o.status!=='approved'||p.receivedConfirmed!==true)fail(400,'请确认客户实际签收');const sh=await first(db,'SELECT * FROM domestic_shipments WHERE id=? AND order_id=?',[p.shipmentId,o.id]);if(!sh)fail(404,'出库单不存在');await proof(db,o,p.proofId,'receipt');const when=date(p.businessDate);if(when<sh.business_date)fail(400,'签收日期不能早于发货');const available=await rows(db,'SELECT * FROM domestic_shipment_lines WHERE shipment_id=?',[sh.id]),ls=requestLines(p.items,'shipmentLineId',available);for(const {line,qty} of ls)if(qty>line.qty-line.received_qty)fail(409,'签收数量超过本次实际发货余量');const id=uid('domreceipt'),statements=[stmt(db,'INSERT INTO domestic_receipts(id,order_id,shipment_id,business_date,receiver,proof_id,actor_id,created_at) VALUES(?,?,?,?,?,?,?,?)',[id,o.id,sh.id,when,required(p.receiver,'实际签收人',100),p.proofId,a.id,now])];
  for(const {line,qty} of ls)statements.push(stmt(db,'INSERT INTO domestic_receipt_lines(id,receipt_id,shipment_line_id,qty) VALUES(?,?,?,?)',[uid('domreceiptline'),id,line.id,qty]),stmt(db,'UPDATE domestic_shipment_lines SET received_qty=received_qty+? WHERE id=?',[qty,line.id]),stmt(db,'UPDATE domestic_order_items SET received_qty=received_qty+? WHERE id=?',[qty,line.item_id]));return change(statements);
 }
 if(action==='consignmentSale'){
  permission(a,'finance');if(o.status!=='approved'||o.settlement_mode!=='consignment')fail(409,'仅寄售合同可登记实际售出');if(p.soldConfirmed!==true)fail(400,'请核实客户已售及对账明细');await proof(db,o,p.proofId,'finance');const when=date(p.businessDate);await openPeriod(when);if(when<o.business_date)fail(400,'寄售售出日期不能早于订单');const ls=requestLines(p.items,'itemId',items),statements=[];for(const {line,qty} of ls){const receivedAtDate=Number((await first(db,'SELECT COALESCE(SUM(l.qty),0) n FROM domestic_receipt_lines l JOIN domestic_receipts r ON r.id=l.receipt_id JOIN domestic_shipment_lines s ON s.id=l.shipment_line_id WHERE r.order_id=? AND s.item_id=? AND r.business_date<=?',[o.id,line.id,when])).n);if(qty>Math.min(line.received_qty,receivedAtDate)-line.sold_qty)fail(409,'寄售已售超过当日客户已签收未结算数量');statements.push(stmt(db,'INSERT INTO domestic_consignment_sales(id,order_id,item_id,qty,amount_minor,business_date,proof_id,actor_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)',[uid('domsold'),o.id,line.id,qty,qty*line.unit_minor,when,p.proofId,a.id,now]),stmt(db,'UPDATE domestic_order_items SET sold_qty=sold_qty+? WHERE id=?',[qty,line.id]));}return change(statements);
 }
 fail(400,'未知国内分销操作');
}

export async function readDomesticDistribution(db,actor){
 const a=await activeActor(db,actor),factory=a.role==='工厂',scope=['管理员','财务'].includes(a.role)?'1=1':factory?"o.factory_user_id=? AND o.status='approved'":'o.supply_user_id=?',args=['管理员','财务'].includes(a.role)?[]:[a.id];
 // Fetch each scoped fact table once. A long order history must not create per-order HTTP/database round trips.
 const direct=table=>rows(db,`SELECT c.* FROM ${table} c JOIN domestic_orders o ON o.id=c.order_id WHERE ${scope}`,args);
 const [orders,allItems,allPacks,allPackLines,allShipments,allShipmentLines,allReceipts,allEntries,allFiles,allVersions,paymentSubmissions]=await Promise.all([
  rows(db,`SELECT o.* FROM domestic_orders o WHERE ${scope} ORDER BY o.created_at DESC`,args),direct('domestic_order_items'),direct('domestic_packs'),
  rows(db,`SELECT c.* FROM domestic_pack_lines c JOIN domestic_packs p ON p.id=c.pack_id JOIN domestic_orders o ON o.id=p.order_id WHERE ${scope}`,args),
  direct('domestic_shipments'),rows(db,`SELECT c.* FROM domestic_shipment_lines c JOIN domestic_shipments s ON s.id=c.shipment_id JOIN domestic_orders o ON o.id=s.order_id WHERE ${scope}`,args),direct('domestic_receipts'),direct('domestic_finance_entries'),
  rows(db,`SELECT c.id,c.order_id,c.purpose,c.name,c.content_type,c.size,c.created_at,c.order_version FROM domestic_files c JOIN domestic_orders o ON o.id=c.order_id WHERE ${scope}${factory?" AND c.purpose IN('source','packing','shipment','receipt')":a.role==='供应链'?" AND c.purpose<>'finance'":''}`,args),
  factory?Promise.resolve([]):direct('domestic_order_versions'),
  factory?Promise.resolve([]):rows(db,`SELECT s.id,s.order_id,s.amount_minor,s.claimed_date,s.customer_reference,s.note,s.digest,s.name,s.created_at,s.actor_id,COALESCE(r.outcome,'pending') status,r.reason review_reason,r.entry_id,r.created_at reviewed_at,e.amount_minor actual_amount_minor,e.business_date actual_date,CASE WHEN rev.id IS NOT NULL THEN 1 ELSE 0 END reversed FROM domestic_payment_submissions s JOIN domestic_orders o ON o.id=s.order_id LEFT JOIN domestic_payment_reviews r ON r.submission_id=s.id LEFT JOIN domestic_finance_entries e ON e.id=r.entry_id LEFT JOIN domestic_finance_entries rev ON rev.related_id=r.entry_id AND rev.kind='receipt_reverse' WHERE ${scope} ORDER BY s.created_at DESC`,args)
 ]);
 const bankLinks=factory?[]:await rows(db,`SELECT l.*,b.amount_minor actual_amount_minor,b.business_date actual_date,b.bank_reference,EXISTS(SELECT 1 FROM domestic_bank_events e WHERE e.receipt_id=b.id AND e.kind='void') bank_voided FROM domestic_bank_proof_links l JOIN domestic_bank_receipts b ON b.id=l.receipt_id JOIN domestic_payment_submissions s ON s.id=l.submission_id JOIN domestic_orders o ON o.id=s.order_id WHERE ${scope}`,args);
 const cancellations=await rows(db,`SELECT c.* FROM domestic_cancel_requests c JOIN domestic_orders o ON o.id=c.order_id WHERE ${scope} ORDER BY c.created_at`,args);
 const followups=factory?[]:await rows(db,`SELECT c.*,u.name actor_name FROM domestic_collection_notes c JOIN domestic_orders o ON o.id=c.order_id JOIN users u ON u.id=c.actor_id WHERE ${scope} ORDER BY c.created_at`,args);
 for(const payment of paymentSubmissions){const link=bankLinks.find(l=>l.submission_id===payment.id);if(link)Object.assign(payment,{status:link.bank_voided?'bank_voided':'bank_confirmed',receipt_id:link.receipt_id,actual_amount_minor:link.actual_amount_minor,actual_date:link.actual_date,review_reason:link.reason,bank_reference:link.bank_reference,reviewed_at:link.created_at});payment.duplicateOrders=[...new Set(paymentSubmissions.filter(x=>x.id!==payment.id&&x.digest===payment.digest).map(x=>orders.find(o=>o.id===x.order_id)?.order_no))].filter(Boolean);}
 for(const payment of paymentSubmissions)delete payment.digest;
 const group=(values,key)=>{const map=new Map();for(const v of values){if(!map.has(v[key]))map.set(v[key],[]);map.get(v[key]).push(v);}return map;};
 const groups={items:group(allItems,'order_id'),packs:group(allPacks,'order_id'),packLines:group(allPackLines,'pack_id'),shipments:group(allShipments,'order_id'),shipmentLines:group(allShipmentLines,'shipment_id'),receipts:group(allReceipts,'order_id'),entries:group(allEntries,'order_id'),files:group(allFiles,'order_id'),versions:group(allVersions,'order_id'),payments:group(paymentSubmissions,'order_id')},visible=[];
 for(const o of orders){
  o.cancellations=cancellations.filter(c=>c.order_id===o.id);o.cancelPending=o.cancellations.some(c=>c.status==='pending');o.followups=followups.filter(c=>c.order_id===o.id);
  const items=groups.items.get(o.id)||[],packs=(groups.packs.get(o.id)||[]).map(p=>({...p,items:groups.packLines.get(p.id)||[]})),shipments=(groups.shipments.get(o.id)||[]).map(s=>({...s,items:groups.shipmentLines.get(s.id)||[]})),receipts=groups.receipts.get(o.id)||[],files=groups.files.get(o.id)||[];
  const customer=parse(o.customer_json),fulfillment=domesticFulfillment(o,items),entries=groups.entries.get(o.id)||[],financial=domesticFinancial(o,items,entries),canShip=gate(o,financial);
  if(factory)visible.push({id:o.id,order_no:o.order_no,business_date:o.business_date,version:o.version,status:o.status,cancelPending:o.cancelPending,factory_user_id:o.factory_user_id,supply_user_id:o.supply_user_id,customer:{company_short_name:customer.company_short_name,contact:customer.contact,phone:customer.phone,address:customer.address},items:items.map(({unit_minor,...i})=>i),packs,shipments,receipts:receipts.map(({receiver,...r})=>r),files,fulfillment,canShip});
  else visible.push({...o,customer,items,packs,shipments,receipts,files,fulfillment,financial,canShip,paymentSubmissions:groups.payments.get(o.id)||[],entries:a.role==='供应链'?[]:entries,versions:groups.versions.get(o.id)||[]});
 }
 const customers=factory?[]:await rows(db,`SELECT * FROM domestic_customers${a.role==='供应链'?' WHERE supply_user_id=?':''} ORDER BY company_short_name`,a.role==='供应链'?[a.id]:[]);
 const users=await rows(db,`SELECT id,name,role,email FROM users WHERE active=1 AND role IN('供应链','工厂')${factory?' AND id=?':''} ORDER BY name`,factory?[a.id]:[]),skus=factory?[]:await rows(db,'SELECT sku,name FROM sku_settings ORDER BY sku');
 const bank=['管理员','财务'].includes(a.role)?await readDomesticBank(db):null;
 const customerHistory=factory?[]:await rows(db,`SELECT v.*,u.name actor_name FROM domestic_customer_versions v JOIN domestic_customers c ON c.id=v.customer_id JOIN users u ON u.id=v.actor_id ${a.role==='供应链'?'WHERE c.supply_user_id=?':''} ORDER BY v.created_at DESC`,a.role==='供应链'?[a.id]:[]);
 return {bank,customerHistory,actor:{id:a.id,name:a.name,role:a.role},capabilities:domesticCapabilities(a),customers,orders:visible,users,skus,summary:factory?null:{orders:visible.length,contractMinor:visible.filter(o=>o.status==='approved').reduce((s,o)=>s+o.total_minor,0),receivedMinor:visible.reduce((s,o)=>s+o.financial.paidMinor,0),outstandingMinor:visible.filter(o=>o.status==='approved').reduce((s,o)=>s+o.financial.contractOutstandingMinor,0),overdue:visible.filter(o=>o.financial.overdue).length,pendingPayments:paymentSubmissions.filter(s=>s.status==='pending').length},boundary:'国内工厂直发事实独立登记，不使用或扣减印尼、海外及跨境在途库存；货物来源须另附真实证明。'};
}

// Login reminders use only aggregates; never load documents, bank references, or attachment bodies.
export async function domesticDistributionTasks(db,actor){
 if(!domesticCapabilities(actor).read)return [];
 const current=await first(db,'SELECT id,active,role FROM users WHERE id=?',[actor.id]);if(!current?.active||current.role!==actor.role)return [];
 const scope=['管理员','财务'].includes(actor.role)?'1=1':actor.role==='供应链'?'o.supply_user_id=?':"o.factory_user_id=? AND o.status='approved'",args=['管理员','财务'].includes(actor.role)?[]:[actor.id];
 const list=await rows(db,`SELECT o.id,o.order_no,o.status,o.creator_id,o.supply_user_id,o.factory_user_id,o.settlement_mode,o.due_date,o.total_qty,o.total_minor,o.release_amount_minor,o.released_at,
  COALESCE(i.packed,0) packed,COALESCE(i.shipped,0) shipped,COALESCE(i.received,0) received,COALESCE(i.sold,0) sold,COALESCE(i.sold_minor,0) sold_minor,COALESCE(i.shipped_minor,0) shipped_minor,(SELECT actor_id FROM domestic_cancel_requests cr WHERE cr.order_id=o.id AND cr.status='pending') cancel_actor,(SELECT next_date FROM domestic_collection_notes cn WHERE cn.order_id=o.id ORDER BY cn.created_at DESC,cn.rowid DESC LIMIT 1) next_review,COALESCE(f.paid,0) paid,(SELECT COUNT(*) FROM domestic_payment_submissions ps LEFT JOIN domestic_payment_reviews pr ON pr.submission_id=ps.id WHERE ps.order_id=o.id AND pr.id IS NULL AND NOT EXISTS(SELECT 1 FROM domestic_bank_proof_links bl WHERE bl.submission_id=ps.id)) pending_payments
  FROM domestic_orders o LEFT JOIN(SELECT order_id,SUM(packed_qty) packed,SUM(shipped_qty) shipped,SUM(received_qty) received,SUM(sold_qty) sold,SUM(shipped_qty*unit_minor) shipped_minor,SUM(sold_qty*unit_minor) sold_minor FROM domestic_order_items GROUP BY order_id)i ON i.order_id=o.id
  LEFT JOIN(SELECT order_id,SUM(CASE WHEN kind IN('receipt','refund_reverse') THEN amount_minor ELSE -amount_minor END) paid FROM domestic_finance_entries GROUP BY order_id)f ON f.order_id=o.id
  WHERE ${scope} ORDER BY o.due_date,o.created_at`,args),tasks=[];
 const add=(o,kind,title,detail,level='amber')=>tasks.push({tab:'domestic-distribution',entity:o.id,id:`domestic:${o.id}:${kind}`,kind,title,detail:`${o.order_no} · ${detail}`,level,dueDate:o.due_date||''});
 for(const o of list){
  o.cancelPending=Boolean(o.cancel_actor);
  if(o.cancelPending&&['管理员','财务'].includes(actor.role)&&![o.creator_id,o.supply_user_id,o.cancel_actor].includes(actor.id))add(o,'cancel-review','审核国内订单取消申请','未发货取消，款项仍需财务核实及处理');
  const payable=o.status==='cancelled'?0:o.settlement_mode==='consignment'?o.sold_minor:o.total_minor,remaining=Math.max(0,payable-o.paid),refund=Math.max(0,o.paid-payable),unsold=o.settlement_mode==='consignment'?o.shipped-o.sold:0,overdue=o.status==='approved'&&o.due_date&&o.due_date<domesticToday()&&(remaining>0||unsold>0),released=gate(o,{paidMinor:o.paid});
  if(['管理员','财务'].includes(actor.role)&&o.pending_payments>0)add(o,'payment-proof','核对国内客户付款凭证',`${o.pending_payments} 份待财务核对；未计入实际到账`);
  if(o.cancelPending)continue;
  if(o.status==='contract_pending'&&['管理员','财务'].includes(actor.role)&&actor.id!==o.creator_id&&actor.id!==o.supply_user_id)add(o,'review','审核国内分销合同','核对报价、合同和结算方式');
  if(['管理员','财务','供应链'].includes(actor.role)&&overdue){const follow=domesticOverdue({status:o.status,mode:o.settlement_mode,dueDate:o.due_date,remaining,receivable:Math.max(0,(o.settlement_mode==='consignment'?o.sold_minor:o.shipped_minor)-o.paid),unsold});add(o,'overdue',follow.overdueLabel,`约定日期 ${o.due_date}；已发/已售应收 ¥${(follow.overdueReceivableMinor/100).toFixed(2)}${unsold>0?`，寄售未结算 ${unsold} 件`:''}${o.next_review?`；复查 ${o.next_review}`:''}`,follow.overdueKind==='receivable'?'red':'amber');}
  if(actor.role==='财务'){
   if(refund>0)add(o,'refund','核对国内订单应退余额',`待核对退款 ¥${(refund/100).toFixed(2)}`,'red');
   if(o.status==='approved'&&o.shipped<o.total_qty&&!released)add(o,'release',o.paid<releaseThreshold(o)?'核对国内实际到账与放货条件':'确认国内合同放货条件',o.paid<releaseThreshold(o)?'客户付款截图仅作待核凭证，按银行实际流水核销':'合同已审核，尚待财务确认放货依据');
   if(o.status==='approved'&&unsold>0&&!overdue)add(o,'consignment','核对国内寄售实际售出',`已发未结算 ${unsold} 件；不把发货当销售`);
   if(o.status==='approved'&&remaining>0&&o.shipped===o.total_qty&&!overdue)add(o,'collection','跟进国内订单待回款',`已发货，合同待回款 ¥${(remaining/100).toFixed(2)}`);
  }
  if(actor.role==='供应链'){
   if(['draft','rejected','quoted'].includes(o.status))add(o,'contract',o.status==='quoted'?'补齐国内签约及账期':'跟进国内客户报价确认','按本版SKU、数量及人民币报价确认后送审');
   if(o.status==='approved'&&o.shipped>o.received)add(o,'receipt','核实国内客户实际签收',`${o.shipped-o.received} 件已发待签收；签收不自动核销`);
   if(o.status==='approved'&&o.packed<o.total_qty)add(o,'preparation','跟进国内工厂备货',`${o.total_qty-o.packed} 件待核实实物及打包证明`);
  }
  if(actor.role==='工厂'){
   if(o.packed<o.total_qty)add(o,'pack','核实国内工厂备货打包',`${o.total_qty-o.packed} 件待打包；附专属来源及实物凭证`);
   if(released&&o.packed>o.shipped)add(o,'ship','登记国内实际发货',`${o.packed-o.shipped} 件已打包待发；以实际交承运商数量为准`);
  }
 }
 if(['管理员','财务'].includes(actor.role)){
  const balances=await rows(db,`SELECT b.customer_id,c.company_short_name name,SUM(b.amount_minor-COALESCE(a.allocated,0)-COALESCE(e.spent,0)) amount
   FROM domestic_bank_receipts b JOIN domestic_customers c ON c.id=b.customer_id
   LEFT JOIN(SELECT bank_receipt_id,SUM(CASE WHEN kind='receipt' THEN amount_minor ELSE -amount_minor END) allocated FROM domestic_finance_entries WHERE bank_receipt_id IS NOT NULL GROUP BY bank_receipt_id)a ON a.bank_receipt_id=b.id
   LEFT JOIN(SELECT receipt_id,SUM(CASE WHEN kind='refund_reverse' THEN -amount_minor ELSE amount_minor END) spent FROM domestic_bank_events GROUP BY receipt_id)e ON e.receipt_id=b.id
   GROUP BY b.customer_id HAVING amount>0`);
  for(const c of balances)tasks.push({tab:'domestic-distribution',entity:c.customer_id,view:'bank',id:`domestic:customer:${c.customer_id}:balance`,kind:'customer-balance',title:'核对国内客户未分配余额',detail:`${c.name} · ¥${(c.amount/100).toFixed(2)}，请核实对应订单、预收约定或实际退款`,level:'amber',dueDate:'',href:'/?page=domestic-distribution&view=bank'});
 }
 return tasks.sort((a,b)=>(a.level==='red'?0:1)-(b.level==='red'?0:1)||a.dueDate.localeCompare(b.dueDate)||a.id.localeCompare(b.id));
}

// This returns only the domestic CNY subledger. The central ledger may freeze this
// object in its close snapshot; callers must authorize finance access themselves.
// Contract eligibility follows recorded approval events, while cash and physical
// facts follow their explicit business dates. No later cancellation or payment is
// allowed to rewrite an earlier month just because this function runs today.
export async function domesticFinancialSummary(db,{month=domesticToday().slice(0,7)}={}){
 if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)||month>domesticToday().slice(0,7))fail(400,'请选择当前或过去的有效月份');
 const from=month+'-01',next=new Date(from+'T00:00:00Z');next.setUTCMonth(next.getUTCMonth()+1);const end=new Date(next.getTime()-86400000).toISOString().slice(0,10),cutoff=end<domesticToday()?end:domesticToday(),cutoffAt=new Date(cutoff+'T23:59:59.999+08:00').toISOString(),version=await financeClock(db);
 const [orders,events,entries,shipments,sold]=await Promise.all([
  rows(db,'SELECT id,order_no,customer_json,business_date,settlement_mode FROM domestic_orders WHERE business_date<=?',[cutoff]),
  rows(db,'SELECT rowid history_seq,order_id,action,snapshot_json,created_at FROM domestic_order_versions WHERE created_at<=? ORDER BY created_at,rowid',[cutoffAt]),
  rows(db,'SELECT order_id,kind,amount_minor,business_date,bank_receipt_id FROM domestic_finance_entries WHERE business_date<=?',[cutoff]),
  rows(db,'SELECT s.order_id,s.business_date,l.qty,l.qty*i.unit_minor amount_minor FROM domestic_shipment_lines l JOIN domestic_shipments s ON s.id=l.shipment_id JOIN domestic_order_items i ON i.id=l.item_id WHERE s.business_date<=?',[cutoff]),
  rows(db,'SELECT order_id,business_date,qty,amount_minor FROM domestic_consignment_sales WHERE business_date<=?',[cutoff])
 ]);
 const group=values=>{const out=new Map();for(const v of values){if(!out.has(v.order_id))out.set(v.order_id,[]);out.get(v.order_id).push(v);}return out;};
 const grouped={events:group(events),entries:group(entries),shipments:group(shipments),sold:group(sold)},sum=(values,key='amount_minor')=>values.reduce((n,v)=>n+Number(v[key]),0),inPeriod=values=>values.filter(v=>v.business_date>=from);
 const cash=values=>{const by=kind=>sum(values.filter(v=>v.kind===kind)),receiptsMinor=by('receipt'),receiptReversalsMinor=by('receipt_reverse'),refundsMinor=by('refund'),refundReversalsMinor=by('refund_reverse'),netReceiptsMinor=receiptsMinor-receiptReversalsMinor,netRefundsMinor=refundsMinor-refundReversalsMinor;return {receiptsMinor,receiptReversalsMinor,refundsMinor,refundReversalsMinor,netReceiptsMinor,netRefundsMinor,netCashMinor:netReceiptsMinor-netRefundsMinor};};
 const detail=[];
 for(const o of orders){
  const history=grouped.events.get(o.id)||[],latest=history.at(-1),snapshot=latest?parse(latest.snapshot_json).order:null;
  const status=latest?latest.action==='orderCancel'?'cancelled':['orderReturn','orderRevise'].includes(latest.action)?'draft':snapshot?.status:'unapproved';
  const approved=status==='approved',consignment=(snapshot?.settlement_mode||o.settlement_mode)==='consignment',es=grouped.entries.get(o.id)||[],ss=grouped.shipments.get(o.id)||[],cs=grouped.sold.get(o.id)||[],paid=cash(es).netCashMinor,shippedMinor=sum(ss),soldMinor=sum(cs),shippedQty=sum(ss,'qty'),soldQty=sum(cs,'qty');
  if(!approved&&!es.length&&!ss.length&&!cs.length)continue;
  const recognizedBasis=consignment?soldMinor:shippedMinor,contractMinor=approved?Number(snapshot.total_minor):0,payable=approved?(consignment?soldMinor:contractMinor):0,contractOutstandingMinor=Math.max(0,payable-paid),receivableMinor=Math.max(0,recognizedBasis-paid),advanceMinor=Math.max(0,paid-recognizedBasis),refundDueMinor=status==='cancelled'?Math.max(0,paid):approved?Math.max(0,paid-payable):0,consignmentUnsettledQty=consignment?Math.max(0,shippedQty-soldQty):0,consignmentUnsettledMinor=consignment?Math.max(0,shippedMinor-soldMinor):0;
  const customer=parse(o.customer_json),dueDate=approved?snapshot.due_date||'':'';
  detail.push({id:o.id,orderNo:o.order_no,customerName:customer.company_short_name||customer.company_name||'',businessDate:o.business_date,contractStatus:status,contractApprovedAt:approved?snapshot.reviewed_at:null,settlementMode:snapshot?.settlement_mode||o.settlement_mode,dueDate,contractMinor,contractOutstandingMinor,receivableMinor,advanceMinor,refundDueMinor,paidMinor:paid,shippedMinor,shippedQty,consignmentSoldMinor:soldMinor,consignmentSoldQty:soldQty,consignmentUnsettledQty,consignmentUnsettledMinor,unfulfilledMinor:Math.max(0,contractMinor-shippedMinor),...domesticOverdue({status,mode:snapshot?.settlement_mode||o.settlement_mode,dueDate,remaining:contractOutstandingMinor,receivable:receivableMinor,unsold:consignmentUnsettledQty,today:cutoff}),overdue:Boolean(dueDate&&dueDate<cutoff&&(contractOutstandingMinor>0||consignmentUnsettledQty>0)),period:{...cash(inPeriod(es)),shippedMinor:sum(inPeriod(ss)),shippedQty:sum(inPeriod(ss),'qty'),consignmentSoldMinor:sum(inPeriod(cs)),consignmentSoldQty:sum(inPeriod(cs),'qty')}});
 }
 const bank=await readDomesticBank(db,{cutoff,includeVersion:false});
 const keys=['contractMinor','contractOutstandingMinor','receivableMinor','advanceMinor','refundDueMinor','paidMinor','shippedMinor','shippedQty','consignmentSoldMinor','consignmentSoldQty','consignmentUnsettledQty','consignmentUnsettledMinor'];
 const balances=Object.fromEntries(keys.map(k=>[k,detail.reduce((n,r)=>n+r[k],0)]));balances.overdueOrders=detail.filter(r=>r.overdue).length;
 const bankCash=[...bank.receipts.map(b=>({kind:'receipt',amount_minor:b.amount_minor,business_date:b.business_date})),...bank.events.map(e=>({...e,kind:e.kind==='void'?'receipt_reverse':e.kind}))];
 const period={...cash(inPeriod([...entries.filter(e=>!e.bank_receipt_id),...bankCash])),shippedMinor:sum(inPeriod(shipments)),shippedQty:sum(inPeriod(shipments),'qty'),consignmentSoldMinor:sum(inPeriod(sold)),consignmentSoldQty:sum(inPeriod(sold),'qty')};
 if(await financeClock(db)!==version)fail(409,'读取期间国内财务数据变化，请刷新');
 return {bank,currency:'CNY',unit:'minor',month,from,cutoff,version,period,balances,rows:detail,method:'仅国内工厂直发人民币子账，金额均为分；收款、退款及冲正按业务日期统计。合同状态按中国时区截止日前系统实际审批与变更记录还原；实际银行到账只计一次，分配核销不新增现金；客户未分配余额单列。实际发货应收按发货货值减订单已核销，寄售仅按财务已确认售出形成应收，未售货物单列。各订单应收及预收分别相加，不跨客户抵销；不包含其他渠道及利润。'};
}

export async function domesticPaymentQueue(db){
 const pending=await rows(db,"SELECT s.id,s.order_id,s.amount_minor,s.claimed_date,s.customer_reference,s.name,s.created_at,o.order_no,o.customer_json,o.status contract_status,o.settlement_mode,o.due_date FROM domestic_payment_submissions s JOIN domestic_orders o ON o.id=s.order_id LEFT JOIN domestic_payment_reviews r ON r.submission_id=s.id WHERE r.id IS NULL AND NOT EXISTS(SELECT 1 FROM domestic_bank_proof_links l WHERE l.submission_id=s.id) ORDER BY s.created_at LIMIT 100");
 const count=await first(db,'SELECT COUNT(*) n FROM domestic_payment_submissions s LEFT JOIN domestic_payment_reviews r ON r.submission_id=s.id WHERE r.id IS NULL AND NOT EXISTS(SELECT 1 FROM domestic_bank_proof_links l WHERE l.submission_id=s.id)');
 return {count:count.n,rows:pending.map(({customer_json,...s})=>({...s,customerName:parse(customer_json).company_short_name||'',href:'/?page=domestic-distribution&entity='+encodeURIComponent(s.order_id)}))};
}
