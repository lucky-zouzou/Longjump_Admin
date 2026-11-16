"use client";
import {useCallback,useEffect,useState} from 'react';
import {parseWorkspaceResponse} from '../lib/workspace-response.mjs';
import {useVisibleRefresh} from './workspace-hooks';
type Row=Record<string,any>;
export default function EvidenceSummary({go}:{go:(tab:string,task?:Row)=>void}){
 const [data,setData]=useState<Row|null>(null),[error,setError]=useState('');
 const load=useCallback(async(signal?:AbortSignal)=>{
  try{const d=await parseWorkspaceResponse(await fetch('/api/business-actions?evidence=summary',{cache:'no-store',signal}));
   if(!signal?.aborted){setData(d);setError('');}
  }catch(e){if(!signal?.aborted)setError((e as Error).message);}
 },[]);
 useEffect(()=>{const c=new AbortController();void load(c.signal);return()=>c.abort();},[load]);
 useVisibleRefresh(()=>load(),60000,true);
 return <section className="overview-card"><header><div><h2>今天先补哪份资料</h2><p>优先显示本人负责、影响商品更多的核对任务。</p></div><button className="overview-link" onClick={()=>go('business-actions',{view:'evidence'})}>查看核对任务{data?' · '+data.count:''} →</button></header>
 {error?<p role="alert">{error} <button className="btn" onClick={()=>void load()}>重试</button></p>:!data?<p>正在读取共同缺口…</p>:data.items.length?<div className="overview-task-list">{data.items.map((t:Row)=><button key={t.key} className="overview-task" onClick={()=>go('business-actions',{view:'evidence',entity:t.key})}><span className="task-copy"><strong>{t.title} · {t.site} / {t.channel} · {t.date||'当前'}</strong><span>{t.skuCount} 个 SKU{t.showValue&&<> · 已知可售库存参考货值 {t.valueCny==null?'待核实':'¥'+t.valueCny.toLocaleString('zh-CN',{maximumFractionDigits:2})}{t.unknown?' · '+t.unknown+' 款货值待核实':''}</>} · {t.owner||('待分配 · '+(t.suggested?'建议 '+t.suggested:t.role))}{t.status==='review_ready'?' · 来源已补齐，待复查':''}</span></span></button>)}</div>:<p>当前岗位没有待补的共同资料。</p>}</section>;
}
