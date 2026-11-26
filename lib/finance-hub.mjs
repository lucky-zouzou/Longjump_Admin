import {readHrHandoffs} from './hr-finance-handoff.mjs';
import {marketingFinance} from './finance-marketing.mjs';
import {ledgerDocuments,latestDocuments,ledgerBalances,createFinanceSnapshot} from './finance-ledger.mjs';
import {financeMode} from './finance-scope.mjs';
import {financeClock,financialRates,financeRows as rows} from './finance-periods.mjs';
import {context,has,fail} from './workplace-common.mjs';
import {readExpenses} from './finance-workbench.mjs';
import {claimFinanceState,claimOffsets} from './claim-finance.mjs';
import {loadWholesaleExportSnapshot} from './wholesale-export.mjs';
import {monthlyReconciliation} from './wholesale-finance.mjs';
import {wholesaleBankSnapshot} from './finance-bank-snapshot.mjs';
import {domesticFinancialSummary,domesticPaymentQueue} from './domestic-distribution.mjs';
import {marketingSampleCostSummary} from './marketing-samples.mjs';

export {financeCategories} from './finance-classification.mjs';
import {financeCategories} from './finance-classification.mjs';
const sum=(xs,key)=>xs.reduce((s,x)=>s+(x[key]||0),0);
export function currencyTotals(entries,rates){
 const by=new Map();for(const e of entries){const x=by.get(e.currency)||{currency:e.currency,amountMinor:0,count:0};x.amountMinor+=e.amountMinor;x.count++;by.set(e.currency,x);}
 const totals=[...by.values()].map(x=>({...x,cnyMinor:rates[x.currency]?Math.round(x.amountMinor*rates[x.currency].rate):null,rate:rates[x.currency]||null}));
 return {currencies:totals,cnyMinor:totals.some(x=>x.cnyMinor==null)?null:sum(totals,'cnyMinor'),missingRates:totals.filter(x=>x.cnyMinor==null).map(x=>x.currency)};
}

export async function readFinanceHub(db,actor,q={}){
 const mode=await financeMode(db,actor);if(!mode)fail('财务汇总仅供管理员及财务',403);
 const today=new Date(Date.now()+8*3600000).toISOString().slice(0,10),month=q.month||today.slice(0,7);
 if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)||month>today.slice(0,7))fail('请选择当前或过去月份');
 const end=new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5)),0)).toISOString().slice(0,10),cutoff=end<today?end:today,from=month+'-01',version=await financeClock(db);
 const [all,ratesLive,wp,scopes,c]=await Promise.all([ledgerDocuments(db),financialRates(db,month),readExpenses(db,actor,{month}),rows(db,'SELECT * FROM workplace_bill_scopes'),context(db,actor)]);
 const central=mode==='headquarters',period=central?await db.prepare('SELECT * FROM finance_period_events WHERE month=? ORDER BY revision DESC LIMIT 1').bind(month).first():null;
 const snapshot=period?.status==='closed'?JSON.parse(period.snapshot_json):null,rates=snapshot?.rates||ratesLive;
 const scopedIds=new Set((await rows(db,"SELECT r.id FROM workplace_requests r JOIN workplace_grants g ON g.unit_id=r.unit_id AND g.capability='finance' AND g.user_id=?",[actor.id])).map(r=>r.id));
 const allowed=d=>central||scopes.some(s=>s.business_key===(d.kind==='supplier_bill'?d.business_key:d.data.debtKey)&&has(c,'finance',s.unit_id))||scopedIds.has(d.data.workplaceRequestId);
 const docs=latestDocuments(all.filter(d=>d.business_date<=cutoff)).filter(d=>d.status==='active'&&allowed(d));
 const billKeys=new Set(docs.filter(d=>d.kind==='supplier_bill').map(d=>d.business_key)),offsets=claimOffsets((await claimFinanceState(db)).sources).filter(s=>s.business_date<=cutoff&&(central||billKeys.has(s.debt_key)));
 // New snapshots retain the activity source. Old snapshots explicitly lack this view.
 const activity=snapshot?(snapshot.financeActivity||null):docs.filter(d=>d.business_date>=from);
 const balances=snapshot?(snapshot.balances||[]):ledgerBalances(docs,offsets),bills=balances.filter(d=>d.kind==='supplier_bill');
 const payableRows=bills.map(d=>({id:d.id,key:d.business_key,source:'finance_documents',site:d.site,channel:d.channel,currency:d.currency,amountMinor:d.remaining,counterparty:d.counterparty,dueDate:d.data.dueDate||null,category:d.data.category||(d.data.purchaseOrderId?'factory':'unclassified'),legalEntity:d.data.legalEntity||scopes.find(s=>s.business_key===d.business_key)?.legal_entity||null,unitId:d.data.unitId||scopes.find(s=>s.business_key===d.business_key)?.unit_id||null,status:d.data.matchStatus||'unverified',billType:d.data.billType||'purchase',revision:d.revision,creatorId:d.actor_id,details:d.data,evidence:d.evidence,href:'/?page=cost-profit&view=finance'}));
 let bank=null,domestic=null,offline=null,sampleCosts=null;
 if(central){if(snapshot){bank=snapshot.bank||null;domestic=snapshot.domestic||null;offline=snapshot.offline||null;sampleCosts=snapshot.sampleCosts||null;}else{const wholesale=await loadWholesaleExportSnapshot(db,actor);bank=wholesaleBankSnapshot(wholesale,month,today);offline=monthlyReconciliation(wholesale.orders,month,today);[domestic,sampleCosts]=await Promise.all([domesticFinancialSummary(db,{month}),marketingSampleCostSummary(db,{from,to:cutoff})]);}}
 const cash=[];
 for(const d of activity||[]){if(!['supplier_payment','platform_receipt'].includes(d.kind))continue;cash.push({id:d.id,source:'finance_documents',date:d.business_date,site:d.site,channel:d.channel,currency:d.currency,amountMinor:d.amount_minor*(d.data.effect===-1?-1:1),kind:d.data.effect===-1||d.data.correctionReentry?'correction':d.kind==='supplier_payment'?'payment':'receipt',legalEntity:d.data.legalEntity||null,reference:d.data.reference,href:'/?page=cost-profit&view=finance'});}
 for(const e of bank?.cash||[])cash.push({id:e.sourceId,source:'wholesale_bank',date:e.date,site:'印尼',channel:'线下分销',currency:'IDR',amountMinor:Math.round((e.kind==='receipt'||e.kind==='receipt_void'?e.received:e.refunded)*100),kind:e.kind==='receipt_void'||e.kind==='refund_void'?'correction':e.kind==='receipt'?'receipt':'refund',legalEntity:e.legalEntity,reference:e.reference,href:'/?page=wholesale'});
 if(domestic)for(const [key,kind] of [['receiptsMinor','receipt'],['refundsMinor','refund'],['receiptReversalsMinor','correction'],['refundReversalsMinor','correction']])if(domestic.period[key])cash.push({id:'domestic-'+month+'-'+key,source:'domestic_finance_entries',date:cutoff,site:'中国',channel:'国内分销',currency:'CNY',amountMinor:domestic.period[key]*(key==='receiptReversalsMinor'?-1:1),kind,legalEntity:null,reference:month+' 国内分销分项合计',href:'/?page=domestic-distribution'});
 const allBudgets=central?(await rows(db,"SELECT * FROM workplace_requests WHERE kind='expense' AND json_extract(data_json,'$.category')='advertising' AND substr(business_date,1,7)=? AND status NOT IN ('rejected','withdrawn')",[month])).map(r=>({...r,data:JSON.parse(r.data_json)})):[];
 const budgetGroups={};for(const r of allBudgets){const key=JSON.stringify([r.data.unit.legalEntity,r.data.unit.site,r.data.channel,r.data.budget?.adAccount,r.data.currency]),g=budgetGroups[key]||={entity:r.data.unit.legalEntity,site:r.data.unit.site,channel:r.data.channel,account:r.data.budget?.adAccount||null,currency:r.data.currency,requested:0,approved:0};g.requested+=r.data.amountMinor;if(r.status==='approved')g.approved+=r.data.budget?.approvedAmountMinor||0;}
 const marketing=snapshot?(snapshot.marketing||null):await marketingFinance(db,actor,month);
 const adSources=central&&!snapshot?await rows(db,"SELECT id,version,business_date,site,channel,currency,amount FROM sales_ad_spend WHERE deleted_at IS NULL AND substr(business_date,1,7)=? ORDER BY business_date DESC",[month]):[];
 const categorySources=(activity||[]).filter(d=>d.kind==='supplier_bill'&&d.data.matchStatus==='matched').map(d=>({site:d.site,channel:d.channel,currency:d.currency,amountMinor:d.amount_minor,category:d.data.category||(d.data.purchaseOrderId?'factory':'unclassified')}));
 const categories=Object.entries(financeCategories).map(([category,label])=>({category,label,pendingReview:(activity||[]).filter(d=>d.kind==='supplier_bill'&&d.data.category===category&&d.data.matchStatus!=='matched').length,...currencyTotals((activity||[]).filter(d=>d.kind==='supplier_bill'&&d.data.matchStatus==='matched'&&(d.data.category||(d.data.purchaseOrderId?'factory':'unclassified'))===category).map(d=>({currency:d.currency,amountMinor:d.amount_minor})),rates)}));
 const quality=q.quality==='1'&&central?(snapshot?.quality||(!snapshot?(await createFinanceSnapshot(db,actor,month)).quality:null)):snapshot?.quality||null;
 if(await financeClock(db)!==version)fail('读取期间财务资料已变化，请刷新',409);
 const domesticPayments=central?await domesticPaymentQueue(db):null;
 const handoffs=await readHrHandoffs(db,actor,month);
 return {domesticPayments,handoffs,marketing,adSources,month,from,cutoff,generatedAt:new Date().toISOString(),mode,closed:!!snapshot,version,scope:central?'总部财务 · 全部已接入业务':'范围财务 · 已授权组织',rates,activityAvailable:activity!==null,cash,cashTotals:{received:currencyTotals(cash.filter(e=>e.kind==='receipt'),rates),paid:currencyTotals(cash.filter(e=>e.kind==='payment'),rates),refunded:currencyTotals(cash.filter(e=>e.kind==='refund'),rates),corrections:currencyTotals(cash.filter(e=>e.kind==='correction'),rates)},payables:payableRows,bank,domestic,offline,sampleCosts,categories,categorySources,expenses:wp.summary,budgets:central?Object.values(budgetGroups):wp.budgetSummary,queue:{...wp.queue,pageCounted:false},quality,serviceUnits:c.units.filter(u=>u.active&&(actor.role==='管理员'||has(c,'finance',u.id))),method:'按原币分组；银行收付、核销、记账更正分别列示。预算不是支出，采购不是当期费用。金额仅覆盖已接入并登记的子账。历史缺法人、到期日或科目保持待补。'};
}
