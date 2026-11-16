"use client";
import {useEffect,useState} from 'react';
import {parseWorkspaceResponse} from '../lib/workspace-response.mjs';
import {reportFields} from '../lib/content-platform-report.mjs';
import type {Row} from './content-center-forms';

export const amountFields=[['attributedGmv','视频归属 GMV'],['videoGmv','视频 GMV'],['indirectGmv','间接 GMV'],['gpm','GPM']];
function RevisionHistory({site,row}:{site:string;row:Row}){
 const [offset,setOffset]=useState(0),[result,setResult]=useState<Row|null>(null),[error,setError]=useState('');
 useEffect(()=>{const c=new AbortController();setResult(null);setError('');
   const query=new URLSearchParams({view:'report-history',site,start:row.start_day,end:row.end_day,videoId:row.video_id,offset:String(offset)});
   fetch('/api/content-center?'+query,{signal:c.signal,cache:'no-store'}).then(parseWorkspaceResponse).then(d=>{if(!c.signal.aborted)setResult(d);}).catch(e=>{if(!c.signal.aborted)setError(e.message);});
   return()=>c.abort();
 },[site,row.start_day,row.end_day,row.video_id,row.revision,offset]);
 return <div>{error||(!result&&'正在读取历史…')}{result?.rows.map((v:Row)=><p key={v.revision}><b>V{v.revision} · {v.source_file}</b><small>{new Date(v.created_at).toLocaleString()} · {row.currency}</small>{reportFields.filter(([key])=>v.metrics[key]!=null).map(([key,label])=>label+' '+v.metrics[key]).join(' / ')}</p>)}{offset>0&&<button onClick={()=>setOffset(offset-20)}>上一页</button>}{result?.more&&<button onClick={()=>setOffset(offset+20)}>下一页</button>}</div>;
}
export function PlatformReports({site,refreshKey}:{site:string;refreshKey:number}){
 const [history,setHistory]=useState('');
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
    <td><details><summary>查看</summary><small>{r.source_file}</small>{reportFields.filter(([k])=>r.metrics[k]!=null).map(([k,label])=><p key={k}>{label} · {r.metrics[k]}{['ctr','liveRate'].includes(k)?'%':''}</p>)}</details>{r.revision>1&&<><button className="btn" onClick={()=>setHistory(history===[r.video_id,r.start_day,r.end_day].join('/')?'':[r.video_id,r.start_day,r.end_day].join('/'))}>修订历史</button>{history===[r.video_id,r.start_day,r.end_day].join('/')&&<RevisionHistory site={site} row={r}/>}</>}</td>
  </tr>)}</tbody></table></div>}
  {(offset>0||data?.more)&&<div className="cc-actions"><button className="btn" disabled={!offset} onClick={()=>setOffset(n=>n-50)}>上一页</button><button className="btn" disabled={!data?.more} onClick={()=>setOffset(n=>n+50)}>下一页</button></div>}
 </section>;
}
