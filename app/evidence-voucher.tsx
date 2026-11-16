"use client";
import {useEffect,useState} from 'react';
type Row=Record<string,any>;
export default function Voucher({task,canCorrect}:{task:Row;canCorrect:boolean}){
 const [rows,setRows]=useState<Row[]|null>(null),[error,setError]=useState('');
 useEffect(()=>{const c=new AbortController();
  fetch('/api/business-actions?voucher='+encodeURIComponent(task.key),{cache:'no-store',signal:c.signal}).then(async r=>{const d=await r.json();if(!r.ok)throw Error(d.error);if(!c.signal.aborted)setRows(d.rows);}).catch(e=>{if(!c.signal.aborted)setError(e.message);});return()=>c.abort();
 },[task.key,task.basisHash]);
 return <section aria-label="原始日报凭据"><h4>原始日报凭据 · 只读</h4>{error?<p role="alert">{error}</p>:!rows?<p>正在读取凭据…</p>:<div className="table-wrap"><table><thead><tr>{['日报批次 / 录入人','SKU','销量','销售额','广告费','状态'].map(k=><th key={k}>{k}</th>)}</tr></thead><tbody>{rows.map((r,i)=><tr key={i}><td>{canCorrect&&!r.reversed_at?<a href={'/?page=sales&view=imports&entity='+encodeURIComponent(r.import_id)}>核对批次 {r.import_id}</a>:r.import_id}<small>{r.recorder}</small></td><td>{r.sku}</td><td>{r.qty}</td><td>{r.reported_amount??'待核实'} {r.currency}</td><td>{r.ad_cost??'待核实'} {r.currency}</td><td>{r.reversed_at?'已冲销':'当前生效'}</td></tr>)}</tbody></table></div>}</section>;
}
