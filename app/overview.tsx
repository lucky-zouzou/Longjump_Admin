"use client";
import {createElement,useState} from "react";
import Icon from "./workspace-icons";
import StyleOperations from "./style-operations";
import EvidenceSummary from "./evidence-summary";
import SupplyChain from "./supply-chain";
import ZeroSalesNotifications from "./zero-sales-notifications";

// These rows are already filtered by the server's role and site boundaries.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row=Record<string,any>;
type Props={reminder:React.ReactNode;allowed:string[];data:{metrics:Row;actor:Row;currentMonth:string;myTasks:Row[];monthlyStatus:Row[];issues:Row[]};go:(tab:string,task?:Row)=>void};
const number=(value:unknown)=>Number(value||0).toLocaleString("zh-CN");


export default function Overview({data,go,allowed,reminder}:Props){
  const [allIssues,setAllIssues]=useState(false);
  const m=data.metrics;
  const completeness=m.monthlyRequired?Math.min(100,100*m.monthlySubmitted/m.monthlyRequired):0;
  const sites=[...new Set(data.monthlyStatus.map(r=>String(r.site)))];
  const issues=[...data.issues].sort((a,b)=>Number(b.level==="critical")-Number(a.level==="critical"));
  const actionLink=(page:string,label:string)=>allowed.includes(page)?<button className="overview-link" onClick={()=>go(page)}>{label}<Icon name="arrow"/></button>:null;
  return <div className="overview-workspace">
    <div className="overview-heading">
      <div><div className="overview-eyebrow">经营工作台 <span> / </span> OVERVIEW</div><h1>经营协同总览</h1>{createElement('workplace-welcome',{'employee-name':data.actor.name||''},'很高兴见到你！')}<script async type="module" src="/workplace-welcome.js"/></div>
      <div className="overview-period"><Icon name="monthly"/><span>经营月份<strong>{data.currentMonth}</strong></span></div>
    </div>
    {reminder}
    <section className="overview-kpis" aria-label="经营关键数据">
      {[
        {label:'当前可售库存',value:m.inventoryQty,icon:'inventory',note:`待上架 ${number(m.pendingShelfQty)} · 隔离 ${number(m.quarantineQty)}`,tone:'stock'},
        {label:'近7个完整日销量',value:m.sales7Qty,icon:'sales',note:new Set((m.salesWindows||[]).map((w:Row)=>w.end)).size>1?'各站截至当地昨日':`${m.salesWindowFrom||'—'} — ${m.salesWindowTo||'—'}`,extra:'今日另计；仅汇总已导入销量，缺报不作零',tone:'sales'},
        {label:'海运在途',value:m.seaTransitQty,icon:'batches',note:'只统计已进入海运的数量',tone:'transit'},
        {label:'建议启动生产',value:m.suggestedProductionQty,icon:'fulfillment',note:m.forecastPendingCount?`已核实部分；${m.forecastPendingCount}项待补数据`:'已扣库存、海运在途和生产中',tone:'production'},
      ].map(k=><article className={`overview-kpi ${k.tone}`} key={k.label}><div className="kpi-caption"><span>{k.label}</span><Icon name={k.icon}/></div><div className="kpi-number">{number(k.value)}<small>件</small></div><p>{k.note}{k.extra&&<small>{k.extra}</small>}</p></article>)}
    </section>
    {allowed.includes('business-actions')&&<EvidenceSummary go={go}/>}
    <ZeroSalesNotifications tasks={data.myTasks} actor={data.actor} go={go}/>
    <div className="overview-columns">
      <div className="overview-primary">
        <section className="overview-card overview-submissions">
          <header><div><h2>月度需求提交</h2><p>五站双渠道，全部提交后才能进入审批。</p></div>{actionLink('monthly','查看明细')}</header>
          <div className="submission-progress"><div><strong>{number(m.monthlySubmitted)}<small> / {number(m.monthlyRequired)} 已提交</small></strong><span>{Math.round(completeness)}%</span></div><div className="bar" role="progressbar" aria-label="月度需求提交完整度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(completeness)}><i style={{width:`${completeness}%`}}/></div></div>
          {sites.length?<div className="overview-site-grid">{sites.map(site=><article key={site}><strong>{site}</strong><div>{data.monthlyStatus.filter(r=>r.site===site).map(r=><span className={r.submitted?'submitted':'pending'} key={r.channel}><i aria-hidden="true">{r.submitted?'✓':'·'}</i>{r.channel}<span className="sr-only">{r.submitted?'已提交':'未提交'}</span></span>)}</div></article>)}</div>:<p className="overview-note">当前没有可展示的提交记录。</p>}
        </section>
      </div>
      <section className="overview-card overview-risks">
        <header><div><h2><Icon name="quality-incidents"/>动态预警</h2><p>优先关注断货、数据缺口及到货时间。</p></div><span className={`overview-risk-count ${m.actionAlertCount?'has-risk':''}`}>{number(m.actionAlertCount)} 项供应风险</span></header>
        {data.issues.length?<><div className="overview-risk-list">{(allIssues?issues:issues.slice(0,4)).map((issue,i)=><article className={issue.level==='critical'?'critical':'warning'} key={`${issue.type}-${i}`}><div><span className="risk-dot"/><strong>{issue.type}</strong><small>{issue.level==='critical'?'优先':'关注'}</small></div><p>{issue.detail}</p></article>)}</div><footer>{data.issues.length>4&&<button className="overview-link" aria-expanded={allIssues} onClick={()=>setAllIssues(!allIssues)}>{allIssues?'收起预警':`展开本页 ${data.issues.length} 条预警`}</button>}{actionLink('suggestions','进入驾驶舱')}</footer></>:<div className="overview-empty"><Icon name="approval"/><strong>暂无高优先级供应风险</strong><span>持续关注销售与库存变化。</span></div>}
      </section>
    </div>
    <StyleOperations role={data.actor.role} allowed={allowed} go={go}/>
    <SupplyChain metrics={m} allowed={allowed} go={go}/>
  </div>;
}
