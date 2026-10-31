export const creatorSites=['印尼','马来西亚','泰国','越南','菲律宾'];
export const creatorStates={candidate:'候选',contacted:'已触达',replied:'有回复',handoff:'待BD',negotiating:'洽谈中',fulfilling:'履约中',maintaining:'复盘维护',paused:'暂停'};
export const creatorTiers={trial:'试合作',growing:'成长',core:'核心',paused:'暂停'};
export const roundStates={draft:'待送审',pending:'待管理员审批',approved:'已批准待执行',executing:'履约中',completed:'交付完成',cancelled:'已终止'};
export const creatorFees={product:'已售商品成本',platform:'平台及交易费用',commission:'达人佣金',logistics:'履约物流与售后成本',samples:'样品成本',sampleFreight:'寄样运费',reward:'达人费用与奖励',ads:'可归属广告费'};
export const creatorZones={印尼:'+07:00',马来西亚:'+08:00',泰国:'+07:00',越南:'+07:00',菲律宾:'+08:00'};
export function fail(message,status=400){const e=new Error(message);e.status=status;throw e;}
export function txt(v,max=2000){if(v!=null&&!['string','number'].includes(typeof v))fail('填写内容格式无效');const s=String(v??'').trim();if(s.length>max)fail('填写内容过长');return s;}
export function required(v,label,max=2000){const s=txt(v,max);if(!s)fail('请填写'+label);return s;}
export function link(v,label='证据链接'){const s=required(v,label,1500);try{const u=new URL(s);if(!['https:','http:'].includes(u.protocol)||u.username||u.password)throw Error();u.hash='';return u.toString();}catch{fail(label+'须为有效的网页链接');}}
export function contentLink(v){const u=new URL(link(v,'内容链接'));for(const k of [...u.searchParams.keys()])if(/^utm_/i.test(k)||['is_from_webapp','sender_device','share_app_id','share_link_id','share_iid','share_item_id','share_author_id','refer'].includes(k))u.searchParams.delete(k);u.searchParams.sort();return u.toString();}
export function instant(v,label='时间'){const s=required(v,label,50);if(!/(Z|[+-]\d\d:\d\d)$/.test(s)||!Number.isFinite(Date.parse(s)))fail(label+'须包含有效时区');return new Date(s).toISOString();}
export function integer(v,label,min=0,max=100000000){const n=Number(v);if(!['string','number'].includes(typeof v)||String(v).trim()===''||!Number.isSafeInteger(n)||n<min||n>max)fail(label+'须为有效整数');return n;}
export function minor(v,label){if(!['string','number'].includes(typeof v)||!/^\d+(\.\d{1,2})?$/.test(String(v)))fail(label+'请填明确金额，未知不能填0');const n=Math.round(Number(v)*100);if(!Number.isSafeInteger(n)||n>1e14)fail(label+'超出范围');return n;}
export function canonicalId(v){const value=required(required(v,'平台唯一ID',200).normalize('NFKC').replace(/^@/,'').trim().toLowerCase(),'平台唯一ID',200);if(/\s/.test(value))fail('平台唯一ID不能包含空格');return value;}
export function financeValue(round,finances){const f=finances.filter(x=>x.round_id===round.id).sort((a,b)=>b.revision-a.revision)[0];return f&&f.basis_version===round.version?f:null;}
const day=86400000;
export function creatorMetrics(profiles,rounds,contents,finances,now=new Date()){
 const completed=rounds.filter(r=>r.status==='completed'),mature=profiles.filter(p=>p.first_contact_at&&Date.parse(p.first_contact_at)+7*day<=+now),accepted=profiles.filter(p=>p.accepted_at),ready=accepted.filter(p=>Date.parse(p.accepted_at)+14*day<=+now);
 const rate=(n,d)=>({numerator:n,denominator:d,value:d?n/d:null,smallSample:d<10});
 const first=p=>completed.filter(r=>r.creator_id===p.id).sort((a,b)=>a.completed_at.localeCompare(b.completed_at));
 const repeat=profiles.filter(p=>first(p)[0]&&Date.parse(first(p)[0].completed_at)+60*day<=+now);
 const due=rounds.filter(r=>!['draft','pending','cancelled'].includes(r.status)&&Date.parse(r.effective_due_at)<=+now);
 const originalDue=rounds.filter(r=>!['draft','pending','cancelled'].includes(r.status)&&Date.parse(r.original_due_at)<=+now);
 const values=rounds.map(r=>financeValue(r,finances)).filter(Boolean);
 return {
  profiles:profiles.length,people:new Set(profiles.map(p=>p.platform+'|'+p.platform_id)).size,
  pendingHandoffs:profiles.filter(p=>p.state==='handoff').length,negotiating:profiles.filter(p=>p.state==='negotiating').length,
  dueActions:profiles.filter(p=>p.state!=='paused'&&p.next_at&&Date.parse(p.next_at)<=+now).length,
  overdue:due.filter(r=>!r.completed_at).length,completed:completed.length,acceptedContents:contents.filter(c=>c.status==='accepted').length,
  reply7:rate(mature.filter(p=>p.first_reply_at&&Date.parse(p.first_reply_at)<=Date.parse(p.first_contact_at)+7*day).length,mature.length),
  contactImmature:profiles.filter(p=>p.first_contact_at&&!mature.includes(p)).length,
  first14:rate(ready.filter(p=>rounds.some(r=>r.creator_id===p.id&&r.approved_at&&Date.parse(r.approved_at)<=Date.parse(p.accepted_at)+14*day)).length,ready.length),
  acceptedImmature:accepted.length-ready.length,
  repeat60:rate(repeat.filter(p=>first(p)[1]&&Date.parse(first(p)[1].completed_at)<=Date.parse(first(p)[0].completed_at)+60*day).length,repeat.length),
  repeatImmature:profiles.filter(p=>first(p)[0]).length-repeat.length,
  onTime:rate(due.filter(r=>r.completed_at&&r.completed_at<=r.effective_due_at).length,due.length),
  originalOnTime:rate(originalDue.filter(r=>r.completed_at&&r.completed_at<=r.original_due_at).length,originalDue.length),
  verifiedProfitCny:values.length?values.reduce((s,f)=>s+f.data.profitCnyMinor,0)/100:null,financePending:rounds.filter(r=>r.approved_at&&!financeValue(r,finances)).length,
  currencies:[...new Set(values.map(f=>f.data.currency))].map(currency=>({currency,profit:values.filter(f=>f.data.currency===currency).reduce((s,f)=>s+f.data.profitMinor,0)/100})),
 };
}
export function creatorTasks(snapshot,now=new Date()){
 const {profiles,rounds,actor}=snapshot,out=[];
 for(const p of profiles){
  const handoff=p.state==='handoff'&&['管理员','达人BD'].includes(actor.role),delivery=rounds.some(r=>r.creator_id===p.id&&['approved','executing'].includes(r.status))&&p.next_action==='按批准条件寄样并跟进交付';
  if(handoff)out.push({kind:'handoff',id:p.id,title:'承接达人交接',name:p.name,site:p.site,dueAt:p.next_at});
  if(!handoff&&!delivery&&p.state!=='paused'&&p.next_at&&(p.next_owner_id===actor.id||actor.role==='管理员'))out.push({kind:'follow',id:p.id,title:p.next_action,name:p.name,site:p.site,dueAt:p.next_at});
 }
 for(const r of rounds){const p=profiles.find(p=>p.id===r.creator_id);if(!p)continue;
  if(r.status==='pending'&&actor.role==='管理员')out.push({kind:'approval',id:p.id,title:'审核合作条件 '+r.round_no,name:p.name,site:p.site,dueAt:r.original_due_at});
  if(['approved','executing'].includes(r.status)&&['管理员','运营','达人BD'].includes(actor.role))out.push({kind:'delivery',id:p.id,title:'跟进寄样及交付 '+r.round_no,name:p.name,site:p.site,dueAt:r.effective_due_at});
 }
 return out.sort((a,b)=>(a.dueAt||'9999').localeCompare(b.dueAt||'9999')).map(t=>({...t,overdue:Boolean(t.dueAt&&Date.parse(t.dueAt)<+now)}));
}
