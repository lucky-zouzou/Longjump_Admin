import {rows,fail,text,day,context,clock,has,manager,canRead,event,write,guard,profileRequired,requestVersion,configurationView} from './workplace-common.mjs';
import {ledgerDocuments,latestDocuments,ledgerBalances,mutateFinanceLedger} from './finance-ledger.mjs';
import {claimFinanceState,claimOffsets} from './claim-finance.mjs';
import {assertFinanceOpen,financialRates,financeClock,financeGuardSql} from './finance-periods.mjs';
import {guardStatement} from './atomic.mjs';
export const expenseCategories=['factory','freight','warehouse','subscription','office','advertising'];
const parse=r=>({...r,data:JSON.parse(r.data_json)});
function money(v){if(!/^\d+(\.\d{1,2})?$/.test(String(v)))fail('金额需为正数，最多两位小数');const n=Math.round(Number(v)*100);if(!Number.isSafeInteger(n)||n<=0||n>1e12)fail('金额超出范围');return n;}
const currencies=['CNY','IDR','MYR','THB','VND','PHP','USD'];
export const expenseRequest=async(db,id)=>{const r=await db.prepare("SELECT * FROM workplace_requests WHERE id=? AND kind='expense'").bind(id||'').first();return r?parse(r):null;};
const financeAllowed=(c,r)=>has(c,'finance',r.unit_id)&&c.a.id!==r.user_id&&c.a.id!==r.manager_actor;
async function books(db){const version=await financeClock(db),documents=await ledgerDocuments(db),balances=ledgerBalances(documents,claimOffsets((await claimFinanceState(db)).sources));return {version,documents:latestDocuments(documents).filter(x=>x.status==='active'),balances};}
const financialGuard=(db,a,v)=>{const g=financeGuardSql(v);return guardStatement(db,a,'workplace-finance',g.sql,g.args);};
async function payments(db,documents,requestId){const links=await rows(db,'SELECT l.*,c.allocation_id,c.actor_id checker FROM workplace_payment_links l LEFT JOIN workplace_bank_checks c ON c.link_id=l.id WHERE l.request_id=?',[requestId]);return links.map(l=>({...l,document:documents.find(d=>d.id===l.document_id)}));}
async function reserve(db,b,sourceKey,exclude=''){
 const rs=(await rows(db,"SELECT * FROM workplace_requests WHERE kind='expense' AND status IN('approved','complete') AND id<>? AND json_extract(data_json,'$.sourceKey')=?",[exclude,sourceKey])).map(parse);let total=0;
 for(const r of rs){const ps=await payments(db,b.documents,r.id),allocated=ps.filter(p=>p.allocation_id).reduce((s,p)=>s+(p.document?.amount_minor||0),0);total+=r.data.amountMinor-allocated;}return total;
}
export async function mutateExpense(db,a,p){
 const c=await context(db,a),now=new Date().toISOString();
 if(p.action==='expenseCreate'){
  const profile=profileRequired(c),unit=c.units.find(u=>u.id===profile.unit_id),businessDate=day(p.businessDate);await assertFinanceOpen(db,businessDate);
  if(businessDate>now.slice(0,10))fail('业务日不能晚于今天');if(!expenseCategories.includes(p.category))fail('一期仅支持已开放费用类别，薪资及税款暂不收集');
  if(['freight','warehouse','subscription'].includes(p.category)&&a.role!=='海运')fail('运输、仓储及紫鸟/IP费用由海运负责人发起',403);
  if(!profile.manager_id&&!c.grants.some(g=>g.unit_id===profile.unit_id&&g.capability==='manager'&&g.user_id!==a.id))fail('尚未配置主管');
  if(!currencies.includes(p.currency))fail('币种无效');const operationId=text(p.operationId,'请求编号',100);if(await db.prepare('SELECT id FROM workplace_requests WHERE operation_id=?').bind(operationId).first())fail('申请已提交',409);
  const data={category:p.category,amountMinor:money(p.amount),currency:p.currency,purpose:text(p.purpose,'用途及来源说明',1000),channel:text(p.channel,'平台/渠道',50),shop:text(p.shop,'店铺/业务单元',120),settlementDate:day(p.settlementDate),sourceReference:text(p.sourceReference,'合同/账单/装箱单来源编号',160),unit:{id:unit.id,name:unit.name,legalEntity:unit.legal_entity,site:unit.site,department:unit.department},sourceKey:null};
  const id=crypto.randomUUID(),v=await financeClock(db);await write(c,[financialGuard(db,c.a,v),db.prepare("INSERT INTO workplace_requests VALUES(?,?,'expense',?,?,?,'submitted',1,?,NULL,NULL,?,?)").bind(id,operationId,a.id,unit.id,businessDate,JSON.stringify(data),now,now),...event(db,c.a,id,'expenseCreate',data)]);return {ok:true,id};
 }
 const r=await expenseRequest(db,p.id);requestVersion(r,p);if(!canRead(c,r))fail('无权查看该费用申请',403);await assertFinanceOpen(db,r.business_date);await assertFinanceOpen(db,r.data.settlementDate);
 let status,detail={},data=r.data;const v=await financeClock(db);
 if(p.action==='withdraw') {if(r.user_id!==a.id||!['submitted','manager_approved'].includes(r.status))fail('该申请不能撤回',403);status='withdrawn';}
 else if(['managerApprove','managerReject'].includes(p.action)){if(r.status!=='submitted'||!manager(c,r.user_id,r.unit_id))fail('仅主管可处理，不能自审',403);status=p.action==='managerApprove'?'manager_approved':'rejected';}
 else if(p.action==='financeReject'){if(r.status!=='manager_approved'||!financeAllowed(c,r))fail('需独立财务复核',403);status='rejected';}
 else if(p.action==='financeApprove'){
  if(r.status!=='manager_approved'||!financeAllowed(c,r))fail('需独立财务复核，不能自审',403);
  // Ad budget/recharge is not an expense. A later budget/consumption model is required.
  if(r.data.category==='advertising')fail('广告申请仅做预算意向；周额度和实耗核验尚未开放，不进入应付或支付');
  const b=await books(db),source=b.balances.find(d=>d.kind==='supplier_bill'&&d.business_key===p.sourceKey),unit=c.units.find(u=>u.id===r.unit_id),scope=await db.prepare('SELECT * FROM workplace_bill_scopes WHERE business_key=?').bind(p.sourceKey||'').first();
  if(!source||source.site!==unit.site||source.channel!==r.data.channel||source.currency!==r.data.currency||source.data.matchStatus!=='matched')fail('须选择同站点、渠道、币种且价量税收货已核对的有效应付');
  if(p.entityConfirmed!==true||!scope||scope.unit_id!==unit.id||scope.legal_entity!==unit.legal_entity)fail('须核实应付的付款法人及组织，不可跨主体认领');
  if(source.remaining-await reserve(db,b,source.business_key)<r.data.amountMinor)fail('申请超过应付尚可申请余额（含已批占用及赔偿抵扣）',409);
  await assertFinanceOpen(db,source.business_date);const rate=(await financialRates(db,r.business_date.slice(0,7)))[r.data.currency]||null;
  data={...data,sourceKey:source.business_key,sourceId:source.id,sourceRevision:source.revision,rate:rate?{id:rate.id,month:rate.month,revision:rate.revision,rate:rate.rate}:null};status='approved';detail.source=source.id;
  const extra=scope?[]:[db.prepare('INSERT INTO workplace_bill_scopes VALUES(?,?,?,?,?)').bind(source.business_key,unit.id,unit.legal_entity,a.id,now)];
  await write(c,[financialGuard(db,c.a,b.version),...extra,db.prepare('UPDATE workplace_requests SET status=?,version=version+1,data_json=?,reviewer_actor=?,updated_at=? WHERE id=?').bind(status,JSON.stringify(data),a.id,now,r.id),...event(db,c.a,r.id,p.action,{...detail,from:r.status,to:status,reason:text(p.reason,'复核依据',500),data})]);return {ok:true};
 }else if(['payment','bankCheck'].includes(p.action))return registerPayment(c,r,p);
 else fail('费用动作无效');
 await write(c,[financialGuard(db,c.a,v),db.prepare('UPDATE workplace_requests SET status=?,version=version+1,manager_actor=?,reviewer_actor=?,updated_at=? WHERE id=?').bind(status,p.action.startsWith('manager')?a.id:r.manager_actor,p.action==='financeReject'?a.id:r.reviewer_actor,now,r.id),...event(db,c.a,r.id,p.action,{from:r.status,to:status,reason:text(p.reason,'处理依据',500)})]);return {ok:true};
}
async function registerPayment(c,r,p){
 const {db,a}=c;if(r.status!=='approved'||!financeAllowed(c,r))fail('仅授权财务可处理已批申请，不能处理本人申请或审批',403);
 const b=await books(db),source=b.balances.find(d=>d.kind==='supplier_bill'&&d.id===r.data.sourceId);if(!source||source.revision!==r.data.sourceRevision)fail('应付来源版本已变化，停止支付并核对',409);
 const ps=await payments(db,b.documents,r.id),paid=ps.reduce((s,x)=>s+(x.document?.amount_minor||0),0),allocated=ps.filter(x=>x.allocation_id).reduce((s,x)=>s+(x.document?.amount_minor||0),0),bankDate=day(p.bankDate),now=new Date().toISOString();await assertFinanceOpen(db,bankDate);await assertFinanceOpen(db,source.business_date);
 if(bankDate>now.slice(0,10)||bankDate<source.business_date||bankDate<r.business_date)fail('银行日须不早于来源业务日且不晚于今天');
 const amount=p.action==='payment'?money(p.amount):0,id=crypto.randomUUID(),key='WF-'+id,reason=text(p.reason,'登记/银行核对依据',500);
 if(p.action==='payment'){
  if(amount>r.data.amountMinor-paid)fail('分笔付款超过已批未付余额',409);
  if(source.remaining-await reserve(db,b,source.business_key,r.id)-(paid-allocated)<amount)fail('应付余额不足或已有待核对付款占用',409);
  const proof=await db.prepare('SELECT * FROM workplace_proofs WHERE id=? AND request_id=?').bind(p.proofId||'',r.id).first();if(!proof)fail('请先上传本申请的私有银行凭证');
  const account=text(p.bankAccount,'银行账户标识（不填密码）',100).toUpperCase(),reference=text(p.bankReference,'银行流水唯一号',160).toUpperCase();
  if(await db.prepare('SELECT id FROM workplace_payment_links WHERE proof_id=? OR (legal_entity=? AND bank_account=? AND bank_reference=?)').bind(proof.id,r.data.unit.legalEntity,account,reference).first())fail('银行流水或凭证已登记，不能重复',409);
  const result=await mutateFinanceLedger(db,a,{action:'document',kind:'supplier_payment',businessKey:key,revision:0,businessDate:bankDate,currency:r.data.currency,counterparty:source.counterparty,site:source.site,channel:source.channel,amount:amount/100,reference:reference,evidence:'私有凭证 '+proof.id,reason},async base=>{
   base.data={...base.data,workplaceRequestId:r.id,legalEntity:r.data.unit.legalEntity,bankDate,settlementDate:r.data.settlementDate,rate:r.data.rate};
   // Deferred foreign keys are unnecessary: insert the link after the ledger row via the hook's after list.
   return {before:[guard(c),financialGuard(db,a,b.version)],after:[db.prepare('INSERT INTO workplace_payment_links VALUES(?,?,?,?,?,?,?,?)').bind(id,r.id,base.id,proof.id,account,reference,bankDate,r.data.unit.legalEntity),db.prepare('UPDATE workplace_requests SET version=version+1,updated_at=? WHERE id=?').bind(now,r.id),...event(db,a,r.id,'payment',{documentId:base.id,proofId:proof.id,amountMinor:amount,bankDate})]};
  });return result;
 }
 const link=ps.find(x=>x.id===p.linkId);if(!link?.document||link.allocation_id)fail('付款不存在或已经核对',409);if(link.document.actor_id===a.id||r.user_id===a.id)fail('银行核对须由另一名财务完成',403);if(bankDate!==link.bank_date)fail('银行核对日期须与登记的银行日一致');
 const n=link.document.amount_minor,result=await mutateFinanceLedger(db,a,{action:'document',kind:'supplier_allocation',businessKey:key,revision:0,businessDate:bankDate,currency:r.data.currency,counterparty:source.counterparty,site:source.site,channel:source.channel,amount:n/100,cashKey:link.document.business_key,debtKey:source.business_key,evidence:'银行核对凭证 '+link.proof_id,reason},async base=>{
  base.data={...base.data,workplaceRequestId:r.id,legalEntity:r.data.unit.legalEntity};return {before:[guard(c),financialGuard(db,a,b.version)],after:[db.prepare('INSERT INTO workplace_bank_checks VALUES(?,?,?,?,?)').bind(id,link.id,base.id,a.id,now),db.prepare('UPDATE workplace_requests SET status=?,version=version+1,updated_at=? WHERE id=?').bind(allocated+n===r.data.amountMinor?'complete':'approved',now,r.id),...event(db,a,r.id,'bankCheck',{linkId:link.id,allocationId:base.id,amountMinor:n,reason})]};
 });return result;
}
export async function readExpenses(db,a,q={}){
 const c=await context(db,a),month=q.month||new Date().toISOString().slice(0,7);if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))fail('月份无效');
 const rs=(await rows(db,"SELECT r.*,u.name FROM workplace_requests r JOIN users u ON u.id=r.user_id WHERE r.kind='expense' AND (substr(business_date,1,7)=? OR r.status IN('submitted','manager_approved','approved')) ORDER BY created_at DESC",[month])).filter(r=>canRead(c,r)).map(parse),b=rs.length||c.grants.some(g=>g.user_id===a.id&&g.capability==='finance')?await books(db):{documents:[],balances:[]},result=[],summary={};
 for(const r of rs){const links=await payments(db,b.documents,r.id),paid=links.reduce((s,l)=>s+(l.document?.amount_minor||0),0),allocated=links.filter(l=>l.allocation_id).reduce((s,l)=>s+(l.document?.amount_minor||0),0);const key=JSON.stringify([r.data.unit.legalEntity,r.data.unit.site,r.data.currency]),t=summary[key]||={entity:r.data.unit.legalEntity,site:r.data.unit.site,currency:r.data.currency,approved:0,paid:0,unallocated:0,approvedCny:0,fxMissing:0,shops:[]};if(['approved','complete'].includes(r.status)){t.approved+=r.data.amountMinor;if(r.data.rate)t.approvedCny+=Math.round(r.data.amountMinor*r.data.rate.rate);else t.fxMissing++;}t.paid+=paid;t.unallocated+=paid-allocated;const shopKey=JSON.stringify([r.unit_id,r.data.channel,r.data.shop]);if(!t.shops.includes(shopKey))t.shops.push(shopKey);
  const detailAccess=r.user_id===a.id||manager(c,r.user_id,r.unit_id)||has(c,'finance',r.unit_id);if(!detailAccess)continue;
  result.push({...r,paidMinor:paid,allocatedMinor:allocated,unpaidMinor:['approved','complete'].includes(r.status)?r.data.amountMinor-paid:null,links:links.map(l=>({id:l.id,proofId:l.proof_id,bankDate:l.bank_date,amountMinor:l.document?.amount_minor??null,checked:!!l.allocation_id,canCheck:financeAllowed(c,r)&&l.document?.actor_id!==a.id&&!l.allocation_id})),canManager:r.status==='submitted'&&manager(c,r.user_id,r.unit_id),canFinance:r.status==='manager_approved'&&financeAllowed(c,r),canPay:r.status==='approved'&&financeAllowed(c,r),proofs:await rows(db,'SELECT id,filename,mime,size,created_at FROM workplace_proofs WHERE request_id=?',[r.id])});}
 const scopes=await rows(db,'SELECT * FROM workplace_bill_scopes'),bills=b.balances.filter(d=>d.kind==='supplier_bill'&&d.data.matchStatus==='matched'&&d.remaining>0&&c.units.some(u=>u.site===d.site&&has(c,'finance',u.id)&&scopes.some(s=>s.business_key===d.business_key&&s.unit_id===u.id))).map(d=>({id:d.id,key:d.business_key,site:d.site,channel:d.channel,currency:d.currency,counterparty:d.counterparty,remaining:d.remaining}));
 const visible=new Set(result.map(r=>r.id)),events=(await rows(db,'SELECT e.*,u.name actor_name FROM workplace_events e JOIN users u ON u.id=e.actor_id ORDER BY e.created_at DESC')).filter(e=>visible.has(e.entity_id));
 if(await clock(db)!==c.version||b.version&&await financeClock(db)!==b.version)fail('读取期间财务资料已变化，请刷新',409);
 return {actor:c.a,profile:c.profile||null,month,configuration:await configurationView(c),requests:result,summary:Object.values(summary).map(t=>({...t,shopCount:t.shops.length,shops:undefined,approvedCny:t.fxMissing?null:t.approvedCny})),bills,events};
}
