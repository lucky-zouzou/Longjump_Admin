import {atomicBatch,assertWritable,guardStatement} from './atomic.mjs';
import {reviewToday,validReviewDate} from './business-review-model.mjs';
import {SITE_CURRENCIES} from './sales-data.mjs';
export const reasons=['商品质量问题','仓库发错货','与描述不符合','客户不想要 / 取消','其他'];
export const responsibilities=['工厂','仓库','运营','客户','其他'];
export class AfterSalesError extends Error {constructor(message,status=400){super(message);this.status=status;}}
const fail=(m,s=400)=>{throw new AfterSalesError(m,s);};
const text=(v,max=2000)=>String(v??'').trim().slice(0,max);
const rows=async(db,sql,args=[]) => (await db.prepare(sql).bind(...args).all()).results||[];
export const canCreate=actor=>actor.role==='运营'&&['TikTok','Shopee'].includes(actor.channel)&&Boolean(SITE_CURRENCIES[actor.site]);
const readers=['管理员','供应链','工厂'];
export function access(actor){if(!canCreate(actor)&&!readers.includes(actor.role))fail('无权访问售后反馈',403);}
const canRead=(a,r)=>r.owner_id===a.id||readers.includes(a.role)&&r.status!=='draft';
export async function afterRecord(db,actor,id){access(actor);const r=await db.prepare('SELECT * FROM after_sales WHERE id=?').bind(text(id,100)).first();if(!r||!canRead(actor,r))fail('记录不存在或无权访问',404);return {...r,data:JSON.parse(r.data_json)};}
export const auditAfter=(db,a,id,action,detail)=>db.prepare('INSERT INTO audit_logs(id,action,entity_type,entity_id,detail_json,actor_id,actor_name,created_at) VALUES(?,?,?,?,?,?,?,?)').bind(crypto.randomUUID(),'after_sales.'+action,'after_sales',id,JSON.stringify(detail),a.id,a.name,new Date().toISOString());
export function money(value,label){if(value===''||value==null||!/^\d+(\.\d{1,2})?$/.test(String(value)))fail(`${label}请填写非负金额（最多两位小数）`);const cents=Math.round(Number(value)*100);if(!Number.isSafeInteger(cents)||cents>1e14)fail(`${label}超出范围`);return cents;}
export function normalizeCase(p,actor){
 const businessDate=text(p.businessDate,10),caseNo=text(p.caseNo,100),orderNo=text(p.orderNo,100),sku=text(p.sku,100),reason=text(p.reason,40),description=text(p.description),qty=Number(p.qty);
 if(!validReviewDate(businessDate)||businessDate>reviewToday())fail('售后日期无效或晚于今天');
 if(!caseNo||!orderNo||!sku||!reasons.includes(reason)||description.length<4||!Number.isSafeInteger(qty)||qty<1||qty>1000000)fail('请填写售后单号、订单号、SKU、正整数件数、原因和至少4字说明');
 const refundCents=money(p.refundAmount,'退款金额');
 return {businessDate,caseNo,sku,data:{orderNo,qty,reason,description,refundCents,currency:SITE_CURRENCIES[actor.site],factory:text(p.factory,160),warehouse:text(p.warehouse,160),batch:text(p.batch,160),improvement:text(p.improvement),payments:[]}};
}
export function afterSummary(records){
 const live=records.filter(r=>!['draft','void'].includes(r.status));const reasonsCount=reasons.map(reason=>({reason,cases:live.filter(r=>r.data.reason===reason).length,qty:live.filter(r=>r.data.reason===reason).reduce((s,r)=>s+r.data.qty,0)}));
 const currencies={};const liable={};
 for(const r of live){const d=r.data,c=currencies[d.currency]??={currency:d.currency,refundCents:0,claimCents:0,paidCents:0};c.refundCents+=d.refundCents;c.claimCents+=d.claimCents||0;const paid=(d.payments||[]).reduce((s,p)=>s+p.amountCents,0);c.paidCents+=paid;
 if(d.responsibility){const key=JSON.stringify([d.responsibility,d.liableName,d.currency]);const g=liable[key]??={responsibility:d.responsibility,name:d.liableName,currency:d.currency,cases:0,qty:0,claimCents:0,paidCents:0};g.cases++;g.qty+=d.qty;g.claimCents+=d.claimCents||0;g.paidCents+=paid;}}
 const daily=Object.values(live.reduce((acc,r)=>{const v=acc[r.business_date]??={date:r.business_date,cases:0,qty:0};v.cases++;v.qty+=r.data.qty;return acc;},{})).sort((a,b)=>a.date.localeCompare(b.date));
 return {daily,cases:live.length,orders:new Set(live.map(r=>`${r.site}|${r.channel}|${r.data.orderNo}`)).size,qty:live.reduce((s,r)=>s+r.data.qty,0),pending:live.filter(r=>r.status==='submitted').length,open:live.filter(r=>r.status!=='closed').length,reasons:reasonsCount,currencies:Object.values(currencies),liable:Object.values(liable)};
}
export async function readAfterSales(db,actor,month){
 access(actor);if(!/^20\d{2}-(0[1-9]|1[0-2])$/.test(month))fail('月份无效');
 const records=(await rows(db,"SELECT * FROM after_sales WHERE business_date LIKE ? AND (owner_id=? OR (?=1 AND status<>'draft')) ORDER BY business_date DESC,created_at DESC",[month+'-%',actor.id,readers.includes(actor.role)?1:0])).map(r=>({...r,data:JSON.parse(r.data_json)}));
 const files=await rows(db,"SELECT f.id,f.record_id,f.name,f.created_at FROM after_sales_files f JOIN after_sales r ON r.id=f.record_id WHERE r.business_date LIKE ? AND (r.owner_id=? OR (?=1 AND r.status<>'draft'))",[month+'-%',actor.id,readers.includes(actor.role)?1:0]);
 return {actor:{id:actor.id,role:actor.role},canCreate:canCreate(actor),month,records,files,summary:afterSummary(records),generatedAt:new Date().toISOString()};
}
export async function afterHistory(db,actor,id){await afterRecord(db,actor,id);return rows(db,"SELECT action,actor_name,created_at,detail_json FROM audit_logs WHERE entity_type='after_sales' AND entity_id=? ORDER BY created_at",[id]);}
export async function mutateAfterSales(db,actor,p){
 access(actor);await assertWritable(db);const now=new Date().toISOString(),action=p.action;
 if(action==='create'){
  if(!canCreate(actor))fail('仅运营可登记本人售后',403);const v=normalizeCase(p,actor);
  const old=await db.prepare('SELECT id FROM after_sales WHERE site=? AND channel=? AND case_no=? AND sku=?').bind(actor.site,actor.channel,v.caseNo,v.sku).first();if(old)fail('该售后单的 SKU 已登记，请查看已有记录，勿重复统计',409);
  const id='as_'+crypto.randomUUID();await atomicBatch(db,[guardStatement(db,actor,'after_sales.create','NOT EXISTS(SELECT 1 FROM after_sales WHERE site=? AND channel=? AND case_no=? AND sku=?)',[actor.site,actor.channel,v.caseNo,v.sku]),db.prepare('INSERT INTO after_sales(id,owner_id,owner_name,site,channel,business_date,case_no,sku,data_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').bind(id,actor.id,actor.name,actor.site,actor.channel,v.businessDate,v.caseNo,v.sku,JSON.stringify(v.data),now,now),auditAfter(db,actor,id,action,v)]);return {ok:true,id};
 }
 const r=await afterRecord(db,actor,p.id);if(p.version!==r.version)fail('记录已更新，请刷新后重试；填写内容仍保留',409);
 const d={...r.data},note=text(p.note),admin=actor.role==='管理员',own=actor.id===r.owner_id;let status=r.status;
 if(action==='save'){
  if(!own||!canCreate(actor)||r.status!=='draft')fail('仅本人草稿可修改',403);
  const v=normalizeCase({...p,businessDate:r.business_date,caseNo:r.case_no,sku:r.sku},actor);Object.assign(d,v.data);
 }else if(action==='submit'){
  if(!own||!canCreate(actor)||r.status!=='draft')fail('仅本人草稿可提交',403);
  if(!await db.prepare('SELECT id FROM after_sales_files WHERE record_id=? LIMIT 1').bind(r.id).first())fail('请先上传至少一张截图或照片作为佐证');
  status='submitted';
 }else if(action==='return'){
  if(!admin||r.status!=='submitted'||note.length<4)fail('仅管理员可退回待确认记录，请填写至少4字原因',403);status='draft';
 }else if(action==='comment'){
  if(r.status==='draft'||r.status==='void'||note.length<4)fail('已提交记录才可补充至少4字的处理意见');
 }else if(action==='improve'){
  if(!own||['draft','void'].includes(r.status)||note.length<4)fail('请由原运营补充至少4字的客户沟通或链接优化措施');d.improvement=note;
 }else if(action==='confirm'){
  if(!admin||!['submitted','confirmed'].includes(r.status))fail('仅管理员可确认责任和应赔金额',403);
  if(!responsibilities.includes(p.responsibility)||!text(p.liableName,160)||note.length<4)fail('请填写责任类型、具体责任方及至少4字判定依据');
  const claimCents=money(p.claimAmount,'应赔金额'),paid=d.payments.reduce((s,x)=>s+x.amountCents,0);
  if(claimCents<paid)fail('应赔金额不能小于已登记赔付');
  if(paid&&(d.responsibility!==p.responsibility||d.liableName!==text(p.liableName,160)))fail('已有赔付记录，不能更换责任方');
  Object.assign(d,{responsibility:p.responsibility,liableName:text(p.liableName,160),claimCents,decision:note});status='confirmed';
 }else if(action==='payment'){
  if(!admin||r.status!=='confirmed')fail('仅管理员可对已确认记录登记实际赔付',403);
  const amountCents=money(p.amount,'本次实赔'),reference=text(p.reference,160),date=text(p.date,10);
  if(!amountCents||!reference||note.length<4||!validReviewDate(date)||date>reviewToday())fail('请填写正数实赔金额、有效日期、凭证号及至少4字说明');
  if(d.payments.some(x=>x.reference===reference))fail('该赔付凭证已登记，请勿重复提交',409);
  if(amountCents+d.payments.reduce((s,x)=>s+x.amountCents,0)>d.claimCents)fail('累计实赔不能超过应赔金额');
  d.payments=[...d.payments,{id:crypto.randomUUID(),amountCents,reference,date,note,actor:actor.name,at:now}];
 }else if(action==='close'){
  if(!admin||r.status!=='confirmed'||note.length<4)fail('仅管理员可结案，请填写至少4字结案说明',403);
  if(d.claimCents!==d.payments.reduce((s,x)=>s+x.amountCents,0))fail('赔偿尚未结清，不能结案');
  if(['客户不想要 / 取消','与描述不符合'].includes(d.reason)&&!d.improvement?.trim())fail('请运营先补充客户沟通或链接优化措施');status='closed';
 }else if(action==='void'){
  if(!(own&&r.status==='draft'||admin&&['submitted','confirmed'].includes(r.status))||d.payments.length||note.length<4)fail('仅可作废未赔付记录，须填写原因',403);status='void';
 }else fail('不支持的售后操作');
 await atomicBatch(db,[guardStatement(db,actor,'after_sales.'+action,'EXISTS(SELECT 1 FROM after_sales WHERE id=? AND version=? AND status=?)',[r.id,r.version,r.status]),db.prepare('UPDATE after_sales SET data_json=?,status=?,version=version+1,updated_at=? WHERE id=?').bind(JSON.stringify(d),status,now,r.id),auditAfter(db,actor,r.id,action,{note,status,data:d,version:r.version+1})]);return {ok:true,id:r.id};
}

export async function afterTasks(db,actor){
 if(actor.role!=='管理员'&&!canCreate(actor))return [];
 const pending=await rows(db,"SELECT business_date,status,data_json FROM after_sales WHERE status IN ('draft','submitted','confirmed') AND (owner_id=? OR (?=1 AND status<>'draft'))",[actor.id,actor.role==='管理员'?1:0]);
 const counts={};for(const r of pending){const d=JSON.parse(r.data_json);if(actor.role!=='管理员'&&r.status!=='draft'&&(!['客户不想要 / 取消','与描述不符合'].includes(d.reason)||d.improvement))continue;const month=r.business_date.slice(0,7);counts[month]=(counts[month]||0)+1;}
 return Object.entries(counts).map(([month,n])=>({tab:'after-sales',level:'red',title:actor.role==='管理员'?'跟进售后责任与赔付':'完善售后反馈及改进',detail:`${month} · ${n}条待处理，请在售后页面选择该月份`}));
}
