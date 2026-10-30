import {claimFinanceState,claimOffsets,mutateClaimSource} from './claim-finance.mjs';
import {purchaseInvoiceCandidates} from './finance-candidates.mjs';
import {loadWholesaleExportSnapshot} from './wholesale-export.mjs';
import {monthlyReconciliation} from './wholesale-finance.mjs';
import {atomicBatch,assertWritable,guardStatement} from './atomic.mjs';
import {fail,text,number,date,cents,fx} from './cost-profit-model.mjs';
import {financeRows as rows,financeClock,financeGuardSql,financialRates,closedFinanceMonths,assertFinanceOpen} from './finance-periods.mjs';
import {costContext} from './cost-source-context.mjs';
import {readSalesDashboard} from './sales-dashboard.mjs';
import {inventoryValuation,valuationBasis} from './finance-inventory.mjs';
export const FINANCE_KINDS={supplier_bill:'供应商应付/发票',supplier_payment:'供应商付款/预付',supplier_allocation:'供应商付款核销',platform_settlement:'平台结算账单',platform_receipt:'平台银行到账',platform_allocation:'平台到账核销',inventory_valuation:'存货批次价值核对'};
export const latestDocuments=rs=>[...rs.reduce((m,r)=>{const k=r.kind+'|'+r.business_key;if(!m.has(k)||m.get(k).revision<r.revision)m.set(k,r);return m;},new Map()).values()];
const active=rs=>latestDocuments(rs).filter(r=>r.status==='active');
const parse=r=>({...r,data:JSON.parse(r.data_json)});
export const ledgerDocuments=async db=>(await rows(db,'SELECT * FROM finance_documents ORDER BY created_at,id')).map(parse);
export async function financeAccess(db,a){if(!a||!['管理员','财务'].includes(a.role))fail('仅管理员和财务可查看资金账册',403);const live=await db.prepare('SELECT active,role FROM users WHERE id=?').bind(a.id).first();if(!live?.active||live.role!==a.role)fail('账号权限已变化',403);}
const period=m=>{if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(m)||m>new Date(Date.now()+8*3600000).toISOString().slice(0,7))fail('请选择有效月份');return m;};
const monthEnd=m=>new Date(Date.UTC(Number(m.slice(0,4)),Number(m.slice(5)),0)).toISOString().slice(0,10);
function missingSalesDates(report){const complete=new Set(report.daily.filter(d=>d.salesComplete).map(d=>d.date)),missing=[];for(let t=Date.parse(report.filters.from);t<=Date.parse(report.filters.to);t+=86400000){const d=new Date(t).toISOString().slice(0,10);if(!complete.has(d))missing.push(d);}return missing;}
const sum=(rs,key)=>rs.reduce((s,r)=>s+Number(r[key]||0),0);
const audit=(db,a,entity,action,detail)=>db.prepare('INSERT INTO audit_logs(id,action,entity_type,entity_id,detail_json,actor_id,actor_name,created_at) VALUES(?,?,?,?,?,?,?,?)').bind(crypto.randomUUID(),action,'finance_chain',entity,JSON.stringify(detail),a.id,a.name,new Date().toISOString());
async function write(db,a,version,statements){await assertWritable(db);await financeAccess(db,a);const g=financeGuardSql(version);await atomicBatch(db,[guardStatement(db,a,'finance-chain',g.sql+' AND EXISTS(SELECT 1 FROM users WHERE id=? AND active=1 AND role=?)',[...g.args,a.id,a.role]),...statements]);}
function used(doc,docs,offsets=[]){if(doc.kind.endsWith('_allocation')||doc.kind==='inventory_valuation')return 0;const field=['supplier_payment','platform_receipt'].includes(doc.kind)?'cashKey':'debtKey';return docs.filter(r=>r.kind.endsWith('_allocation')&&r.data[field]===doc.business_key&&r.kind.startsWith(doc.kind.split('_')[0])).reduce((s,r)=>s+r.amount_minor,0)+(doc.kind==='supplier_bill'?offsets.filter(s=>s.debt_key===doc.business_key).reduce((n,s)=>n+s.amount_minor,0):0);}
export function ledgerBalances(documents,offsets=[]){
 const docs=active(documents);return docs.filter(d=>!d.kind.endsWith('_allocation')&&d.kind!=='inventory_valuation').map(d=>({...d,allocated:used(d,docs,offsets),remaining:d.amount_minor-used(d,docs,offsets)}));
}
async function purchaseMatches(db){
 const [orders,items,received]=await Promise.all([rows(db,'SELECT * FROM series_purchase_orders'),rows(db,'SELECT * FROM series_purchase_order_items'),rows(db,`SELECT pi.purchase_order_id,pi.sku,SUM(li.received_qty) qty FROM transport_leg_items li JOIN transport_batch_items bi ON bi.id=li.batch_item_id JOIN series_production_order_items pr ON pr.id=bi.production_order_item_id JOIN series_purchase_order_items pi ON pi.id=pr.purchase_order_item_id GROUP BY pi.purchase_order_id,pi.sku`)]);
 return orders.map(o=>{const d=JSON.parse(o.document_json||'{}');return {id:o.id,reference:o.order_ref||o.id,supplier:o.supplier_name,document:d,approved:!!o.approval_id&&o.status!=='cancelled',items:items.filter(i=>i.purchase_order_id===o.id).map(i=>({...i,receivedQty:received.find(r=>r.purchase_order_id===o.id&&r.sku===i.sku)?.qty||0,unitPrice:d.items?.find(x=>x.sku===i.sku)?.purchasePrice??null}))};});
}
export async function readFinanceLedger(db,a,query={}){
 await financeAccess(db,a);const version=await financeClock(db),month=period(query.month||new Date().toISOString().slice(0,7));
 const [all,purchases,periods,rates,inventory,offlineSnapshot,access]=await Promise.all([ledgerDocuments(db),purchaseMatches(db),rows(db,'SELECT * FROM finance_period_events ORDER BY month,revision DESC'),financialRates(db,month),inventoryValuation(db),loadWholesaleExportSnapshot(db,a),a.role==='管理员'?rows(db,"SELECT u.id,u.name,u.role,COALESCE(c.can_read,0) can_read,COALESCE(c.can_write,0) can_write,COALESCE(c.can_review,0) can_review FROM users u LEFT JOIN cost_access c ON c.user_id=u.id WHERE u.active=1 AND u.role IN ('财务','运营','运营主管','供应链') ORDER BY u.role,u.name"):[]]);
 const claims=await claimFinanceState(db);
 const offline=monthlyReconciliation(offlineSnapshot.orders,month,new Date(Date.now()+7*3600000).toISOString().slice(0,10));
 const closed=periods.find(r=>r.month===month),snapshot=closed?.status==='closed'?JSON.parse(closed.snapshot_json):null,balances=snapshot?snapshot.balances:ledgerBalances(all.filter(d=>d.business_date<=monthEnd(month)),claimOffsets(claims.sources).filter(s=>s.business_date<=monthEnd(month)));
 if(await financeClock(db)!==version)fail('读取期间财务数据变化，请刷新',409);
 return {claims,factories:await rows(db,"SELECT id,name FROM business_partners WHERE type='supplier' AND active=1"),month,version,offline:snapshot?.offline||offline,documents:all.filter(d=>d.business_date.slice(0,7)===month),valuations:active(all).filter(d=>d.kind==='inventory_valuation'),balances,purchases:purchaseInvoiceCandidates(purchases,active(all)),rates:Object.values(rates),periods:periods.map(r=>({id:r.id,month:r.month,revision:r.revision,status:r.status,evidence:r.evidence,actor_id:r.actor_id,created_at:r.created_at})),snapshot: snapshot?{closedAt:closed.created_at,inventory:snapshot.inventory,profit:snapshot.profitSummary,quality:snapshot.quality}:null,inventory,access,method:'应付、实付、结算、到账分别登记；核销不新增现金流。余额按原币独立统计，凭据与修订留痕。库存为当前时点，已关账库存单独保留。'};
}
export async function mutateFinanceLedger(db,a,p){
 await financeAccess(db,a);if(['claimSource','voidClaimSource'].includes(p.action))return mutateClaimSource(db,a,p);const version=await financeClock(db),offsets=claimOffsets((await claimFinanceState(db)).sources),now=new Date().toISOString(),id=crypto.randomUUID();
 if(p.action==='access'){
  if(a.role!=='管理员')fail('仅管理员可配置成本权限',403);const u=await db.prepare('SELECT * FROM users WHERE id=? AND active=1').bind(p.userId).first();if(!u||!['财务','运营','运营主管','供应链'].includes(u.role))fail('该岗位不开放成本权限');
  const read=p.canRead===true?1:0,canWrite=read&&p.canWrite===true?1:0,review=read&&u.role==='财务'&&p.canReview===true?1:0;
  await write(db,a,version,[db.prepare('INSERT INTO cost_access(user_id,can_read,can_write,can_review) VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET can_read=excluded.can_read,can_write=excluded.can_write,can_review=excluded.can_review').bind(u.id,read,canWrite,review),audit(db,a,u.id,'finance.access',{read,canWrite,review,reason:text(p.reason,'授权依据')})]);return {ok:true};
 }
 if(p.action==='rate'){
  const month=period(p.month);await assertFinanceOpen(db,month+'-01');const rate=fx({currency:p.currency,fx:p.rate,fxVersion:month});const previous=(await financialRates(db,month))[rate.currency];if(rate.currency==='CNY')fail('人民币固定为1，无需登记');if(Number(p.revision)!==(previous?.revision||0))fail('汇率版本已变化',409);
  await write(db,a,version,[db.prepare('INSERT INTO finance_rates VALUES(?,?,?,?,?,?,?,?)').bind(id,month,rate.currency,(previous?.revision||0)+1,rate.fx,text(p.evidence,'财务汇率凭据/核定依据',1000),a.id,now),audit(db,a,id,'finance.rate',{month,currency:rate.currency,rate:rate.fx})]);return {ok:true};
 }
 if(['close','reopen'].includes(p.action)){
  if(a.role!=='管理员')fail('关账及反关账由管理员确认',403);const month=period(p.month),events=await rows(db,'SELECT * FROM finance_period_events ORDER BY revision DESC'),previous=events.find(e=>e.month===month),closed=await closedFinanceMonths(db);
  if(Number(p.revision)!==(previous?.revision||0))fail('期间版本已变化',409);if(p.action==='close'&&previous?.status==='closed'||p.action==='reopen'&&previous?.status!=='closed')fail('期间状态已变化',409);
  if(closed.some(r=>r.month>month))fail('请从最新已关账月份开始反关账；不能跨过后续已关账月份',409);
  if(p.action==='close'&&month>=now.slice(0,7))fail('月份未结束，不能关账');const evidence=text(p.evidence,'关账/反关账依据',1000);
  const snapshot=p.action==='close'?await createFinanceSnapshot(db,a,month):{};
  await write(db,a,version,[db.prepare('INSERT INTO finance_period_events VALUES(?,?,?,?,?,?,?,?)').bind(id,month,(previous?.revision||0)+1,p.action==='close'?'closed':'open',JSON.stringify(snapshot),evidence,a.id,now),audit(db,a,id,'finance.'+p.action,{month,evidence,version})]);return {ok:true};
 }
 if(p.action!=='document')fail('不支持的财务动作');const kind=text(p.kind,'单据类型');if(!Object.hasOwn(FINANCE_KINDS,kind))fail('单据类型无效');
 const key=text(p.businessKey,'唯一单据编号',120),dateValue=date(p.businessDate);await assertFinanceOpen(db,dateValue);if(dateValue>new Date(Date.now()+8*3600000).toISOString().slice(0,10))fail('经营日期不能晚于今天');
 const all=await ledgerDocuments(db),current=latestDocuments(all),docs=active(all),old=current.find(d=>d.kind===kind&&d.business_key===key);if(Number(p.revision)!==(old?.revision||0))fail('单据已存在或版本已变化',409);
 if(old){if(kind==='inventory_valuation'){if(dateValue<old.business_date)fail('库存价值续记日期不得早于上次核对');}else{await assertFinanceOpen(db,old.business_date);if(old.business_date!==dateValue)fail('修订保留原业务日期');}if(used(old,docs,offsets)>0)fail('单据已核销；请先作废关联核销，再修订或作废原单',409);}
 const status=p.status==='void'?'void':'active';if(status==='void'&&!old)fail('没有可作废的原单');
 const currency=fx({currency:p.currency,fx:p.currency==='CNY'?1:1,fxVersion:'币种校验'}).currency;
 const base={id,kind,business_key:key,revision:(old?.revision||0)+1,business_date:dateValue,counterparty:text(p.counterparty,'供应商/平台主体'),site:text(p.site,'站点',50,true),channel:text(p.channel,'渠道',50,true),currency,amount_minor:cents(number(p.amount,'原币金额')),status,data:{},evidence:text(p.evidence,'凭据文件编号/存放地址',1000),reason:text(p.reason,'登记或修订原因',1000),actor_id:a.id,created_at:now};
 if(old&&(currency!==old.currency||base.counterparty!==old.counterparty||base.site!==old.site||base.channel!==old.channel))fail('修订不能更改币种、交易主体和站点渠道；应作废后新建');
 if(status==='void'){base.data=old.data;base.amount_minor=old.amount_minor;}
 else if(kind==='inventory_valuation'){
  if(currency!=='CNY')fail('存货价值统一以人民币核算');const inventory=await inventoryValuation(db),row=inventory.rows.find(r=>r.site===base.site&&r.channel===base.channel&&r.sku===p.sku);if(!row||row.anomalies.length||row.totalQty<=0)fail('请先核对有效的实物库存');
  if(docs.some(d=>d.kind===kind&&d.business_key!==key&&d.site===base.site&&d.channel===base.channel&&d.data.sku===p.sku))fail('该站点渠道SKU已有估值，请修订原核对记录');
  const context=await costContext(db);if(!Array.isArray(p.lots)||!p.lots.length||p.lots.length>200)fail('请选择实物对应的成本批次与数量');const selected=[],seen=new Set();let total=0,qty=0;
  base.data.lots=p.lots.map(x=>{const lot=context.state.lots.find(l=>l.ticket.business_key===x.ticketKey&&l.lineKey===x.lineKey);const key=x.ticketKey+'|'+x.lineKey;if(!lot||lot.sku!==p.sku||lot.ticket.site!==base.site||!lot.ticket.reviewed_at||lot.estimated||lot.missing.length||seen.has(key))fail('批次必须为同站点SKU的已复核实际成本，且不能重复');seen.add(key);const n=number(x.qty,'批次对应数量',{integer:true,min:1});const allocations=docs.filter(d=>d.kind==='inventory_valuation'&&d.business_key!==base.business_key).flatMap(d=>d.data.lots||[]).filter(l=>l.ticketKey===x.ticketKey&&l.lineKey===x.lineKey),others=allocations.reduce((s,l)=>s+l.qty,0),otherValue=allocations.reduce((s,l)=>s+l.valueMinor,0),remainingValue=Object.values(lot.remaining).reduce((s,v)=>s+v,0);if(n+others>lot.remainingQty)fail('各库存核对累计对应数量超过成本批次未售余额');if(allocations.some(l=>l.costId!==lot.ticket.id)||otherValue>remainingValue)fail('其他存货核对仍引用旧成本，请先修订或作废原核对记录');const value=n+others===lot.remainingQty?remainingValue-otherValue:Math.min(Math.round(remainingValue*n/lot.remainingQty),remainingValue-otherValue);total+=value;qty+=n;selected.push(lot);return {ticketKey:x.ticketKey,lineKey:x.lineKey,qty:n,valueMinor:value,costId:lot.ticket.id};});
  if(qty!==row.totalQty)fail('实物六类库存数量必须与批次对应数量完全一致');if(!Number.isSafeInteger(total)||total>1e13)fail('存货金额超过安全范围');base.amount_minor=total;base.data={...base.data,sku:p.sku,buckets:row.buckets,basis:valuationBasis(row,selected),method:'财务凭据核对批次，不自动调整库存'};
 }else if(kind.endsWith('_allocation')){
  const supplier=kind==='supplier_allocation',cashKind=supplier?'supplier_payment':'platform_receipt',debtKind=supplier?'supplier_bill':'platform_settlement';
  const cash=docs.find(d=>d.kind===cashKind&&d.business_key===p.cashKey),debt=docs.find(d=>d.kind===debtKind&&d.business_key===p.debtKey);
  if(!cash||!debt)fail('请选择有效的资金单和应付/结算单');if([cash,debt].some(d=>d.currency!==currency||d.counterparty!==base.counterparty||d.site!==base.site||d.channel!==base.channel||d.business_date>dateValue))fail('核销须同币种、主体、站点及渠道，日期不得早于来源单据');
  const other=docs.filter(d=>!(d.kind===kind&&d.business_key===key));if(base.amount_minor<=0||[cash,debt].some(d=>used(d,other,offsets)+base.amount_minor>d.amount_minor))fail('核销金额超过未核销余额',409);base.data={cashKey:cash.business_key,debtKey:debt.business_key,cashVersion:cash.revision,debtVersion:debt.revision};
 }else{
  const reference=text(p.reference,'发票/银行流水/平台账单唯一编号',160);if(docs.some(d=>d.kind===kind&&d.business_key!==key&&d.data.reference===reference&&d.counterparty===base.counterparty&&d.currency===currency))fail('同一凭据已登记，不能更换单号重复记账',409);base.data={reference};
  if(kind==='supplier_bill'){
   const po=(await purchaseMatches(db)).find(o=>o.id===p.purchaseOrderId);if(!po?.approved||po.supplier!==base.counterparty)fail('须关联对应供应商已审批的采购订单');if(po.document.currency!==currency)fail('发票币种与已批采购单不符');
   if(!Array.isArray(p.lines)||!p.lines.length||p.lines.length>200)fail('请逐行登记发票SKU、数量和不含税单价');const seen=new Set();let subtotal=0;
   base.data.lines=p.lines.map(l=>{const sku=text(l.sku,'SKU'),i=po.items.find(x=>x.sku===sku);if(!i||seen.has(sku))fail('SKU不属于采购单或重复');seen.add(sku);const qty=number(l.qty,'发票数量',{integer:true,min:1}),price=cents(number(l.unitPrice,'不含税单价'));const billed=docs.filter(d=>d.kind==='supplier_bill'&&d.business_key!==key&&d.data.purchaseOrderId===po.id).flatMap(d=>d.data.lines).filter(x=>x.sku===sku).reduce((n,x)=>n+x.qty,0);if(billed+qty>i.ordered_qty)fail('累计发票数量超过已批采购数量');subtotal+=qty*price;return {sku,qty,unitPriceMinor:price,receivedQty:i.receivedQty,poQty:i.ordered_qty,poPriceMinor:i.unitPrice==null?null:cents(i.unitPrice),priceMatches:i.unitPrice!=null&&price===cents(i.unitPrice),receiptMatches:billed+qty<=i.receivedQty};});
   base.data.taxMinor=cents(number(p.taxAmount,'发票税额'));if(base.amount_minor!==subtotal+base.data.taxMinor)fail('应付总额须等于明细不含税金额加税额');base.data.purchaseOrderId=po.id;base.data.purchaseReference=po.reference;
   base.data.expectedTaxMinor=po.document.taxRate==null||po.document.taxRate===''?null:Math.round(subtotal*Number(po.document.taxRate)/100);base.data.taxMatches=base.data.expectedTaxMinor===base.data.taxMinor;
   base.data.matchStatus=base.data.taxMatches&&base.data.lines.every(l=>l.priceMatches&&l.receiptMatches)?'matched':'exception';base.data.exceptionReason=base.data.matchStatus==='exception'?text(p.exceptionReason,'采购价/收货差异说明',1000):'';
  }
  if(kind==='platform_settlement'){
   if(!['印尼','马来西亚','泰国','越南','菲律宾'].includes(base.site)||!['TikTok','Shopee'].includes(base.channel))fail('平台结算须指定站点及渠道');
   const from=date(p.from),to=date(p.to);if(from>to||to>dateValue)fail('结算起止日期无效');
   if(docs.some(d=>d.kind===kind&&d.business_key!==key&&d.site===base.site&&d.channel===base.channel&&d.currency===currency&&d.data.from<=to&&d.data.to>=from))fail('该范围已有结算单，重叠账期请修订原单，不得重复登记',409);
   const gross=cents(number(p.gross,'平台销售总额')),refunds=cents(number(p.refunds,'平台退款')),fees=cents(number(p.fees,'平台及履约扣费')),adjustment=cents(number(p.adjustment,'其他扣款'));
   if(gross-refunds-fees-adjustment!==base.amount_minor)fail('待到账净额须等于总销售减退款、费用及其他扣款');
   const report=await readSalesDashboard(db,{...a,role:'管理员'},{from,to,site:base.site,channel:base.channel}),r=report.currencies.find(r=>r.currency===currency);const sourceRevenue=r?.revenueMissing?null:r?.revenue??null;
   base.data={...base.data,from,to,gross,refunds,fees,adjustment,sourceRevenueMinor:sourceRevenue==null?null:cents(sourceRevenue),difference:sourceRevenue==null?null:gross-cents(sourceRevenue),missingDates:missingSalesDates(report),reconciliationNote:text(p.reconciliationNote,'平台账单与销售、退款及费用核对说明',1000)};
  }
 }
 if(base.amount_minor<=0&&!['platform_settlement'].includes(kind)&&status==='active')fail('金额须大于0');
 await write(db,a,version,[db.prepare('INSERT INTO finance_documents VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(base.id,base.kind,base.business_key,base.revision,base.business_date,base.counterparty,base.site,base.channel,base.currency,base.amount_minor,base.status,JSON.stringify(base.data),base.evidence,base.reason,base.actor_id,base.created_at),audit(db,a,id,'finance.document',{kind,key,revision:base.revision,status,reason:base.reason})]);return {ok:true,id};
}
export async function createFinanceSnapshot(db,a,month){
 const [report,all,context,inventory,rates]=await Promise.all([readSalesDashboard(db,a,{from:month+'-01',to:monthEnd(month)}),ledgerDocuments(db),costContext(db),inventoryValuation(db),financialRates(db,month)]);
 const claims=await claimFinanceState(db),offlineSnapshot=await loadWholesaleExportSnapshot(db,a);
 const currencies=new Set([...report.scopes.map(r=>r.currency),...claims.sources.filter(s=>!s.voided&&s.business_date<=monthEnd(month)).map(s=>s.currency),...active(all).filter(d=>d.business_date<=monthEnd(month)).map(d=>d.currency)]);if([...currencies].some(c=>!rates[c]))fail('请先核定本月所有有金额币种的财务汇率');
 const orders=context.state.orders.filter(o=>o.business_date.slice(0,7)===month),known=orders.filter(o=>o.contribution!=null),uncovered=context.sales.filter(s=>s.business_date.slice(0,7)===month&&!s.reversed_at&&s.qty>(context.state.usedSales.get(s.id)||0));
 return {month,claims,offline:monthlyReconciliation(offlineSnapshot.orders,month,new Date(Date.now()+7*3600000).toISOString().slice(0,10)),createdAt:new Date().toISOString(),balances:ledgerBalances(all.filter(d=>d.business_date<=monthEnd(month)),claimOffsets(claims.sources).filter(s=>s.business_date<=monthEnd(month))),salesDays:report.dayScopes,rates,orders,sales:context.sales.filter(s=>s.business_date.slice(0,7)===month),inventory,profitSummary:{confirmed:sum(known.filter(o=>!o.estimated),'contribution'),estimated:sum(known.filter(o=>o.estimated),'contribution'),pending:orders.length-known.length},quality:{uncoveredSales:uncovered.length,missingSalesDays:missingSalesDates(report),note:'快照保留已知与待核实部分；贡献不是净利润，库存为关账操作时点，非追溯月末盘点'}};
}
