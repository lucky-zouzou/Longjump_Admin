"use client";
import {useEffect,useRef,useState} from 'react';
import {transportSteps,transportGuidance} from '../lib/transport-workflow.mjs';
type Row=Record<string,any>;
type Act=(action:string,payload:Row,success:string,onError?:(message:string)=>void)=>Promise<Row|null>;
const fmt=(n:unknown)=>Number(n||0).toLocaleString('zh-CN');
const today=()=>new Date(Date.now()+8*3600000).toISOString().slice(0,10);
const stamp=(v:string)=>v?new Date(v).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'—';

export function TransportCreated({batchNo}:{batchNo:string}){
  const target=useRef<HTMLDivElement>(null);
  useEffect(()=>{target.current?.focus({preventScroll:true});target.current?.scrollIntoView({block:'center',behavior:'smooth'});},[]);
  return <div className="notice info transport-created" ref={target} tabIndex={-1} role="status"><strong>{batchNo} 已建立。</strong> 下一步：供应链在下方每个目的地点击“登记开船并交接海运”，补齐日期与凭证。创建批次不等于已经开船。</div>;
}
export default function TransportLegCard({leg,actor,users,act,busy,onReceive,receipt}:{leg:Row;actor:Row;users:Row[];act:Act;busy:boolean;onReceive:()=>void;receipt?:React.ReactNode}){
  const guide=transportGuidance(leg,actor,users);
  const [mode,setMode]=useState(''),[error,setError]=useState(''),[feedback,setFeedback]=useState('');
  const [form,setForm]=useState({reference:'',note:'',etd:'',eta:'',ata:'',portName:'',version:0,stage:'',itemId:'',qty:''});
  const editor=useRef<HTMLFormElement>(null);
  useEffect(()=>{if(mode)editor.current?.scrollIntoView({block:'center',behavior:'smooth'});},[mode]);
  const begin=(next:string,item?:Row)=>{setMode(next);setError('');setFeedback('');setForm({reference:'',note:'',etd:leg.etd||today(),eta:leg.eta||'',ata:leg.ata||today(),portName:leg.port_name||'',version:leg.version,stage:leg.stage,itemId:item?.id||'',qty:String(item?.pending_shelf_qty||'')});};
  const submit=async(e:React.FormEvent)=>{
    e.preventDefault();setError('');
    if(form.version!==leg.version||form.stage!==leg.stage){setError('该节点已更新，请取消后重新打开操作并核对。');return;}
    let action='advanceTransportLeg',payload:Row={legId:leg.id,version:form.version,evidenceRef:form.reference,note:form.note},success='节点已更新，请按新的下一步指引继续。';
    if(mode==='eta'){action='updateTransportLegPlan';payload={legId:leg.id,eta:form.eta,etd:form.etd,reason:form.note};success='预计到仓日期已更新。';}
    else if(mode==='shelf'){action='confirmTransportShelf';payload={legItemId:form.itemId,shelvedQty:Number(form.qty),listingRef:form.reference,note:form.note};success='本次数量已转为可售库存。';}
    else{if(leg.stage==='booking')Object.assign(payload,{etd:form.etd,eta:form.eta});if(leg.stage==='port_arrived')Object.assign(payload,{ata:form.ata,portName:form.portName});}
    if(await act(action,payload,success,setError)){setMode('');setFeedback(success);}
  };
  const pendingItems=(leg.items||[]).filter((item:Row)=>Number(item.pending_shelf_qty)>0);
  return <section className="transport-guide" aria-label={`目的地 ${leg.leg_no}`}>
    <header><div><h4>{leg.leg_no}</h4><p>{leg.site} · {leg.channel} · {leg.warehouse_name}</p></div><span className={`pill ${leg.stage==='on_shelf'?'green':'blue'}`}>{transportSteps[guide.index]?.[1]||leg.stage}</span></header>
    <ol className="transport-flow" aria-label="目的地运输流程">{transportSteps.map(([key,label],i)=><li key={key} className={i<guide.index?'done':i===guide.index?'current':''} aria-current={i===guide.index?'step':undefined}><i>{i<guide.index?'✓':i+1}</i><span>{label}</span></li>)}</ol>
    <div className="transport-facts"><span>当前处理人<strong>{guide.owner}</strong></span><span>开船 / 预计到仓<strong>{leg.etd||'未登记'} / {leg.eta||'未登记'}</strong></span><span>已到仓 / 发运<strong>{fmt(leg.receivedQty)} / {fmt(leg.total_qty)} 件</strong></span><span>待上架 / 隔离<strong>{fmt(leg.pendingShelfQty)} / {fmt(leg.quarantineQty)} 件</strong></span></div>
    <div className="transport-next"><strong>{leg.stage==='on_shelf'?'流程完成':`下一步：${guide.label}`}</strong><p>{guide.hint}</p>{!guide.allowed&&leg.stage!=='on_shelf'&&<p className="transport-wait">等待 {guide.owner} 处理；当前账号可查看进展。</p>}{leg.stage==='shelf_pending'&&Number(leg.quarantineQty)>0&&<p className="transport-wait">仍有 {fmt(leg.quarantineQty)} 件隔离品，请供应链在库存流水中核对处理；全部处理并上架后才会完成。</p>}</div>
    {(leg.exceptions||[]).map((issue:Row,i:number)=><div className="notice warn" key={i}><strong>{issue.type}</strong> {issue.detail}</div>)}
    {!mode&&<div className="transport-actions">{guide.allowed&&guide.index<5&&<button className="btn primary" disabled={busy} onClick={()=>begin('advance')}>{guide.label}</button>}{guide.canEta&&<button className="btn" disabled={busy} onClick={()=>begin('eta')}>调整预计到仓日期</button>}{guide.allowed&&leg.stage==='awaiting_receipt'&&<button className="btn primary" disabled={busy} onClick={onReceive}>{guide.label}</button>}{guide.allowed&&leg.stage==='shelf_pending'&&pendingItems.map((item:Row)=><button key={item.id} className="btn primary" disabled={busy} onClick={()=>begin('shelf',item)}>{item.sku} · 确认上架</button>)}</div>}
    {mode&&<form ref={editor} className="transport-editor" onSubmit={submit}><h4>{mode==='eta'?'调整预计到仓日期':mode==='shelf'?'登记实际已上架数量':guide.label}</h4><div className="transport-form-grid">
      {(mode==='eta'||mode==='advance'&&leg.stage==='booking')&&<><label>开船日期（ETD）<input type="date" required value={form.etd} onChange={e=>setForm({...form,etd:e.target.value})}/></label><label>预计到仓日期（ETA）<input type="date" required min={mode==='eta'?(form.etd>today()?form.etd:today()):form.etd} value={form.eta} onChange={e=>setForm({...form,eta:e.target.value})}/></label></>}
      {mode==='advance'&&leg.stage==='port_arrived'&&<><label>实际到港日期<input type="date" required max={today()} value={form.ata} onChange={e=>setForm({...form,ata:e.target.value})}/></label><label>到港港口<input maxLength={120} value={form.portName} onChange={e=>setForm({...form,portName:e.target.value})}/></label></>}
      {mode==='shelf'&&<label>本次上架数量<input type="number" step="1" min="1" required max={pendingItems.find((i:Row)=>i.id===form.itemId)?.pending_shelf_qty||0} value={form.qty} onChange={e=>setForm({...form,qty:e.target.value})}/></label>}
      {mode!=='eta'&&<label>{mode==='shelf'?'平台上架凭证或链接':'业务凭证／单据编号'}<input required maxLength={240} value={form.reference} onChange={e=>setForm({...form,reference:e.target.value})}/></label>}
      <label className="wide">{mode==='eta'?'调整原因（至少3个字）':'操作说明（至少3个字）'}<textarea required minLength={3} maxLength={500} rows={3} value={form.note} onChange={e=>setForm({...form,note:e.target.value})}/></label></div>
      {error&&<p role="alert" className="notice error">{error}</p>}<div className="transport-actions"><button className="btn" type="button" disabled={busy} onClick={()=>{setMode('');setError('');}}>取消操作</button><button className="btn primary" type="submit" disabled={busy}>{busy?'正在提交…':mode==='eta'?'确认调整':mode==='shelf'?'确认转为可售库存':guide.label}</button></div>
    </form>}
    {feedback&&<p className="notice info" role="status">{feedback}</p>}{receipt}
    <details className="transport-trace"><summary>查看 SKU 明细与节点记录</summary><div className="table-wrap"><table><thead><tr><th>SKU / 商品</th><th>发运</th><th>已收</th><th>待上架</th><th>已上架</th><th>隔离</th></tr></thead><tbody>{(leg.items||[]).map((item:Row)=><tr key={item.id}><td>{item.sku}<div className="cell-note">{item.name}</div></td><td>{fmt(item.qty)}</td><td>{fmt(item.received_qty)}</td><td>{fmt(item.pending_shelf_qty)}</td><td>{fmt(item.sellable_qty)}</td><td>{fmt(item.quarantine_qty)}</td></tr>)}</tbody></table></div><ol className="production-timeline">{(leg.evidence||[]).map((e:Row,i:number)=><li key={i}><strong>{transportSteps.find(([key])=>key===e.stage)?.[1]||e.stage}</strong><small>{stamp(e.at)} · {e.by} · {e.role}</small><p>{e.note}</p><p>凭证：{e.reference}</p></li>)}</ol>{!(leg.evidence||[]).length&&<p>尚无节点交接记录，请按上方下一步操作。</p>}</details>
  </section>;
}
