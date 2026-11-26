import {HISTORY_SITES,HISTORY_CHANNELS,readReplenishmentHistory} from './replenishment-history.mjs';
import {localDay,shiftDay,validDay} from './promotion-model.mjs';
import {canReadDomain} from './permissions.mjs';
import {productionStageLabel} from './production-workflow.mjs';
import {transportSteps} from './transport-workflow.mjs';

const approvalLabels={pending:'待管理员审批',approved:'已批准',withdrawn:'已撤回',rejected:'已驳回'};
const stageNames=new Map([...transportSteps,['channel_allocation','待海运交接'],['voided','已关联历史到仓处理']]);
const sentStages=new Set(transportSteps.slice(1).map(([stage])=>stage).filter(stage=>stage!=='voided'));
const parseList=value=>JSON.parse(value||'[]');
const fmt=value=>Number(value).toLocaleString('zh-CN');
const units=value=>fmt(value)+' 件';
const statusWords=/到哪|哪一步|哪个环节|进度|进展|情况|啥情况|怎么样|多少|几件|几单|几批|何时|什么时候|几号|哪天|多久|到了?没|发了?没|好了吗|到货|到仓|交期|ETA|审批了?吗|批了?没|开工了?没|发货了吗|发出去了吗|排产了吗|完工了吗/i;
const subject=/备货|补货|月度计划|月计划|生产单|工厂单|这批货/;
const numericMonth=/20\d\d年|20\d\d[-/]|\d{1,2}月|本月|这月|这个月|上个?月|下个?月/;
const shortFollow=/^(?:那|那么|再|只看|换成|换|看一下|看)?(?:菲律宾|印尼|泰国|越南|马来西亚|大马|马来|TK|TikTok|Shopee|虾皮|双平台|两个平台|全部平台|本月|上个?月|下个?月|\d{1,2}月份?)(?:的)?[呢呢啊呀吗？?。\s]*$/i;
const base=(answer,extra={})=>({answer,source:'ledger',intent:'live',guide:null,notice:'',...extra});
export function validPlanContext(c){
  return !!c&&typeof c==='object'&&/^20\d{2}-(0[1-9]|1[0-2])$/.test(c.month)&&
    typeof c.month==='string'&&(c.site===''||HISTORY_SITES.includes(c.site))&&(c.channel===''||HISTORY_CHANNELS.includes(c.channel));
}
function planMonth(q,now,previous){
  const current=localDay(now,'马来西亚').slice(0,7);
  if(/季度|上周|本周|下周|同比|环比|[至到~～—]\s*\d{1,2}月|前年|上上月|上上个月/.test(q))return null;
  const dates=[...q.matchAll(/(20\d{2})[-/年](\d{1,2})(?:月份?)?|(\d{1,2})月份?/g)];
  if(dates.length>1||/20\d\d[-/]\d{1,2}[-/]\d|\d+月\d+[日号]/.test(q))return null;
  if(dates.length){
    const [,y,ym,standalone]=dates[0],m=ym||standalone,year=Number(y||current.slice(0,4))+(!y&&q.includes('去年')?-1:!y&&q.includes('明年')?1:0);
    return +m>=1&&+m<=12?year+'-'+m.padStart(2,'0'):null;
  }
  if(/年|月份对比/.test(q))return null;
  if(/上个?月|下个?月/.test(q)){
    const d=new Date(current+'-01T00:00:00Z');d.setUTCMonth(d.getUTCMonth()+(q.includes('下')?1:-1));return d.toISOString().slice(0,7);
  }
  return /本月|这个月|这月/.test(q)?current:previous||current;
}

// Resolve document lineage through the approved plan (including approved amendments).
// Shipping and receipt dates can fall outside the plan month.
const lineage=`WITH base AS (SELECT id FROM approval_requests WHERE type='monthly_plan' AND month=? AND status='approved'),
 orders AS (SELECT o.* FROM series_production_orders o JOIN series_purchase_orders p ON p.id=o.purchase_order_id
 WHERE o.status!='cancelled' AND p.status!='cancelled' AND (p.approval_id IN (SELECT id FROM base)
 OR p.approval_id IN (SELECT id FROM plan_changes WHERE status='approved' AND approval_id IN (SELECT id FROM base)))),
 lines AS (SELECT i.* FROM series_production_order_items i JOIN orders o ON o.id=i.production_order_id) `;
async function fulfillmentFacts(db,month,site,channel,today){
  const query=async sql=>(await db.prepare(lineage+sql).bind(month).all()).results;
  const [items,legs,legacy,receipts,packed,policies]=await Promise.all([
    query(`SELECT i.id,i.sku,i.produced_qty,o.id orderId,o.status,o.qc_status,o.series_name,o.promised_completion_date,s.sea_lead_days,
      COALESCE(i.dispatch_allocations_json,p.allocations_json) allocations FROM lines i
      JOIN orders o ON o.id=i.production_order_id JOIN series_purchase_order_items p ON p.id=i.purchase_order_item_id LEFT JOIN sku_settings s ON s.sku=i.sku`),
    query(`SELECT l.leg_no ref,l.stage,l.site,l.channel,l.eta,li.qty,li.received_qty received,
      v.reason voidReason,v.discrepancy_reason discrepancyReason,v.created_at voidedAt,v.history_json voidHistory,
      CASE WHEN l.stage='voided' THEN json_extract(v.original_json,'$.leg.stage') ELSE l.stage END originalStage,
      EXISTS(SELECT 1 FROM factory_dispatch_notices n WHERE n.transport_batch_id=l.batch_id AND n.production_order_id=i.production_order_id AND n.status='linked') linked
      FROM lines i JOIN transport_batch_items bi ON bi.production_order_item_id=i.id
      JOIN transport_leg_items li ON li.batch_item_id=bi.id JOIN transport_legs l ON l.id=li.leg_id
      LEFT JOIN transport_leg_voids v ON v.leg_id=l.id`),
    query(`SELECT si.id,b.batch_no ref,b.stage,b.estimated_arrival_date eta,si.allocations_json allocations FROM lines i
      JOIN shipment_batch_items si ON si.production_order_item_id=i.id JOIN shipment_batches b ON b.id=si.batch_id`),
    query(`SELECT r.batch_item_id id,r.allocations_json allocations FROM lines i JOIN shipment_batch_items si ON si.production_order_item_id=i.id
      JOIN shipment_receipt_items r ON r.batch_item_id=si.id`),
    query(`SELECT n.notice_no ref,n.site,n.channel,n.status,n.approval_status,n.packing_json packing FROM orders o JOIN factory_dispatch_notices n
      ON n.production_order_id=o.id WHERE n.approval_status IN ('approved','pending') AND n.status IN ('issued','packing_submitted','confirmed') AND n.transport_batch_id IS NULL`),
    query(`SELECT p.sku,p.site,p.channel,p.transport_days FROM supply_policies p WHERE p.sku IN (SELECT sku FROM lines)`)
  ]);
  const matches=a=>a.site===site&&(!channel||a.channel===channel);
  const orders=new Map(),batches=new Map(),estimates=new Set(),notices=new Map();
  const transportDays=new Map(policies.map(p=>[[p.sku,p.site,p.channel].join('|'),p.transport_days]));
  let produced=0,sharedVariance=0,inProduction=0,shipped=0,received=0,review=0;
  for(const item of items){
    const allocations=parseList(item.allocations).filter(a=>a.qty>0),own=allocations.filter(matches);
    if(!own.length)continue;
    const allocated=own.reduce((sum,a)=>sum+a.qty,0);
    orders.set(item.orderId,item);
    if(item.status==='in_production'){
      inProduction+=allocated;
      if(validDay(item.promised_completion_date)&&item.promised_completion_date>=today)for(const a of own){
        const days=transportDays.get([item.sku,a.site,a.channel].join('|'))??item.sea_lead_days;
        if(Number.isSafeInteger(days)&&days>0)estimates.add(shiftDay(item.promised_completion_date,days));
      }
    }
    if(own.length===allocations.length)produced+=item.produced_qty;
    else if(item.produced_qty===allocations.reduce((sum,a)=>sum+a.qty,0))produced+=allocated;
    else if(item.produced_qty>0)sharedVariance++;
  }
  function batch(ref,stage,eta,qty,actual,sent,reconciliation={}){
    const b=batches.get(ref)||{ref,stage,eta,qty:0,received:0,sent,...reconciliation};
    b.qty+=qty;b.received+=actual;batches.set(ref,b);
    if(sent)shipped+=qty;
    received+=actual;
  }
  for(const l of legs)if(matches(l))batch(l.ref,l.stage,l.eta,l.qty,l.received,l.linked||sentStages.has(l.originalStage),
    {voidReason:l.voidReason,discrepancyReason:l.discrepancyReason,voidedAt:l.voidedAt,voidHistory:parseList(l.voidHistory)});
  const receivedByItem=new Map();
  for(const r of receipts)for(const a of parseList(r.allocations).filter(matches)){
    receivedByItem.set(r.id,(receivedByItem.get(r.id)||0)+a.qty);
  }
  for(const l of legacy){
    const qty=parseList(l.allocations).filter(matches).reduce((sum,a)=>sum+a.qty,0);
    if(qty)batch(l.ref,l.stage,l.eta,qty,receivedByItem.get(l.id)||0,sentStages.has(l.stage));
  }
  for(const n of packed)if(matches(n)){
    if(n.status==='issued'){
      const label=n.approval_status==='pending'?'发货通知待管理员审核':'工厂待装箱发货';
      notices.set(label,(notices.get(label)||0)+1);
      continue;
    }
    const qty=JSON.parse(n.packing).totalQty;
    if(!Number.isSafeInteger(qty)||qty<=0)throw new Error('装箱单数量待核实');
    if(n.status==='packing_submitted')review+=qty;
    batch(n.ref,n.status,null,qty,0,true);
  }
  const arrivals=new Map();
  let undated=0,overdue=0;
  for(const b of batches.values()){
    // Historical inbound is a separate stock fact. Reconciliation closes this
    // transit reminder without inventing a transport receipt or releasing shipment.
    if(b.stage==='voided')continue;
    const remaining=Math.max(0,b.qty-b.received);
    if(!remaining)continue;
    if(!validDay(b.eta)){undated+=remaining;continue;}
    if(b.eta<today){overdue+=remaining;continue;}
    arrivals.set(b.eta,(arrivals.get(b.eta)||0)+remaining);
  }
  return {orders,batches,estimates,notices,produced,sharedVariance,inProduction,shipped,received,review,arrivals,undated,overdue};
}

export async function answerPlanProgress(db,actor,question,at,context){
  const chineseMonths=['十二','十一','十','九','八','七','六','五','四','三','二','一'];
  const q=question.replace(/(\d)\s+([年月])/g,'$1$2').replace(/年\s+(\d)/g,'年$1').replace(/十二月|十一月|[一二三四五六七八九十]月/g,m=>(12-chineseMonths.indexOf(m.slice(0,-1)))+'月');
  const prior=validPlanContext(context)?context:null;
  const sites=HISTORY_SITES.filter(s=>q.includes(s)||(s==='马来西亚'&&/马来|大马/.test(q))||(s==='印尼'&&q.includes('印度尼西亚')));
  const channels=HISTORY_CHANNELS.filter(ch=>(ch==='TikTok'?/tiktok|tk|抖音/i:/shopee|虾皮/i).test(q));
  if(/(?:去|在)?哪[里儿](?:可以|能)?(?:查|看|填|录|提交)|哪个(?:页面|入口|按钮)|怎么(?:填|录|提交|审批|查|操作)|如何(?:填|录|提交|审批|查|操作)|要不要|为什么建议|如何备货|建议启动|建议(?:生产|备货|补货)|应该备|该备多少|需要备多少|大促.*够/.test(q))return null;
  const progress=statusWords.test(q), physical=/生产了|完工|生产进度|发出去|发货|发运|到仓|到货|在途|开船/.test(q);
  if(!(subject.test(q)&&(progress||numericMonth.test(q))||sites.length&&physical&&progress||
    (!prior&&!sites.length&&physical&&progress&&q.length<22)||prior&&(shortFollow.test(q)||progress&&/发|产|到|交期|备货|审批|进展|在途|几批/.test(q))))return null;
  if(!canReadDomain(actor.role,'planning')||!canReadDomain(actor.role,'fulfillment'))return base('你的岗位没有这份站点备货计划的读取权限，请供应链核对。');
  if(sites.length>1)return base('可以先选一个站点。比如问“菲律宾 11 月的备货计划到哪一步了？”');
  const ops=actor.role==='运营',site=sites[0]||(ops?actor.site:prior?.site)||'';
  const channel=channels.length===2||/两个平台|双平台|全部平台/.test(q)?'':channels[0]||(ops?actor.channel:prior?.channel)||'';
  if(ops&&(site!==actor.site||!HISTORY_CHANNELS.includes(actor.channel)||channels.some(ch=>ch!==actor.channel)))return base('你的账号可以查'+actor.site+' '+actor.channel+' 的备货和发运进度。');
  const month=planMonth(q,at,prior?.month);
  if(!month)return base('请给我一个计划月份，比如“菲律宾 2026 年 11 月的备货进度”。');
  const planContext={site,channel:ops?actor.channel:channel,month};
  if(!site)return base('想看哪个站点的 '+month+' 备货？回复站点名就行。',{planContext,questions:HISTORY_SITES});
  if(/\bSKU\b|\b[A-Z]+\d*[-_][A-Z0-9_-]+\b/i.test(q))return base('这项查询按站点和平台汇总。要查某个 SKU，可以打开月度计划查看明细。',{planContext});
  const parts=[
    ['production',/生产了多少|完工了?多少|做了多少|生产了?几件/],
    ['shipping',/发出去了?多少|发了多少|发出多少|发货了?多少|已经发了几/],
    ['arrival',/什么时候.{0,5}到|几[号天].{0,4}到|多久.{0,3}到|预计.{0,4}到|到仓时间|几时到|哪天到/],
  ].filter(([,pattern])=>pattern.test(q)).map(([part])=>part);
  const focus=parts.length===1&&!/到哪一步|到哪了|进展/.test(q)?parts[0]:'';
  const scope=site+(planContext.channel?' '+planContext.channel:'（双平台）')+' '+month;
  const history=await readReplenishmentHistory(db,actor,{site,channel:planContext.channel,month},new Date(at));
  const f=await fulfillmentFacts(db,month,site,planContext.channel,localDay(at,site));
  const details=[],state=history.plan?.status;
  const link={page:'monthly',view:'plan-history',entity:[site,planContext.channel].join('|'),month,label:'核对本站月度计划'};
  const reply=(answer)=>base(answer,{planContext,ledger:link,brief:{period:'按计划月份追踪至 '+localDay(at,site)+' · '+scope,details},questions:['生产了多少？','发出去了多少？','大概什么时候可以到？']});
  for(const s of history.submissions)details.push(s.channel+' 申报 '+units(s.totalQty)+' · '+s.id);
  if(history.plan)details.push('月度计划 '+history.plan.id+' · V'+history.plan.version+' · '+(approvalLabels[state]||state));
  if(!f.orders.size&&!f.batches.size){
    if(!state&&!history.submissions.length)return reply(scope+' 暂未查到提交记录或关联的生产、发运单据，数量和到仓时间都还无法确认。');
    const label=approvalLabels[state]||'已提交，待供应链送审';
    const qty=state?history.summary.planQty:history.summary.submittedQty;
    return reply(scope+' '+label+(qty==null?'':'，'+(state==='approved'?'批准':state?'送审':'运营申报')+' '+units(qty))+'。'+(state==='pending'?'下一步是管理员审批，通过后下发工厂。':'')+'\n'+(history.submissions.length&&history.summary.submittedQty===0&&!history.summary.planQty?'本站已提交零需求。':'还没有查到可关联的工厂单，完工、发出和到仓日期暂无记录。'));
  }
  const stages=new Map();
  for(const o of f.orders.values()){
    const label=o.status==='awaiting_factory'?'待工厂接单':o.qc_status==='passed'&&['completed','completed_with_variance'].includes(o.status)?'已完工并通过质检':productionStageLabel(o);stages.set(label,(stages.get(label)||0)+1);
    details.push('生产单 '+o.orderId+' · '+o.series_name+' · '+label+(validDay(o.promised_completion_date)?' · 工厂交期 '+o.promised_completion_date:''));
  }
  const plan=state==='approved'?'批准 '+units(history.summary.planQty):'按已下发订单追踪';
  const shippingStages=new Map();
  for(const b of f.batches.values()){
    const stage=b.stage==='voided'?stageNames.get(b.stage):b.received>=b.qty?'已实收到仓':stageNames.get(b.stage)||({confirmed:'装箱已复核，待转海运',packing_submitted:'工厂已发货，装箱待复核'}[b.stage]);
    if(stage)shippingStages.set(stage,(shippingStages.get(stage)||0)+1);
  }
  const downstream=[...f.notices].map(([label,n])=>label+' '+n+' 单')
    .concat([...shippingStages].map(([label,n])=>label+' '+n+' 批')).join('，');
  const first=scope+' '+plan+'。'+([...stages].map(([s,n])=>s+' '+n+' 单').join('，')||'已查到本站发运记录')+'。'+(downstream?'发运进度：'+downstream+'。':'');
  const second='已登记'+(f.sharedVariance?'可归属本站的':'')+'完工 '+units(f.produced)+'，已发出 '+units(f.shipped)+'，仓库已实收 '+units(f.received)+'。';
  const reconciled=[...f.batches.values()].filter(b=>b.stage==='voided');
  const reconciliation=reconciled.length?reconciled.length+' 批已关联历史到仓处理，原运输数量合计 '+units(reconciled.reduce((n,b)=>n+b.qty,0))+'，不再计入在途或待补到仓日期。历史凭据与原票可能存在差异，以上实收仅为运输签收记录，不把核销数量当作本票实收；本次处理未再次增加库存。':'';
  if(f.inProduction)details.push('仍在生产的订单分配 '+units(f.inProduction)+'，进度百分比不能折算为实际完工件数。');
  const ordered=[...f.arrivals].sort(([a],[b])=>a.localeCompare(b));
  const estimated=[...f.estimates].sort();
  const timing=estimated.length?'在产货按工厂交期加运输天数粗估，约 '+estimated[0]+(estimated.length>1?' 至 '+estimated.at(-1):'')+' 到仓，质检、候船可能顺延。':'';
  const eta=ordered.length?'预计 '+ordered[0][0]+' 到 '+units(ordered[0][1])+(ordered.length>1?'，其余分 '+(ordered.length-1)+' 个日期陆续到仓':'')+'。':reconciled.length&&!f.undated&&!f.overdue?'当前没有仍待到仓的运输数量；历史核销明细见依据。':f.received>0&&f.received===f.shipped&&!f.undated&&!f.overdue?'已发出的货均已实收。':'暂时没有可确认的到仓日期。';
  for(const b of f.batches.values()){
    const history=(b.voidHistory||[]).map(h=>h.receiptNo+(h.businessDate?'（'+h.businessDate+'）':'')).join('、');
    details.push(b.ref+' · '+(stageNames.get(b.stage)||({confirmed:'装箱已复核',packing_submitted:'装箱待复核'}[b.stage])||b.stage)+' · '+units(b.qty)+' · 运输签收 '+units(b.received)+(b.stage==='voided'?' · 不再计在途'+(b.voidedAt?' · 核销登记 '+b.voidedAt:'')+(history?' · 历史到仓凭据：'+history:'')+(b.voidReason?' · 原因：'+b.voidReason:'')+(b.discrepancyReason?' · 差异说明：'+b.discrepancyReason:''):b.qty>b.received?' · '+(validDay(b.eta)?'预计 '+b.eta:'待补到仓日期'):''));
  }
  for(const [date,qty] of ordered)details.push(date+' 预计到仓 '+units(qty));
  const variance=f.sharedVariance?f.sharedVariance+' 项跨站 SKU 的完工差异尚待分摊。':'';
  const review=f.review?'已发出中有 '+units(f.review)+' 为工厂回传，待供应链复核。':'';
  const arrival=eta+(f.undated?units(f.undated)+' 待补到仓日期。':'')+(f.overdue?units(f.overdue)+' 的预计到仓日已过，需核对新日期。':'');
  if(focus==='production')return reply([scope+' 已登记'+(f.sharedVariance?'可归属本站的':'')+'完工 '+units(f.produced)+'。',variance,
    f.inProduction?'还有 '+units(f.inProduction)+' 分配在生产中的订单上，实际完工量按工厂登记。':''].filter(Boolean).join('\n'));
  if(focus==='shipping')return reply([scope+' 已发出 '+units(f.shipped)+'，仓库已实收 '+units(f.received)+'。',reconciliation,review,arrival].filter(Boolean).join('\n'));
  if(focus==='arrival')return reply([scope+'，'+arrival,timing,'已发出 '+units(f.shipped)+'，仓库已实收 '+units(f.received)+'。',reconciliation].filter(Boolean).join('\n'));
  return reply([first,second,reconciliation,arrival,timing,variance,review].filter(Boolean).join('\n'));
}
