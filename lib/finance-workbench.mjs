import {financeMode} from './finance-scope.mjs';
import {mutateMarketingFinance} from './finance-marketing.mjs';
import {workplaceAccess} from './role-workplace.mjs';
import {rows,fail,text,day,context,clock,has,manager,canRead,event,write,guard,profileRequired,requestVersion,configurationView} from './workplace-common.mjs';
import {ledgerDocuments,latestDocuments,ledgerBalances,mutateFinanceLedger} from './finance-ledger.mjs';
import {claimFinanceState,claimOffsets} from './claim-finance.mjs';
import {assertFinanceOpen,financialRates,financeClock,financeGuardSql} from './finance-periods.mjs';
import {guardStatement} from './atomic.mjs';
import {workplaceSetup} from './workplace-readiness.mjs';
export const expenseCategories=['factory','freight','warehouse','subscription','office','service','advertising'];
const parse=r=>({...r,data:JSON.parse(r.data_json)});
function money(v){if(!/^\d+(\.\d{1,2})?$/.test(String(v)))fail('金额需为正数，最多两位小数');const n=Math.round(Number(v)*100);if(!Number.isSafeInteger(n)||n<=0||n>1e12)fail('金额超出范围');return n;}
const currencies=['CNY','IDR','MYR','THB','VND','PHP','USD'];
const advertisingScope=a=>['印尼','马来西亚','泰国','越南','菲律宾'].includes(a.site)&&['TikTok','Shopee'].includes(a.channel);
const advertising=r=>r.data.category==='advertising';
const budgetReady=r=>advertising(r)&&r.data.budget?.version===1;
const unitSnapshot=u=>({id:u.id,name:u.name,legalEntity:u.legal_entity,site:u.site,department:u.department});
async function expenseSetup(c){
 const users=await rows(c.db,'SELECT id,role,site,channel,active FROM users'),setup=workplaceSetup(c,c.a,users),unitId=c.profile?.unit_id;
 const managers=users.filter(u=>u.active&&u.id!==c.a.id&&(c.profile?.manager_id===u.id||c.grants.some(g=>g.user_id===u.id&&g.unit_id===unitId&&g.capability==='manager')));
 const financeReady=users.some(u=>u.active&&u.role==='财务'&&u.id!==c.a.id&&c.grants.some(g=>g.user_id===u.id&&g.unit_id===unitId&&g.capability==='finance')&&managers.some(m=>m.id!==u.id));
 const issues=[...setup.issues.filter(x=>x!=='shift'),...(!financeReady?['finance']:[]),...(c.a.role==='运营'&&!advertisingScope(c.a)?['scope']:[])];
 const organizationReady=setup.organizationReady&&!setup.issues.includes('job');
 return {organizationReady,managerReady:setup.managerReady,financeReady,canApplyAdvertising:c.a.role==='运营'&&advertisingScope(c.a)&&organizationReady&&setup.managerReady&&financeReady,issues};
}
async function createAdvertising(c,p,now){
 const {db,a}=c,setup=await expenseSetup(c);if(a.role!=='运营')fail('广告预算由对应站点运营发起',403);
 if(!setup.organizationReady)fail('请先由管理员配置组织、岗位和直属主管');
 if(!setup.managerReady)fail('尚未配置有效主管');if(!setup.financeReady)fail('尚未配置独立财务复核，请联系管理员');
 if(!advertisingScope(a)||p.site&&p.site!==a.site||p.channel&&p.channel!==a.channel)fail('只能申请本人站点和平台的广告预算',403);
 const profile=profileRequired(c),unit=c.units.find(u=>u.id===profile.unit_id),today=new Intl.DateTimeFormat('en-CA',{timeZone:unit.timezone}).format(new Date(now)),startDate=day(p.startDate),endDate=day(p.endDate);
 if(startDate<today||endDate<startDate||Date.parse(endDate)-Date.parse(startDate)>365*86400000)fail('投放开始日不得早于当地今天，结束日须在开始日之后或当天，期间不超过366天');
 if(!currencies.includes(p.currency))fail('币种无效');const v=await financeClock(db);await assertFinanceOpen(db,startDate);await assertFinanceOpen(db,endDate);
 const operationId=text(p.operationId,'请求编号',100);if(await db.prepare('SELECT id FROM workplace_requests WHERE operation_id=?').bind(operationId).first())fail('申请已提交',409);
 const adAccount=text(p.adAccount,'广告账户',160),data={category:'advertising',amountMinor:money(p.amount),currency:p.currency,purpose:text(p.purpose,'投放目的',1000),channel:a.channel,shop:text(p.shop,'店铺',120),settlementDate:endDate,sourceReference:adAccount,unit:unitSnapshot(unit),sourceKey:null,budget:{version:1,startDate,endDate,adAccount,approvedAmountMinor:null,approvedAt:null,approvedBy:null}};
 const id=crypto.randomUUID();await write(c,[financialGuard(db,a,v),db.prepare("INSERT INTO workplace_requests VALUES(?,?,'expense',?,?,?,'submitted',1,?,NULL,NULL,?,?)").bind(id,operationId,a.id,unit.id,startDate,JSON.stringify(data),now,now),...event(db,a,id,'advertisingCreate',data)]);return {ok:true,id};
}
export const expenseRequest=async(db,id)=>{const r=await db.prepare("SELECT * FROM workplace_requests WHERE id=? AND kind='expense'").bind(id||'').first();return r?parse(r):null;};
const financeAllowed=(c,r)=>has(c,'finance',r.unit_id)&&c.a.id!==r.user_id&&c.a.id!==r.manager_actor;
async function books(db){const version=await financeClock(db),documents=await ledgerDocuments(db),balances=ledgerBalances(documents,claimOffsets((await claimFinanceState(db)).sources));return {version,documents:latestDocuments(documents).filter(x=>x.status==='active'),balances};}
const financialGuard=(db,a,v)=>{const g=financeGuardSql(v);return guardStatement(db,a,'workplace-finance',g.sql,g.args);};
async function payments(db,documents,requestId){const links=await rows(db,'SELECT l.*,c.allocation_id,c.actor_id checker FROM workplace_all_payments l LEFT JOIN workplace_all_checks c ON c.link_id=l.id WHERE l.request_id=?',[requestId]);return links.map(l=>paymentView(l,documents));}
const documentIndexes=new WeakMap();
function paymentView(l,documents){let index=documentIndexes.get(documents);if(!index){index={byId:new Map(documents.map(d=>[d.id,d])),reversed:new Map(documents.filter(d=>d.kind==='supplier_payment'&&d.data.reversalOf).map(d=>[d.data.reversalOf,d]))};documentIndexes.set(documents,index);}const reversal=index.reversed.get(l.document_id);return {...l,reversed:!!reversal,reversalDate:reversal?.business_date,document:index.byId.get(l.document_id)};}
const paidAmount=l=>l.reversed?0:(l.document?.amount_minor||0);
async function reserve(db,b,sourceKey,exclude=''){
 const rs=(await rows(db,"SELECT * FROM workplace_requests WHERE kind='expense' AND NOT EXISTS(SELECT 1 FROM workplace_request_cancellations z WHERE z.request_id=workplace_requests.id) AND status IN('approved','complete') AND id<>? AND json_extract(data_json,'$.sourceKey')=?",[exclude,sourceKey])).map(parse);let total=0;
 const linked=await rows(db,"SELECT l.*,c.allocation_id FROM workplace_all_payments l JOIN workplace_requests r ON r.id=l.request_id LEFT JOIN workplace_all_checks c ON c.link_id=l.id WHERE json_extract(r.data_json,'$.sourceKey')=?",[sourceKey]);
 for(const r of rs){const allocated=linked.filter(l=>l.request_id===r.id&&l.allocation_id).reduce((n,l)=>n+paidAmount(paymentView(l,b.documents)),0);total+=r.data.amountMinor-allocated;}return total;
}
export async function mutateExpense(db,a,p){
 if(['adStatementCreate','adStatementReview','adStatementReject','adStatementSupersede'].includes(p.action))return mutateMarketingFinance(db,a,p);
 const c=await context(db,a),now=new Date().toISOString();
 if(['serviceBillCreate','serviceBillReview','serviceBillReject'].includes(p.action)){if(!['管理员','财务'].includes(a.role))fail('仅财务岗位可处理服务应付',403);return mutateFinanceLedger(db,a,{...p,action:p.action==='serviceBillReview'?'serviceReview':p.action==='serviceBillReject'?'serviceReject':'document',kind:'supplier_bill',billType:'service',...(p.action==='serviceBillCreate'?{revision:0}:{})},async()=>({before:[guard(c)],after:[]}));}
 if(p.action==='advertisingCreate')return createAdvertising(c,p,now);
 if(p.action==='expenseCreate'){
  const profile=profileRequired(c),unit=c.units.find(u=>u.id===profile.unit_id),businessDate=day(p.businessDate);await assertFinanceOpen(db,businessDate);
  if(businessDate>now.slice(0,10))fail('业务日不能晚于今天');if(!expenseCategories.includes(p.category))fail('一期仅支持已开放费用类别，薪资及税款暂不收集');
  if(p.category==='advertising')fail('请使用广告预算申请入口，填写投放期间和广告账户');
  if(['freight','warehouse','subscription'].includes(p.category)&&a.role!=='海运')fail('运输、仓储及紫鸟/IP费用由海运负责人发起',403);
  if(!profile.manager_id&&!c.grants.some(g=>g.unit_id===profile.unit_id&&g.capability==='manager'&&g.user_id!==a.id))fail('尚未配置主管');
  if(!currencies.includes(p.currency))fail('币种无效');const operationId=text(p.operationId,'请求编号',100);if(await db.prepare('SELECT id FROM workplace_requests WHERE operation_id=?').bind(operationId).first())fail('申请已提交',409);
  const data={category:p.category,amountMinor:money(p.amount),currency:p.currency,purpose:text(p.purpose,'用途及来源说明',1000),channel:text(p.channel,'平台/渠道',50),shop:text(p.shop,'店铺/业务单元',120),settlementDate:day(p.settlementDate),sourceReference:text(p.sourceReference,'合同/账单/装箱单来源编号',160),unit:{id:unit.id,name:unit.name,legalEntity:unit.legal_entity,site:unit.site,department:unit.department},sourceKey:null};
  const id=crypto.randomUUID(),v=await financeClock(db);await write(c,[financialGuard(db,c.a,v),db.prepare("INSERT INTO workplace_requests VALUES(?,?,'expense',?,?,?,'submitted',1,?,NULL,NULL,?,?)").bind(id,operationId,a.id,unit.id,businessDate,JSON.stringify(data),now,now),...event(db,c.a,id,'expenseCreate',data)]);return {ok:true,id};
 }
 const r=await expenseRequest(db,p.id);requestVersion(r,p);if(!canRead(c,r))fail('无权查看该费用申请',403);if(await db.prepare('SELECT request_id FROM workplace_request_cancellations WHERE request_id=?').bind(r.id).first())fail('申请已取消，请沿原单重新申请',409);if(['cancelRequest','cancelApprove','cancelReject'].includes(p.action))return cancelApproved(c,r,p);if(!['payment','bankCheck','correctionRequest','correctionApprove','correctionReject'].includes(p.action)){await assertFinanceOpen(db,r.business_date);await assertFinanceOpen(db,r.data.settlementDate);}
 let status,detail={},data=r.data;const v=await financeClock(db);
 if(p.action==='withdraw') {if(r.user_id!==a.id||!['submitted','manager_approved'].includes(r.status))fail('该申请不能撤回',403);status='withdrawn';}
 else if(['managerApprove','managerReject'].includes(p.action)){
  if(r.status!=='submitted'||!manager(c,r.user_id,r.unit_id))fail('仅主管可处理，不能自审',403);
  if(p.action==='managerApprove'&&budgetReady(r)&&!await db.prepare("SELECT u.id FROM users u JOIN workplace_grants g ON g.user_id=u.id WHERE u.active=1 AND u.role='财务' AND g.unit_id=? AND g.capability='finance' AND u.id NOT IN (?,?) LIMIT 1").bind(r.unit_id,r.user_id,c.a.id).first())fail('需先配置另一位有效财务，才能继续独立核定预算');
  status=p.action==='managerApprove'?'manager_approved':'rejected';
 }
 else if(p.action==='financeReject'){if(r.status!=='manager_approved'||!financeAllowed(c,r))fail('需独立财务复核',403);status='rejected';}
 else if(p.action==='advertisingApprove'){
  if(!budgetReady(r))fail('旧广告意向缺少投放期间，请申请人撤回后从广告预算入口重新提交');
  if(r.status!=='manager_approved'||!financeAllowed(c,r))fail('需独立财务核定预算，不能自审',403);
  const owner=await db.prepare('SELECT id,role,site,channel,active FROM users WHERE id=?').bind(r.user_id).first(),unit=c.units.find(u=>u.id===r.unit_id&&u.active);
  if(!owner?.active||owner.role!=='运营'||owner.site!==r.data.unit.site||owner.channel!==r.data.channel||!unit||!c.profiles.some(x=>x.user_id===owner.id&&x.unit_id===r.unit_id&&x.active))fail('申请人的岗位或组织归属已变化，请退回后重新提交',409);
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:unit.timezone}).format(new Date(now));if(r.data.budget.endDate<today)fail('投放期间已结束，请退回后重新提交');
  const approvedAmountMinor=money(p.approvedAmount);if(approvedAmountMinor>r.data.amountMinor)fail('核定预算不能超过申请金额，需增加时请退回重提');
  const rate=(await financialRates(db,r.business_date.slice(0,7)))[r.data.currency]||null;
  data={...r.data,rate:rate?{id:rate.id,month:rate.month,revision:rate.revision,rate:rate.rate}:null,budget:{...r.data.budget,approvedAmountMinor,approvedAt:now,approvedBy:a.id}};
  await write(c,[financialGuard(db,c.a,v),db.prepare("UPDATE workplace_requests SET status='approved',version=version+1,data_json=?,reviewer_actor=?,updated_at=? WHERE id=?").bind(JSON.stringify(data),a.id,now,r.id),...event(db,c.a,r.id,'advertisingApprove',{from:r.status,to:'approved',reason:text(p.reason,'预算核定依据',500),data})]);return {ok:true,id:r.id,status:'approved',approvedAmountMinor};
 }
 else if(p.action==='financeApprove'){
  if(r.status!=='manager_approved'||!financeAllowed(c,r))fail('需独立财务复核，不能自审',403);
  // Ad budget/recharge is not an expense. A later budget/consumption model is required.
  if(advertising(r))fail('广告申请请单独核定预算，不进入应付或支付');
  const b=await books(db),source=b.balances.find(d=>d.kind==='supplier_bill'&&d.business_key===p.sourceKey),unit=c.units.find(u=>u.id===r.unit_id),scope=await db.prepare('SELECT * FROM workplace_bill_scopes WHERE business_key=?').bind(p.sourceKey||'').first();
  if(!source||source.site!==unit.site||source.channel!==r.data.channel||source.currency!==r.data.currency||source.data.matchStatus!=='matched')fail('须选择同站点、渠道、币种且价量税收货已核对的有效应付');
  if(p.entityConfirmed!==true||!scope||scope.unit_id!==unit.id||scope.legal_entity!==unit.legal_entity)fail('须核实应付的付款法人及组织，不可跨主体认领');
  if(source.remaining-await reserve(db,b,source.business_key)<r.data.amountMinor)fail('申请超过应付尚可申请余额（含已批占用及赔偿抵扣）',409);
  const rate=(await financialRates(db,r.business_date.slice(0,7)))[r.data.currency]||null;
  data={...data,sourceKey:source.business_key,sourceId:source.id,sourceRevision:source.revision,rate:rate?{id:rate.id,month:rate.month,revision:rate.revision,rate:rate.rate}:null};status='approved';detail.source=source.id;
  const extra=scope?[]:[db.prepare('INSERT INTO workplace_bill_scopes VALUES(?,?,?,?,?)').bind(source.business_key,unit.id,unit.legal_entity,a.id,now)];
  await write(c,[financialGuard(db,c.a,b.version),...extra,db.prepare('UPDATE workplace_requests SET status=?,version=version+1,data_json=?,reviewer_actor=?,updated_at=? WHERE id=?').bind(status,JSON.stringify(data),a.id,now,r.id),...event(db,c.a,r.id,p.action,{...detail,from:r.status,to:status,reason:text(p.reason,'复核依据',500),data})]);return {ok:true};
 }else if(['correctionRequest','correctionApprove','correctionReject'].includes(p.action))return correctPayment(c,r,p);
 else if(['payment','bankCheck'].includes(p.action))return registerPayment(c,r,p);
 else fail('费用动作无效');
 await write(c,[financialGuard(db,c.a,v),db.prepare('UPDATE workplace_requests SET status=?,version=version+1,manager_actor=?,reviewer_actor=?,updated_at=? WHERE id=?').bind(status,p.action.startsWith('manager')?a.id:r.manager_actor,p.action==='financeReject'?a.id:r.reviewer_actor,now,r.id),...event(db,c.a,r.id,p.action,{from:r.status,to:status,reason:text(p.reason,'处理依据',500)})]);return {ok:true};
}
async function registerPayment(c,r,p){
 if(advertising(r))fail('广告预算核定不代表付款，不可在此登记付款或核销',403);
 const {db,a}=c;if(r.status!=='approved'||!financeAllowed(c,r))fail('仅授权财务可处理已批申请，不能处理本人申请或审批',403);
 if(await db.prepare("SELECT id FROM workplace_events e WHERE e.entity_id=? AND e.action IN ('expenseCancellationRequested','paymentCorrectionRequested') AND NOT EXISTS(SELECT 1 FROM workplace_events x WHERE x.entity_id=e.entity_id AND x.action IN ('expenseCancellationApproved','expenseCancellationRejected','paymentCorrectionApproved','paymentCorrectionRejected') AND json_extract(x.detail_json,'$.requestEventId')=e.id) LIMIT 1").bind(r.id).first())fail('本单更正或取消正在复核，完成后再付款核销',409);
 const b=await books(db),source=b.balances.find(d=>d.kind==='supplier_bill'&&d.id===r.data.sourceId);if(!source||source.revision!==r.data.sourceRevision)fail('应付来源版本已变化，停止支付并核对',409);
 const ps=await payments(db,b.documents,r.id),paid=ps.reduce((s,x)=>s+paidAmount(x),0),allocated=ps.filter(x=>x.allocation_id).reduce((s,x)=>s+paidAmount(x),0),bankDate=day(p.bankDate),now=new Date().toISOString();const accountingDate=day(p.accountingDate||bankDate);await assertFinanceOpen(db,accountingDate);if(accountingDate<bankDate||accountingDate>now.slice(0,10))fail('核销记账日须不早于银行日且不晚于今天');
 if(bankDate>now.slice(0,10)||bankDate<source.business_date||bankDate<r.business_date)fail('银行日须不早于来源业务日且不晚于今天');
 const amount=p.action==='payment'?money(p.amount):0,id=crypto.randomUUID(),key='WF-'+id,reason=text(p.reason,'登记/银行核对依据',500);
 if(p.action==='payment'){
  if(amount>r.data.amountMinor-paid)fail('分笔付款超过已批未付余额',409);
  if(source.remaining-await reserve(db,b,source.business_key,r.id)-(paid-allocated)<amount)fail('应付余额不足或已有待核对付款占用',409);
  const proof=await db.prepare('SELECT * FROM workplace_proofs WHERE id=? AND request_id=?').bind(p.proofId||'',r.id).first();if(!proof)fail('请先上传本申请的私有银行凭证');
  const account=text(p.bankAccount,'银行账户标识（不填密码）',100).toUpperCase(),reference=text(p.bankReference,'银行流水唯一号',160).toUpperCase();
  const duplicates=await rows(db,'SELECT * FROM workplace_all_payments WHERE proof_id=? OR (legal_entity=? AND bank_account=? AND bank_reference=?)',[proof.id,r.data.unit.legalEntity,account,reference]);
  if(duplicates.some(l=>l.proof_id===proof.id||!paymentView(l,b.documents).reversed))fail('银行流水或凭证已登记，不能重复',409);
  const reentry=duplicates.length>0;if(reentry&&duplicates.some(l=>paymentView(l,b.documents).reversalDate>accountingDate))fail('更正重录日期不得早于原冲正日期');if(!reentry&&accountingDate!==bankDate)fail('普通付款记账日须与银行日一致；历史差错需走原付款更正');
  const result=await mutateFinanceLedger(db,a,{action:'document',kind:'supplier_payment',businessKey:key,revision:0,businessDate:accountingDate,currency:r.data.currency,counterparty:source.counterparty,site:source.site,channel:source.channel,amount:amount/100,reference:reference,evidence:'私有凭证 '+proof.id,reason},async base=>{
   base.data={...base.data,workplaceRequestId:r.id,legalEntity:r.data.unit.legalEntity,unitId:r.unit_id,sourceKey:r.data.sourceKey,correctionReentry:reentry,bankDate,accountingDate,settlementDate:r.data.settlementDate,rate:r.data.rate};
   // Deferred foreign keys are unnecessary: insert the link after the ledger row via the hook's after list.
   return {before:[guard(c),financialGuard(db,a,b.version)],after:[db.prepare(`INSERT INTO ${reentry?'workplace_payment_reentries':'workplace_payment_links'} VALUES(?,?,?,?,?,?,?,?)`).bind(id,r.id,base.id,proof.id,account,reference,bankDate,r.data.unit.legalEntity),db.prepare('UPDATE workplace_requests SET version=version+1,updated_at=? WHERE id=?').bind(now,r.id),...event(db,a,r.id,'payment',{documentId:base.id,proofId:proof.id,amountMinor:amount,bankDate})]};
  });return result;
 }
 const link=ps.find(x=>x.id===p.linkId);if(!link?.document||link.reversed||link.allocation_id)fail('付款不存在或已经核对',409);if(link.document.actor_id===a.id||r.user_id===a.id)fail('银行核对须由另一名财务完成',403);if(bankDate!==link.bank_date)fail('银行核对日期须与登记的银行日一致');
 const reentry=await db.prepare('SELECT id FROM workplace_payment_reentries WHERE id=?').bind(link.id).first();
 const n=link.document.amount_minor,result=await mutateFinanceLedger(db,a,{action:'document',kind:'supplier_allocation',businessKey:key,revision:0,businessDate:accountingDate,currency:r.data.currency,counterparty:source.counterparty,site:source.site,channel:source.channel,amount:n/100,cashKey:link.document.business_key,debtKey:source.business_key,evidence:'银行核对凭证 '+link.proof_id,reason},async base=>{
  base.data={...base.data,workplaceRequestId:r.id,legalEntity:r.data.unit.legalEntity,unitId:r.unit_id};return {before:[guard(c),financialGuard(db,a,b.version)],after:[db.prepare(`INSERT INTO ${reentry?'workplace_reentry_checks':'workplace_bank_checks'} VALUES(?,?,?,?,?)`).bind(id,link.id,base.id,a.id,now),db.prepare('UPDATE workplace_requests SET status=?,version=version+1,updated_at=? WHERE id=?').bind(allocated+n===r.data.amountMinor?'complete':'approved',now,r.id),...event(db,a,r.id,'bankCheck',{linkId:link.id,allocationId:base.id,amountMinor:n,reason})]};
 });return result;
}
async function correctPayment(c,r,p){
 const {db,a}=c;if(advertising(r)||!['approved','complete'].includes(r.status)||!financeAllowed(c,r))fail('仅授权财务可更正已批准费用付款',403);
 const b=await books(db),ps=await payments(db,b.documents,r.id),history=await rows(db,"SELECT * FROM workplace_events WHERE entity_id=? AND action IN ('paymentCorrectionRequested','paymentCorrectionApproved','paymentCorrectionRejected')",[r.id]);
 const pending=history.filter(e=>e.action==='paymentCorrectionRequested'&&!history.some(x=>x.action!=='paymentCorrectionRequested'&&JSON.parse(x.detail_json).requestEventId===e.id));
 const reason=text(p.reason,'更正依据',1000),at=new Date().toISOString();
 if(p.action==='correctionRequest'){
  const link=ps.find(l=>l.id===p.linkId);if(!link?.document||link.reversed)fail('付款已更正或不存在',409);
  if(pending.some(e=>JSON.parse(e.detail_json).linkId===link.id))fail('这笔付款已有待复核更正',409);
  const correctionDate=day(p.correctionDate);if(correctionDate<link.bank_date||correctionDate>at.slice(0,10))fail('更正记账日须不早于原银行日且不晚于今天');await assertFinanceOpen(db,correctionDate);
  await write(c,[financialGuard(db,a,b.version),db.prepare('UPDATE workplace_requests SET version=version+1,updated_at=? WHERE id=?').bind(at,r.id),...event(db,a,r.id,'paymentCorrectionRequested',{linkId:link.id,correctionDate,reason,amountMinor:link.document.amount_minor})]);return {ok:true};
 }
 const request=pending.find(e=>e.id===p.requestEventId);if(!request)fail('更正申请已处理或不存在',409);
 const detail=JSON.parse(request.detail_json),link=ps.find(l=>l.id===detail.linkId);
 if(!link?.document||link.reversed)fail('原付款状态已变化',409);
 if(request.actor_id===a.id||link.document.actor_id===a.id)fail('更正须另一名未登记原付款的财务独立复核',403);
 const statements=[];let action='paymentCorrectionRejected';
 if(p.action==='correctionApprove'){
  await assertFinanceOpen(db,detail.correctionDate);action='paymentCorrectionApproved';
  const originals=[link.document,...(link.allocation_id?[b.documents.find(d=>d.id===link.allocation_id)]:[])];if(originals.some(d=>!d))fail('原核销证据不完整，请先核查',409);if(originals.some(d=>d.business_date>detail.correctionDate))fail('更正日期不得早于原付款或核销记账日，请驳回后重新申请',409);
  for(const original of originals){
   const id=crypto.randomUUID(),data={...original.data,effect:-1,reversalOf:original.id,requestEventId:request.id,originalBankDate:link.bank_date,correctionBasis:reason};
   statements.push(db.prepare('INSERT INTO finance_documents VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(id,original.kind,'WF-CORRECTION-'+id,1,detail.correctionDate,original.counterparty,original.site,original.channel,original.currency,original.amount_minor,'active',JSON.stringify(data),original.evidence,reason,a.id,at));
  }
 }
 await write(c,[financialGuard(db,a,b.version),...statements,db.prepare('UPDATE workplace_requests SET status=?,version=version+1,updated_at=? WHERE id=?').bind(action==='paymentCorrectionApproved'?'approved':r.status,at,r.id),...event(db,a,r.id,action,{...detail,requestEventId:request.id,reason})]);return {ok:true};
}

async function cancelApproved(c,r,p){
 const {db,a}=c;if(advertising(r)||r.status!=='approved'||!(r.user_id===a.id||financeAllowed(c,r)))fail('只能申请取消已批准且尚未付款的费用',403);
 const b=await books(db),ps=await payments(db,b.documents,r.id);if(ps.some(l=>paidAmount(l)>0))fail('已有付款，须先由财务完成付款更正后再取消',409);
 const history=await rows(db,"SELECT * FROM workplace_events WHERE entity_id=? AND action IN ('expenseCancellationRequested','expenseCancellationApproved','expenseCancellationRejected')",[r.id]);
 const pending=history.filter(e=>e.action==='expenseCancellationRequested'&&!history.some(x=>x.action!=='expenseCancellationRequested'&&JSON.parse(x.detail_json).requestEventId===e.id));
 const reason=text(p.reason,'取消及重新申请依据',1000),at=new Date().toISOString();
 if(p.action==='cancelRequest'){
  if(pending.length)fail('已有待复核取消申请',409);const date=day(p.correctionDate);if(date<r.business_date||date>at.slice(0,10))fail('取消记账日须在原业务日与今天之间');await assertFinanceOpen(db,date);
  await write(c,[financialGuard(db,a,b.version),db.prepare('UPDATE workplace_requests SET version=version+1,updated_at=? WHERE id=?').bind(at,r.id),...event(db,a,r.id,'expenseCancellationRequested',{correctionDate:date,reason})]);return {ok:true};
 }
 const request=pending.find(e=>e.id===p.requestEventId);if(!request)fail('取消申请已处理',409);if(!financeAllowed(c,r)||request.actor_id===a.id)fail('须由另一位授权财务独立复核',403);
 const detail=JSON.parse(request.detail_json),approve=p.action==='cancelApprove';await assertFinanceOpen(db,detail.correctionDate);
 await write(c,[financialGuard(db,a,b.version),...(approve?[db.prepare('INSERT INTO workplace_request_cancellations VALUES(?,?,?,?,?,?)').bind(r.id,detail.correctionDate,reason,request.actor_id,a.id,at)]:[]),db.prepare('UPDATE workplace_requests SET version=version+1,updated_at=? WHERE id=?').bind(at,r.id),...event(db,a,r.id,approve?'expenseCancellationApproved':'expenseCancellationRejected',{...detail,requestEventId:request.id,reason})]);return {ok:true};
}

export async function readExpenses(db,a,q={}){
 const c=await context(db,a),serverTime=new Date().toISOString(),month=q.month||serverTime.slice(0,7);if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))fail('月份无效');
 const auth=`(r.user_id=? OR EXISTS(SELECT 1 FROM workplace_profiles p WHERE p.user_id=r.user_id AND p.unit_id=r.unit_id AND p.active=1 AND p.manager_id=?) OR EXISTS(SELECT 1 FROM workplace_grants g WHERE g.user_id=? AND g.unit_id=r.unit_id AND (g.capability IN('manager','executive') OR (g.capability='finance' AND ?='财务'))))`;
 const cancelled=await rows(db,'SELECT * FROM workplace_request_cancellations'),cancelIds=new Set(cancelled.map(x=>x.request_id)),cancelMonths=new Map(cancelled.map(x=>[x.request_id,x.business_date.slice(0,7)]));
 const rs=(await rows(db,`SELECT r.*,u.name FROM workplace_requests r JOIN users u ON u.id=r.user_id WHERE r.kind='expense' AND ${auth} AND (?<>'mine' OR r.user_id=?) AND (substr(business_date,1,7)=? OR r.status IN('submitted','manager_approved') OR (r.status='approved' AND COALESCE(json_extract(r.data_json,'$.category'),'')<>'advertising') OR EXISTS(SELECT 1 FROM workplace_all_payments l WHERE l.request_id=r.id AND substr(l.bank_date,1,7)=?) OR EXISTS(SELECT 1 FROM finance_documents d WHERE json_extract(d.data_json,'$.workplaceRequestId')=r.id AND substr(d.business_date,1,7)=?) OR EXISTS(SELECT 1 FROM workplace_events e WHERE e.entity_id=r.id AND e.action='paymentCorrectionRequested' AND NOT EXISTS(SELECT 1 FROM workplace_events x WHERE x.entity_id=r.id AND x.action IN ('paymentCorrectionApproved','paymentCorrectionRejected') AND json_extract(x.detail_json,'$.requestEventId')=e.id))) ORDER BY r.created_at DESC,r.id`,[a.id,a.id,a.id,c.a.role,q.scope||'',a.id,month,month,month])).filter(r=>canRead(c,r)).map(parse),b=rs.some(r=>!advertising(r))||c.grants.some(g=>g.user_id===a.id&&g.capability==='finance')?await books(db):{documents:[],balances:[]},result=[],summary={},budgetSummary={},queue={reviews:0,advertisingReviews:0,payments:0,checks:0};
 const allLinks=rs.length?await rows(db,`SELECT l.*,k.allocation_id,k.actor_id checker FROM workplace_all_payments l JOIN workplace_requests r ON r.id=l.request_id LEFT JOIN workplace_all_checks k ON k.link_id=l.id WHERE ${auth} AND (?<>'mine' OR r.user_id=?)`,[a.id,a.id,a.id,c.a.role,q.scope||'',a.id]):[];
 const linkMap=new Map();for(const l of allLinks){const list=linkMap.get(l.request_id)||[];list.push(paymentView(l,b.documents));linkMap.set(l.request_id,list);}
 const detailed=rs.filter(r=>(r.user_id===a.id||manager(c,r.user_id,r.unit_id)||has(c,'finance',r.unit_id))&&(q.category==='advertising'?advertising(r):q.category==='expenses'?!advertising(r):true));
 const pageSize=50,page=Math.max(1,Math.min(Math.ceil(detailed.length/pageSize)||1,Number.parseInt(q.page||'1',10)||1)),pageRows=detailed.slice((page-1)*pageSize,page*pageSize),ids=pageRows.map(r=>r.id),selected=new Set(ids);
 const proofs=ids.length?await rows(db,`SELECT id,request_id,filename,mime,size,created_at FROM workplace_proofs WHERE request_id IN (${ids.map(()=>'?').join(',')})`,ids):[];

 for(const r of rs){const isAdvertising=advertising(r),links=isAdvertising?[]:(linkMap.get(r.id)||[]),paid=links.reduce((s,l)=>s+paidAmount(l),0),allocated=links.filter(l=>l.allocation_id).reduce((s,l)=>s+paidAmount(l),0),key=JSON.stringify([r.data.unit.legalEntity,r.data.unit.site,r.data.currency]);
  if(isAdvertising){
   // Totals belong to the budget start month, not the payment ledger or every month it spans.
   if(r.business_date.slice(0,7)===month&&!['rejected','withdrawn'].includes(r.status)){
    const t=budgetSummary[key]||={entity:r.data.unit.legalEntity,site:r.data.unit.site,currency:r.data.currency,requested:0,approved:0,approvedCny:0,fxMissing:0,count:0};t.requested+=r.data.amountMinor;t.count++;
    if(r.status==='approved'&&budgetReady(r)&&r.data.budget.approvedAmountMinor!=null){t.approved+=r.data.budget.approvedAmountMinor;if(r.data.rate)t.approvedCny+=Math.round(r.data.budget.approvedAmountMinor*r.data.rate.rate);else t.fxMissing++;}
   }
  }else{
   const t=summary[key]||={entity:r.data.unit.legalEntity,site:r.data.unit.site,currency:r.data.currency,approved:0,paid:0,unallocated:0,approvedCny:0,fxMissing:0,outstanding:0,shops:[]};if(!cancelIds.has(r.id)&&['approved','complete'].includes(r.status))t.outstanding+=r.data.amountMinor-paid;if(r.business_date.slice(0,7)===month&&['approved','complete'].includes(r.status)&&(!cancelMonths.has(r.id)||cancelMonths.get(r.id)>month)){t.approved+=r.data.amountMinor;if(r.data.rate)t.approvedCny+=Math.round(r.data.amountMinor*r.data.rate.rate);else t.fxMissing++;}t.paid+=b.documents.filter(d=>d.kind==='supplier_payment'&&d.data.workplaceRequestId===r.id&&d.business_date.slice(0,7)===month).reduce((n,d)=>n+d.amount_minor*(d.data.effect===-1?-1:1),0);t.unallocated+=paid-allocated;const shopKey=JSON.stringify([r.unit_id,r.data.channel,r.data.shop]);if(!t.shops.includes(shopKey))t.shops.push(shopKey);
  }
  const cancelled=cancelIds.has(r.id);if(!cancelled){if(r.status==='submitted'&&manager(c,r.user_id,r.unit_id)||r.status==='manager_approved'&&financeAllowed(c,r)){queue.reviews++;if(isAdvertising)queue.advertisingReviews++;}if(!isAdvertising&&r.status==='approved'&&financeAllowed(c,r)&&r.data.amountMinor>paid)queue.payments++;queue.checks+=links.filter(l=>financeAllowed(c,r)&&l.document?.actor_id!==a.id&&!l.allocation_id&&!l.reversed).length;}
  const detailAccess=r.user_id===a.id||manager(c,r.user_id,r.unit_id)||has(c,'finance',r.unit_id);if(!detailAccess||!selected.has(r.id))continue;
  result.push({...r,originalStatus:r.status,status:cancelled?'withdrawn':r.status,cancelled,canCancel:!cancelled&&!isAdvertising&&r.status==='approved'&&paid===0&&(r.user_id===a.id||financeAllowed(c,r)),isAdvertising,legacyAdvertising:isAdvertising&&!budgetReady(r),paidMinor:isAdvertising?null:paid,allocatedMinor:isAdvertising?null:allocated,unpaidMinor:cancelled?0:!isAdvertising&&['approved','complete'].includes(r.status)?r.data.amountMinor-paid:null,links:links.map(l=>({id:l.id,proofId:l.proof_id,bankDate:l.bank_date,amountMinor:l.document?.amount_minor??null,reversed:l.reversed,reversalDate:l.reversalDate,canCorrect:!cancelled&&!l.reversed&&financeAllowed(c,r),checked:!!l.allocation_id,canCheck:!cancelled&&financeAllowed(c,r)&&l.document?.actor_id!==a.id&&!l.allocation_id&&!l.reversed})),canManager:r.status==='submitted'&&manager(c,r.user_id,r.unit_id),canFinance:!isAdvertising&&r.status==='manager_approved'&&financeAllowed(c,r),canFinanceReject:r.status==='manager_approved'&&financeAllowed(c,r),canBudgetApprove:budgetReady(r)&&r.status==='manager_approved'&&financeAllowed(c,r),canPay:!cancelled&&!isAdvertising&&r.status==='approved'&&financeAllowed(c,r),corrections:[],proofs:proofs.filter(p=>p.request_id===r.id)});}
 const scopes=await rows(db,'SELECT * FROM workplace_bill_scopes'),bills=b.balances.filter(d=>q.scope!=='mine'&&d.kind==='supplier_bill'&&d.data.matchStatus==='matched'&&d.remaining>0&&c.units.some(u=>u.site===d.site&&has(c,'finance',u.id)&&scopes.some(s=>s.business_key===d.business_key&&s.unit_id===u.id))).map(d=>({id:d.id,key:d.business_key,site:d.site,channel:d.channel,currency:d.currency,counterparty:d.counterparty,remaining:d.remaining}));
 const events=ids.length?await rows(db,`SELECT e.*,u.name actor_name FROM workplace_events e JOIN users u ON u.id=e.actor_id WHERE e.entity_id IN (${ids.map(()=>'?').join(',')}) ORDER BY e.created_at DESC LIMIT 300`,ids):[];
 const pendingEvents=rs.length?await rows(db,`SELECT e.* FROM workplace_events e JOIN workplace_requests r ON r.id=e.entity_id WHERE ${auth} AND e.action IN ('paymentCorrectionRequested','expenseCancellationRequested') AND NOT EXISTS(SELECT 1 FROM workplace_events x WHERE x.entity_id=e.entity_id AND x.action IN ('paymentCorrectionApproved','paymentCorrectionRejected','expenseCancellationApproved','expenseCancellationRejected') AND json_extract(x.detail_json,'$.requestEventId')=e.id)`,[a.id,a.id,a.id,c.a.role]):[];
 for(const e of pendingEvents){const r=rs.find(r=>r.id===e.entity_id),detail=JSON.parse(e.detail_json);if(r&&financeAllowed(c,r)&&e.actor_id!==a.id&&(e.action==='expenseCancellationRequested'||(linkMap.get(r.id)||[]).find(l=>l.id===detail.linkId)?.document?.actor_id!==a.id))queue.reviews++;}
 for(const r of result){r.cancellations=pendingEvents.filter(e=>e.entity_id===r.id&&e.action==='expenseCancellationRequested').map(e=>({...JSON.parse(e.detail_json),id:e.id,canReview:financeAllowed(c,r)&&e.actor_id!==a.id}));r.corrections=pendingEvents.filter(e=>e.entity_id===r.id&&e.action==='paymentCorrectionRequested').map(e=>({...JSON.parse(e.detail_json),id:e.id,requestedBy:e.actor_id,canReview:financeAllowed(c,r)&&e.actor_id!==a.id&&(linkMap.get(r.id)||[]).find(l=>l.id===JSON.parse(e.detail_json).linkId)?.document?.actor_id!==a.id&&!events.some(x=>['paymentCorrectionApproved','paymentCorrectionRejected'].includes(x.action)&&JSON.parse(x.detail_json).requestEventId===e.id)}));}
 const setup=await expenseSetup(c);if(await clock(db)!==c.version||b.version&&await financeClock(db)!==b.version)fail('读取期间财务资料已变化，请刷新',409);
 return {queue,pagination:{page,pageSize,total:detailed.length,pages:Math.ceil(detailed.length/pageSize)},basis:{occurrence:month,cash:month,outstandingAsOf:serverTime,eventLimit:300},actor:{...c.a,financeMode:await financeMode(db,c.a)},profile:c.profile||null,setup,serverTime,month,scope:q.scope==='mine'?'mine':'authorized',access:workplaceAccess(c),configuration:await configurationView(c),requests:result,summary:Object.values(summary).map(t=>({...t,shopCount:t.shops.length,shops:undefined,approvedCny:t.fxMissing?null:t.approvedCny})),budgetSummary:Object.values(budgetSummary).map(t=>({...t,approvedCny:t.fxMissing?null:t.approvedCny})),bills,events};
}
