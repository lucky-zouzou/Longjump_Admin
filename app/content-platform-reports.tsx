"use client";
import {useEffect,useState} from 'react';
import {parseWorkspaceResponse} from '../lib/workspace-response.mjs';
import {reportFields} from '../lib/content-platform-report.mjs';
import type {Row} from './content-center-forms';

export const amountFields=[['attributedGmv','视频归属 GMV'],['videoGmv','视频 GMV'],['indirectGmv','间接 GMV'],['gpm','GPM']];
export function PlatformReports({site,refreshKey}:{site:string;refreshKey:number}){
 const [offset,setOffset]=useState(0),[data,setData]=useState<Row|null>(null),[error,setError]=useState('');
 useEffect(()=>{
   const ctl=new AbortController();setError('');setData(null);
   fetch('/api/content-center?view=platform-report&site='+encodeURIComponent(site)+'&offset='+offset,{cache:'no-store',signal:ctl.signal})
     .then(parseWorkspaceResponse).then(v=>{if(!ctl.signal.aborted)setData(v);})
     .catch(e=>{if(!ctl.signal.aborted)setError(e.message);});
   return ()=>ctl.abort();
 },[site,refreshKey,offset]);
 return <section className="cc-card"><h3>{site} · 平台报表记录</h3>
  {error?<p role="alert">{error}</p>:!data?<p>正在读取…</p>:!data.rows.length?<p>本页暂无记录。</p>:<div className="cc-table-scroll"><table><thead><tr>
    {['视频编号 / 匹配','报表期间',...amountFields.map(([,l])=>l),'指标明细'].map(l=><th key={l}>{l}</th>)}
  </tr></thead><tbody>{data.rows.map((r:Row)=><tr key={[r.video_id,r.start_day,r.end_day].join('/')}>
    <td>{r.video_id}<small>{r.matched?'已关联发布':'待关联发布'}</small></td><td>{r.start_day} 至 {r.end_day}<small>{r.currency} · V{r.revision}</small></td>
    {amountFields.map(([k])=><td key={k}>{r.metrics[k]?.toLocaleString()??'—'}</td>)}
    <td><details><summary>查看</summary><small>{r.source_file}</small>{reportFields.filter(([k])=>r.metrics[k]!=null).map(([k,label])=><p key={k}>{label} · {r.metrics[k]}{['ctr','liveRate'].includes(k)?'%':''}</p>)}</details></td>
  </tr>)}</tbody></table></div>}
  {(offset>0||data?.more)&&<div className="cc-actions"><button className="btn" disabled={!offset} onClick={()=>setOffset(n=>n-50)}>上一页</button><button className="btn" disabled={!data?.more} onClick={()=>setOffset(n=>n+50)}>下一页</button></div>}
 </section>;
}
