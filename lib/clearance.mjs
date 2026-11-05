import {assertWritable,guardStatement,atomicBatch} from './atomic.mjs';
import {financeRows as rows,financeClock,financeGuardSql,assertFinanceOpen,financialRates} from './finance-periods.mjs';
import {actionFinanceDay} from './business-action-data.mjs';
import {assertDailyAdAllocation} from './finance-ad-allocation.mjs';
import {financeFields} from './business-action-model.mjs';
import {digest} from './business-action-finance.mjs';
import {effectiveCost} from './effective-cost.mjs';
import {SITE_CURRENCIES} from './sales-data.mjs';
import {validDay,shiftDay} from './promotion-model.mjs';
import {clearanceLine,clearanceEvidence} from './clearance-data.mjs';
import {readClearanceZeroSales} from './clearance-zero-sales.mjs';
import {clearanceTaskForActor} from './clearance-oversight.mjs';
import {canClearance,clearanceScope,clearanceSites,clearanceActions,ownerOn,periods,monthEnd,money,text,fail,localDay} from './clearance-model.mjs';
export {readClearance} from './clearance-data.mjs';
async function owner(db,id,site,channel){const u=await db.prepare("SELECT id FROM users WHERE id=? AND role='运营' AND active=1 AND site=? AND channel=?").bind(id,site,channel).first();if(!u)fail('负责人须为该站点／平台的在岗运营');return u;}
async function competingPromotion(db,r,from,to){
 const ps=await rows(db,"SELECT * FROM promotions WHERE site=? AND channel=? AND sku=? AND status IN ('approved','active','stop_required','review_pending')",[r.site,r.channel,r.sku]);
 for(const p of ps){const d=JSON.parse(p.data_json);if(['active','stop_required','review_pending'].includes(p.status)||!d.start||!d.end||d.start<=to&&d.end>=from)fail('该 SKU 有未结束的优惠申请，请先停止并完成原优惠复盘，避免两套活动重复归因',409);}
}
function promotionGuard(db,a,r,start,end){return guardStatement(db,a,'clearance.promotion-overlap',"NOT EXISTS(SELECT 1 FROM promotions WHERE site=? AND channel=? AND sku=? AND status IN ('approved','active','stop_required','review_pending') AND (status IN ('active','stop_required','review_pending') OR (json_extract(data_json,'$.start')<=? AND json_extract(data_json,'$.end')>=?)))",[r.site,r.channel,r.sku,end,start]);}
export async function readClearanceDay(db,a,id,date){const r=await clearanceLine(db,a,id);if(!validDay(date)||!r.started_on||date<r.started_on||date>(r.ended_on||r.data.end)||date>=localDay(new Date(),r.site))fail('请选择活动期间已结束的一天');return actionFinanceDay(db,r,date);}
export async function mutateClearance(db,a,p,now=new Date()){
 if(!canClearance(a))fail('当前账号无清仓权限',403);
 if(!p||typeof p!=='object'||typeof p.operationId!=='string'||!/^[-\w]{16,100}$/.test(p.operationId))fail('请求编号无效，请刷新');
 const hash=await digest(p),existing=await db.prepare('SELECT * FROM clearance_operations WHERE id=?').bind(p.operationId).first();
 if(existing){if(existing.actor_id!==a.id||existing.request_hash!==hash)fail('请求编号已用于其他操作',409);return JSON.parse(existing.result_json);}
 await assertWritable(db);const at=now.toISOString(),extra=[],clock=await financeClock(db),fg=financeGuardSql(clock);
 extra.push(guardStatement(db,a,'clearance.actor',"EXISTS(SELECT 1 FROM users WHERE id=? AND active=1 AND role=? AND COALESCE(site,'')=? AND COALESCE(channel,'')=?)",[a.id,a.role,a.site||'',a.channel||'']));
 let id=p.id,r=null,data={},fields={},detail={},businessDate='',action=p.action;
 if(action==='create'){
  if(!['管理员','运营主管','运营'].includes(a.role))fail('由运营或管理人员提出清仓计划',403);
  monthEnd(p.month);if(!clearanceSites.includes(p.site)||!['TikTok','Shopee'].includes(p.channel)||!clearanceScope(a,p))fail('请选择权限内的站点和平台',403);
  const today=localDay(now,p.site),start=text(p.start,10),end=text(p.end,10);if(!validDay(start)||!validDay(end)||start<today||start>end||start.slice(0,7)!==p.month||end.slice(0,7)!==p.month)fail('计划日期须在所选月份内，开始日不能早于今天');
  const sku=text(p.sku,120);if(!await db.prepare('SELECT sku FROM sku_settings WHERE sku=?').bind(sku).first())fail('请选择系统已有 SKU');
  if(await db.prepare("SELECT id FROM clearance_lines WHERE month=? AND site=? AND channel=? AND sku=? AND status<>'cancelled'").bind(p.month,p.site,p.channel,sku).first())fail('本月该站点／平台／SKU已有计划，请进入原记录持续跟进',409);
  const ownerId=a.role==='运营'?a.id:text(p.ownerId,100);await owner(db,ownerId,p.site,p.channel);
  const target=Number(p.targetQty);if(!Number.isSafeInteger(target)||target<1||target>1e7)fail('清仓目标须为正整数');
  if(text(p.reason).length<4||text(p.strategy).length<4)fail('请填写滞销依据、诊断和拟执行动作');
  data={start,end,targetQty:target,proposedPrice:money(p.proposedPrice,'建议售价'),reason:text(p.reason),strategy:text(p.strategy),initialOwnerId:ownerId};
  if(p.sourceZeroSales===true){
   const candidate=await readClearanceZeroSales(db,a,p.month,now,{site:p.site,channel:p.channel,sku});
   if(!candidate.canApply)fail('零动销依据或库存已变化，或已有未结束的申请，请刷新商品池后核对',409);
   if(target>candidate.available)fail('清仓目标不能超过当前可售库存，请刷新后核对',409);
   data.zeroSalesSource={start:candidate.start,cutoff:candidate.cutoff,qty:candidate.recentQty,available:candidate.available,coverage:candidate.coverage,historyVerified:candidate.historyVerified,costRef:candidate.referenceCost,capturedAt:at};
  }
  id=crypto.randomUUID();businessDate=today;detail={...data,site:p.site,channel:p.channel,sku,ownerId};
  extra.push(guardStatement(db,a,'clearance.owner',"EXISTS(SELECT 1 FROM users WHERE id=? AND active=1 AND role='运营' AND site=? AND channel=?)",[ownerId,p.site,p.channel]));
  extra.push(db.prepare('INSERT INTO clearance_lines(id,month,site,channel,sku,owner_id,data_json,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').bind(id,p.month,p.site,p.channel,sku,ownerId,JSON.stringify(data),a.id,at,at));
 }else{
  r=await clearanceLine(db,a,id);data={...r.data};businessDate=localDay(now,r.site);
  if(!Number.isInteger(p.version)||p.version!==r.version)fail('计划已更新，请刷新核对后重试',409);
  extra.push(guardStatement(db,a,'clearance.version','EXISTS(SELECT 1 FROM clearance_lines WHERE id=? AND version=?)',[id,p.version]));
  const events=(await rows(db,'SELECT * FROM clearance_events WHERE line_id=? ORDER BY created_at,id',[id])).map(e=>({...e,detail:JSON.parse(e.detail_json)}));
  const own=ownerOn(r,events,businessDate)===a.id,manage=['管理员','运营主管'].includes(a.role),note=text(p.note);
  const requireState=(states)=>{if(!states.includes(r.status))fail('当前状态不能执行此操作',409);};
  if(action==='edit'){
   requireState(['draft']);if(!own&&!manage)fail('仅负责人或管理人员修改草稿',403);
   const start=text(p.start,10),end=text(p.end,10),target=Number(p.targetQty);if(!validDay(start)||!validDay(end)||start<businessDate||start>end||start.slice(0,7)!==r.month||end.slice(0,7)!==r.month)fail('日期须在该月内且开始日不能早于今天');
   if(!Number.isSafeInteger(target)||target<1||target>1e7||text(p.reason).length<4||text(p.strategy).length<4)fail('请完整填写目标、问题依据和措施');
   data={...data,start,end,targetQty:target,proposedPrice:money(p.proposedPrice,'建议售价'),reason:text(p.reason),strategy:text(p.strategy)};detail={...data};
  }else if(action==='submit'){
   requireState(['draft']);if(!own&&!manage)fail('由负责人或管理人员送审',403);if(data.end<businessDate)fail('计划已过期，请取消后按新月份创建');
   fields.status='finance_review';detail={note};
  }else if(action==='financeCheck'){
   requireState(['finance_review','admin_review']);if(a.role!=='财务')fail('仅财务核定成本、支持预算和亏损上限',403);
   const product=effectiveCost(await rows(db,'SELECT * FROM product_cost_versions WHERE site=? AND sku=?',[r.site,r.sku]),r.site,r.sku,data.start);
   if(product?.total==null||product.basis!=='landed')fail('请先核实该站点 SKU 的完整到仓成本');
   const rate=(await financialRates(db,r.month))[SITE_CURRENCIES[r.site]];if(!rate)fail('请先在成本利润透明中核定本月财务汇率');
   const percent=money(p.allowancePercent,'让利比例');if(percent>100)fail('让利比例须在0至100之间');
   const price=money(p.price,'批准计划售价'),floor=money(p.floorPrice,'最低执行价');if(floor>price||price<=0)fail('计划售价须大于0且不低于最低执行价');
   const source=text(p.source);if(source.length<4||note.length<4)fail('请填写财务核定依据和支持说明');
   data.finance={price,floorPrice:floor,allowancePercent:percent,supportBudget:money(p.supportBudget,'广告及其他直接支持预算'),lossLimit:money(p.lossLimit,'可接受净亏损上限'),source,note,costRef:{id:product.id,version:product.version,unitCny:product.total/10000,basis:product.basis},rateId:rate.id,rate:rate.rate,currency:SITE_CURRENCIES[r.site]};
   fields={status:'admin_review',finance_by:a.id};detail=data.finance;
  }else if(action==='approve'){
   requireState(['admin_review']);if(a.role!=='管理员'||a.id===r.finance_by)fail('仅独立管理员审批',403);
   const product=effectiveCost(await rows(db,'SELECT * FROM product_cost_versions WHERE site=? AND sku=?',[r.site,r.sku]),r.site,r.sku,data.start),rate=(await financialRates(db,r.month))[SITE_CURRENCIES[r.site]];
   if(product?.id!==data.finance?.costRef?.id||rate?.id!==data.finance?.rateId)fail('成本或汇率已修订，请财务重新核定',409);
   await owner(db,r.owner_id,r.site,r.channel);await competingPromotion(db,r,data.start,data.end);extra.push(promotionGuard(db,a,r,data.start,data.end));if(data.end<businessDate)fail('活动已过期');
   if(note.length<4)fail('请填写审批意见');fields={status:'approved',approved_by:a.id};detail={note,finance:data.finance};
  }else if(action==='return'){
   requireState(['finance_review','admin_review','approved']);if(!['管理员','财务'].includes(a.role)||note.length<4)fail('由财务或管理员填写退回原因',403);fields={status:'draft',finance_by:null,approved_by:null};delete data.finance;detail={note};
  }else if(action==='start'){
   requireState(['approved']);if(!own)fail('由指定运营在平台执行后登记',403);
   if(businessDate<data.start||businessDate>data.end)fail('尚未到执行日或计划已过期');
   const currentCost=effectiveCost(await rows(db,'SELECT * FROM product_cost_versions WHERE site=? AND sku=?',[r.site,r.sku]),r.site,r.sku,businessDate),currentRate=(await financialRates(db,r.month))[SITE_CURRENCIES[r.site]];if(currentCost?.id!==data.finance?.costRef?.id||currentRate?.id!==data.finance?.rateId)fail('审批后的成本或汇率已变化，请退回重新核定后执行',409);
   await competingPromotion(db,r,businessDate,data.end);extra.push(promotionGuard(db,a,r,businessDate,data.end));
   const actualPrice=money(p.actualPrice,'实际执行价');if(actualPrice<data.finance.floorPrice)fail('实际售价低于批准底价，请退回重新审批');
   const source=text(p.source);if(source.length<4||note.length<4||p.confirmed!==true)fail('请提供平台执行凭据、说明，并确认已手动执行');
   const stock=await db.prepare('SELECT qty,reserved_qty,updated_at FROM inventory_balances WHERE site=? AND channel=? AND sku=?').bind(r.site,r.channel,r.sku).first();
   if(!stock||stock.qty<=Number(stock.reserved_qty||0))fail('无有效可售库存，先核对库存');
   data.opening={available:stock.qty-Number(stock.reserved_qty||0),at,stockAt:stock.updated_at};fields={status:'active',started_on:businessDate};detail={source,note,actualPrice,opening:data.opening};
  }else if(action==='log'){
   requireState(['active']);const kind=text(p.kind,40);if(!clearanceActions[kind])fail('动作类型无效');
   if(kind==='support'?a.role!=='财务':!own)fail(kind==='support'?'由财务登记支持措施':'由当前负责人登记执行动作',403);
   if(r.ended_on&&kind!=='support')fail('已停止优惠，后续请核算及复盘');
   const source=text(p.source);if(source.length<4||note.length<4)fail('请提供执行凭据／链接／编号和动作说明');
   detail={kind,note,source};if(kind==='price'){detail.actualPrice=money(p.actualPrice,'实际执行价');if(detail.actualPrice<data.finance.floorPrice)fail('低于批准底价，不能登记为已批准执行');}
   if(kind==='stop')fields.ended_on=businessDate<data.end?businessDate:data.end;
  }else if(action==='assign'){
   requireState(['draft','finance_review','admin_review','approved','active']);if(!manage)fail('仅管理员或运营主管调整负责人',403);
   const ownerId=text(p.ownerId,100);await owner(db,ownerId,r.site,r.channel);if(note.length<4)fail('请填写交接原因');
   const from=r.started_on?shiftDay(businessDate,1):businessDate;if(r.started_on&&from>(r.ended_on||data.end))fail('活动已经结束，不能重分配历史贡献');
   if(events.some(e=>e.action==='assign'&&e.business_date===from))fail('该生效日期已有交接，请勿重复分配');
   if(!r.started_on)data.initialOwnerId=ownerId;fields.owner_id=ownerId;businessDate=from;detail={ownerId,note};
   extra.push(guardStatement(db,a,'clearance.owner',"EXISTS(SELECT 1 FROM users WHERE id=? AND active=1 AND role='运营' AND site=? AND channel=?)",[ownerId,r.site,r.channel]));
  }else if(action==='financeDay'){
   requireState(['active','completed']);if(a.role!=='财务')fail('仅财务核实每日成本',403);
   const date=text(p.date,10);if(!validDay(date)||!r.started_on||date<r.started_on||date>(r.ended_on||data.end)||date>=businessDate)fail('请选择已结束的活动日期');
   const day=await actionFinanceDay(db,r,date);if(day.status==='sales_pending'||day.basisHash!==p.basisHash||day.revision!==p.revision)fail('销售／退款／成本依据或修订已变化，请刷新该日',409);
   await assertFinanceOpen(db,date);const costs={};for(const [key,label] of Object.entries({...financeFields,other:'其他直接费用'}))costs[key]=money(p.costs?.[key],label);
   const source=text(p.source);if(source.length<4||p.confirmed!==true)fail('请填写核算凭据并确认折扣、退款及整店广告未重复计入');
   await assertDailyAdAllocation(db,{site:r.site,channel:r.channel,sku:r.sku,date,currency:day.currency},costs.ads);
   extra.push(guardStatement(db,a,'clearance.daily-revision','COALESCE((SELECT MAX(revision) FROM business_action_finance_days WHERE site=? AND channel=? AND sku=? AND business_date=?),0)=?',[r.site,r.channel,r.sku,date,day.revision]));
   extra.push(db.prepare('INSERT INTO business_action_finance_days(id,site,channel,sku,business_date,revision,currency,basis_hash,basis_json,data_json,source,note,actor_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(crypto.randomUUID(),r.site,r.channel,r.sku,date,day.revision+1,day.currency,day.basisHash,JSON.stringify(day.basis),JSON.stringify(costs),source,note,a.id,at));
   if(r.status==='completed')fields.status='active';
   businessDate=date;detail={date,source,note,costs,revision:day.revision+1,reopened:r.status==='completed'};
  }else if(action==='review'){
   requireState(['active','completed']);if(!own&&!manage&&a.role!=='财务')fail('由负责人、财务或管理人员复盘',403);
   const record=(await clearanceEvidence(db,[r],now))[0],period=record.windows.find(w=>w.to===p.periodEnd);
   if(!period?.ready||period.evidenceHash!==p.evidenceHash)fail('周期尚未结束或依据已变更，请刷新',409);
   if(!['continue','adjust','stop'].includes(p.outcome)||note.length<4)fail('请选择复盘决定并填写依据／下一步');
   const revision=(period.review?.revision||0)+1;
   extra.push(db.prepare('INSERT INTO clearance_reviews(id,line_id,period_end,revision,evidence_hash,snapshot_json,outcome,note,actor_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').bind(crypto.randomUUID(),id,period.to,revision,period.evidenceHash,JSON.stringify({summary:{...period,review:undefined},stock:record.stock,contributions:record.contributions,finance:data.finance}),p.outcome,note,a.id,at));
   detail={periodEnd:period.to,revision,outcome:p.outcome,note,financePending:period.pendingFinance.length};
  }else if(action==='close'){
   requireState(['active','completed']);if(a.role!=='财务')fail('财务核清费用后结案',403);
   const record=(await clearanceEvidence(db,[r],now))[0];
   if(!record.progress.stockMatched)fail('日报与库存扣减流水不一致，请先核对具体批次再结案');
   if((r.ended_on||data.end)>=businessDate||!record.days.length||record.summary.profit==null||record.windows.some(w=>!w.review||w.review.stale)||!events.some(e=>e.action==='log'&&e.detail.kind==='stop'))fail('请先停止平台优惠，等待末日数据，核清每日费用并完成全部周期复盘');
   if(note.length<4)fail('请填写结案核对说明');fields.status='completed';detail={note,summary:record.summary};
  }else if(action==='cancel'){
   requireState(['draft','finance_review','admin_review','approved']);if(!own&&!manage)fail('由负责人或管理人员取消',403);if(note.length<4)fail('请填写取消原因');fields.status='cancelled';detail={note};
  }else fail('操作无效');
  extra.push(db.prepare(`UPDATE clearance_lines SET data_json=?,version=version+1,updated_at=?${Object.keys(fields).map(k=>`,${k}=?`).join('')} WHERE id=?`).bind(JSON.stringify(data),at,...Object.values(fields),id));
 }
 // One transaction checks the source snapshot, permissions, request version and writes an append-only audit.
 extra.unshift(guardStatement(db,a,'clearance.source',fg.sql,fg.args));
 extra.push(db.prepare('INSERT INTO clearance_events(id,line_id,action,business_date,actor_id,detail_json,created_at) VALUES(?,?,?,?,?,?,?)').bind(crypto.randomUUID(),id,action,businessDate,a.id,JSON.stringify(detail),at));
 const result={id,version:r?r.version+1:1};extra.push(db.prepare('INSERT INTO clearance_operations(id,actor_id,request_hash,result_json,created_at) VALUES(?,?,?,?,?)').bind(p.operationId,a.id,hash,JSON.stringify(result),at));
 try{await atomicBatch(db,extra);}catch(e){if(/UNIQUE constraint/.test(String(e)))fail('相同计划、周期或请求已保存，请刷新核对',409);throw e;}return result;
}
export async function clearanceTasks(db,a,now=new Date()){
 if(!canClearance(a))return [];
 const month=localDay(now,a.site||'印尼').slice(0,7),items=(await rows(db,"SELECT * FROM clearance_lines WHERE status NOT IN ('cancelled','completed') ORDER BY month,site,sku")).filter(r=>clearanceScope(a,r)),out=[];
 // One evidence read per month, not per plan. Overview and clearance use the
 // same priorities; one reminder per plan prevents repeated notification rows.
 for(const m of [...new Set(items.map(r=>r.month))])for(const r of await clearanceEvidence(db,items.filter(r=>r.month===m).map(r=>({...r,data:JSON.parse(r.data_json)})),now)){
  const t=r.oversight.tasks.find(t=>clearanceTaskForActor(t,a));
  if(t)out.push({tab:'clearance',entity:r.id,month:r.month,title:(['管理员','运营主管'].includes(a.role)&&t.role!=='管理员'?'督办：':'')+t.title,detail:`${r.site} · ${r.channel} · ${r.sku} · ${t.role}${t.due?' · 建议处理日 '+t.due:''}`,level:t.priority===0?'red':'amber'});
 }
 if(['管理员','运营主管','运营'].includes(a.role))for(const site of a.role==='运营'?[a.site]:clearanceSites){
  const completed=await rows(db,"SELECT site,channel FROM clearance_lines WHERE month=? AND site=? AND status='completed'",[month,site]);
  if(site&&!items.some(r=>r.month===month&&r.site===site)&&!completed.some(r=>clearanceScope(a,r)))out.push({tab:'clearance',entity:'',month,title:'制定本月清仓计划',detail:`${site}${a.role==='运营'?' · '+a.channel:''} · ${month} 尚无计划`,level:'amber'});
 }
 return out;
}
