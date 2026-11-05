"use client";
import {useState} from 'react';
import {clearanceDuties,compareClearanceTasks,clearanceTaskForActor} from '../lib/clearance-oversight.mjs';
type Row=Record<string,any>;

export default function ClearanceOversight({items,actor,users,site,setSite,sites,onOpen}:{items:Row[];actor:Row;users:Row[];site:string;setSite:(s:string)=>void;sites:string[];onOpen:(id:string)=>void}){
 const [role,setRole]=useState(['运营','财务'].includes(actor.role)?actor.role:''),[limit,setLimit]=useState(8);
 const name=(id:string)=>users.find(u=>u.id===id)?.name||id;
 const scoped=items.filter(r=>!site||r.site===site),all=scoped.flatMap(r=>(r.oversight?.tasks||[]).map((t:Row)=>({...t,line:r}))).sort(compareClearanceTasks);
 const tasks=all.filter(t=>(!role||t.role===role)&&(actor.role!=='运营'||t.role!=='运营'||t.ownerId===actor.id));
 return <section className="panel cl-oversight" aria-label="清仓三方行动台">
  <div className="cl-section-head"><div><span className="cl-eyebrow">发现 → 行动 → 日报验证 → 七天复盘</span><h2>今天推动哪些商品去库存</h2><p>同一计划持续跟进；已处理事项自动移出，数据修订后重新提示。</p></div><label className="cl-oversight-site">查看站点<select aria-label="清仓行动站点" value={site} onChange={e=>{setSite(e.target.value);setLimit(8);}}><option value="">全部可见站点</option>{sites.map(s=><option key={s}>{s}</option>)}</select></label></div>
  <div className="cl-duty-cards">{Object.entries(clearanceDuties).map(([key,d])=><button key={key} aria-pressed={role===key} className={role===key?'selected':''} onClick={()=>{setRole(role===key?'':key);setLimit(8);}}><span>{d.title}</span><b>{all.filter(t=>t.role===key&&(key!=='运营'||actor.role!=='运营'||t.ownerId===actor.id)).length}<small> 项待处理</small></b><p>{d.description}</p></button>)}</div>
  <div className="cl-oversight-meta"><span>{role||'三方全部'} · {tasks.length} 项{all.some(t=>t.priority===0)&&<b> · {all.filter(t=>t.priority===0).length} 项风险需先核对</b>}</span><button className="cl-text-button" onClick={()=>{setRole('');setLimit(8);}}>查看三方全部</button></div>
  {!tasks.length?<div className="cl-oversight-empty">{!items.length?'先从下方零动销商品池选择 SKU，申请促销价并指定运营。':'当前分工没有待处理事项。继续监测每日销量和库存，到复盘日再核对效果。'}</div>:<ul className="cl-duty-list">{tasks.slice(0,limit).map(t=><li key={t.id} className={t.priority===0?'risk':''}><div className="cl-duty-product"><b>{t.line.sku}</b><span>{t.line.site} · {t.line.channel}</span><small>{t.line.status==='active'?'执行中':t.line.status==='completed'?'结案复核':'准备与审批'}</small></div><div className="cl-duty-action"><strong>{t.title}</strong><p>{t.detail}</p><small>主责：{t.role==='运营'?name(t.ownerId):t.role+'岗位'}{t.due?` · 建议处理日 ${t.due}`:''}{t.overdue?' · 已逾期':''}</small></div><button className="btn" onClick={()=>onOpen(t.line.id)}>{clearanceTaskForActor(t,actor)?'查看并处理':'查看协作进度'} →</button></li>)}</ul>}
  {tasks.length>limit&&<button className="btn" onClick={()=>setLimit(limit+12)}>继续查看待办（还有 {tasks.length-limit} 项）</button>}
  <p className="cl-muted">优先显示库存不一致、超预算／亏损风险，其次缺报、待核算和到期复盘。数量统计的是待办事项，同一 SKU 可需多人协作；财务和管理员保留原审批权限。</p>
 </section>;
}

export function ClearanceFollowup({r,users}:{r:Row;users:Row[]}){
 const o=r.oversight;if(!o)return null;
 const name=(id:string)=>users.find(u=>u.id===id)?.name||id;
 const labels:Row={not_started:'待平台执行',verify:'数据待核对',sales_observed:'期间已出现销量',pending:'日报待齐，效果待核实',no_sales:'已报日期仍无销量'};
 return <div className="cl-followup"><div><small>去库存跟进</small><b>{labels[o.outcome]}</b><span>运营主责：{name(o.ownerId)}</span></div><div><small>最近运营动作</small><b>{o.lastAction?.date||'尚未登记执行'}</b><span>{o.lastAction?`${name(o.lastAction.actorId)} · ${o.lastAction.note||'已登记平台执行'}`:'按批准方案操作后留下凭据'}</span></div><div><small>财务支持记录</small><b>{o.lastSupport?.date||'尚无支持记录'}</b><span>{o.lastSupport?`${name(o.lastSupport.actorId)} · ${o.lastSupport.note}`:'预算批准不等于已支付费用'}</span></div><div><small>下一复盘区间截止</small><b>{o.nextReview||(r.started_on?'本期复盘已完成':'执行后每7天')}</b><span>{o.reviewPending?`${o.reviewPending} 期需复盘／重算`:'周期结束后核对销量、余货及损益'}</span></div></div>;
}
