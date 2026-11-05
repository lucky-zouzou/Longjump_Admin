import {localDay,ownerOn,dates,round} from './clearance-model.mjs';
import {shiftDay} from './promotion-model.mjs';

export const clearanceDuties={
  '运营':{title:'运营执行',description:'申请促销、补齐日报、记录动作、七天复盘'},
  '财务':{title:'财务核算',description:'核价与支持、只补新增或变更费用、跟踪损益'},
  '管理员':{title:'管理督办',description:'批准计划、检查库存异常、督办逾期事项'}
};

// Derived from the same read snapshot as inventory, daily sales and finance.
// Stable task keys follow an existing plan; reading never creates another plan,
// stock movement, cost entry or automatic platform operation.
export function clearanceOversight(r,now=new Date()){
  const today=localDay(now,r.site),yesterday=shiftDay(today,-1),ownerId=ownerOn(r,r.events,today),tasks=[];
  const add=(code,role,title,detail,due,priority=2)=>tasks.push({id:`${r.id}:${code}`,code,role,ownerId:role==='运营'?ownerId:null,title,detail,due,priority,overdue:!!due&&due<today});
  const f=r.data.finance,p=r.progress,s=r.summary,ended=!!r.ended_on,open=r.status==='active';
  const finished=p.daily.filter(d=>d.date<=yesterday),missing=finished.filter(d=>d.status!=='complete').map(d=>d.date);
  // A missing sales/amount basis goes to operations first, not to finance as a
  // request to confirm an invented zero. Already confirmed days stay untouched.
  const salesGaps=[...new Set([...missing,...s.missingSales])].sort();
  const financeGaps=r.days.filter(d=>d.revenue!=null&&d.status!=='confirmed').map(d=>d.date).sort();
  const reviews=r.windows.filter(w=>w.ready&&(!w.review||w.review.stale));
  const budgetExceeded=!!f&&s.knownSupportSpend>f.supportBudget;
  const lossExceeded=!!f&&s.netLoss!=null&&s.netLoss>f.lossLimit;
  const lastAction=[...r.events].reverse().find(e=>e.action==='start'||e.action==='log'&&e.detail.kind!=='support');
  const lastSupport=[...r.events].reverse().find(e=>e.action==='log'&&e.detail.kind==='support');
  if(r.status==='draft')add('submit','运营','完善清仓方案并送财务','核对促销价、目标数量与拟执行动作。',r.data.start);
  if(r.status==='finance_review')add('finance','财务','核定促销价与支持预算','核对真实到仓成本、售价底线、支持预算及可接受亏损。',r.data.start);
  if(r.status==='admin_review')add('approve','管理员','审批清仓方案','核对负责人、财务核价及执行期间后批准。',r.data.start);
  if(r.status==='approved'){
    if(r.data.end<today)add('expired','管理员','撤回过期未执行计划','计划已过执行期；取消后重新安排，不能补填已执行。',r.data.end,1);
    else if(r.data.start<=today)add('start','运营','登记平台执行，开始跟踪','在平台完成操作后登记实际售价与凭据。',r.data.start,1);
  }
  const needsReopen=r.status==='completed'&&(s.profit==null||reviews.length>0||!p.stockMatched);
  if(open||needsReopen){
    if(!p.stockMatched||p.overlapDays.length||r.stock.available==null)add('inventory','管理员','核对日报与库存异常','按日期、批次核对销量、扣库及当前库存；不要再次扣库。',today,0);
    if(salesGaps.length)add('sales','运营',`补齐 ${salesGaps.length} 天销售依据`,`缺报、部分日报或金额不全：${salesGaps.join('、')}。`,shiftDay(salesGaps[0],1),1);
    if(financeGaps.length)add('cost','财务',`核清 ${financeGaps.length} 天新增／变更费用`,`仅处理 ${financeGaps.join('、')}；其余已核清日期继续复用。`,shiftDay(financeGaps[0],1),1);
    if(r.days.length&&!r.rate)add('rate','财务','核定本月人民币汇率','原币核算保留，汇率缺失时不汇总人民币损益。',today,1);
    if(open&&(budgetExceeded||lossExceeded)){
      const detail=[budgetExceeded?`已核实支持消耗 ${round(s.knownSupportSpend)} > 预算 ${f.supportBudget}`:'',lossExceeded?`实际净亏损 ${round(s.netLoss)} > 上限 ${f.lossLimit}`:''].filter(Boolean).join('；')+`（${r.currency}）。`;
      add('risk','财务','复核超限并记录处理意见',detail,today,0);
      if(!ended)add('stop-risk','运营','停止追加优惠并登记凭据','已触发财务边界，联系财务及管理员复审；系统不会自动改价。',today,0);
    }
    if(open&&!ended&&!tasks.some(t=>t.code==='stop-risk')){
      if(r.data.end<today)add('stop','运营','计划已到期，登记停止优惠','停止平台活动后记录凭据，再核清费用及复盘。',r.data.end,1);
      else if(r.stock.available===0)add('stop','运营','可售库存已用尽，核对平台优惠','核对预留与实际可售；停止继续促销并保留凭据。',today,1);
    }
    if(reviews.length){
      const w=reviews[0],days=p.daily.filter(d=>d.date>=w.from&&d.date<=w.to),zero=dates(w.from,w.to).length===7&&days.length===7&&days.every(d=>d.status==='complete'&&d.stockMatched&&d.qty===0)&&r.stock.available>0;
      add('review','运营',zero?'7天仍无销量，调整动作并复盘':dates(w.from,w.to).length===7?'完成七天效果复盘':'完成期末效果复盘',`${w.from} 至 ${w.to}；${w.review?.stale?'原复盘依据已变化，重新核对。':zero?'先核对期间是否缺货，再区分流量、转化、价格和品质，不直接一律降价。':'对照销量、余货和损益记录下一步。'}`,shiftDay(w.to,1),1);
    }
    if(needsReopen)add('reopen','财务','结案依据变化，重新核算复盘','原记录继续保留，修订费用后重新确认结案。',today,1);
    if(open&&ended&&r.ended_on<today&&s.profit!=null&&p.stockMatched&&!p.overlapDays.length&&r.stock.available!=null&&r.windows.every(w=>w.ready&&w.review&&!w.review.stale))add('close','财务','核对结果并结案','已停止优惠、费用已核清、复盘有效；库存剩余仍持续可见。',shiftDay(r.ended_on,1));
  }
  tasks.sort(compareClearanceTasks);
  const opening=r.data.opening?.available;
  return {today,ownerId,tasks,salesGaps,financeGaps,reviewPending:reviews.length,
    nextReview:r.windows.find(w=>!w.review||w.review.stale)?.to||null,
    lastAction:lastAction?{date:lastAction.business_date,actorId:lastAction.actor_id,kind:lastAction.detail.kind||'start',note:lastAction.detail.note||''}:null,
    lastSupport:lastSupport?{date:lastSupport.business_date,actorId:lastSupport.actor_id,note:lastSupport.detail.note||''}:null,
    openingAvailable:opening??null,inventoryChange:opening!=null&&r.stock.available!=null?r.stock.available-opening:null,
    outcome:!r.started_on?'not_started':!p.stockMatched||p.overlapDays.length?'verify':p.qty>0?'sales_observed':!finished.length||salesGaps.length?'pending':'no_sales',
    budgetExceeded,lossExceeded};
}

export function compareClearanceTasks(a,b){return a.priority-b.priority||Number(b.overdue)-Number(a.overdue)||(a.due||'9999').localeCompare(b.due||'9999')||a.id.localeCompare(b.id);}
export function clearanceTaskForActor(task,actor){return ['管理员','运营主管'].includes(actor.role)||actor.role===task.role&&(task.role!=='运营'||task.ownerId===actor.id);}
