"use client";
import {useCallback,useEffect,useState} from 'react';
import {parseWorkspaceResponse} from '../lib/workspace-response.mjs';
import {useVisibleRefresh} from './workspace-hooks';
import {MaterialUpload,SiteChoices,materialApi} from './content-material-upload';
import type {Row} from './content-center-forms';

type Receipt={site:string;status:string;handled_by:string|null;handled_at:string|null};
type Material={id:string;script_id:string|null;title:string;original_name:string;sku:string;note:string;shoot_from:string;shoot_to:string;batch_id:string;created_at:string;uploader:string;size:number;state:string;sites:Receipt[]};
const states:Record<string,string>={pending:'待下载',downloaded:'已下载',failed:'下载失败'};
const timestamp=(s:string)=>new Date(s).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false});
const errorText=(e:unknown)=>e instanceof Error?e.message:'操作失败，请重试';
const fileUrl=(id:string)=>materialApi+'?id='+encodeURIComponent(id);
function period(start:string,end:string){
  const [,m,d]=start.split('-').map(Number);
  return m+'月第'+Math.ceil(d/7)+'周 · '+start.slice(5)+' 至 '+(start.slice(0,4)===end.slice(0,4)?end.slice(5):end);
}
async function action(data:Row){
  return parseWorkspaceResponse(await fetch(materialApi,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)}));
}
function browserSave(blob:Blob,name:string){
  const url=URL.createObjectURL(blob),anchor=document.createElement('a');
  anchor.href=url;anchor.download=name;document.body.append(anchor);anchor.click();anchor.remove();
  window.setTimeout(()=>URL.revokeObjectURL(url),60000);
}
export function ContentMaterials({data,onDirty,refreshKey}:{data:Row;onDirty:(value:boolean)=>void;refreshKey:number}){
  const manage=['管理员','运营主管','拍摄剪辑'].includes(data.actor.role);
  const siteOptions:string[]=manage?data.sites:data.writeSites;
  const [site,setSite]=useState(siteOptions.length===1?siteOptions[0]:''),[q,setQ]=useState(''),[status,setStatus]=useState(''),[by,setBy]=useState('');
  const [from,setFrom]=useState(''),[to,setTo]=useState(''),[archived,setArchived]=useState(false),[page,setPage]=useState(1);
  const [upload,setUpload]=useState(false),[assign,setAssign]=useState(false),[targets,setTargets]=useState<string[]>([]);
  const [list,setList]=useState<{items:Material[];total:number;page:number}|null>(null),[selected,setSelected]=useState<string[]>([]);
  const [preview,setPreview]=useState<Material|null>(null),[busy,setBusy]=useState(false),[notice,setNotice]=useState(''),[error,setError]=useState('');
  const [revision,setRevision]=useState(0);
  const reload=useCallback(async()=>setRevision(n=>n+1),[]);
  useVisibleRefresh(reload,30000,!upload&&!busy&&!preview&&!assign);
  const params=new URLSearchParams({q,site,status,by,from,to,archived:archived?'1':'0',page:String(page)}).toString();
  useEffect(()=>{let alive=true;const controller=new AbortController();
    const timer=setTimeout(async()=>{
      try{const res=await parseWorkspaceResponse(await fetch(materialApi+'?'+params,{cache:'no-store',signal:controller.signal}));
        if(alive){setList(res);setSelected(old=>old.filter(id=>res.items.some((r:Material)=>r.id===id)));}}
      catch(e){if(alive)setError(errorText(e));}
    },120);
    return()=>{alive=false;controller.abort();clearTimeout(timer);};
  },[params,revision,refreshKey]);
  function filterChange(change:()=>void){change();setPage(1);setSelected([]);setList(null);setAssign(false);setError('');setNotice('');}
  async function mutate(form:Row,msg:string){
    setError('');setNotice('');setBusy(true);
    try{await action(form);setNotice(msg);setAssign(false);setSelected([]);reload();}catch(e){setError(errorText(e));}finally{setBusy(false);}
  }
  async function download(rows:Material[],receiptSite?:string){
    if(!rows.length||busy)return;
    setBusy(true);setNotice('');setError('');
    try{
      if(rows.length>1&&rows.reduce((sum,r)=>sum+r.size,0)>128*1048576)throw Error('批量下载合计最多 128 MB，请减少勾选数量或逐条下载。');
      const zip=rows.length>1?(await import('fflate')).zipSync:null;
      const archive:Record<string,Uint8Array>={};
      for(const [i,row] of rows.entries()){
        let blob:Blob;
        try{
          const res=await fetch(fileUrl(row.id)+'&download=1',{cache:'no-store'});
          if(!res.ok)throw Error('下载失败，请重试');
          blob=await res.blob();
          if(blob.size!==row.size)throw Error('文件接收不完整，请重新下载');
        }catch(e){
          const target=receiptSite||(site&&data.writeSites.includes(site)?site:row.sites.length===1&&data.writeSites.includes(row.sites[0].site)?row.sites[0].site:'');
          if(target){await action({action:'failed',ids:[row.id],site:target});reload();}
          throw Error(row.title+' · '+errorText(e));
        }
        if(zip)archive[(i+1)+'-'+row.original_name.replace(/[/\\:\x00-\x1f]/g,'_')]=new Uint8Array(await blob.arrayBuffer());
        else browserSave(blob,row.original_name);
      }
      if(zip){const bytes=new Uint8Array(zip(archive,{level:0}));browserSave(new Blob([bytes],{type:'application/zip'}),'成片素材.zip');}
      setNotice('已发起文件保存。请核对本地视频后，在对应站点点「确认已下载」。');
    }catch(e){setError(errorText(e));}finally{setBusy(false);}
  }
  const rows=list?.items||[],chosen=rows.filter(r=>selected.includes(r.id));
  function toggle(id:string){setSelected(old=>old.includes(id)?old.filter(s=>s!==id):[...old,id]);}
  return <div className="cc-materials"><header className="cc-row"><div><h3>成片分发</h3><small>{manage?'按拍摄周期分发视频，查看各站领取情况。':'查看分配到本站的成片，下载后确认收件。'}</small></div>
    {manage&&!upload&&<button className="btn primary" onClick={()=>setUpload(true)}>＋ 批量上传视频</button>}</header>
    {upload&&<MaterialUpload sites={siteOptions} scripts={data.scripts.filter((s:Row)=>s.source==='studio')} onClose={()=>setUpload(false)} onDone={reload} onDirty={onDirty}/>}
    <div className="cc-material-filters">
      <label className="cc-search">搜索素材<input type="search" value={q} placeholder="素材名称、产品编码或批次" onChange={e=>filterChange(()=>setQ(e.target.value))}/></label>
      <label>分发站点<select value={site} onChange={e=>filterChange(()=>setSite(e.target.value))}><option value="">全部可见站点</option>{siteOptions.map(s=><option key={s}>{s}</option>)}</select></label>
      <label>下载状态<select value={status} onChange={e=>filterChange(()=>setStatus(e.target.value))}><option value="">全部状态</option>{Object.entries(states).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select></label>
      <label>上传人<select value={by} onChange={e=>filterChange(()=>setBy(e.target.value))}><option value="">所有上传人</option>{data.people.filter((u:Row)=>['拍摄剪辑','运营主管','管理员'].includes(u.role)).map((u:Row)=><option key={u.id} value={u.id}>{u.name}</option>)}</select></label>
      <label>上传起日<input type="date" value={from} max={to||undefined} onInput={e=>{const value=e.currentTarget.value;filterChange(()=>setFrom(value));}} readOnly={false}/></label>
      <label>上传止日<input type="date" value={to} min={from||undefined} onInput={e=>{const value=e.currentTarget.value;filterChange(()=>setTo(value));}} readOnly={false}/></label>
      {manage&&<label className="cc-inline"><input type="checkbox" checked={archived} onChange={e=>filterChange(()=>setArchived(e.target.checked))}/>只看已归档</label>}
    </div>
    {error&&<p role="alert" className="cc-error">{error}</p>}{notice&&<p role="status" className="cc-note">{notice}</p>}
    <div className="cc-bar"><strong>{list?'共 '+list.total+' 条成片':'正在读取成片…'}</strong>
      {selected.length>0&&<div className="cc-actions"><span>已选 {selected.length} 条</span><button className="btn" disabled={busy} onClick={()=>void download(chosen)}>批量下载</button>
        {!archived&&site&&data.writeSites.includes(site)&&<button className="btn" disabled={busy} onClick={()=>void mutate({action:'downloaded',ids:selected,site},'已登记本站下载结果')}>确认本站已下载</button>}
        {manage&&!archived&&<><button className="btn" disabled={busy} onClick={()=>setAssign(!assign)}>追加分发站点</button><button className="btn" disabled={busy} onClick={()=>{if(window.confirm('归档后运营将看不到所选成片，下载记录会保留。确认归档？'))void mutate({action:'archive',ids:selected},'成片已归档');}}>批量归档</button></>}</div>}</div>
    {assign&&selected.length>0&&<div className="cc-card"><SiteChoices options={siteOptions} value={targets} onChange={setTargets}/><button className="btn primary" disabled={busy||!targets.length} onClick={()=>void mutate({action:'assign',ids:selected,sites:targets},'已分发到所选站点')}>确认追加分发</button></div>}
    {preview&&<div className="cc-player"><div className="cc-row"><strong>{preview.title}</strong><button className="btn" onClick={()=>setPreview(null)}>关闭预览</button></div><video key={preview.id} src={fileUrl(preview.id)} controls autoPlay playsInline preload="metadata"/><small>{preview.original_name}</small></div>}
    {list&&(!rows.length?<p className="cc-empty">{q||site||status||by||from||to||archived?'当前条件下没有成片。':'暂无已分发成片。'}</p>:<div className="cc-table-scroll"><table className="cc-material-table"><thead><tr><th><input type="checkbox" aria-label="选择本页全部素材" checked={selected.length===rows.length} onChange={e=>setSelected(e.target.checked?rows.map(r=>r.id):[])}/></th><th>成片 / 产品编码</th><th>拍摄周期 / 上传批次</th><th>站点下载记录</th><th>操作</th></tr></thead>
      <tbody>{rows.map(row=><tr key={row.id}><td><input type="checkbox" aria-label={'选择 '+row.title} checked={selected.includes(row.id)} onChange={()=>toggle(row.id)}/></td>
        <td><div className="cc-film"><button className="cc-thumb" aria-label={'预览 '+row.title} onClick={()=>setPreview(row)}><video muted playsInline preload="metadata" src={fileUrl(row.id)+'#t=0.1'}/><span aria-hidden="true">▶</span></button><div><strong>{row.title}</strong><small>{row.sku} · {(row.size/1048576).toFixed(1)} MB</small>{row.original_name!==row.title&&<small>{row.original_name}</small>}{row.script_id&&<small>关联需求 · {data.scripts.find((s:Row)=>s.id===row.script_id)?.title}</small>}{row.note&&<small>{row.note}</small>}</div></div></td>
        <td>{period(row.shoot_from,row.shoot_to)}<small>{row.uploader} · {timestamp(row.created_at)}</small><small title={row.batch_id}>批次 {row.batch_id.slice(0,8)}</small></td>
        <td>{row.sites.map(r=><div className="cc-receipt" key={r.site}><span>{r.site}</span><span className={'cc-state '+r.status}>{states[r.status]}</span>
          {!archived&&r.status!=='downloaded'&&data.writeSites.includes(r.site)&&<button disabled={busy} className="cc-text-action" onClick={()=>void mutate({action:'downloaded',ids:[row.id],site:r.site},'已登记'+r.site+'下载结果')}>确认已下载</button>}
          {r.handled_at&&<small>{r.handled_by} · {timestamp(r.handled_at)}</small>}</div>)}</td>
        <td><button className="btn" disabled={busy} onClick={()=>void download([row])}>下载原片</button></td></tr>)}</tbody></table></div>)}
    {list&&list.total>24&&<div className="cc-pager"><button className="btn" disabled={list.page===1} onClick={()=>{setSelected([]);setPage(list.page-1);}}>上一页</button> {list.page} / {Math.ceil(list.total/24)} <button className="btn" disabled={list.page*24>=list.total} onClick={()=>{setSelected([]);setPage(list.page+1);}}>下一页</button></div>}
  </div>;
}
