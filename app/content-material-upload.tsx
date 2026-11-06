"use client";
import {useRef,useState} from 'react';
import {parseWorkspaceResponse} from '../lib/workspace-response.mjs';
import {useDirtyGuard} from './workspace-hooks';

export const materialApi='/api/content-center/materials';
const partSize=8*1024*1024;
const maxSize=256*1024*1024;
type Entry={id:string;file:File;title:string;sku:string;message:string;started:boolean;done:boolean};
export function SiteChoices({options,value,onChange}:{options:string[];value:string[];onChange:(v:string[])=>void}){
  return <div className="cc-site-options">{options.map(site=><label key={site}><input type="checkbox" checked={value.includes(site)} onChange={e=>onChange(e.target.checked?[...value,site]:value.filter(s=>s!==site))}/>{site}</label>)}</div>;
}
export function MaterialUpload({sites,scripts,onDone,onClose,onDirty}:{sites:string[];scripts:{id:string;title:string;sku:string}[];onDone:()=>void;onClose:()=>void;onDirty:(value:boolean)=>void}){
  const [entries,setEntries]=useState<Entry[]>([]),[batch]=useState(()=>crypto.randomUUID());
  const [targets,setTargets]=useState<string[]>([]),[sku,setSku]=useState(''),[note,setNote]=useState('');
  const [scriptId,setScriptId]=useState('');
  const startDate=useRef<HTMLInputElement>(null),endDate=useRef<HTMLInputElement>(null);
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const dirty=entries.some(e=>!e.done);
  const confirmLeave=useDirtyGuard(dirty);
  const started=entries.some(e=>e.started);
  function change(id:string,patch:Partial<Entry>){setEntries(old=>old.map(e=>e.id===id?{...e,...patch}:e));}
  function choose(files:File[]){
    const invalid=files.find(f=>!f.size||f.size>maxSize||!(/\.(mp4|mov|webm)$/i.test(f.name)));
    if(invalid){setError(invalid.name+' 无法加入，请选择不超过 256 MB 的 MP4、MOV 或 WebM 视频。');return;}
    if(entries.length+files.length>50){setError('每批最多 50 条视频，请分批上传。');return;}
    setError('');setEntries(old=>[...old,...files.map(file=>({id:crypto.randomUUID(),file,title:file.name.replace(/\.[^.]+$/,''),sku:'',message:'待上传',started:false,done:false}))]);onDirty(true);
  }
  async function submit(){
    if(busy)return;
    const from=startDate.current?.value||'',to=endDate.current?.value||'';
    if(!from||!to||from>to){setError('请核对拍摄开始和结束日期。');return;}
    if(!targets.length){setError('请至少选择一个分发站点。');return;}
    const invalid=entries.find(e=>!e.title.trim()||!(e.sku.trim()||sku.trim()));
    if(invalid){setError(invalid.file.name+' 缺少素材名称或产品编码。');return;}
    setBusy(true);setError('');let failed=0;
    for(const entry of entries.filter(e=>!e.done)){
      change(entry.id,{started:true});
      const file=entry.file,meta={id:entry.id,batch,scriptId,original:file.name,title:entry.title,sku:entry.sku.trim()||sku.trim(),note,from,to,sites:targets,size:file.size};
      try{
        for(let offset=0;offset<file.size;offset+=partSize){
          change(entry.id,{message:'上传中 '+Math.floor(100*offset/file.size)+'%'});
          const form=new FormData();form.set('file',file.slice(offset,offset+partSize),'part');form.set('part',String(offset/partSize));form.set('meta',JSON.stringify(meta));
          await parseWorkspaceResponse(await fetch(materialApi,{method:'POST',body:form}));
        }
        change(entry.id,{done:true,message:'已分发'});
      }catch(e){failed++;change(entry.id,{message:e instanceof Error?e.message:'上传中断，可重试'});}
    }
    setBusy(false);onDone();
    if(failed)setError('有 '+failed+' 条未完成，重试会跳过已分发视频。');
    else onDirty(false);
  }
  return <section className="cc-upload cc-card"><div className="cc-row"><h3>批量上传成片</h3><button className="btn" disabled={busy} onClick={()=>{if(!dirty||confirmLeave()){onDirty(false);onClose();}}}>关闭</button></div>
    <fieldset disabled={busy||started} className="cc-input-grid">
      <label>拍摄开始日期<input type="date" ref={startDate}/></label>
      <label>拍摄结束日期<input type="date" ref={endDate}/></label>
      <label className="cc-span">关联实拍需求（可选）<select value={scriptId} onChange={e=>{setScriptId(e.target.value);const item=scripts.find(s=>s.id===e.target.value);if(item){setSku(item.sku);setEntries(old=>old.map(row=>({...row,sku:''})));}}}><option value="">独立素材</option>{scripts.map(s=><option key={s.id} value={s.id}>{s.sku} · {s.title}</option>)}</select></label>
      <label>共用产品编码 / SKU<input disabled={!!scriptId} maxLength={120} placeholder="例如 H068-3" value={sku} onChange={e=>setSku(e.target.value)}/></label>
      <label>批次备注<input maxLength={1600} value={note} onChange={e=>setNote(e.target.value)} placeholder="剪辑版本或使用说明"/></label>
      <div className="cc-span"><strong>分发到站点</strong><SiteChoices options={sites} value={targets} onChange={setTargets}/></div>
    </fieldset>
    <label className="cc-pick">选择视频<input type="file" multiple accept=".mp4,.mov,.webm" disabled={busy||started} onChange={e=>{choose(Array.from(e.target.files||[]));e.target.value='';}}/><small>每批最多 50 条，单条最大 256 MB。仅上传公司有权向所选站点分发的成片。</small></label>
    {entries.map((entry,i)=><div key={entry.id} className="cc-upload-line"><div><strong>{entry.file.name}</strong><small>{(entry.file.size/1048576).toFixed(1)} MB · {entry.message}</small></div>
      <input aria-label={'第'+(i+1)+'条素材名称'} maxLength={180} value={entry.title} disabled={busy||entry.started} onChange={e=>change(entry.id,{title:e.target.value})}/>
      <input aria-label={'第'+(i+1)+'条产品编码'} maxLength={120} placeholder={sku||'单独填写产品编码'} value={entry.sku} disabled={!!scriptId||busy||entry.started} onChange={e=>change(entry.id,{sku:e.target.value})}/>
      {!entry.done&&<button className="btn" disabled={busy} onClick={()=>{setEntries(old=>old.filter(e=>e.id!==entry.id));if(entries.filter(e=>!e.done).length===1)onDirty(false);}}>移除</button>}</div>)}
    {error&&<p role="alert" className="cc-error">{error}</p>}
    <div className="cc-actions"><button className="btn primary" disabled={busy||!dirty} onClick={()=>void submit()}>{busy?'正在上传…':started&&dirty?'重试未完成的视频':'上传并分发'}</button>
    {entries.length>0&&<small role="status">已分发 {entries.filter(e=>e.done).length} / {entries.length}</small>}</div>
  </section>;
}
