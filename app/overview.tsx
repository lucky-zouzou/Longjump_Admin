"use client";
import {useState} from "react";
import {navigationForRole} from "../lib/permissions.mjs";
import Icon from "./workspace-icons";

// These rows are already filtered by the server's role and site boundaries.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row=Record<string,any>;
type Props={data:{metrics:Row;actor:Row;currentMonth:string;myTasks:Row[];monthlyStatus:Row[];issues:Row[]};go:(tab:string,task?:Row)=>void};
const number=(value:unknown)=>Number(value||0).toLocaleString("zh-CN");
const steps=[['supply_confirm','备货确认'],['factory_production','工厂生产'],['booking','订舱'],['sea_freight','海运'],['port_arrived','到港'],['customs_clearance','清关'],['last_mile_delivery','派送'],['awaiting_receipt','待到仓'],['shelf_pending','待上架'],['on_shelf','已上架']];

export default function Overview({data,go}:Props){
  const [allTasks,setAllTasks]=useState(false),[allIssues,setAllIssues]=useState(false);
  const m=data.metrics,allowed=navigationForRole(data.actor.role);
  const completeness=m.monthlyRequired?Math.min(100,100*m.monthlySubmitted/m.monthlyRequired):0;
  const sites=[...new Set(data.monthlyStatus.map(r=>String(r.site)))];
  const issues=[...data.issues].sort((a,b)=>Number(b.level==="critical")-Number(a.level==="critical"));
  const actionLink=(page:string,label:string)=>allowed.includes(page)?<button className="overview-link" onClick={()=>go(page)}>{label}<Icon name="arrow"/></button>:null;
  return <div className="overview-workspace">
    <div className="overview-heading">
      <div><div className="overview-eyebrow">经营工作台 <span> / </span> OVERVIEW</div><h1>经营协同总览</h1><p>看清经营现状，让每一步协作有序推进。</p></div>
      <div className="overview-period"><Icon name="monthly"/><span>经营月份<strong>{data.currentMonth}</strong></span></div>
    </div>
    <section className="overview-kpis" aria-label="经营关键数据">
      {[
        {label:'当前可售库存',value:m.inventoryQty,icon:'inventory',note:`待上架 ${number(m.pendingShelfQty)} · 隔离 ${number(m.quarantineQty)}`,tone:'stock'},
        {label:'近7天销量',value:m.sales7Qty,icon:'sales',note:`${m.salesWindowFrom||'—'} — ${m.salesWindowTo||'—'}`,extra:'滚动7个自然日，缺报不视为零销量',tone:'sales'},
        {label:'海运在途',value:m.seaTransitQty,icon:'batches',note:'只统计已进入海运的数量',tone:'transit'},
        {label:'建议启动生产',value:m.suggestedProductionQty,icon:'fulfillment',note:m.forecastPendingCount?`已核实部分；${m.forecastPendingCount}项待补数据`:'已扣库存、海运在途和生产中',tone:'production'},
      ].map(k=><article className={`overview-kpi ${k.tone}`} key={k.label}><div className="kpi-caption"><span>{k.label}</span><Icon name={k.icon}/></div><div className="kpi-number">{number(k.value)}<small>件</small></div><p>{k.note}{k.extra&&<small>{k.extra}</small>}</p></article>)}
    </section>
    <div className="overview-columns">
      <div className="overview-primary">
        <section className="overview-card overview-tasks">
          <header><div><h2><Icon name="business-actions"/>我的待办 <span className="overview-count">{data.myTasks.length}</span></h2><p>按当前账号分工处理，完成后自动移出。</p></div>{data.myTasks.length>4&&<button className="overview-link" aria-expanded={allTasks} onClick={()=>setAllTasks(!allTasks)}>{allTasks?'收起':`查看全部 ${data.myTasks.length} 项`}<Icon name="chevron"/></button>}</header>
          <div className="overview-task-list">
            {data.myTasks.length===0?<div className="overview-empty"><Icon name="approval"/><strong>当前没有待办事项</strong><span>有新的协作任务时，会在这里提醒您。</span></div>:(allTasks?data.myTasks:data.myTasks.slice(0,4)).map((task,index)=><button className={`overview-task ${task.level}`} key={`${task.title}-${index}`} onClick={()=>go(task.tab,task)}><span className="task-mark"><Icon name={task.tab}/></span><span className="task-copy"><strong>{task.title}</strong><span>{task.detail}</span></span><span className="task-priority">{task.level==='red'?'优先处理':'待处理'}</span><Icon name="chevron"/></button>)}
          </div>
        </section>
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
    <section className="overview-card overview-chain">
      <header><div><h2>全链路实时状态</h2><p>从备货到上架，追踪每一个履约节点。</p></div>{actionLink('batches','查看全部批次')}</header>
      <div className="overview-chain-meta"><span><i className="transit-dot"/>{number(m.activeBatchCount)} 个在途批次</span><span className={m.stalledBatchCount?'stalled':''}>{number(m.stalledBatchCount)} 个节点停滞</span><span>{number(m.pendingShelfCount)} 个待上架</span></div>
      <div className="overview-stage-grid">{steps.map(([key,label],index)=><div className={`overview-stage ${Number(m.batchStageCounts?.[key])>0?'has-value':''} ${key==='on_shelf'?'finished':''}`} key={key}><span className="stage-number">{String(index+1).padStart(2,'0')}</span><strong>{number(m.batchStageCounts?.[key])}</strong><span>{label}</span><Icon name="chevron"/></div>)}</div>
    </section>
  </div>;
}
