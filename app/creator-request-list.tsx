"use client";
import {useState} from 'react';
type Row=Record<string,any>;
const states:Record<string,string>={pending:'待BD接收',following:'BD跟进中',executing:'合作执行中',completed:'已完成',cancelled:'已取消'};
const methods:Record<string,string>={commission:'纯佣',paid:'付费',mixed:'佣金＋付费'};
const date=(v:string)=>new Date(v).toLocaleString('zh-CN',{hour12:false});
function Terms({terms:t}:{terms:Row}){
 return <dl className="creator-request-terms">{[
  ['产品与样品',t.items.map((i:Row)=>i.sku+' × '+i.sampleQty+' 件').join('、')],
  ['合作条件',methods[t.method]+' · 佣金 '+t.commission+'%'],
  ['交付',t.videos+' 条视频 / '+t.lives+' 场直播 · '+date(t.dueAt)],
  ['达人联系方式',t.contact],['具体优惠活动',t.promotion],['验收要求',t.requirements],['合作备注',t.cooperationNote],
 ].filter(([,value])=>value).map(([key,value])=><div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl>;
}
export function RequestList({data,profiles,open,save,busy,onProfile,onRound}:{data:Row;profiles:Row[];open:(a:string,p:Row,r:null,e:Row)=>void;save:(p:Row)=>Promise<void>;busy:boolean;onProfile:(id:string)=>void;onRound:(p:string)=>void}){
 const [filter,setFilter]=useState('all'),[selected,setSelected]=useState<Record<string,number>>({});
 const people=new Map(profiles.map(p=>[p.id,p])),rows=data.requests.filter((q:Row)=>people.has(q.creator_id)&&(filter==='all'||q.state===filter));
 const bd=data.actor.role==='达人BD',selection=rows.filter((q:Row)=>q.state==='pending'&&selected[q.id]===q.version).map((q:Row)=>({requestId:q.id,version:q.version}));
 return <section className="panel creator-request-list"><div className="creator-section-title"><div><h2>合作需求</h2><p>运营或BD从达人档案发起，调用档案联系方式；确认合作条件后进入履约。</p></div><div className="creator-actions"><select aria-label="需求状态" value={filter} onChange={e=>{setFilter(e.target.value);setSelected({});}}><option value="all">全部状态</option>{Object.entries(states).map(([k,v])=><option value={k} key={k}>{v}</option>)}</select>{bd&&<button className="btn primary" disabled={busy||!selection.length||selection.length>50} onClick={()=>void save({action:'requestAccept',selection})}>批量接收（{selection.length}）</button>}</div></div>
 {rows.map((q:Row)=>{const p=people.get(q.creator_id)!,t=q.terms,owner=q.author_id===data.actor.id,extra={requestId:q.id,version:q.version};return <article className="creator-round" key={q.id} id={'creator-request-'+q.id}><div className="creator-section-title"><div>{bd&&q.state==='pending'&&<input aria-label={'选择 '+p.name+' 的需求'} type="checkbox" checked={selected[q.id]===q.version} onChange={e=>setSelected({...selected,[q.id]:e.target.checked?q.version:0})}/>} <button className="creator-link" onClick={()=>onProfile(p.id)}>{p.name}</button> <span className="creator-tag">{states[q.state]}</span><small>{p.site} · {p.shop} · {date(q.created_at)} · v{q.version}</small></div><div className="creator-actions">
 {owner&&['pending','following'].includes(q.state)&&<button className="btn" onClick={()=>open('requestEdit',p,null,{...t,...extra,dueAt:new Date(Date.parse(t.dueAt)-new Date(t.dueAt).getTimezoneOffset()*60000).toISOString().slice(0,19),contentFormat:t.videos&&t.lives?'both':t.lives?'live':'video'})}>修改条件</button>}
 {(owner&&q.state==='pending'||bd&&['pending','following'].includes(q.state))&&<button className="btn" onClick={()=>open('requestCancel',p,null,extra)}>{owner?'撤回需求':'取消需求'}</button>}
 {bd&&q.state==='pending'&&<button className="btn primary" disabled={busy} onClick={()=>void save({action:'requestAccept',...extra})}>接收需求</button>}
 {bd&&q.state==='following'&&<button className="btn primary" onClick={()=>open('requestConfirm',p,null,{...extra,terms:t})}>确认合作条件</button>}
 {q.round_id&&<button className="btn" onClick={()=>onRound(q.round_id)}>查看本轮履约 →</button>}</div></div>
 <Terms terms={t}/>{data.events.some((e:Row)=>e.detail.requestId===q.id&&e.action==='requestEdit')&&<details><summary>运营已修订条件 · 查看变更</summary>{data.events.filter((e:Row)=>e.detail.requestId===q.id&&e.action==='requestEdit').map((e:Row)=><div key={e.id}><b>{date(e.created_at)} · {e.actor_name}</b><p>修改前</p><Terms terms={e.detail.before}/><p>修改后</p><Terms terms={e.detail.after}/></div>)}</details>}</article>;})}
 {!rows.length&&<p className="creator-empty">当前范围暂无合作需求</p>}</section>;
}
export {Terms};
