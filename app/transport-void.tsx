"use client";
import {useEffect,useId,useState} from 'react';
// Workspace snapshots carry optional fields across historical schema versions.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row=Record<string,any>;
type Act=(action:string,payload:Row,success:string,onError?:(message:string)=>void)=>Promise<Row|null>;
const key=(row:Row)=>`${row.kind}:${row.id}`;
const fmt=(n:unknown)=>Number(n||0).toLocaleString('zh-CN');

export default function TransportVoid({leg,act,busy,onClose}:{leg:Row;act:Act;busy:boolean;onClose:()=>void}){
  const heading=useId();
  const [version]=useState(leg.version);
  const [candidates,setCandidates]=useState<Row[]>([]),[selected,setSelected]=useState<string[]>([]);
  const [query,setQuery]=useState(''),[search,setSearch]=useState('');
  const [loading,setLoading]=useState(true),[error,setError]=useState(''),[retry,setRetry]=useState(0);
  const [reason,setReason]=useState('原海运单与实际不符，实际到仓已在历史到仓中登记。');
  const [discrepancyReason,setDiscrepancyReason]=useState(''),[confirmed,setConfirmed]=useState(false);
  const reloadCandidates=()=>{setLoading(true);setError('');setSelected([]);setConfirmed(false);setSearch(query.trim());setRetry(value=>value+1);};
  useEffect(()=>{
    const controller=new AbortController();
    fetch('/api/system',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'transportVoidCandidates',legId:leg.id,q:search}),signal:controller.signal})
      .then(async response=>{const result=await response.json();if(!response.ok)throw Error(result.error||'到仓记录暂时没有读到，请重试。');return result;})
      .then(result=>{if(!controller.signal.aborted){setCandidates(result.candidates||[]);setSelected([]);}})
      .catch(err=>{if(!controller.signal.aborted)setError(err.message);})
      .finally(()=>{if(!controller.signal.aborted)setLoading(false);});
    return()=>controller.abort();
  },[leg.id,retry,search]);
  const choices=candidates.filter(row=>selected.includes(key(row)));
  const expected=new Map<string,number>(),actual=new Map<string,number>();
  for(const row of leg.items||[])expected.set(row.sku,(expected.get(row.sku)||0)+Number(row.qty||0));
  for(const candidate of choices)for(const row of candidate.sourceItems||[])actual.set(row.sku,(actual.get(row.sku)||0)+Number(row.qty||0));
  const skus=[...new Set([...expected.keys(),...actual.keys()])];
  const mismatch=choices.length>0&&skus.some(sku=>(expected.get(sku)||0)!==(actual.get(sku)||0));
  const stale=version!==leg.version||leg.stage==='voided';
  const submit=async(e:React.FormEvent)=>{
    e.preventDefault();setError('');
    if(stale){setError('这张单已更新，请关闭后重新核对。');return;}
    const result=await act('voidTransportLeg',{legId:leg.id,version,historyRefs:choices.map(row=>({kind:row.kind,id:row.id,skus:(row.sourceItems||[]).map((item:Row)=>item.sku)})),reason,discrepancyReason:mismatch?discrepancyReason:'',confirmed},'旧海运单已删除并保留记录，现有库存未改变。',setError);
    if(result)onClose();
  };
  return <form className="transport-editor" onSubmit={submit} aria-labelledby={heading}>
    <h4 id={heading}>删除旧海运单 · {leg.leg_no}</h4>
    <p className="notice info">适用于实际货物已在“历史到仓”登记的旧单。删除后不再提示签收，也不再计入在途；不会增加或扣减库存，原发货记录保留。</p>
    <div className="transport-actions"><label style={{flex:1}}>按历史到仓单号或凭据查找<input type="search" value={query} onChange={e=>setQuery(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();reloadCandidates();}}} placeholder="输入已补录的到仓单号" disabled={busy}/></label><button className="btn" type="button" disabled={busy||loading} onClick={reloadCandidates}>查找</button></div>
    <fieldset disabled={busy||loading||stale} style={{border:0,padding:0,margin:0,minWidth:0}}>
      <legend>选择已登记的历史到仓凭据 · {leg.site} / {leg.channel}</legend>
      {loading?<p role="status">正在读取历史到仓记录…</p>:candidates.length===0?<p>没有找到这个站点、渠道下可核对的历史到仓记录。请先到“历史到仓”核对实际入仓单号。</p>:<div className="table-wrap" style={{maxHeight:280,overflowY:'auto'}}><table><thead><tr><th>选择</th><th>到仓单号 / 凭据</th><th>日期</th><th>关联 SKU / 实际数量</th></tr></thead><tbody>{candidates.map(row=><tr key={key(row)}><td><input type="checkbox" aria-label={`关联 ${row.receiptNo}`} disabled={row.selectable===false} checked={selected.includes(key(row))} onChange={e=>{setSelected(e.target.checked?[...selected,key(row)]:selected.filter(value=>value!==key(row)));setConfirmed(false);}}/></td><td>{row.receiptNo}<div className="cell-note">{row.proofRef||'—'}</div>{row.selectable===false&&<div className="cell-note">已关联其他海运单</div>}</td><td>{row.date||row.businessDate||'—'}</td><td>{(row.sourceItems||[]).map((item:Row)=><div key={item.sku}>{item.sku} · {fmt(item.qty)} 件</div>)}</td></tr>)}</tbody></table></div>}
      {choices.length>0&&<><h4>核对旧单与历史到仓</h4><div className="table-wrap"><table><thead><tr><th>SKU</th><th>旧海运单</th><th>关联历史到仓</th></tr></thead><tbody>{skus.map(sku=><tr key={sku}><td>{sku}</td><td>{fmt(expected.get(sku))} 件</td><td>{fmt(actual.get(sku))} 件</td></tr>)}</tbody></table></div><p className="cell-note">此处用于核对关联，不会把历史数量回填成这张海运单的签收数量。</p></>}
      <div className="transport-form-grid"><label className="wide">删除原因<textarea required minLength={4} maxLength={500} rows={2} value={reason} onChange={e=>setReason(e.target.value)}/></label>
      {mismatch&&<label className="wide">数量或 SKU 不一致，请说明原因（至少 8 个字）<textarea required minLength={8} maxLength={500} rows={2} value={discrepancyReason} onChange={e=>setDiscrepancyReason(e.target.value)} placeholder="例如：旧单数量录入不符，实际入仓以所选历史凭据为准。"/></label>}</div>
      <label style={{display:'flex',alignItems:'flex-start',gap:8,marginTop:16}}><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)} style={{width:'auto',marginTop:4}}/><span>已核对所选凭据确实对应这批货，不再通过旧海运单登记到仓。</span></label>
    </fieldset>
    {stale&&<p className="notice warn">单据状态已变化，请关闭后重新核对。</p>}
    {error&&<p className="notice error" role="alert">{error}</p>}
    <div className="transport-actions"><button className="btn" type="button" disabled={busy} onClick={onClose}>取消</button>{error&&<button className="btn" type="button" disabled={busy||loading} onClick={reloadCandidates}>重新读取</button>}<button className="btn danger" type="submit" disabled={busy||loading||stale||choices.length===0||!confirmed||reason.trim().length<4||mismatch&&discrepancyReason.trim().length<8}>{busy?'正在处理…':'确认删除旧单，保留记录'}</button></div>
  </form>;
}
