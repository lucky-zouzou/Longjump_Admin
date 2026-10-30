import {atomicBatch,assertWritable,guardStatement} from './atomic.mjs';
import {financeClock,financeGuardSql,assertFinanceOpen} from './finance-periods.mjs';
import {SALES_CURRENCIES} from './sales-data.mjs';
import {validDay,localDay} from './promotion-model.mjs';
const rows=async(db,sql,args=[])=>(await db.prepare(sql).bind(...args).all()).results||[];
const fail=(m,status=400)=>{throw Object.assign(new Error(m),{status});};
const text=(v,label)=>{const s=String(v||'').trim();if(s.length<4||s.length>1500)fail(`请填写${label}（至少4字）`);return s;};
const amount=v=>{if(v==null||!/^\d+(\.\d{1,2})?$/.test(String(v)))fail('请填写正数原币金额，最多两位小数');const n=Math.round(Number(v)*100);if(!Number.isSafeInteger(n)||n<=0||n>1e13)fail('金额无效');return n;};
export async function claimFinanceState(db){
 const [sources,allocations,reversals]=await Promise.all([rows(db,'SELECT s.*,p.name factory_name FROM finance_claim_sources s JOIN business_partners p ON p.id=s.factory_id'),rows(db,'SELECT * FROM finance_claim_allocations'),rows(db,'SELECT * FROM finance_claim_reversals')]);
 const activeAllocations=allocations.filter(a=>!reversals.some(r=>r.allocation_id===a.id));
 return {sources:sources.map(s=>{const voided=reversals.some(r=>r.source_id===s.id),allocated=activeAllocations.filter(a=>a.source_id===s.id).reduce((n,a)=>n+a.amount_minor,0);return {...s,voided,allocated,remaining:voided?0:s.amount_minor-allocated};}),allocations,reversals,activeAllocations};
}
export const claimOffsets=sources=>sources.filter(s=>!s.voided&&s.kind==='offset');
export function claimWriteGuard(db,a,version){const g=financeGuardSql(version);return guardStatement(db,a,'finance.claim',g.sql+" AND EXISTS(SELECT 1 FROM users WHERE id=? AND active=1 AND role='财务')",[...g.args,a.id]);}
export async function mutateClaimSource(db,a,p){
 if(a.role!=='财务'||!await db.prepare("SELECT 1 FROM users WHERE id=? AND role='财务' AND active=1").bind(a.id).first())fail('由财务核验赔偿到账或货款抵扣',403);
 await assertWritable(db);const version=await financeClock(db),state=await claimFinanceState(db),date=p.businessDate;
 if(!validDay(date)||date>localDay(new Date(),'马来西亚'))fail('请填写已发生的有效财务日期');await assertFinanceOpen(db,date);
 const evidence=text(p.evidence,'银行/抵扣原凭据与核对说明'),at=new Date().toISOString(),id=crypto.randomUUID();let statement;
 if(p.action==='voidClaimSource'){
  const s=state.sources.find(s=>s.id===p.id&&!s.voided);if(!s||s.allocated)fail('请先冲销相关赔偿分配，再作废资金来源',409);await assertFinanceOpen(db,s.business_date);if(date<s.business_date)fail('冲销日期不能早于原凭据');
  statement=db.prepare('INSERT INTO finance_claim_reversals VALUES(?,NULL,?,?,?,?,?)').bind(id,s.id,date,evidence,a.id,at);
 }else{
  if(!['cash','offset'].includes(p.kind))fail('请选择实际到账或应付货款抵扣');const factory=await db.prepare("SELECT * FROM business_partners WHERE id=? AND type='supplier' AND active=1").bind(p.factoryId||'').first();if(!factory)fail('请选择核实后的工厂主体');
  if(!SALES_CURRENCIES.includes(p.currency))fail('币种无效');const n=amount(p.amount),reference=text(p.reference,'唯一银行流水/抵扣凭据编号');
  if(state.sources.some(s=>!s.voided&&s.currency===p.currency&&s.reference===reference))fail('同一原币凭据已登记，请使用已有来源余额分配',409);
  let debt=null;
  if(p.kind==='offset'){
   const bill=await db.prepare("SELECT * FROM finance_documents WHERE kind='supplier_bill' AND business_key=? ORDER BY revision DESC LIMIT 1").bind(p.debtKey||'').first();if(!bill||bill.status!=='active'||bill.currency!==p.currency||bill.business_date>date)fail('请选择同币种、已登记且日期不晚于本次的供应商应付单');
   const aliases=await rows(db,'SELECT alias FROM quality_factory_aliases WHERE factory_id=?',[factory.id]);if(bill.counterparty!==factory.name&&!aliases.some(x=>x.alias===bill.counterparty))fail('应付主体与核实工厂不一致，先核实别名');
   const allocated=await db.prepare("SELECT COALESCE(SUM(amount_minor),0) n FROM finance_documents d WHERE kind='supplier_allocation' AND status='active' AND revision=(SELECT MAX(x.revision) FROM finance_documents x WHERE x.kind=d.kind AND x.business_key=d.business_key) AND json_extract(data_json,'$.debtKey')=?").bind(bill.business_key).first();
   const offsets=claimOffsets(state.sources).filter(s=>s.debt_key===bill.business_key).reduce((n,s)=>n+s.amount_minor,0);if(n+allocated.n+offsets>bill.amount_minor)fail('抵扣超过应付未核销余额',409);await assertFinanceOpen(db,bill.business_date);debt=bill.business_key;
  }
  statement=db.prepare('INSERT INTO finance_claim_sources VALUES(?,?,?,?,?,?,?,?,?,?,?)').bind(id,p.kind,factory.id,p.currency,n,date,reference,debt,evidence,a.id,at);
 }
 await atomicBatch(db,[claimWriteGuard(db,a,version),statement,db.prepare('INSERT INTO audit_logs(id,action,entity_type,entity_id,detail_json,actor_id,actor_name,created_at) VALUES(?,?,?,?,?,?,?,?)').bind(crypto.randomUUID(),'finance.'+p.action,'claim_source',id,JSON.stringify({evidence,date}),a.id,a.name,at)]);return {ok:true,id};
}
