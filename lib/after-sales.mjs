import {recordQualityDelivery,closureActions,mutateQualityClosure,qualityClosureData,settlementProgress,canSupplement} from './quality-closure.mjs';
import {atomicBatch,assertWritable,guardStatement} from './atomic.mjs';
import {reviewToday,validReviewDate} from './business-review-model.mjs';
import {SITE_CURRENCIES,SALES_CURRENCIES} from './sales-data.mjs';
export const reasons=['商品质量问题','仓库发错货','与描述不符合','客户不想要 / 取消','其他'];
export const qualityReasons=['包装错误','标签错误','标识错误','商品质量问题','数量差异','运输破损','其他'];
export const discoveryStages=[{id:'domestic',phase:'售前',label:'入国内集运仓'},{id:'overseas',phase:'售前',label:'入海外仓'},{id:'packing',phase:'售中',label:'打包出库时'},{id:'delivery',phase:'售中',label:'买家到手前'},{id:'customer',phase:'售后',label:'买家到手后反馈'}];
export const discoveryZones=[{id:'+08:00',label:'UTC+8 北京 / 马来西亚 / 菲律宾'},{id:'+07:00',label:'UTC+7 印尼西部 / 泰国 / 越南'},{id:'+09:00',label:'UTC+9 印尼东部'}];
export const responsibilities=['工厂','仓库','运营','客户','其他'];
export class AfterSalesError extends Error {constructor(message,status=400){super(message);this.status=status;}}
const fail=(m,s=400)=>{throw new AfterSalesError(m,s);};
const text=(v,max=2000)=>String(v??'').trim().slice(0,max);
const rows=async(db,sql,args=[]) => (await db.prepare(sql).bind(...args).all()).results||[];
export const canCreate=(actor,kind='after_sale')=>['quality','after_sale','all'].includes(kind)&&(actor.role==='供应链'||actor.role==='销售'||actor.role==='运营'&&['TikTok','Shopee'].includes(actor.channel)&&Boolean(SITE_CURRENCIES[actor.site]));
const readers=['管理员','供应链','工厂','财务'];
export function access(actor){if(!canCreate(actor)&&!readers.includes(actor.role))fail('无权访问售后反馈',403);}
const canRead=(a,r)=>r.owner_id===a.id||readers.includes(a.role)&&r.status!=='draft';
export async function afterRecord(db,actor,id){access(actor);const r=await db.prepare('SELECT * FROM after_sales WHERE id=?').bind(text(id,100)).first();if(!r||!canRead(actor,r))fail('记录不存在或无权访问',404);return {...r,data:JSON.parse(r.data_json)};}
export const auditAfter=(db,a,id,action,detail)=>db.prepare('INSERT INTO audit_logs(id,action,entity_type,entity_id,detail_json,actor_id,actor_name,created_at) VALUES(?,?,?,?,?,?,?,?)').bind(crypto.randomUUID(),'after_sales.'+action,'after_sales',id,JSON.stringify(detail),a.id,a.name,new Date().toISOString());
export function money(value,label){if(value===''||value==null||!/^\d+(\.\d{1,2})?$/.test(String(value)))fail(`${label}请填写非负金额（最多两位小数）`);const cents=Math.round(Number(value)*100);if(!Number.isSafeInteger(cents)||cents>1e14)fail(`${label}超出范围`);return cents;}
export function normalizeCase(p,actor){
 const kind=p.kind||'after_sale',quality=kind==='quality';if(!['after_sale','quality'].includes(kind))fail('记录类型无效');
 const site=actor.role==='销售'?'印尼':actor.role==='运营'?actor.site:text(p.site,30),channel=actor.role==='销售'?'线下批发':actor.role==='运营'?actor.channel:text(p.channel,30);
 if(actor.role==='销售'&&(p.site&&p.site!=='印尼'||p.channel&&p.channel!=='线下批发'))fail('线下销售仅可登记印尼线下批发问题',403);
 if(actor.role==='运营'&&(p.site&&p.site!==actor.site||p.channel&&p.channel!==actor.channel))fail('只能登记本人站点渠道',403);
 if(!(SITE_CURRENCIES[site]||quality&&site==='国内')||!['TikTok','Shopee','线下批发',...(quality?['跨渠道']:[])].includes(channel))fail('请选择有效站点与渠道');
 const businessDate=text(p.businessDate,10),caseNo=text(p.caseNo,100),orderNo=text(p.orderNo,100),sku=text(p.sku,100),reason=text(p.reason,40),description=text(p.description),qty=Number(p.qty);
 if(!validReviewDate(businessDate)||!quality&&businessDate>reviewToday())fail('售后日期无效或晚于今天');
 if(!caseNo||!quality&&!orderNo||!sku||!(quality?qualityReasons:reasons).includes(reason)||description.length<4||!Number.isSafeInteger(qty)||qty<1||qty>1000000)fail('请填写单号、SKU、正整数件数、原因和至少4字说明；售后还须填写订单号');
 const extra={};
 if(quality){
  const discoveredAt=text(p.discoveredAt,16),zone=text(p.discoveryZone,6),stage=discoveryStages.find(s=>s.id===p.discoveryStage),location=text(p.location,160),purchaseNo=text(p.purchaseNo,160),transportNo=text(p.transportNo,160);
  const stamp=Date.parse(discoveredAt+zone);
  if(!/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/.test(discoveredAt)||!validReviewDate(discoveredAt.slice(0,10))||!discoveryZones.some(z=>z.id===zone)||!Number.isFinite(stamp)||stamp>Date.now()||discoveredAt.slice(0,10)!==businessDate)fail('请填写不晚于当前的发现时间及对应时区，日期须与发现日期一致');
  if(!stage||!location||![purchaseNo,transportNo,text(p.batch,160)].some(Boolean))fail('请填写发现环节、具体地点及至少一项采购单/运输单/批次线索');
  const currency=text(p.currency||SITE_CURRENCIES[site]||'CNY',3);if(!SALES_CURRENCIES.includes(currency))fail('损失金额币种无效');
  Object.assign(extra,{discoveredAt,discoveryZone:zone,discoveredUtc:new Date(stamp).toISOString(),discoveryStage:stage.id,phase:stage.phase,location,purchaseNo,transportNo,containment:text(p.containment),currency,lossCents:p.lossAmount===''||p.lossAmount==null?null:money(p.lossAmount,'估计损失金额')});
 }
 const refundCents=quality?0:money(p.refundAmount,'退款金额');
 return {kind,site,channel,businessDate,caseNo,sku,data:{orderNo,qty,reason,description,refundCents,currency:SITE_CURRENCIES[site],factory:text(p.factory,160),warehouse:text(p.warehouse,160),batch:text(p.batch,160),improvement:text(p.improvement),payments:[],...extra}};
}
export function afterSummary(records,kind='after_sale'){
 const live=records.filter(r=>!['draft','void'].includes(r.status));const reasonsCount=(kind==='all'?[...new Set([...qualityReasons,...reasons])]:kind==='quality'?qualityReasons:reasons).map(reason=>({reason,cases:live.filter(r=>r.data.reason===reason).length,qty:live.filter(r=>r.data.reason===reason).reduce((s,r)=>s+r.data.qty,0)}));
 const currencies={};const liable={};
 for(const r of live){const d=r.data,c=currencies[d.currency]??={currency:d.currency,refundCents:0,claimCents:0,paidCents:0,lossCents:0,lossMissing:0};c.refundCents+=d.refundCents;c.lossCents+=d.lossCents||0;if(r.record_kind==='quality'&&d.lossCents==null)c.lossMissing++;c.claimCents+=d.claimCents||0;const paid=(d.payments||[]).filter(p=>!p.reversed).reduce((s,p)=>s+p.amountCents,0);c.paidCents+=paid;c.verifiedPaidCents=(c.verifiedPaidCents||0)+settlementProgress(d).verified;c.unverifiedPaidCents=(c.unverifiedPaidCents||0)+settlementProgress(d).unverified;
 if(d.responsibility){const key=JSON.stringify([d.responsibility,d.responsibility==='工厂'?d.factoryId||d.liableName:d.liableName,d.currency]);const g=liable[key]??={responsibility:d.responsibility,name:d.responsibility==='工厂'?d.factoryName||d.liableName:d.liableName,currency:d.currency,cases:0,qty:0,claimCents:0,paidCents:0};g.cases++;g.qty+=d.qty;g.claimCents+=d.claimCents||0;g.paidCents+=paid;}}
 const daily=Object.values(live.reduce((acc,r)=>{const v=acc[r.business_date]??={date:r.business_date,cases:0,qty:0};v.cases++;v.qty+=r.data.qty;return acc;},{})).sort((a,b)=>a.date.localeCompare(b.date));
 return {daily,cases:live.length,orders:new Set(live.map(r=>`${r.record_kind}|${r.site}|${r.channel}|${r.record_kind==='quality'?r.case_no:r.data.orderNo}`)).size,qty:live.reduce((s,r)=>s+r.data.qty,0),pending:live.filter(r=>r.status==='submitted').length,open:live.filter(r=>r.status!=='closed').length,reasons:reasonsCount.sort((a,b)=>b.qty-a.qty||b.cases-a.cases),currencies:Object.values(currencies),liable:Object.values(liable),stages:discoveryStages.map(s=>({...s,cases:live.filter(r=>(r.data.discoveryStage||(r.record_kind==='after_sale'?'customer':''))===s.id).length,qty:live.filter(r=>(r.data.discoveryStage||(r.record_kind==='after_sale'?'customer':''))===s.id).reduce((n,r)=>n+r.data.qty,0)}))};
}
export async function readAfterSales(db,actor,month,kind='after_sale'){
 access(actor);if(!/^20\d{2}-(0[1-9]|1[0-2])$/.test(month))fail('月份无效');
 if(!['after_sale','quality','all'].includes(kind))fail('记录类型无效');
 const records=(await rows(db,"SELECT * FROM after_sales WHERE (?='all' OR record_kind=?) AND business_date LIKE ? AND (owner_id=? OR (?=1 AND status<>'draft')) ORDER BY business_date DESC,created_at DESC",[kind,kind,month+'-%',actor.id,readers.includes(actor.role)?1:0])).map(r=>({...r,data:JSON.parse(r.data_json)}));
 const files=await rows(db,"SELECT f.id,f.record_id,f.name,f.content_type,f.created_at FROM after_sales_files f JOIN after_sales r ON r.id=f.record_id WHERE (?='all' OR r.record_kind=?) AND r.business_date LIKE ? AND (r.owner_id=? OR (?=1 AND r.status<>'draft'))",[kind,kind,month+'-%',actor.id,readers.includes(actor.role)?1:0]);
 const closure=await qualityClosureData(db,actor,records,month);for(const r of closure.records)r.canSupplement=await canSupplement(db,actor,r);
 return {...closure,actor:{id:actor.id,role:actor.role,site:actor.site,channel:actor.channel},kind,canCreate:canCreate(actor,kind),month,files,summary:afterSummary(closure.records,kind),generatedAt:new Date().toISOString()};
}
export async function afterHistory(db,actor,id){await afterRecord(db,actor,id);return rows(db,"SELECT action,actor_name,created_at,detail_json FROM audit_logs WHERE entity_type='after_sales' AND entity_id=? ORDER BY created_at",[id]);}
export async function mutateAfterSales(db,actor,p){
 access(actor);await assertWritable(db);const now=new Date().toISOString(),action=p.action;
 if(action==='deliveryEvidence')return recordQualityDelivery(db,actor,p);
 if(action==='create'){
  if(!canCreate(actor,p.kind||'after_sale'))fail('仅运营可登记本人售后；供应链可登记售后及品质异常',403);const v=normalizeCase(p,actor);
  const old=await db.prepare('SELECT id FROM after_sales WHERE site=? AND channel=? AND case_no=? AND sku=?').bind(v.site,v.channel,v.caseNo,v.sku).first();if(old)fail('该单据的 SKU 已登记，请查看已有记录，勿重复统计',409);
  const id='as_'+crypto.randomUUID();await atomicBatch(db,[guardStatement(db,actor,'after_sales.create','NOT EXISTS(SELECT 1 FROM after_sales WHERE site=? AND channel=? AND case_no=? AND sku=?)',[v.site,v.channel,v.caseNo,v.sku]),db.prepare('INSERT INTO after_sales(id,record_kind,owner_id,owner_name,site,channel,business_date,case_no,sku,data_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').bind(id,v.kind,actor.id,actor.name,v.site,v.channel,v.businessDate,v.caseNo,v.sku,JSON.stringify(v.data),now,now),auditAfter(db,actor,id,action,v)]);return {ok:true,id};
 }
 const r=await afterRecord(db,actor,p.id);if(p.version!==r.version)fail('记录已更新，请刷新后重试；填写内容仍保留',409);
 if(closureActions.includes(action)&&(action!=='payment'||r.data.responsibility==='工厂'))return mutateQualityClosure(db,actor,p,r,auditAfter);
 const d={...r.data},note=text(p.note),admin=actor.role==='管理员',own=actor.id===r.owner_id;let status=r.status;
 if(action==='save'){
  if(!own||!canCreate(actor,r.record_kind)||r.status!=='draft')fail('仅本人草稿可修改',403);
  const v=normalizeCase({...p,kind:r.record_kind,site:r.site,channel:r.channel,businessDate:r.business_date,caseNo:r.case_no,sku:r.sku},actor);Object.assign(d,v.data);
 }else if(action==='submit'){
  if(!own||!canCreate(actor,r.record_kind)||r.status!=='draft')fail('仅本人草稿可提交',403);
  if(!await db.prepare('SELECT id FROM after_sales_files WHERE record_id=? LIMIT 1').bind(r.id).first())fail('请先上传至少一张截图或照片作为佐证');
  status='submitted';
 }else if(action==='return'){
  if(!admin||r.status!=='submitted'||note.length<4)fail('仅管理员可退回待确认记录，请填写至少4字原因',403);status='draft';
 }else if(action==='comment'){
  if(r.status==='draft'||r.status==='void'||note.length<4)fail('已提交记录才可补充至少4字的处理意见');
 }else if(action==='improve'){
  if(!own||['draft','void'].includes(r.status)||note.length<4)fail('请由登记人补充至少4字的沟通或整改措施');d.improvement=note;
 }else if(action==='confirm'){
  if(!admin||!['submitted','confirmed'].includes(r.status))fail('仅管理员可确认责任和应赔金额',403);
  if(!responsibilities.includes(p.responsibility)||!text(p.liableName,160)||note.length<4)fail('请填写责任类型、具体责任方及至少4字判定依据');
  const claimCents=money(p.claimAmount,'应赔金额'),paid=d.payments.filter(p=>!p.reversed).reduce((s,x)=>s+x.amountCents,0);
  if(claimCents<paid)fail('应赔金额不能小于已登记赔付');
  if(paid&&(d.responsibility!==p.responsibility||d.liableName!==text(p.liableName,160)))fail('已有赔付记录，不能更换责任方');
  if(d.responsibility!==p.responsibility||d.liableName!==text(p.liableName,160)){delete d.factoryId;delete d.factoryName;delete d.factoryLinkEvidence;}
  Object.assign(d,{responsibility:p.responsibility,liableName:text(p.liableName,160),claimCents,decision:note});status='confirmed';
 }else if(action==='payment'){
  if(!admin||r.status!=='confirmed')fail('仅管理员可对已确认记录登记实际赔付',403);
  const amountCents=money(p.amount,'本次实赔'),reference=text(p.reference,160),date=text(p.date,10);
  if(!amountCents||!reference||note.length<4||!validReviewDate(date)||date>reviewToday())fail('请填写正数实赔金额、有效日期、凭证号及至少4字说明');
  if(d.payments.some(x=>x.reference===reference))fail('该赔付凭证已登记，请勿重复提交',409);
  if(amountCents+d.payments.filter(p=>!p.reversed).reduce((s,x)=>s+x.amountCents,0)>d.claimCents)fail('累计实赔不能超过应赔金额');
  d.payments=[...d.payments,{id:crypto.randomUUID(),amountCents,reference,date,note,actor:actor.name,at:now}];
 }else if(action==='close'){
  if(!admin||r.status!=='confirmed'||note.length<4)fail('仅管理员可结案，请填写至少4字结案说明',403);
  if(d.claimCents!==d.payments.filter(p=>!p.reversed).reduce((s,x)=>s+x.amountCents,0))fail('赔偿尚未结清，不能结案');
  if(d.responsibility==='工厂'&&settlementProgress(d).unverified>0)fail('历史赔付尚未关联财务到账/抵扣凭据，请财务核验后结案');
  if((r.record_kind==='quality'||d.reason==='商品质量问题')&&d.rectification?.outcome!=='effective')fail('品质整改尚未经过独立复查确认有效；赔偿结清不等于整改完成');
  if(['客户不想要 / 取消','与描述不符合'].includes(d.reason)&&!d.improvement?.trim())fail('请运营先补充客户沟通或链接优化措施');status='closed';
 }else if(action==='reopenCase'){
  if(!admin||r.status!=='closed'||note.length<4)fail('管理员填写原因后重新打开结案记录',403);status='confirmed';
 }else if(action==='void'){
  if(!(own&&r.status==='draft'||admin&&['submitted','confirmed'].includes(r.status))||d.payments.length||note.length<4)fail('仅可作废未赔付记录，须填写原因',403);status='void';
 }else fail('不支持的售后操作');
 await atomicBatch(db,[guardStatement(db,actor,'after_sales.'+action,'EXISTS(SELECT 1 FROM after_sales WHERE id=? AND version=? AND status=?)',[r.id,r.version,r.status]),db.prepare('UPDATE after_sales SET data_json=?,status=?,version=version+1,updated_at=? WHERE id=?').bind(JSON.stringify(d),status,now,r.id),auditAfter(db,actor,r.id,action,{note,status,data:d,version:r.version+1})]);return {ok:true,id:r.id};
}

export async function afterTasks(db,actor){
 if(actor.role!=='管理员'&&!canCreate(actor))return [];
 const pending=await rows(db,"SELECT record_kind,business_date,status,data_json FROM after_sales WHERE status IN ('draft','submitted','confirmed') AND (owner_id=? OR (?=1 AND status<>'draft'))",[actor.id,actor.role==='管理员'?1:0]);
 const counts={};for(const r of pending){const d=JSON.parse(r.data_json);if(actor.role!=='管理员'&&r.status!=='draft'&&(r.record_kind!=='quality'&&!['客户不想要 / 取消','与描述不符合'].includes(d.reason)||d.improvement))continue;const key=r.record_kind+'|'+r.business_date.slice(0,7);counts[key]=(counts[key]||0)+1;}
 return Object.entries(counts).map(([key,n])=>{const [kind,month]=key.split('|');return {tab:'quality-incidents',month,level:'red',title:kind==='quality'?'跟进品质异常与整改':actor.role==='管理员'?'跟进售后责任与赔付':'完善售后反馈及改进',detail:`${month} · ${n}条待处理，请在对应页面选择该月份`};});
}
