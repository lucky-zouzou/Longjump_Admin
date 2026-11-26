import {readFinanceHub,currencyTotals,financeCategories} from './finance-hub.mjs';

const response=(answer,month)=>({source:'ledger',intent:'live',guide:null,notice:'按当前授权范围核对财务原单，金额不经模型估算。',answer,ledger:{page:'finance-workbench',view:'expenses',month,label:'查看财务分类与原单'}});
const money=t=>t.currencies.length?t.currencies.map(x=>`${(x.amountMinor/100).toLocaleString('zh-CN',{maximumFractionDigits:2})} ${x.currency}`).join('；'):'0（当前已登记范围）';
const aliases={'中国':/中国|国内/,'印尼':/印尼|印度尼西亚/,'菲律宾':/菲律宾/,'马来西亚':/马来西亚|大马/,'泰国':/泰国/,'越南':/越南/};
export async function answerFinance(db,actor,question,now=new Date().toISOString()){
 if(!/回款|应收|应付|到账|预收|实际支出|实际付|现金支出|付哪些|哪些钱|关账|费用.*(?:归类|分类|多少)|广告.*(?:花|消耗|多少)|预算.*(?:剩|多少|执行)|客户.*(?:没付|未付|逾期|欠)|逾期.*客户/.test(question)||/怎么(?!样)|如何|按钮|入口|步骤|流程/.test(question))return null;
 if(!['管理员','财务'].includes(actor.role))return response('这类资金汇总需要财务授权。你自己的费用和广告申请可以在“我的工作”查看，跨部门的到账与应收请财务核对。');
 const requested=question.match(/(20\d{2})[-年](\d{1,2})(?:月)?/),short=question.match(/(\d{1,2})月份?/),date=new Date(Date.parse(now)+8*3600000),base=date.toISOString().slice(0,7);
 const month=requested?`${requested[1]}-${requested[2].padStart(2,'0')}`:short?`${date.getUTCFullYear()}-${short[1].padStart(2,'0')}`:/上月|上个月/.test(question)?new Date(Date.UTC(date.getUTCFullYear(),date.getUTCMonth()-1,1)).toISOString().slice(0,7):base;
 if(!/^20\d{2}-(0[1-9]|1[0-2])$/.test(month)||month>base)return response('这个月份还没发生，不能把预计资金说成实际收付款。可以问本月到账，或下周到期应付。',base);
 if(/今天|昨天|昨日|本周|上周|近\d+天|\d{1,2}月\d{1,2}[日号]|20\d{2}-\d{2}-\d{2}/.test(question)&&!/下周/.test(question))return response('财务汇总目前按月份和月末截点核对。请给我月份；具体银行日可在资金明细查看，我不会拿整月数代替某一天。',month);
 const h=await readFinanceHub(db,actor,{month,quality:/关账/.test(question)?'1':'0'}),sites=Object.keys(aliases).filter(k=>aliases[k].test(question)),channel=/TikTok|\bTK\b/i.test(question)?'TikTok':/Shopee|虾皮/i.test(question)?'Shopee':null;
 const inScope=r=>(!/平台/.test(question)||!/线下分销|国内分销/.test(r.channel||''))&&(!sites.length||sites.includes(r.site))&&(!channel||r.channel===channel)&&(!/线下/.test(question)||r.channel==='线下分销'||r.channel==='国内分销'),scopeText=sites.join('、')||h.scope;
 const intro=`${month}，截至 ${h.cutoff}；${scopeText}${channel?' / '+channel:''}${h.closed?'，已关账快照':''}。`;
 const notes=[],lines=[];
 if(/关账/.test(question)){
  if(!h.quality)return response(intro+'\n当前权限或旧快照不提供中央月结检查，请总部财务查看。',month);
  const checks=h.quality.checks.filter(x=>x.count>0);lines.push(checks.length?`还有 ${checks.filter(x=>x.blocking).length} 类关账资料待处理。`:'当前检查项没有待补事项，仍需授权人员确认关账。');lines.push(...checks.slice(0,8).map(x=>`${x.key}：${x.count} 项${x.blocking?'，关账前处理':'，结转跟进'}`));notes.push('负责人：财务核对明细，管理员确认关账。');
 }else if(/广告|预算/.test(question)){
  const budgets=(h.marketing?.budgets||[]).filter(inScope);for(const b of budgets)lines.push(`${b.site} / ${b.channel} · ${b.account}：核定预算 ${money(currencyTotals([{currency:b.currency,amountMinor:b.approvedMinor}],h.rates))}，${b.verifiedConsumedMinor==null?'消耗尚未独立核对，余额未知':`已核消耗 ${(b.verifiedConsumedMinor/100).toLocaleString()} ${b.currency}；预算未使用额 ${(b.remainingBudgetMinor/100).toLocaleString()} ${b.currency}（只扣已核消耗，核对至 ${b.verifiedThrough}）`}${b.stale?'；原消耗已修订，需要重核':''}。`);
  const source=h.adSources.filter(inScope);if(source.length)lines.push('本月渠道登记广告费（未按账户拆分）：'+money(currencyTotals(source.map(s=>({currency:s.currency,amountMinor:Math.round(s.amount*100)})),h.rates))+'。');
  if(!budgets.length)lines.push('当前范围没有可核对的已批广告账户预算，不能把缺预算当零预算。');notes.push('账户余额请看营销投入中的期初、充值、退款、消耗与期末对账。预算按整段投放期；渠道费用按所选月份，含未核部分时不能直接相减。负责人：运营提供账户归属，财务独立核对。');
 }else if(/应付|付哪些|哪些钱|下周.*付/.test(question)){
  const today=date.toISOString().slice(0,10),nextMonday=new Date(Date.UTC(date.getUTCFullYear(),date.getUTCMonth(),date.getUTCDate()+8-(date.getUTCDay()||7))).toISOString().slice(0,10),nextWeek=/下周/.test(question),limit=new Date(nextWeek?Date.parse(nextMonday)+6*86400000:date.getTime()+7*86400000).toISOString().slice(0,10),out=h.payables.filter(p=>inScope(p)&&p.amountMinor>0),due=out.filter(p=>p.dueDate&&p.dueDate<=limit&&(!nextWeek||p.dueDate>=nextMonday||p.dueDate<today)).sort((a,b)=>a.dueDate.localeCompare(b.dueDate));
  lines.push('已登记应付未核销：'+money(currencyTotals(out,h.rates))+'。');notes.push(`${nextWeek?'下周 '+nextMonday+' 至 '+limit:'到期筛选截至 '+limit}，另含已逾期；不把缺交期的单据当作可以延付。`);lines.push(...due.slice(0,8).map(p=>`${p.counterparty} · ${p.key}：${(p.amountMinor/100).toLocaleString()} ${p.currency}，${p.dueDate} 到期，${p.status==='matched'?'已核对':'仍待复核'}。`));notes.push(`${out.filter(p=>!p.dueDate).length} 笔缺到期日，暂不能判断急缓；待银行核对的已付款须先核销，不能重复支付。负责人：应付财务。`);
 }else if(/费用.*多少/.test(question)){
  if(!h.activityAvailable)notes.push('这个旧月快照没有保存完整分类发生额，不能把缺失当零。');
  else {const bills=h.categorySources.filter(inScope);for(const [category,label] of Object.entries(financeCategories)){const part=bills.filter(b=>b.category===category);if(part.length)lines.push(`${label}已核账单：${money(currencyTotals(part,h.rates))}。`);}notes.push('按所选月账单归属日分类，采购和期间费用分列；这不是现金支出，也不是净利润扣减。');}
 }else if(/归类|分类/.test(question)){
  const bills=h.payables.filter(inScope);for(const [category,label] of Object.entries(financeCategories)){const part=bills.filter(b=>b.category===category);if(part.length)lines.push(`${label}未核销：${money(currencyTotals(part,h.rates))}。`);}notes.push('这是应付余额分类，包含采购，不代表当期利润扣减。缺法人、科目的历史单据由财务按原凭据补核。');
 }else{
  const cash=h.cash.filter(inScope);if(!h.activityAvailable)notes.push('这个旧月快照没有保存中央资金发生额，无法给出完整到账/付款合计。');
  if(h.activityAvailable&&(!/应收|逾期|客户.*(?:没付|欠)/.test(question)||/到账|回款/.test(question))){
   lines.push('登记银行到账：'+money(currencyTotals(cash.filter(x=>x.kind==='receipt'),h.rates))+'。');lines.push('登记实际付款：'+money(currencyTotals(cash.filter(x=>x.kind==='payment'),h.rates))+'；客户退款：'+money(currencyTotals(cash.filter(x=>x.kind==='refund'),h.rates))+'。');if(cash.some(x=>x.kind==='correction'))notes.push('本期还有记账更正，请单独核对更正明细；它不代表重新转账。');
  }
  if((!sites.length||sites.includes('中国'))&&!channel&&h.domestic){lines.push(`国内分销期末应收 ${(h.domestic.balances.receivableMinor/100).toLocaleString()} CNY；逾期 ${h.domestic.balances.overdueOrders} 单。`);lines.push(...h.domestic.rows.filter(r=>r.overdue).slice(0,5).map(r=>`${r.customerName} · ${r.orderNo}，合同待收 ${(r.contractOutstandingMinor/100).toLocaleString()} CNY，约定 ${r.dueDate}。`));}
  if((!sites.length||sites.includes('印尼'))&&!channel&&h.offline)lines.push(`印尼线下期末应收 ${h.offline.totals.closingReceivable.toLocaleString()} IDR；未分配银行预收 ${h.bank?h.bank.totals.unallocated.toLocaleString():'旧快照未保存'}${h.bank?' IDR':''}。`);
  notes.push('负责人：财务核对银行到账及核销，责任销售跟进客户；应收与预收不跨客户抵消。');
 }
 const missing=currencyTotals(h.cash.filter(inScope),h.rates).missingRates;if(missing.length)notes.push(`缺 ${missing.join('、')} 核定汇率，暂不提供完整人民币合计。`);
 return response([lines.length?lines.join('\n'):'当前范围没有已登记的对应明细，不能据此认定实际没有发生。',intro,...notes,'依据：财务原单、银行收款子账及关账快照；仅覆盖已接入台账。'].join('\n'),month);
}
