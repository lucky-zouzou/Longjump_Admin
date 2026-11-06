"use client";
import {useEffect,useState} from 'react';
import {distributorStates} from '../lib/quality-report.mjs';
type Row=Record<string,any>;
export default function DistributorServiceReview({r,role,busy,perform}:{r:Row;role:string;busy:boolean;perform:(action:string,p:Row)=>Promise<boolean>}){
 const d=r.data,x=d.dist,refund=x.kind==='return';
 const [note,setNote]=useState(''),[amount,setAmount]=useState(''),[choices,setChoices]=useState<Row|null>(null),[error,setError]=useState('');
 const [returnIds,setReturns]=useState<string[]>([]),[refundIds,setRefunds]=useState<string[]>([]);
 const [receipt,setReceipt]=useState(''),[carrier,setCarrier]=useState(''),[tracking,setTracking]=useState('');
 const [shipChannel,setShip]=useState(''),[returnChannel,setReturn]=useState(''),[physicalConfirmed,setPhysical]=useState(false),[revision,reload]=useState(0);
 const active=!['void','closed','draft'].includes(r.status);
 useEffect(()=>{
   if(!active||role!=='财务'||!refund||x.state!=='approved')return;
   const ctrl=new AbortController();setChoices(null);setReturns([]);setRefunds([]);setError('');
   fetch('/api/after-sales?distChoices='+encodeURIComponent(r.id),{cache:'no-store',signal:ctrl.signal}).then(async res=>{
     const body=await res.json();if(!res.ok)throw Error(body.error);if(!ctrl.signal.aborted)setChoices(body);
   }).catch(e=>{if(!ctrl.signal.aborted)setError(e.message);});
   return ()=>ctrl.abort();
 },[active,refund,role,r.id,r.version,x.state,revision]);
 const call=async(action:string,extra:Row={})=>{if(await perform(action,{note,...extra}))setNote('');};
 const canReview=active&&role==='管理员'&&x.state==='submitted',canHandle=active&&role==='财务'&&x.state==='approved';
 const canUndo=active&&role==='财务'&&refund&&x.state==='completed';
 const pick=(title:string,items:Row[],ids:string[],set:(ids:string[])=>void)=> <fieldset><legend>{title}</legend>{items.length?items.map(s=><label key={s.id}>
   <input type="checkbox" checked={ids.includes(s.id)} onChange={e=>set(e.target.checked?[...ids,s.id]:ids.filter(id=>id!==s.id))}/>
   {s.day} · {s.ref} · 可用 {s.available.toLocaleString()}</label>):<p>原订单暂无可关联凭据。</p>}</fieldset>;
 return <section className="as-admin"><h4>线下分销 · {refund?'退货退款':'同 SKU 换新'}</h4>
   <p>{(distributorStates as Record<string,string>)[x.state]} · {d.qty} 件{x.approvedAmount?' · 核准退款 IDR '+x.approvedAmount.toLocaleString():''} {x.carrier} {x.tracking}</p>
   {x.message&&<p>给客户的审核说明：{x.message}</p>}
   {(canReview||canHandle||canUndo)&&<label>{canReview?'审核说明（客户可见，建议使用印尼语）':'财务核对说明（内部）'}<textarea minLength={4} maxLength={1000} value={note} onChange={e=>setNote(e.target.value)}/></label>}
   {canReview&&<>{refund&&<label>核准退款金额 · IDR<input type="number" min="1" step="1" value={amount} onChange={e=>setAmount(e.target.value)}/></label>}
     <div className="as-controls"><button className="btn primary" disabled={busy||note.trim().length<4||(refund&&Number(amount)<=0)} onClick={()=>void call('distApprove',{amount})}>批准并交财务处理</button>
     <button className="btn danger" disabled={busy||note.trim().length<4} onClick={()=>void call('distReject')}>驳回并告知客户</button></div></>}
   {canHandle&&<>{refund?<><p>先在原批发订单登记仓库实收和实际退款，再选取凭据核销。</p>
     <a href={'/?page=wholesale&view=orders&entity='+encodeURIComponent(x.orderId)+'&month='+encodeURIComponent(x.orderMonth||'')} target="_blank" rel="noreferrer">查看原批发订单 ↗</a> <button className="btn" onClick={()=>reload(v=>v+1)}>刷新凭据</button>
     {error&&<p role="alert">{error}</p>}{choices&&<>{pick('仓库实收（件）',choices.returns,returnIds,setReturns)}{pick('实际退款（IDR）',choices.refunds,refundIds,setRefunds)}</>}</>:
     <><p>确认后将收回件记入隔离库存，按补发件数扣减指定渠道可售库存。</p>
       <div className="as-fields">{[['退回入仓渠道',returnChannel,setReturn],['补发出库渠道',shipChannel,setShip]].map(([s,v,fn])=><label key={String(s)}>{String(s)}<select value={String(v)} onChange={e=>(fn as (v:string)=>void)(e.target.value)}><option value="">请选择</option><option>TikTok</option><option>Shopee</option></select></label>)}
       <label>仓库实收凭据号<input value={receipt} onChange={e=>setReceipt(e.target.value)}/></label><label>补发承运商<input value={carrier} onChange={e=>setCarrier(e.target.value)}/></label>
       <label>补发运单号<input value={tracking} onChange={e=>setTracking(e.target.value)}/></label></div>
       <label><input type="checkbox" checked={physicalConfirmed} onChange={e=>setPhysical(e.target.checked)}/> 已与仓库核实收回问题件并实际补发同 SKU，此次换货尚未另行登记库存流水。</label></>}
     <button className="btn primary" disabled={busy||note.trim().length<4||(refund?!returnIds.length||!refundIds.length:!physicalConfirmed||!carrier||!tracking||!receipt||!returnChannel||!shipChannel)} onClick={()=>void call('distFinish',{returnIds,refundIds,receipt,carrier,tracking,returnChannel,shipChannel,physicalConfirmed})}>{refund?'关联实际退款并办结':'确认换新并回传物流'}</button></>}
   {canUndo&&<button className="btn" disabled={busy||note.trim().length<4} onClick={()=>void call('distUndoRefund')}>撤销售后核销并重新核对</button>}
 </section>;
}
