"use client";
import SkuLabel from './sku-label';

import {useEffect,useId,useState} from 'react';
import {HISTORY_CHANNELS,HISTORY_SITES,previousPlanMonth} from '../lib/replenishment-history.mjs';
import {parseWorkspaceResponse} from '../lib/workspace-response.mjs';
import './replenishment-history.css';

type Actor={id?:string;role:string;site?:string|null;channel?:string|null};
type Detail={id:string;site:string;channel:string;sku:string;name:string;submittedQty:number|null;planQty:number|null;reason:string};
type Submission={id:string;site:string;channel:string;version:number;submittedAt:string;actorName:string;zeroDemand:boolean;zeroReason:string;skuCount:number;totalQty:number};
type History={month:string;months:string[];plan:null|{id:string;status:string;version:number;updatedAt:string};submissions:Submission[];rows:Detail[];summary:{skuCount:number;submissionCount:number;submittedQty:number|null;planQty:number|null}};
const statusLabels:Record<string,string>={approved:'已批准',pending:'待审批',withdrawn:'已撤回',rejected:'已驳回'};
const fmt=(value:number|null)=>value===null?'—':value.toLocaleString('zh-CN');
const time=(value:string)=>{const d=new Date(value);return Number.isFinite(d.valueOf())?d.toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'时间待核实';};

export default function ReplenishmentHistory({actor,currentMonth,refreshToken}:{actor:Actor;currentMonth:string;refreshToken:string}){
  const lastMonth=previousPlanMonth(currentMonth),id=useId(),restricted=actor.role==='运营';
  const [open,setOpen]=useState(false),[month,setMonth]=useState(lastMonth),[site,setSite]=useState(''),[channel,setChannel]=useState('');
  const [search,setSearch]=useState(''),[page,setPage]=useState(1),[reload,setReload]=useState(0);
  const [response,setResponse]=useState<{key:string;data?:History;error?:string}|null>(null);
  const query=new URLSearchParams({month,site:restricted?actor.site||'':site,channel:restricted?actor.channel||'':channel}).toString();
  const requestKey=JSON.stringify([actor.id,actor.role,query,refreshToken,reload]);
  const active=response?.key===requestKey?response:null,data=active?.data,busy=open&&!active;
  useEffect(()=>{
    if(!open)return;
    const abort=new AbortController();
    fetch('/api/replenishment-history?'+query,{cache:'no-store',signal:abort.signal}).then(parseWorkspaceResponse).then(data=>{
      if(!abort.signal.aborted)setResponse({key:requestKey,data});
    }).catch(error=>{if(!abort.signal.aborted)setResponse({key:requestKey,error:error.message||'读取失败，请重试'});});
    return()=>abort.abort();
  },[open,query,requestKey]);
  const months=[...new Set([currentMonth,lastMonth,month,...(data?.months||[])])].sort().reverse();
  const needle=search.trim().toLowerCase();
  const rows=(data?.rows||[]).filter(row=>!needle||[row.sku,row.name,row.reason].some(value=>value.toLowerCase().includes(needle)));
  const pages=Math.max(1,Math.ceil(rows.length/30)),visiblePage=Math.min(page,pages);
  const planLabel=data?.plan?statusLabels[data.plan.status]||data.plan.status:'未送审';
  const planQtyLabel=data?.plan?.status==='approved'?'已批准计划量':'送审计划量';
  const changeMonth=(value:string)=>{setMonth(value);setPage(1);setSearch('');};
  return <section className="panel replenishment-history" aria-labelledby={id+'-title'}>
    <div className="rh-heading"><div><span className="rh-eyebrow">月度需求档案</span><h3 id={id+'-title'}>历史补货计划</h3><p>回看运营提交、SKU 数量与审批结果，方便本月备货核对。</p></div>
      <div className="rh-buttons"><button className="btn" onClick={()=>{changeMonth(lastMonth);setOpen(true);setReload(n=>n+1);}}>查看上月计划</button><button className="btn primary" aria-expanded={open} aria-controls={id+'-content'} onClick={()=>{setOpen(!open);if(!open)setReload(n=>n+1);}}>{open?'收起历史':'查看历史月份'}</button></div>
    </div>
    {open&&<div id={id+'-content'} className="rh-content">
      <div className="rh-filters"><label>备货月份<select value={month} onChange={e=>changeMonth(e.target.value)}>{months.map(m=><option key={m} value={m}>{m}{m===lastMonth?' · 上个月':m===currentMonth?' · 本月':''}</option>)}</select></label>
        {restricted?<div className="rh-scope"><strong>{actor.site} · {actor.channel}</strong><span>查看本人负责的站点和渠道</span></div>:<><label>站点<select value={site} onChange={e=>{setSite(e.target.value);setPage(1);}}><option value="">全部站点</option>{HISTORY_SITES.map(s=><option key={s}>{s}</option>)}</select></label><label>渠道<select value={channel} onChange={e=>{setChannel(e.target.value);setPage(1);}}><option value="">全部渠道</option>{HISTORY_CHANNELS.map(c=><option key={c}>{c}</option>)}</select></label></>}
        <button className="btn" disabled={busy} onClick={()=>setReload(n=>n+1)}>刷新记录</button>
      </div>
      {busy&&<p role="status" className="rh-empty">正在读取 {month} 已保存的补货计划…</p>}
      {active?.error&&<p className="notice error" role="alert">{active.error}</p>}
      {data&&<>
        <div className="rh-summary"><div><span>运营提交数量</span><strong>{fmt(data.summary.submittedQty)} <small>件</small></strong></div><div><span>{planQtyLabel}</span><strong>{fmt(data.summary.planQty)} <small>件</small></strong></div><div><span>涉及 SKU</span><strong>{fmt(data.summary.skuCount)} <small>款</small></strong></div><div><span>月度计划状态</span><strong className={'rh-status '+(data.plan?.status||'')}>{planLabel}</strong>{data.plan&&<small>计划 V{data.plan.version}</small>}</div></div>
        <p className="rh-source">仅展示该月最近保存的提交记录及当前审批版本，不使用实时补货测算。{data.plan?.status==='approved'?'批准量包含后续已批准的计划变更。':'未批准的计划量仅用于核对，不代表已下单。'}{data.plan&&<> 计划更新：{time(data.plan.updatedAt)}（北京时间）。</>}</p>
        {!data.submissions.length&&!data.plan?<div className="rh-empty">{month} 在当前范围没有保存的补货计划。可选择其他历史月份；没有记录不代表需求为零。</div>:<>
          <div className="rh-submissions">{data.submissions.map(s=><div className="rh-submission" key={s.id}><div><strong>{s.site} · {s.channel}</strong><span>{s.zeroDemand?'已确认无需备货':`${s.skuCount} 款 · ${fmt(s.totalQty)} 件`}</span></div><p>{s.actorName} · 提交 V{s.version} · {time(s.submittedAt)}（北京时间）</p>{s.zeroDemand&&<p>无需备货说明：{s.zeroReason||'未记录说明'}</p>}</div>)}</div>
          {!data.submissions.length&&<p className="notice info">该范围有审批计划分配，未找到运营提交明细；提交量显示为“—”。</p>}
          <div className="rh-detail-heading"><h4>SKU 补货明细</h4><label><span className="sr-only">搜索历史补货 SKU</span><input type="search" placeholder="搜索 SKU、商品、调整原因" value={search} onChange={e=>{setSearch(e.target.value);setPage(1);}}/></label></div>
          <div className="table-wrap"><table><thead><tr><th>SKU / 商品</th><th>站点 / 渠道</th><th className="num">运营提交量</th><th className="num">{planQtyLabel}</th><th>运营调整原因</th></tr></thead><tbody>{rows.slice((visiblePage-1)*30,visiblePage*30).map(row=><tr key={row.id}><td><strong><SkuLabel sku={row.sku}/></strong><span className="rh-product-name">{row.name||'—'}</span></td><td>{row.site}<span className="rh-product-name">{row.channel}</span></td><td className="num">{fmt(row.submittedQty)}</td><td className={'num '+(row.planQty!==null&&row.submittedQty!==null&&row.planQty!==row.submittedQty?'rh-changed':'')}>{fmt(row.planQty)}</td><td className="rh-reason">{row.reason||'—'}</td></tr>)}{!rows.length&&<tr><td colSpan={5} className="rh-empty">{search?'没有匹配的 SKU，请调整搜索词。':'本月无 SKU 补货明细，请查看上方无需备货说明。'}</td></tr>}</tbody></table></div>
          <div className="rh-pagination"><span>共 {rows.length} 条站点渠道明细 · 数量单位：件</span><div><button className="btn" disabled={visiblePage<=1} onClick={()=>setPage(visiblePage-1)}>上一页</button><span>{visiblePage} / {pages}</span><button className="btn" disabled={visiblePage>=pages} onClick={()=>setPage(visiblePage+1)}>下一页</button></div></div>
        </>}
      </>}
    </div>}
  </section>;
}
