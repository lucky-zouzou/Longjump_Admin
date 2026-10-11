"use client";
import {useState} from 'react';
import {hasPermission} from '../lib/permissions.mjs';
import {productionStage,productionStageLabel,productionWorkbook} from '../lib/production-workflow.mjs';
type Row=Record<string,any>;
type Act=(action:string,payload:Row,success:string,onError?:(message:string)=>void)=>Promise<Row|null>;
const fmt=(n:unknown)=>Number(n||0).toLocaleString('zh-CN');
const time=(v:string)=>v?new Date(v).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'—';
const today=()=>new Date(Date.now()+8*3600000).toISOString().slice(0,10);
const eventLabels:Record<string,string>={factory_accepted:'确认接单并开始生产',production_progress:'更新生产进度',production_completed:'生产完成，转待质检',qc_passed:'质检通过',qc_rejected:'质检不通过'};
function Flow({stage}:{stage:string}){
  const current=stage==='awaiting_order'?0:stage==='awaiting_factory'?1:stage==='in_production'||stage==='pending'?2:stage==='ready_to_ship'?5:4;
  return <ol className="production-flow" aria-label="工厂生产流程">{['收到订单','导出确认','生产中','生产完成','待质检','可发货'].map((label,i)=><li key={label} className={i<current?'done':i===current?'current':''}><span>{i<current?'✓':i+1}</span>{label}</li>)}</ol>;
}
function Timeline({events}:{events:Row[]}){
  return <ol className="production-timeline">{events.map((event,i)=><li key={i}><strong>{event.label}</strong>{event.progressPct!==undefined&&<span> · {event.progressPct}%</span>}<small>{time(event.at)}{event.by&&` · ${event.by}`}</small>{event.note&&<p>{event.note}</p>}{event.reference&&<p>凭证：{event.reference}</p>}</li>)}</ol>;
}
export function ProductionOrders({data,act,busy}:{data:Row;act:Act;busy:boolean}){
  const [search,setSearch]=useState(''),[filter,setFilter]=useState('all');
  const orders=data.productionOrders.filter((order:Row)=>(filter==='all'||productionStage(order)===filter)&&`${order.series_name} ${order.factory_name} ${order.id} ${order.items.map((i:Row)=>i.sku).join(' ')}`.toLowerCase().includes(search.toLowerCase()));
  return <section className="panel production-panel"><div className="panel-head"><div><h4>工厂生产订单</h4><p>先导出核对订单，再确认接单开始生产；完成后交供应链质检。每步自动留痕。</p></div></div><div className="production-filters"><label>查找订单<input value={search} onChange={e=>setSearch(e.target.value)} placeholder="系列、工厂、SKU或生产单号"/></label><label>当前阶段<select value={filter} onChange={e=>setFilter(e.target.value)}><option value="all">全部阶段</option>{[['awaiting_order','待采购确认'],['awaiting_factory','待导出确认'],['in_production','生产中'],['awaiting_qc','待质检'],['qc_rejected','质检不通过'],['ready_to_ship','可发货']].map(([v,l])=><option key={v} value={v}>{l}</option>)}</select></label></div>
    <div className="production-order-list">{orders.length?orders.map((order:Row)=><ProductionOrder key={order.id} order={order} actor={data.actor} act={act} busy={busy}/>):<p className="empty">暂无符合条件的生产订单</p>}</div>
  </section>;
}
function ProductionOrder({order,actor,act,busy}:{order:Row;actor:Row;act:Act;busy:boolean}){
  const [mode,setMode]=useState(''),[receipt,setReceipt]=useState(''),[downloading,setDownloading]=useState(false),[feedback,setFeedback]=useState(''),[error,setError]=useState('');
  const [form,setForm]=useState({date:order.promised_completion_date||today(),reference:'',note:'',progress:String(Math.max(1,Number(order.progress_pct||1))),reviewed:false});
  const [qty,setQty]=useState<Record<string,string>>({});
  const stage=productionStage(order),assigned=actor.role==='管理员'||actor.role==='工厂'&&order.assigned_user_id===actor.id;
  const can=(p:string)=>hasPermission(actor.role,p)&&(p==='production.qc'||assigned);
  const pending=busy||downloading,done=['completed','completed_with_variance'].includes(order.status);
  const begin=(next:string)=>{setMode(next);setError('');setForm({...form,reference:'',note:'',reviewed:false,progress:String(Math.max(1,Number(order.progress_pct||1)))});if(next==='complete')setQty(Object.fromEntries(order.items.map((i:Row)=>[i.id,String(i.planned_qty)])));};
  const download=async()=>{
    setDownloading(true);setError('');setFeedback('');setReceipt('');
    try{
      const XLSX=await import('xlsx');
      const result=await act('exportProductionOrder',{productionOrderId:order.id},'工厂订单导出已生成',setError);if(!result)return;
      const bytes=XLSX.write(productionWorkbook(XLSX,result.document),{type:'array',bookType:'xlsx',compression:true});
      const url=URL.createObjectURL(new Blob([bytes],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'})),link=document.createElement('a');
      link.href=url;link.download=`工厂生产订单-${order.month}-${String(order.series_name).replace(/[\\/:*?"<>|]/g,'_')}-${order.id}.xlsx`;document.body.appendChild(link);
      try{link.click();}finally{link.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);}
      setReceipt(result.exportReceiptId);setFeedback(`已生成 Excel，包含 ${result.document.items.length} 个 SKU；请打开下载文件核对数量与交期。`);
    }catch(e){setError(e instanceof Error?e.message:'导出失败，请重试');}finally{setDownloading(false);}
  };
  const submit=async(e:React.FormEvent)=>{
    e.preventDefault();setError('');let action='',payload:Row={productionOrderId:order.id,evidenceRef:form.reference,note:form.note},success='';
    if(mode==='accept'){action='acceptProductionOrder';payload={...payload,promisedCompletionDate:form.date,orderReviewed:form.reviewed,exportReceiptId:receipt};success='已确认接单，进入生产中';}
    if(mode==='progress'){action='updateProductionProgress';payload.progressPct=Number(form.progress);success='生产进度已同步';}
    if(mode==='complete'){action='completeProductionOrder';payload.items=order.items.map((i:Row)=>({id:i.id,producedQty:Number(qty[i.id])}));success='生产完成已登记，已转待质检';}
    if(mode==='pass'||mode==='reject'){action='confirmProductionQc';payload.decision=mode;success=mode==='pass'?'质检通过，可安排海运发货':'质检不通过，暂停发货';}
    if(await act(action,payload,success,setError)){setMode('');setFeedback(success);}
  };
  const events=(order.evidence||[]).filter((e:Row)=>eventLabels[e.stage]).map((e:Row)=>({...e,label:eventLabels[e.stage]}));
  return <article className="production-card"><header><div><h4>{order.series_name}</h4><p>{order.factory_name||'待分配工厂'} · {order.month} · {order.items.length} 个 SKU</p><small className="production-id">{order.id}</small></div><span className={`production-badge ${['awaiting_qc','qc_rejected','awaiting_factory'].includes(stage)?'attention':''}`}>{productionStageLabel(order)}</span></header>
    <Flow stage={stage}/><div className="production-stats"><span>计划数量<strong>{fmt(order.visiblePlannedQty)}</strong></span><span>实际完工<strong>{fmt(order.visibleProducedQty)}</strong></span><span>生产进度<strong>{fmt(order.progress_pct)}%</strong></span><span>承诺完工日<strong>{order.promised_completion_date||'待确认'}</strong></span></div>
    <p className="production-next">{stage==='awaiting_factory'?'下一步：工厂导出订单，核对SKU和数量后确认接单。':['in_production','pending'].includes(stage)?'下一步：工厂更新进度；完成后逐项登记实际完工数量。':stage==='awaiting_qc'?'下一步：供应链核对质检报告并确认结果。':stage==='qc_rejected'?'下一步：工厂按质检意见整改，供应链复检后重新确认。':stage==='ready_to_ship'?'下一步：供应链前往“海运批次”，按剩余可发数量安排发运。':'下一步：供应链先确认采购订单。'}</p>
    {done&&Number(order.visiblePlannedQty)!==Number(order.visibleProducedQty)&&<p className="notice warn">完工差异：计划 {fmt(order.visiblePlannedQty)} 件，实际 {fmt(order.visibleProducedQty)} 件，相差 {fmt(Math.abs(Number(order.visibleProducedQty)-Number(order.visiblePlannedQty)))} 件，请结合生产说明核对。</p>}
    <details className="production-detail"><summary>SKU明细与操作记录</summary><div className="table-wrap"><table><thead><tr><th>SKU / 商品</th><th className="num">计划</th><th className="num">实际完工</th><th className="num">累计发货</th><th className="num">剩余可发</th></tr></thead><tbody>{order.items.map((i:Row)=><tr key={i.id}><td><strong>{i.sku}</strong><small>{i.name}</small></td><td className="num">{fmt(i.visiblePlanned)}</td><td className="num">{fmt(i.visibleProduced)}</td><td className="num">{fmt(i.shippedQty)}</td><td className="num">{fmt(i.remainingToShip)}</td></tr>)}</tbody></table></div>{events.length?<Timeline events={events}/>:<p>暂无工厂操作记录</p>}</details>
    <div className="production-actions">{can('production.export')&&order.status!=='awaiting_order'&&<button className="btn" disabled={pending} onClick={download}>{downloading?'正在生成…':'导出工厂订单 Excel'}</button>}{order.status==='awaiting_factory'&&can('production.accept')&&<button className="btn primary" disabled={pending||!receipt} onClick={()=>begin('accept')}>确认接单并开始生产</button>}{order.status==='in_production'&&can('production.progress')&&<button className="btn" disabled={pending} onClick={()=>begin('progress')}>更新生产进度</button>}{['in_production','pending'].includes(order.status)&&can('production.complete')&&<button className="btn primary" disabled={pending} onClick={()=>begin('complete')}>登记生产完成</button>}{done&&order.qc_status!=='passed'&&can('production.qc')&&<><button className="btn primary" disabled={pending} onClick={()=>begin('pass')}>质检通过</button><button className="btn danger" disabled={pending} onClick={()=>begin('reject')}>质检不通过</button></>}</div>
    {feedback&&<p className="notice info" role="status">{feedback}</p>}{error&&<p className="notice warn" role="alert">{error}</p>}
    {mode&&<form className="production-editor" onSubmit={submit}><h4>{{accept:'核对订单并开始生产',progress:'更新生产进度',complete:'登记实际完工，提交质检',pass:'确认质检通过',reject:'登记质检问题'}[mode]}</h4><div className="production-form-grid">
      {mode==='accept'&&<label>承诺完工日<input type="date" required min={today()} value={form.date} onChange={e=>setForm({...form,date:e.target.value})}/></label>}
      {mode==='progress'&&<label>生产进度（1—99%）<input type="number" required step="1" min={Math.max(1,Number(order.progress_pct||1))} max="99" value={form.progress} onChange={e=>setForm({...form,progress:e.target.value})}/></label>}
      <label>{['pass','reject'].includes(mode)?'质检报告／抽检单编号':mode==='complete'?'完工单／生产凭证编号':'接单／进度凭证编号'}<input required maxLength={240} value={form.reference} onChange={e=>setForm({...form,reference:e.target.value})}/></label>
      <label className="wide">{mode==='reject'?'不通过原因与返工要求':'操作说明（至少3个字）'}<textarea required minLength={3} maxLength={500} rows={3} value={form.note} onChange={e=>setForm({...form,note:e.target.value})}/></label></div>
      {mode==='complete'&&<><p>核对每个 SKU 的实产数量；短产或超产请在说明中填写原因。</p><div className="table-wrap"><table><thead><tr><th>SKU</th><th>计划</th><th>实际完工</th></tr></thead><tbody>{order.items.map((i:Row)=><tr key={i.id}><td>{i.sku}</td><td>{fmt(i.planned_qty)}</td><td><input aria-label={`${i.sku}实际完工`} type="number" required min="0" max={i.planned_qty*2} step="1" value={qty[i.id]??''} onChange={e=>setQty({...qty,[i.id]:e.target.value})}/></td></tr>)}</tbody></table></div></>}
      {mode==='accept'&&<label className="production-check"><input type="checkbox" required checked={form.reviewed} onChange={e=>setForm({...form,reviewed:e.target.checked})}/>我已打开导出的订单，核对全部 SKU、数量及交期，确认开始生产。</label>}
      <div className="production-actions"><button type="button" className="btn" disabled={pending} onClick={()=>setMode('')}>取消操作</button><button type="submit" className="btn primary" disabled={pending||mode==='accept'&&(!receipt||!form.reviewed)}>{pending?'正在提交…':mode==='complete'?'确认完工并转待质检':'确认提交'}</button></div></form>}
  </article>;
}
export default function ProductionTracking({rows,generatedAt}:{rows:Row[];generatedAt:string}){
  const [query,setQuery]=useState(''),[stage,setStage]=useState('all');
  const list=rows.filter(r=>(stage==='all'||r.stage===stage)&&`${r.seriesName} ${r.factoryName} ${r.items.map((i:Row)=>i.sku).join(' ')}`.toLowerCase().includes(query.toLowerCase()));
  return <section className="production-tracking"><div className="page-head"><div><h3>生产动态</h3><p>全账号共享生产进展 · 页面开启时每30秒同步</p><small>最近数据时间：{time(generatedAt)}（北京时间）</small></div></div><div className="production-summary">{[['awaiting_factory','待工厂确认'],['in_production','生产中'],['awaiting_qc','待质检'],['ready_to_ship','质检通过']].map(([v,l])=><button key={v} className={stage===v?'selected':''} onClick={()=>setStage(stage===v?'all':v)}><span>{l}</span><strong>{rows.filter(r=>r.stage===v).length}</strong></button>)}</div><div className="production-filters"><label>搜索生产动态<input placeholder="系列、工厂或SKU" value={query} onChange={e=>setQuery(e.target.value)}/></label><label>阶段<select value={stage} onChange={e=>setStage(e.target.value)}><option value="all">全部阶段</option>{[['awaiting_order','待采购确认'],['awaiting_factory','待工厂确认'],['in_production','生产中'],['pending','历史待生产'],['awaiting_qc','待质检'],['qc_rejected','质检不通过'],['ready_to_ship','质检通过']].map(([v,l])=><option key={v} value={v}>{l}</option>)}</select></label></div><div className="production-order-list">{list.map(order=><article className="production-card" key={order.id}><header><div><h4>{order.seriesName}</h4><p>{order.factoryName} · {order.month} · {order.items.length} 个 SKU</p></div><span className="production-badge">{order.stageLabel}</span></header><Flow stage={order.stage}/><div className="production-stats"><span>计划数量<strong>{fmt(order.plannedQty)}</strong></span><span>实际完工<strong>{fmt(order.producedQty)}</strong></span><span>生产进度<strong>{order.progressPct}%</strong></span><span>承诺完工日<strong>{order.promisedDate||'待确认'}</strong></span></div><details className="production-detail"><summary>查看SKU明细与动态记录</summary><p className="production-id">{order.id}</p><div className="table-wrap"><table><thead><tr><th>SKU / 商品</th><th>计划</th><th>完工</th></tr></thead><tbody>{order.items.map((i:Row)=><tr key={i.sku}><td>{i.sku}<small>{i.name}</small></td><td>{fmt(i.plannedQty)}</td><td>{fmt(i.producedQty)}</td></tr>)}</tbody></table></div><Timeline events={order.events}/></details></article>)}{!list.length&&<p className="empty">暂无符合条件的生产动态</p>}</div></section>;
}
