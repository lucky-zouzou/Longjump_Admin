import {atomicBatch,assertWritable,guardStatement} from './atomic.mjs';
import {fail,text,localDay,shiftDay,validDay,normalizeProposal,normalizeCosts,evaluateZeroSales,cents} from './promotion-model.mjs';
export const rows=async(db,sql,args=[])=>(await db.prepare(sql).bind(...args).all()).results||[];
export const canApply=a=>a.role==='运营'&&a.site==='印尼'&&['TikTok','Shopee'].includes(a.channel);
export const canRead=a=>canApply(a)||['管理员','财务','供应链'].includes(a.role);
export const access=a=>{if(!canRead(a))fail('本期开放印尼 TikTok／Shopee 运营、财务、管理员及供应链',403)};
const scope=(a,r)=>['管理员','财务','供应链'].includes(a.role)||canApply(a)&&a.site===r.site&&a.channel===r.channel;
export const auditPromotion=(db,a,id,action,detail,now=new Date())=>db.prepare('INSERT INTO audit_logs(id,action,entity_type,entity_id,detail_json,actor_id,actor_name,created_at) VALUES(?,?,?,?,?,?,?,?)').bind(crypto.randomUUID(),'promotion.'+action,'promotion',id,JSON.stringify(detail),a.id,a.name||'系统',now.toISOString());
export async function promotionRecord(db,a,id){access(a);const r=await db.prepare('SELECT * FROM promotions WHERE id=?').bind(text(id,100)).first();if(!r||!scope(a,r)||r.status==='draft'&&r.owner_id!==a.id)fail('申请不存在或无权查看',404);return {...r,data:JSON.parse(r.data_json)};}
export async function zeroSales(db,a,now=new Date()){
 access(a);const cutoff=shiftDay(localDay(now),-1),start=shiftDay(cutoff,-29),args=canApply(a)?[a.channel]:[],filter=canApply(a)?' AND channel=?':'';
 const [stocks,sales,complete,availability,observations,owners]=await Promise.all([
 rows(db,"SELECT * FROM inventory_balances WHERE site='印尼' AND channel IN ('TikTok','Shopee')"+filter,args),
 rows(db,"SELECT site,channel,sku,business_date,SUM(CASE WHEN qty>0 THEN qty ELSE 0 END) qty FROM sales_records WHERE reversed_at IS NULL AND site='印尼' AND business_date<=?"+filter+' GROUP BY site,channel,sku,business_date',[cutoff,...args]),
 rows(db,"SELECT DISTINCT channel,business_date FROM sales_imports WHERE site='印尼' AND reversed_at IS NULL AND report_kind IN ('complete','zero') AND business_date BETWEEN ? AND ?"+filter,[start,cutoff,...args]),
 rows(db,"SELECT * FROM promotion_availability WHERE site='印尼'"+filter,args),rows(db,"SELECT * FROM promotion_stock_days WHERE site='印尼' AND day>=?"+filter,[start,...args]),rows(db,"SELECT id,name,channel FROM users WHERE active=1 AND role='运营' AND site='印尼'"+filter,args)]);
 const group=(data,key)=>{const m=new Map();for(const r of data){const k=key(r);if(!m.has(k))m.set(k,[]);m.get(k).push(r);}return m;},key=r=>r.channel+'|'+r.sku,sm=group(sales,key),om=group(observations,key),am=new Map(availability.map(r=>[key(r),r]));
 return stocks.map(stock=>({...evaluateZeroSales({stock,sales:sm.get(key(stock))||[],completeDates:complete.filter(r=>r.channel===stock.channel).map(r=>r.business_date),availability:am.get(key(stock)),observations:om.get(key(stock))||[]},now),owners:owners.filter(r=>r.channel===stock.channel).map(r=>r.name)}));
}
export async function campaignMetrics(db,r,now=new Date()){
 const d=r.data,start=d.execution?.date||d.start,end=d.stop?.date||localDay(now),sales=await rows(db,'SELECT business_date,SUM(CASE WHEN qty>0 THEN qty ELSE 0 END) qty,SUM(reported_amount) amount,SUM(CASE WHEN reported_amount IS NULL AND qty>0 THEN 1 ELSE 0 END) unknown FROM sales_records WHERE site=? AND channel=? AND sku=? AND reversed_at IS NULL AND business_date BETWEEN ? AND ? GROUP BY business_date',[r.site,r.channel,r.sku,start,end]);
 const qty=sales.reduce((s,x)=>s+x.qty,0),amountKnown=!sales.some(x=>x.unknown>0),amount=amountKnown?Math.round(sales.reduce((s,x)=>s+(x.amount||0),0)*100):null;
 const complete=await rows(db,"SELECT DISTINCT business_date FROM sales_imports WHERE site=? AND channel=? AND reversed_at IS NULL AND report_kind IN ('complete','zero') AND business_date BETWEEN ? AND ?",[r.site,r.channel,start,end]);
 const expected=Math.max(0,Math.round((Date.parse(end)-Date.parse(start))/86400000)+1),remaining=await db.prepare('SELECT qty-reserved_qty available FROM inventory_balances WHERE site=? AND channel=? AND sku=?').bind(r.site,r.channel,r.sku).first();
 const estimatedBudget=qty*(d.original-d.price+(d.costs?.ad||0));
 return {qty,amount,amountKnown,coverage:complete.length,days:expected,remaining:Math.max(0,remaining?.available||0),estimatedBudget,start,end,stopReason:localDay(now)>d.end?'活动已到期':qty>=d.qty?'SKU销量达到数量上限':estimatedBudget>=d.budget?'估算用量达到预算上限':(!remaining||remaining.available<=0)?'无可售库存':'',scopeNote:'活动期同站点渠道全部SKU销量，含非活动销售；用于保守提醒，不代表活动归因。退款／退货与实际平台费用需财务复核。'};
}
export function publicPromotion(r,a){
 const {data_json,...safe}=r;if(a.role!=='供应链')return safe;
 return {id:r.id,site:r.site,channel:r.channel,sku:r.sku,owner_name:r.owner_name,status:r.status,version:r.version,revision:r.revision,created_at:r.created_at,updated_at:r.updated_at,data:{start:r.data.start,end:r.data.end,qty:r.data.qty},metrics:r.metrics?{qty:r.metrics.qty,remaining:r.metrics.remaining,stopReason:r.metrics.stopReason}:undefined};
}
export async function readPromotions(db,a,now=new Date()){
 access(a);const all=await rows(db,"SELECT * FROM promotions WHERE (status<>'draft' OR owner_id=?) ORDER BY created_at DESC",[a.id]);
 const records=[];for(const raw of all.filter(r=>scope(a,r))){const r={...raw,data:JSON.parse(raw.data_json)};if(r.data.execution)r.metrics=await campaignMetrics(db,r,now);records.push(publicPromotion(r,a));}
 const measures=a.role==='供应链'?[]:(await rows(db,"SELECT entity_id,actor_name,created_at,detail_json FROM audit_logs WHERE action='promotion.measure' ORDER BY created_at DESC LIMIT 500")).filter(x=>!canApply(a)||x.entity_id.startsWith(a.site+'|'+a.channel+'|'));
 const files=a.role==='供应链'?[]:(await rows(db,'SELECT id,record_id,revision,purpose,name,created_at FROM promotion_files')).filter(f=>records.some(r=>r.id===f.record_id));
 return {actor:{id:a.id,role:a.role,site:a.site,channel:a.channel},canApply:canApply(a),alerts:await zeroSales(db,a,now),records,files,measures,generatedAt:now.toISOString(),cutoff:shiftDay(localDay(now),-1)};
}
export async function promotionHistory(db,a,id){if(a.role==='供应链')fail('供应链仅查看库存与处理状态',403);await promotionRecord(db,a,id);return rows(db,"SELECT action,actor_name,created_at,detail_json FROM audit_logs WHERE entity_type='promotion' AND entity_id=? ORDER BY created_at",[id]);}
const overlapStatuses="'finance_review','admin_review','approved','active','stop_required'";
const overlapSql=`NOT EXISTS(SELECT 1 FROM promotions WHERE id<>? AND site=? AND channel=? AND sku=? AND status IN (${overlapStatuses}) AND (status IN ('active','stop_required') OR (json_extract(data_json,'$.start')<=? AND json_extract(data_json,'$.end')>=?)))`;
export async function mutatePromotion(db,a,p,now=new Date()){
 access(a);await assertWritable(db);const action=p.action,at=now.toISOString();
 if(action==='verify'){
  if(!canApply(a))fail('仅本站渠道运营可核实在售情况',403);const sku=text(p.sku,100),listed=text(p.listedSince,10),available=text(p.availableSince,10),through=shiftDay(localDay(now),-1),reference=text(p.reference,600),note=text(p.note);
  if(!validDay(listed)||!validDay(available)||listed>through||available>through||available<listed||reference.length<4||note.length<4||p.confirmed!==true)fail('请核对连续上架、可售日期，提供平台链接或核对凭证并确认');
  if(!await db.prepare('SELECT 1 FROM inventory_balances WHERE site=? AND channel=? AND sku=? AND qty-reserved_qty>0').bind(a.site,a.channel,sku).first())fail('SKU不存在或暂无可售库存');
  if(await db.prepare('SELECT 1 FROM promotion_stock_days WHERE site=? AND channel=? AND sku=? AND day BETWEEN ? AND ? AND min_available<=0 LIMIT 1').bind(a.site,a.channel,sku,available,through).first())fail('该时段存在无可售库存记录，请缩短连续有货日期，不可覆盖系统事实');
  await atomicBatch(db,[guardStatement(db,a,'promotion.verify','1=1'),db.prepare('INSERT INTO promotion_availability VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(site,channel,sku) DO UPDATE SET listed_since=excluded.listed_since,available_since=excluded.available_since,verified_through=excluded.verified_through,reference=excluded.reference,note=excluded.note,actor_id=excluded.actor_id,updated_at=excluded.updated_at').bind(a.site,a.channel,sku,listed,available,through,reference,note,a.id,at),auditPromotion(db,a,`${a.site}|${a.channel}|${sku}`,'verify',{listed,available,through,reference,note,source:'运营核验，非平台自动采集'},now)]);return {ok:true};
 }
 if(action==='measure'){
  if(!canApply(a)||text(p.note).length<4)fail('请由本站运营填写改进措施',403);const sku=text(p.sku,100);if(!await db.prepare('SELECT 1 FROM inventory_balances WHERE site=? AND channel=? AND sku=?').bind(a.site,a.channel,sku).first())fail('SKU无效');
  await atomicBatch(db,[guardStatement(db,a,'promotion.measure','1=1'),auditPromotion(db,a,`${a.site}|${a.channel}|${sku}`,'measure',{note:text(p.note)},now)]);return {ok:true};
 }
 if(action==='create'){
  if(!canApply(a))fail('仅印尼本站渠道运营可申请优惠',403);const sku=text(p.sku,100),d=normalizeProposal(p,now);
  if(!await db.prepare('SELECT 1 FROM inventory_balances WHERE site=? AND channel=? AND sku=? AND qty-reserved_qty>0').bind(a.site,a.channel,sku).first())fail('请选择有可售库存的系统SKU');
  const id='promo_'+crypto.randomUUID();await atomicBatch(db,[guardStatement(db,a,'promotion.create','1=1'),db.prepare('INSERT INTO promotions(id,site,channel,sku,owner_id,owner_name,data_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').bind(id,a.site,a.channel,sku,a.id,a.name,JSON.stringify(d),at,at),auditPromotion(db,a,id,'create',{data:d},now)]);return {ok:true,id};
 }
 const r=await promotionRecord(db,a,p.id);if(r.version!==p.version)fail('记录已更新，请刷新核对后重试，当前内容仍保留',409);
 const own=canApply(a)&&a.id===r.owner_id,admin=a.role==='管理员',finance=a.role==='财务',d={...r.data},note=text(p.note);let status=r.status,revision=r.revision,extraGuard='1=1',args=[];
 const needNote=()=>{if(note.length<4)fail('请填写至少4字处理依据');};
 const stockGuard=()=>{extraGuard+=' AND EXISTS(SELECT 1 FROM inventory_balances WHERE site=? AND channel=? AND sku=? AND qty-reserved_qty>=?)';args.push(r.site,r.channel,r.sku,d.qty);};
 const noOverlap=()=>{extraGuard+=' AND '+overlapSql;args.push(r.id,r.site,r.channel,r.sku,d.end,d.start);};
 const proof=async purpose=>{if(!await db.prepare('SELECT 1 FROM promotion_files WHERE record_id=? AND revision=? AND purpose=? LIMIT 1').bind(r.id,r.revision,purpose).first())fail('请先上传本次'+({proposal:'申请',execution:'执行',stop:'停止／恢复价格'}[purpose])+'截图凭证');};
 if(action==='save'){
  if(!own||r.status!=='draft')fail('只有本人草稿可修改',403);Object.keys(d).forEach(k=>delete d[k]);Object.assign(d,normalizeProposal(p,now));revision++;
 }else if(action==='submit'){
  if(!own||r.status!=='draft')fail('只有本人草稿可提交',403);if(d.start<localDay(now))fail('计划开始日已过，请修改日期');await proof('proposal');noOverlap();stockGuard();status='finance_review';
  const alert=(await zeroSales(db,a,now)).find(x=>x.sku===r.sku&&x.channel===r.channel);d.alertSnapshot=alert;
 }else if(action==='finance'){
  if(!finance||r.status!=='finance_review'||a.id===r.owner_id)fail('需独立财务核算',403);needNote();d.costs=normalizeCosts(p,d);d.finance={id:a.id,name:a.name,note,at,revision};status='admin_review';
 }else if(action==='approve'){
  if(!admin||r.status!=='admin_review'||a.id===r.owner_id||a.id===d.finance?.id)fail('需独立管理员审批，不可自己审批',403);needNote();if(!d.finance||d.finance.revision!==revision||!d.costs)fail('请先完成本版财务核算');
  if(d.start<localDay(now))fail('开始日已过，请退回重报');if(d.costs.contribution<0&&p.lossConfirmed!==true)fail('专项亏损清仓需明确确认亏损金额与上限');
  noOverlap();stockGuard();d.approval={id:a.id,name:a.name,note,at,revision};status='approved';
 }else if(action==='return'||action==='reject'){
  if(!(finance&&r.status==='finance_review'||admin&&r.status==='admin_review')||a.id===r.owner_id)fail('仅当前审批角色可退回或驳回',403);needNote();status=action==='return'?'draft':'rejected';if(action==='return'){revision++;delete d.costs;delete d.finance;delete d.approval;}
 }else if(action==='withdraw'){
  if(!own||!['draft','finance_review','admin_review','approved'].includes(r.status))fail('仅申请人可撤回尚未执行的申请',403);needNote();status='withdrawn';
 }else if(action==='execute'){
  if(!own||r.status!=='approved')fail('仅申请人可登记已批准优惠的执行',403);needNote();if(localDay(now)<d.start||localDay(now)>d.end)fail('当前不在批准的活动日期范围');
  if(p.termsConfirmed!==true||cents(p.actualPrice,'实际成交价')!==d.price)fail('请确认成本、库存及优惠条件未变化；实际成交价必须与批准价一致，变化需撤回重报');
  await proof('execution');noOverlap();stockGuard();if(!text(p.activityRef,600))fail('请填写平台活动编号／执行链接');d.execution={date:localDay(now),at,activityRef:text(p.activityRef,600),price:d.price,note};status='active';
 }else if(action==='terminate'){
  if(!admin||!['approved','active','stop_required'].includes(r.status))fail('管理员仅可终止已批准或执行中优惠',403);needNote();status=r.status==='approved'?'terminated':'stop_required';d.stopReason='管理员要求停止：'+note;
 }else if(action==='stop'){
  if(!own||!['active','stop_required'].includes(r.status))fail('仅执行运营可登记停止与恢复价格',403);needNote();await proof('stop');if(p.restored!==true)fail('请确认平台优惠已停止并核对恢复后的价格');const restoredPrice=cents(p.restoredPrice,'恢复后的实际价格');if(!restoredPrice)fail('恢复后价格需大于0');d.stop={at,date:localDay(now),price:restoredPrice,note};status='review_pending';
 }else if(action==='review'){
  if(!finance||r.status!=='review_pending'||a.id===r.owner_id)fail('仅独立财务可完成复盘',403);needNote();const metrics=await campaignMetrics(db,r,now);
  if(localDay(now)<shiftDay(d.stop.date,7))fail('停止后满7天再完成复盘，期间可查看阶段结果');if(metrics.coverage<metrics.days)fail('活动期日报尚未报齐，请补齐后复盘');
  const refund=cents(p.refund,'实际退款总额'),expenses=cents(p.expenses,'实际采购履约平台等费用（不含广告）'),ad=cents(p.actualAd,'实际可归属广告费',true),revenue=metrics.amount;
  d.review={at,note,refund,expenses,ad,metrics,contribution:revenue==null||ad==null?null:revenue-refund-expenses-ad,source:text(p.reviewSource,600)};if(d.review.source.length<4)fail('请填写退款、费用与广告核对依据');status='completed';
 }else fail('不支持的优惠操作');
 if(['submit','approve','execute'].includes(action)){
  if(!(await db.prepare('SELECT '+overlapSql+' ok').bind(r.id,r.site,r.channel,r.sku,d.end,d.start).first()).ok)fail('同一SKU已有重叠申请或未停止活动，请先处理已有申请',409);
  const stock=await db.prepare('SELECT qty-reserved_qty available FROM inventory_balances WHERE site=? AND channel=? AND sku=?').bind(r.site,r.channel,r.sku).first();if(!stock||stock.available<d.qty)fail('可售库存已变化，低于申请数量上限，请减少数量后重新送审',409);
 }
 await atomicBatch(db,[guardStatement(db,a,'promotion.'+action,'EXISTS(SELECT 1 FROM promotions WHERE id=? AND version=? AND status=?) AND '+extraGuard,[r.id,r.version,r.status,...args]),db.prepare('UPDATE promotions SET data_json=?,status=?,version=version+1,revision=?,updated_at=? WHERE id=?').bind(JSON.stringify(d),status,revision,at,r.id),auditPromotion(db,a,r.id,action,{note,status,revision,data:d},now)]);return {ok:true,id:r.id};
}
// A periodic job records only observed days. It never fills missing historical availability.
export async function refreshPromotions(db,now=new Date()){
 await assertWritable(db);const system={id:'promotion-system',name:'优惠预警系统',role:'管理员'},at=now.toISOString(),day=localDay(now);
 await db.prepare("INSERT INTO promotion_stock_days(site,channel,sku,day,min_available,first_at,last_at) SELECT site,channel,sku,?,qty-reserved_qty,?,? FROM inventory_balances WHERE site='印尼' AND channel IN ('TikTok','Shopee') ON CONFLICT(site,channel,sku,day) DO UPDATE SET min_available=MIN(min_available,excluded.min_available),last_at=excluded.last_at").bind(day,at,at).run();
 const alerts=await zeroSales(db,system,now);
 for(const alert of alerts){
  const old=await db.prepare('SELECT * FROM zero_sales_alerts WHERE site=? AND channel=? AND sku=?').bind(alert.site,alert.channel,alert.sku).first();if(!old&&alert.status==='closed')continue;
  const id=old?.id||'zero_'+crypto.randomUUID(),statements=[db.prepare('INSERT INTO zero_sales_alerts VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(site,channel,sku) DO UPDATE SET status=excluded.status,data_json=excluded.data_json,updated_at=excluded.updated_at').bind(id,alert.site,alert.channel,alert.sku,alert.status,JSON.stringify(alert),old?.opened_at||at,at)];
  if(!old||old.status!==alert.status)statements.push(auditPromotion(db,system,id,'alert',{status:alert.status,cutoff:alert.cutoff,zeroDays:alert.zeroDays,reason:alert.closedReason||alert.reasons.join('；')},now));await atomicBatch(db,statements);
 }
 for(const raw of await rows(db,"SELECT * FROM promotions WHERE status IN ('approved','active')")){
  const r={...raw,data:JSON.parse(raw.data_json)};let status='',reason='';
  if(r.status==='approved'&&day>r.data.end){status='terminated';reason='审批后未登记执行，计划已到期';}
  if(r.status==='active'){reason=(await campaignMetrics(db,r,now)).stopReason;if(reason)status='stop_required';}
  if(status)try{await atomicBatch(db,[guardStatement(db,system,'promotion.monitor','EXISTS(SELECT 1 FROM promotions WHERE id=? AND version=? AND status=?)',[r.id,r.version,r.status]),db.prepare('UPDATE promotions SET status=?,data_json=?,version=version+1,updated_at=? WHERE id=?').bind(status,JSON.stringify({...r.data,stopReason:reason}),at,r.id),auditPromotion(db,system,r.id,'monitor',{status,note:reason},now)]);}catch(e){if(e.status!==409)throw e;}
 }
}
export async function promotionTasks(db,a){
 if(!canRead(a))return [];const tasks=[],alerts=(await zeroSales(db,a)).filter(r=>r.status==='open');if(alerts.length)tasks.push({tab:'promotions',level:'amber',title:'跟进零销量SKU',detail:`${alerts.length}个SKU连续至少7天零销量`});
 for(const raw of await rows(db,"SELECT * FROM promotions WHERE status NOT IN ('completed','withdrawn','rejected','terminated')")){if(!scope(a,raw))continue;const r={...raw,data:JSON.parse(raw.data_json)},own=r.owner_id===a.id;
 let title=own&&r.status==='draft'?'完善优惠申请':a.role==='财务'&&r.status==='finance_review'?'核算优惠成本':a.role==='管理员'&&r.status==='admin_review'?'审批优惠申请':own&&r.status==='approved'?'登记平台优惠执行':own&&r.status==='stop_required'?'停止优惠并恢复价格':a.role==='财务'&&r.status==='review_pending'?'复盘优惠效果':'';
 if(own&&r.status==='active'&&(await campaignMetrics(db,r)).stopReason)title='停止优惠并恢复价格';
 if(title)tasks.push({tab:'promotions',entity:r.id,level:'red',title,detail:`${r.channel} · ${r.sku} · ${r.owner_name}`});
 }return tasks;
}
