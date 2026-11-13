"use client";
import {useRef,useState} from 'react';
import {parseWorkspaceResponse} from '../lib/workspace-response.mjs';
import {MaterialFields,emptyMetadata,remembered,remember,type MaterialMetadata,type MaterialOptions} from './content-material-fields';
import {useDirtyGuard} from './workspace-hooks';

export const materialApi='/api/content-center/materials';
const partSize=8*1024*1024;
const maxSize=256*1024*1024;
type Entry={id:string;file:File;title:string;sku:string;message:string;started:boolean;done:boolean;metadata?:MaterialMetadata};
export function SiteChoices({options,value,onChange}:{options:string[];value:string[];onChange:(v:string[])=>void}){
  return <div className="cc-site-options">{options.map(site=><label key={site}><input type="checkbox" checked={value.includes(site)} onChange={e=>onChange(e.target.checked?[...value,site]:value.filter(s=>s!==site))}/>{site}</label>)}</div>;
}
export function MaterialUpload({sites,scripts,products,actorId,options,replacement,onDone,onClose,onDirty}:{sites:string[];scripts:{id:string;title:string;sku:string}[];products:{sku:string;name:string}[];actorId:string;options:MaterialOptions;replacement?:any;onDone:()=>void;onClose:()=>void;onDirty:(value:boolean)=>void}){
  const [entries,setEntries]=useState<Entry[]>([]),[batch]=useState(()=>crypto.randomUUID());
  const [last]=useState(()=>remembered(actorId));
  const history=Array.isArray(last.history)?last.history:[];
  const choices=[...products,...history.filter((h:any)=>h.sku&&!products.some(p=>p.sku===h.sku)).map((h:any)=>({sku:h.sku,name:h.metadata?.productName||''}))];
  const quickOptions=Object.fromEntries(Object.entries(options).map(([k,values])=>[k,[...new Set([...values,...history.flatMap((h:any)=>Array.isArray(h.metadata?.[k])?h.metadata[k]:[])])]])) as MaterialOptions;
  const [targets,setTargets]=useState<string[]>(replacement?replacement.sites.map((s:any)=>s.site):(last.sites||[]).filter((s:string)=>sites.includes(s))),[sku,setSku]=useState(replacement?.sku||last.sku||''),[note,setNote]=useState(replacement?.note||'');
  const [metadata,setMetadata]=useState<MaterialMetadata>({...emptyMetadata,...(replacement?.metadata||last.metadata||{})});
  const [scriptId,setScriptId]=useState(replacement?.script_id||'');
  const startDate=useRef<HTMLInputElement>(null),endDate=useRef<HTMLInputElement>(null);
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const dirty=entries.some(e=>!e.done);
  const confirmLeave=useDirtyGuard(dirty);
  const started=entries.some(e=>e.started);
  function change(id:string,patch:Partial<Entry>){setEntries(old=>old.map(e=>e.id===id?{...e,...patch}:e));}
  function choose(files:File[]){
    const invalid=files.find(f=>!f.size||f.size>maxSize||!(/\.(mp4|mov|webm)$/i.test(f.name)));
    if(invalid){setError(invalid.name+' 无法加入，请选择不超过 256 MB 的 MP4、MOV 或 WebM 视频。');return;}
    if(replacement&&entries.length+files.length>1){setError('替换时请选择一个视频');return;}
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
      const file=entry.file,meta={id:entry.id,batch,scriptId,original:file.name,title:entry.title,sku:entry.sku.trim()||sku.trim(),note,from,to,sites:targets,size:file.size,metadata:entry.metadata||metadata,...(replacement?{replacesId:replacement.id,replacesRevision:replacement.revision}:{})};
      try{
        for(let offset=0;offset<file.size;offset+=partSize){
          change(entry.id,{message:'上传中 '+Math.floor(100*offset/file.size)+'%'});
          const form=new FormData();form.set('file',file.slice(offset,offset+partSize),'part');form.set('part',String(offset/partSize));form.set('meta',JSON.stringify(meta));
          await parseWorkspaceResponse(await fetch(materialApi,{method:'POST',body:form}));
        }
        change(entry.id,{done:true,message:'已分发'});remember(actorId,{sku:meta.sku,sites:targets,metadata:meta.metadata});
      }catch(e){failed++;change(entry.id,{message:e instanceof Error?e.message:'上传中断，可重试'});}
    }
    setBusy(false);onDone();
    if(failed)setError('有 '+failed+' 条未完成，重试会跳过已分发视频。');
    else onDirty(false);
  }
  return <section className="cc-upload cc-card"><div className="cc-row"><h3>{replacement?'替换成片':'批量上传成片'}</h3><button className="btn" disabled={busy} onClick={()=>{if(!dirty||confirmLeave()){onDirty(false);onClose();}}}>关闭</button></div>
    <fieldset disabled={busy||started} className="cc-input-grid">
      <label>拍摄开始日期<input type="date" ref={startDate} defaultValue={replacement?.shoot_from||new Date().toLocaleDateString('en-CA')}/></label>
      <label>拍摄结束日期<input type="date" ref={endDate} defaultValue={replacement?.shoot_to||new Date().toLocaleDateString('en-CA')}/></label>
      <label className="cc-span">关联实拍需求（可选）<select value={scriptId} onChange={e=>{setScriptId(e.target.value);const item=scripts.find(s=>s.id===e.target.value);if(item){setSku(item.sku);setMetadata({...metadata,productName:products.find(p=>p.sku===item.sku)?.name||metadata.productName});setEntries(old=>old.map(row=>({...row,sku:''})));}}}><option value="">独立素材</option>{scripts.map(s=><option key={s.id} value={s.id}>{s.sku} · {s.title}</option>)}</select></label>
      <div className="cc-span"><MaterialFields sku={sku} metadata={metadata} products={choices} options={quickOptions} locked={!!scriptId} onSku={setSku} onChange={setMetadata}/></div>
      <label>批次备注<input maxLength={1600} value={note} onChange={e=>setNote(e.target.value)} placeholder="剪辑版本或使用说明"/></label>
      <div className="cc-span"><strong>分发到站点</strong><SiteChoices options={sites} value={targets} onChange={setTargets}/></div>
    </fieldset>
    <label className="cc-pick">选择视频<input type="file" multiple={!replacement} accept=".mp4,.mov,.webm" disabled={busy||started} onChange={e=>{choose(Array.from(e.target.files||[]));e.target.value='';}}/><small>每批最多 50 条，单条最大 256 MB。推荐 MP4（H.264 视频、AAC 音频）以直接预览。共用信息可批量设置，下方可逐条调整。</small></label>
    {entries.map((entry,i)=><div key={entry.id} className="cc-upload-line"><div><strong>{entry.file.name}</strong><small>{(entry.file.size/1048576).toFixed(1)} MB · {entry.message}</small></div>
      <input aria-label={'第'+(i+1)+'条素材名称'} maxLength={180} value={entry.title} disabled={busy||entry.started} onChange={e=>change(entry.id,{title:e.target.value})}/>
      <details><summary>单独修改产品及拍摄信息</summary><fieldset disabled={busy||entry.started}><MaterialFields sku={entry.sku||sku} metadata={entry.metadata||metadata} products={choices} options={quickOptions} locked={!!scriptId} onSku={v=>change(entry.id,{sku:v})} onChange={v=>change(entry.id,{metadata:v})}/></fieldset></details>
      {!entry.done&&<button className="btn" disabled={busy} onClick={()=>{setEntries(old=>old.filter(e=>e.id!==entry.id));if(entries.filter(e=>!e.done).length===1)onDirty(false);}}>移除</button>}</div>)}
    {error&&<p role="alert" className="cc-error">{error}</p>}
    <div className="cc-actions"><button className="btn primary" disabled={busy||!dirty} onClick={()=>void submit()}>{busy?'正在上传…':started&&dirty?'重试未完成的视频':'上传并分发'}</button>
    {entries.length>0&&<small role="status">已分发 {entries.filter(e=>e.done).length} / {entries.length}</small>}</div>
  </section>;
}
