"use client";
import SkuLabel from './sku-label';

import {useCallback,useEffect,useState} from 'react';
import {parseWorkspaceResponse} from '../lib/workspace-response.mjs';
import {useVisibleRefresh} from './workspace-hooks';
import {MaterialUpload,SiteChoices,materialApi} from './content-material-upload';
import {receiveMaterial} from '../lib/material-download.mjs';
import {MaterialFields,defaultOptions,type MaterialMetadata,type MaterialOptions} from './content-material-fields';
import type {Row} from './content-center-forms';

type Receipt={site:string;status:string;handled_by:string|null;handled_at:string|null};
type Material={metadata:MaterialMetadata;revision:number;id:string;script_id:string|null;title:string;original_name:string;sku:string;note:string;shoot_from:string;shoot_to:string;batch_id:string;created_at:string;uploader:string;size:number;state:string;sites:Receipt[]};
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
  const [editing,setEditing]=useState<Material|null>(null),[replacement,setReplacement]=useState<Material|null>(null),[optionForm,setOptionForm]=useState<MaterialOptions|null>(null);
  const [upload,setUpload]=useState(false),[assign,setAssign]=useState(false),[targets,setTargets]=useState<string[]>([]);
  const [list,setList]=useState<{items:Material[];total:number;page:number;options:{version:number;values:MaterialOptions}}|null>(null),[selected,setSelected]=useState<string[]>([]);
  const [preview,setPreview]=useState<Material|null>(null),[busy,setBusy]=useState(false),[notice,setNotice]=useState(''),[error,setError]=useState('');
  const [revision,setRevision]=useState(0);
  const reload=useCallback(async()=>setRevision(n=>n+1),[]);
  useVisibleRefresh(reload,10000,!upload&&!busy&&!preview&&!assign&&!editing&&!optionForm);
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
    try{await action(form);setNotice(msg);setAssign(false);setEditing(null);setOptionForm(null);onDirty(false);setSelected([]);reload();}catch(e){setError(errorText(e));}finally{setBusy(false);}
  }
  async function download(rows:Material[],receiptSite?:string){
    if(!rows.length||busy)return;
    setBusy(true);setNotice('');setError('');
    const target=(row:Material)=>row.state!=='ready'?'':receiptSite||(site&&data.writeSites.includes(site)?site:row.sites.filter(r=>data.writeSites.includes(r.site)).length===1?row.sites.find(r=>data.writeSites.includes(r.site))!.site:'');
    try{
      if(!manage&&rows.some(row=>!target(row)))throw Error('请先选择收件站点，便于自动同步下载状态。');
      if(rows.length>1&&rows.reduce((sum,r)=>sum+r.size,0)>128*1048576)throw Error('批量打包最多128 MB，请减少勾选数量或逐条下载。');
      const filename=rows.length>1?'成片素材.zip':rows[0].original_name;
      // Invoke the picker in the original click gesture, before fetching anything.
      const handle=typeof (window as any).showSaveFilePicker==='function'?await (window as any).showSaveFilePicker({suggestedName:filename}):null;
      const zip=rows.length>1?(await import('fflate')).zipSync:null;
      const archive:Record<string,Uint8Array>={};
      for(const [i,row] of rows.entries()){
        try{
          const response=await fetch(fileUrl(row.id)+'&download=1',{cache:'no-store'});
          const writable=handle&&!zip?await handle.createWritable():null;
          const blob=await receiveMaterial(response,row.size,writable,(n:number,total:number)=>setNotice('正在接收 '+row.original_name+' · '+Math.floor(100*n/total)+'%'));
          if(zip)archive[(i+1)+'-'+row.original_name.replace(/[/\\:\x00-\x1f]/g,'_')]=new Uint8Array(await blob!.arrayBuffer());
          else if(blob)browserSave(blob,row.original_name);
        }catch(e){if(target(row))try{await action({action:'failed',ids:[row.id],site:target(row)});}catch{}throw Error(row.title+' · '+errorText(e));}
      }
      if(zip)try{const blob=new Blob([new Uint8Array(zip(archive,{level:0}))],{type:'application/zip'});
        if(handle){const out=await handle.createWritable();try{await out.write(blob);await out.close();}catch(e){try{await out.abort();}catch{}throw e;}}else browserSave(blob,filename);
      }catch(e){for(const row of rows)if(target(row))try{await action({action:'failed',ids:[row.id],site:target(row)});}catch{}throw e;}
      const groups=new Map<string,string[]>();for(const row of rows)if(target(row))groups.set(target(row),[...(groups.get(target(row))||[]),row.id]);
      try{for(const [site,ids] of groups)await action({action:'downloaded',ids,site});}
      catch{throw Error('文件已接收，但下载状态同步失败；可点击“确认已下载”补记，无需重复下载。');}
      const synced=groups.size?'下载状态已同步。':'';setNotice(handle?'已保存「'+filename+'」至您选择的位置。'+synced:'视频已完整接收并交给浏览器保存。'+synced+'请在浏览器“下载内容”中查看文件及保存位置。');
    }catch(e){if((e as Error).name==='AbortError')setNotice('已取消保存，可重新下载。');else setError(errorText(e));}
    finally{reload();setBusy(false);}
  }
  const rows=list?.items||[],chosen=rows.filter(r=>selected.includes(r.id));
  function toggle(id:string){setSelected(old=>old.includes(id)?old.filter(s=>s!==id):[...old,id]);}
  return <div className="cc-materials"><header className="cc-row"><div><h3>成片分发</h3><small>{manage?'按拍摄周期分发视频，查看各站领取情况。':'查看分配到本站的成片，下载完成后自动同步收件状态。'}</small></div>
    {data.actor.role==='管理员'&&!upload&&<button className="btn" onClick={()=>{setOptionForm(list?.options.values||defaultOptions);onDirty(true);}}>维护常用选项</button>}{manage&&!upload&&<button className="btn primary" onClick={()=>{setReplacement(null);setUpload(true);}}>＋ 批量上传视频</button>}</header>
    {upload&&<MaterialUpload key={replacement?.id||'new'} actorId={data.actor.id} products={data.skus} options={list?.options.values||defaultOptions} replacement={replacement} sites={siteOptions} scripts={data.scripts.filter((s:Row)=>s.source==='studio')} onClose={()=>{setUpload(false);setReplacement(null);}} onDone={reload} onDirty={onDirty}/>}
    {optionForm&&<form className="cc-card" onSubmit={e=>{e.preventDefault();void mutate({action:'options',options:optionForm,version:list?.options.version||0},'常用选项已保存');}}><h3>管理员维护常用选项</h3><div className="cc-input-grid">{(['colors','directions','sellingPoints'] as const).map((k,i)=><label key={k}>{['拍摄颜色','内容方向','视频卖点'][i]}<textarea value={optionForm[k].join('、')} onChange={e=>setOptionForm({...optionForm,[k]:e.target.value.split(/[、,，\n]/).map(v=>v.trim()).filter(Boolean)})}/><small>用逗号或顿号分隔；上传人仍可自行输入其他内容。</small></label>)}</div><button className="btn primary" disabled={busy}>保存常用选项</button><button type="button" className="btn" onClick={()=>{setOptionForm(null);onDirty(false);}}>取消</button></form>}
    {editing&&<form className="cc-card" onSubmit={e=>{e.preventDefault();void mutate({action:'edit',ids:[editing.id],version:editing.revision,title:editing.title,sku:editing.sku,note:editing.note,metadata:editing.metadata},'素材信息已更新，无需重传视频');}}><h3>编辑成片信息</h3><label>素材名称<input required value={editing.title} onChange={e=>setEditing({...editing,title:e.target.value})}/></label><MaterialFields sku={editing.sku} metadata={editing.metadata} products={data.skus} options={list?.options.values||defaultOptions} locked={!!editing.script_id} onSku={sku=>setEditing(old=>old?{...old,sku}:old)} onChange={metadata=>setEditing(old=>old?{...old,metadata}:old)}/><label>备注<input value={editing.note} onChange={e=>setEditing({...editing,note:e.target.value})}/></label><button className="btn primary" disabled={busy}>保存信息</button><button type="button" className="btn" onClick={()=>{setEditing(null);onDirty(false);}}>取消</button></form>}
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
    {preview&&<div className="cc-player"><div className="cc-row"><strong>{preview.title}</strong><button className="btn" onClick={()=>setPreview(null)}>关闭预览</button></div><video key={preview.id} src={fileUrl(preview.id)} controls autoPlay playsInline preload="metadata" onError={()=>setError('当前视频无法预览。请重试下载；若文件能正常下载，请上传 MP4（H.264/AAC）版本以兼容浏览器。')}/><small>{preview.original_name}</small></div>}
    {list&&(!rows.length?<p className="cc-empty">{q||site||status||by||from||to||archived?'当前条件下没有成片。':'暂无已分发成片。'}</p>:<div className="cc-table-scroll"><table className="cc-material-table"><thead><tr><th><input type="checkbox" aria-label="选择本页全部素材" checked={selected.length===rows.length} onChange={e=>setSelected(e.target.checked?rows.map(r=>r.id):[])}/></th><th>成片 / 产品编码</th><th>拍摄周期 / 上传批次</th><th>站点下载记录</th><th>操作</th></tr></thead>
      <tbody>{rows.map(row=><tr key={row.id}><td><input type="checkbox" aria-label={'选择 '+row.title} checked={selected.includes(row.id)} onChange={()=>toggle(row.id)}/></td>
        <td><div className="cc-film"><button className="cc-thumb" aria-label={'预览 '+row.title} onClick={()=>setPreview(row)}><video muted playsInline preload="none" src={fileUrl(row.id)+'#t=0.1'}/><span aria-hidden="true">▶</span></button><div><strong>{row.title}</strong><small><SkuLabel sku={row.sku}/> · {row.metadata.productName} · {(row.size/1048576).toFixed(1)} MB</small>{row.original_name!==row.title&&<small>{row.original_name}</small>}{row.script_id&&<small>关联需求 · {data.scripts.find((s:Row)=>s.id===row.script_id)?.title}</small>}{[...(row.metadata.colors||[]),...(row.metadata.directions||[]),...(row.metadata.sellingPoints||[])].length>0&&<small>{[...(row.metadata.colors||[]),...(row.metadata.directions||[]),...(row.metadata.sellingPoints||[])].join(' · ')}</small>}{row.note&&<small>{row.note}</small>}</div></div></td>
        <td>{period(row.shoot_from,row.shoot_to)}<small>{row.uploader} · {timestamp(row.created_at)}</small><small title={row.batch_id}>批次 {row.batch_id.slice(0,8)}</small></td>
        <td>{row.sites.map(r=><div className="cc-receipt" key={r.site}><span>{r.site}</span><span className={'cc-state '+r.status}>{states[r.status]}</span>
          {!archived&&r.status!=='downloaded'&&data.writeSites.includes(r.site)&&<button disabled={busy} className="cc-text-action" onClick={()=>void mutate({action:'downloaded',ids:[row.id],site:r.site},'已登记'+r.site+'下载结果')}>确认已下载</button>}
          {r.handled_at&&<small>{r.handled_by} · {timestamp(r.handled_at)}</small>}</div>)}</td>
        <td><div className="cc-actions"><button className="btn" disabled={busy} onClick={()=>void download([row])}>下载原片</button>{manage&&!archived&&<><button className="btn" disabled={busy||upload} onClick={()=>{setEditing(row);onDirty(true);}}>编辑</button><button className="btn" disabled={busy||upload} onClick={()=>{setReplacement(row);setUpload(true);}}>替换</button><button className="btn" disabled={busy} onClick={()=>{if(window.confirm('确认删除此成片？运营将不再看到该视频，历史下载记录仍会保留。'))void mutate({action:'delete',ids:[row.id]},'成片已删除，历史记录保留');}}>删除</button></>}</div></td></tr>)}</tbody></table></div>)}
    {list&&list.total>24&&<div className="cc-pager"><button className="btn" disabled={list.page===1} onClick={()=>{setSelected([]);setPage(list.page-1);}}>上一页</button> {list.page} / {Math.ceil(list.total/24)} <button className="btn" disabled={list.page*24>=list.total} onClick={()=>{setSelected([]);setPage(list.page+1);}}>下一页</button></div>}
  </div>;
}
