"use client";
import {useEffect,useRef,useState} from 'react';
import {parseWorkspaceResponse} from '../lib/workspace-response.mjs';
import {reportFields} from '../lib/content-platform-report.mjs';
import type {Row} from './content-center-forms';

export const amountFields=[['attributedGmv','视频归属 GMV'],['videoGmv','视频 GMV'],['indirectGmv','间接 GMV'],['gpm','GPM']];
function VideoLink({row}:{row:Row}){
 return <a className="cc-report-video-link" href={row.videoUrl} target="_blank" rel="noopener noreferrer" aria-label={'打开视频 '+row.video_id+'（新标签页）'}>{row.video_id} ↗</a>;
}
function DeleteReport({row,onClose,onDeleted}:{row:Row;onClose:()=>void;onDeleted:()=>void}){
 const dialog=useRef<HTMLDialogElement>(null),[reason,setReason]=useState('填写错误'),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const [operationId]=useState(()=>crypto.randomUUID());
 useEffect(()=>{const el=dialog.current;el?.showModal();return()=>el?.close();},[]);
 async function remove(e:React.FormEvent){
  e.preventDefault();if(busy)return;setBusy(true);setError('');
  try{
   await parseWorkspaceResponse(await fetch('/api/content-center',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
    action:'deletePlatformReport',operationId,site:row.site,start:row.start_day,end:row.end_day,videoId:row.video_id,revision:row.revision,reason
   })}));
   onDeleted();
  }catch(e){setError(e instanceof Error?e.message:'删除失败，请重试');}finally{setBusy(false);}
 }
 return <dialog ref={dialog} className="cc-preview-dialog cc-report-delete-dialog" aria-labelledby="cc-delete-report-title" onCancel={e=>{if(busy)e.preventDefault();else onClose();}}>
  <form onSubmit={remove}><h3 id="cc-delete-report-title">删除这条导入记录？</h3>
   <p><b>{row.site} · {row.metrics.creatorName||'未提供创作者名字'}</b><br/>Video ID：{row.video_id}<br/>{row.start_day} 至 {row.end_day} · V{row.revision}</p>
   <p>删除后，数据罗盘会按剩余有效报表重新计算。TikTok 上的视频和已登记的发布记录不受影响，历史数据和删除原因会保留。</p>
   <label>删除原因<input value={reason} maxLength={300} required disabled={busy} onChange={e=>setReason(e.target.value)}/></label>
   <small>需要重新统计时，可再次导入核对正确的报表。</small>
   {error&&<p className="cc-error" role="alert">{error}</p>}
   <footer className="cc-actions"><button type="button" className="btn" disabled={busy} onClick={onClose}>先保留</button><button className="btn cc-delete-confirm" disabled={busy||!reason.trim()}>{busy?'正在删除…':'确认删除'}</button></footer>
  </form>
 </dialog>;
}
function RevisionHistory({site,row}:{site:string;row:Row}){
 const [offset,setOffset]=useState(0),[result,setResult]=useState<Row|null>(null),[error,setError]=useState('');
 useEffect(()=>{const c=new AbortController();setResult(null);setError('');
   const query=new URLSearchParams({view:'report-history',site,start:row.start_day,end:row.end_day,videoId:row.video_id,offset:String(offset)});
   fetch('/api/content-center?'+query,{signal:c.signal,cache:'no-store'}).then(parseWorkspaceResponse).then(d=>{if(!c.signal.aborted)setResult(d);}).catch(e=>{if(!c.signal.aborted)setError(e.message);});
   return()=>c.abort();
 },[site,row.start_day,row.end_day,row.video_id,row.revision,offset]);
 return <div>{error||(!result&&'正在读取历史…')}{result?.rows.map((v:Row)=><p key={v.revision}><b>V{v.revision} · {v.deleted_at?'已删除 · ':''}{v.source_file}</b><small>{new Date(v.created_at).toLocaleString()} · {row.currency}</small>{v.deleted_at?<span>删除原因：{v.delete_reason}（原数据保留，不计入统计）</span>:reportFields.filter(([key])=>v.metrics[key]!=null).map(([key,label])=>label+' '+v.metrics[key]).join(' / ')}</p>)}{offset>0&&<button onClick={()=>setOffset(offset-20)}>上一页</button>}{result?.more&&<button onClick={()=>setOffset(offset+20)}>下一页</button>}</div>;
}
export function PlatformReports({site,period,range='',refreshKey,onChanged}:{site:string;period?:string;range?:string;refreshKey:number;onChanged?:()=>void}){
 const [history,setHistory]=useState(''),[matching,setMatching]=useState('all');
 const [offset,setOffset]=useState(0),[data,setData]=useState<Row|null>(null),[error,setError]=useState('');
 const [deleting,setDeleting]=useState<Row|null>(null),[attempt,retry]=useState(0),[notice,setNotice]=useState('');
 useEffect(()=>{
   const ctl=new AbortController();setError('');setData(null);
   fetch('/api/content-center?'+new URLSearchParams({view:'platform-report',site,period:period||'all',range,matching,offset:String(offset)}),{cache:'no-store',signal:ctl.signal})
     .then(parseWorkspaceResponse).then(v=>{if(!ctl.signal.aborted)setData(v);})
     .catch(e=>{if(!ctl.signal.aborted)setError(e.message);});
   return ()=>ctl.abort();
 },[site,refreshKey,offset,period,range,matching,attempt]);
 return <section className="cc-card"><h3>{period?'创作者视频明细':site+' · 平台报表记录'}</h3>
  {deleting&&<DeleteReport row={deleting} onClose={()=>setDeleting(null)} onDeleted={()=>{setDeleting(null);setHistory('');setNotice('已删除，历史记录已保留。');if(data?.rows.length===1&&offset>0)setOffset(n=>Math.max(0,n-50));retry(n=>n+1);onChanged?.();}}/>}
  {notice&&<p role="status">{notice}</p>}
  {period&&<p>按报表结束日筛选。每行是一条视频在该报表期间的表现，金额为站点原币。</p>}
  <label>发布关联<select value={matching} onChange={e=>{setMatching(e.target.value);setOffset(0);}}><option value="all">全部报表</option><option value="unmatched">待关联发布</option><option value="matched">已关联发布</option></select></label>
  {data?.coverage&&<p>当前范围 {data.coverage.total} 条最新报表，已关联 {data.coverage.matched} 条，待关联 {data.coverage.total-data.coverage.matched} 条。按站点＋Video ID 精确匹配；报表结果不自动归功于内部拍摄人员。<small>未关联时，请在对应发布记录核对视频链接。</small></p>}
  {error?<p role="alert">{error}</p>:!data?<p>正在读取…</p>:!data.rows.length?<p>本页暂无记录。</p>:<div className="cc-table-scroll"><table><thead><tr>
    {['站点','报表期间','播放量','归属订单',...(period?amountFields.slice(0,1):amountFields).map(([,l])=>l),'指标明细','Creator name','Video ID','操作'].map(l=><th key={l}>{l}</th>)}
  </tr></thead><tbody>{data.rows.map((r:Row)=><tr key={[r.site,r.video_id,r.start_day,r.end_day].join('/')}>
    <td>{r.site}</td><td>{r.start_day} 至 {r.end_day}<small>{r.currency} · V{r.revision}</small></td>
    <td>{r.metrics.views?.toLocaleString()??'—'}</td><td>{r.metrics.orders?.toLocaleString()??'—'}</td>
    {(period?amountFields.slice(0,1):amountFields).map(([k])=><td key={k}>{r.metrics[k]?.toLocaleString()??'—'}</td>)}
    <td><details><summary>查看</summary><small>{r.source_file}</small><p>Creator name · {r.metrics.creatorName??'未提供'}</p><p>Video ID · <VideoLink row={r}/></p>{reportFields.filter(([k])=>k!=='creatorName'&&r.metrics[k]!=null).map(([k,label])=><p key={k}>{label} · {r.metrics[k]}{['ctr','liveRate','finishRate','ctor'].includes(k)?'%':''}</p>)}</details>{r.revision>1&&<><button className="btn" onClick={()=>setHistory(history===[r.site,r.video_id,r.start_day,r.end_day].join('/')?'':[r.site,r.video_id,r.start_day,r.end_day].join('/'))}>修订历史</button>{history===[r.site,r.video_id,r.start_day,r.end_day].join('/')&&<RevisionHistory site={r.site} row={r}/>}</>}</td>
    <td>{r.metrics.creatorName??'未提供'}</td><td><VideoLink row={r}/><small>{r.matched?'已关联发布':'待关联发布'}</small></td>
    <td>{r.canDelete?<button type="button" className="btn cc-report-delete" aria-label={'删除报表 '+r.video_id} onClick={()=>{setNotice('');setDeleting(r);}}>删除</button>:<small>只读</small>}</td>
  </tr>)}</tbody></table></div>}
  {(offset>0||data?.more)&&<div className="cc-actions"><button className="btn" disabled={!offset} onClick={()=>setOffset(n=>n-50)}>上一页</button><button className="btn" disabled={!data?.more} onClick={()=>setOffset(n=>n+50)}>下一页</button></div>}
 </section>;
}
