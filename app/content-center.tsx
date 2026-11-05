"use client";
import {useCallback,useEffect,useRef,useState} from 'react';
import {parseWorkspaceResponse} from '../lib/workspace-response.mjs';
import {useVisibleRefresh} from './workspace-hooks';
import {ContentForm,sourceLabels,type Row} from './content-center-forms';
import './content-center.css';

const tabs=['需求与排期','脚本与素材','站点发布','效果复盘','复拍与跨站测试'];
const stamp=(s:string)=>new Date(s).toLocaleString('zh-CN',{hour12:false});
const inputTime=()=>{const n=new Date();return new Date(n.getTime()-n.getTimezoneOffset()*60000).toISOString().slice(0,16);};
function Link({href,children}:{href?:string;children:React.ReactNode}){return href&&/^https:\/\//.test(href)?<a href={href} target="_blank" rel="noreferrer">{children} ↗</a>:null;}
function Empty({children}:{children:React.ReactNode}){return <p className="cc-empty">{children}</p>;}
function number(n:number|null|undefined){return n==null?'待补录':n.toLocaleString('zh-CN');}
function selectedMetric(data:Row,post:Row,script:Row,days:number){
 if(post.original&&days!==1)return data.external.find((m:Row)=>m.content_id===script.source_content_id&&m.days===days);
 return data.metrics.find((m:Row)=>m.post_id===post.id&&m.days===days);
}
function windowStatus(at:string,days:number){
 return Date.now()<Date.parse(at)+days*86400000?'未成熟':'待补录';
}
export default function ContentCenter(){
 const [snapshot,setData]=useState<Row|null>(null),[tab,setTab]=useState(0),[filter,setFilter]=useState(''),[site,setSite]=useState(''),[source,setSource]=useState(''),[week,setWeek]=useState('');
 const [form,setForm]=useState<Row|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const formBox=useRef<HTMLDivElement>(null),counter=useRef(0);
 const refresh=useCallback(async()=>{const generation=++counter.current;
  try{const response=await parseWorkspaceResponse(await fetch('/api/content-center',{cache:'no-store'}));if(generation===counter.current){setData(response);setError('');}}
  catch(e){if(generation===counter.current)setError(e instanceof Error?e.message:'加载失败');}
 },[]);
 useEffect(()=>{void refresh();return()=>{counter.current++;};},[refresh]);
 useVisibleRefresh(refresh,30000,!form&&!busy);
 useEffect(()=>{if(form)formBox.current?.scrollIntoView({block:'start',behavior:'smooth'});},[form]);
 const open=(action:string,initial:Row={})=>{setError('');setNotice('');setForm({action,operationId:crypto.randomUUID(),...initial});};
 async function save(value:Row){
   if(busy)return;setBusy(true);setError('');
   try{await parseWorkspaceResponse(await fetch('/api/content-center',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)}));
     setForm(null);setNotice('已保存');await refresh();
   }catch(e){setError(e instanceof Error?e.message:'保存失败');}finally{setBusy(false);}
 }
 if(!snapshot)return <section className="cc"><h2>TikTok 内容中心</h2><p>{error||'正在读取内容中心…'}</p>{error&&<button className="btn" onClick={()=>void refresh()}>重新加载</button>}</section>;
 const data:Row=snapshot;
 const {actor}=data,manager=['管理员','运营主管'].includes(actor.role),camera=manager||actor.role==='拍摄剪辑',ops=manager||actor.role==='运营';
 const scripts:Row[]=data.scripts,versions:Row[]=data.versions,posts:Row[]=data.posts,reviews:Row[]=data.reviews;
 const byScript=new Map(scripts.map(s=>[s.id,s])),byVersion=new Map(versions.map(v=>[v.id,v]));
 const sFor=(post:Row)=>byScript.get(byVersion.get(post.version_id)!.script_id)!;
 const ownsSite=(s:string)=>data.writeSites.includes(s);
 const name=(id:string)=>data.people.find((u:Row)=>u.id===id)?.name||id;
 const find=(s:Row,extra='')=>(!source||s.source===source)&&(!filter||[s.sku,s.title,s.audience,s.selling_point,s.scene,s.brief,extra].join(' ').toLowerCase().includes(filter.trim().toLowerCase()));
 const visibleScripts=scripts.filter(s=>(!site||s.site===site)&&find(s,versions.filter(v=>v.script_id===s.id).map(v=>v.label+' '+v.storyboard).join(' ')));
 const visiblePosts=posts.filter(p=>(!site||site===p.site)&&find(sFor(p),p.account+' '+byVersion.get(p.version_id)?.label));
 const inWeek=(value:string)=>!week||value>=week&&Date.parse(value)<Date.parse(week)+7*86400000;
 const queue=visibleScripts.filter(s=>inWeek(s.shoot_date||s.due));
 const newValues={source:'studio',site:data.writeSites[0]||'',scene:'公司静拍'};
 const canClaim=(s:Row)=>ops&&data.writeSites.some((site:string)=>s.source!=='creator'||s.allowedSites.includes(site));
 const go=(i:number)=>{if(form)return;setTab(i);setNotice('');};
 function cardTitle(s:Row){return <><div className="cc-tagline"><span>{sourceLabels[s.source]}</span><span>{s.site} · {s.sku}</span></div><h4>{s.title}</h4><p>{s.selling_point} · {s.scene}</p></>;}
 function actionsFor(s:Row){
  return <div className="cc-actions">{s.source==='studio'&&camera&&['待排期','已排期'].includes(s.status)&&<button className="btn" onClick={()=>open('schedule',{scriptId:s.id,version:s.version,shoot:s.shoot_date||'',delivery:s.delivery_date||'',jointWith:s.joint_with||'',context:s.title})}>安排拍摄</button>}
    {(s.source==='studio'&&camera&&s.shoot_date||s.source==='ai'&&ops&&ownsSite(s.site))&&<button className="btn" onClick={()=>open('deliver',{scriptId:s.id,version:s.version,context:s.title,storyboard:s.brief})}>交付新版本</button>}
    {s.source==='creator'&&manager&&<button className="btn" onClick={()=>open('rights',{scriptId:s.id,version:s.version,context:s.title,mode:s.rightsMode,sites:s.allowedSites,end:s.expires,evidence:s.rightsEvidence})}>素材授权</button>}</div>;
 }
 function asset(v:Row,s:Row){
  return <div key={v.id} className="cc-version"><div className="cc-row"><strong>{v.label}</strong><span>{v.status}</span></div><p>{v.storyboard}</p>
   <div className="cc-actions"><Link href={v.master_url}>打开母版／原片</Link><Link href={v.raw_url}>原始镜头</Link><Link href={v.product_ref}>实物参考</Link></div>
   {v.prompt&&<details><summary>AI 提示词</summary><p>{v.prompt}</p></details>}{v.feedback&&<p>验收意见 · {v.feedback}</p>}
   <div className="cc-actions">{v.status==='待验收'&&ops&&ownsSite(s.site)&&['accept','return'].map(action=><button className="btn" key={action} onClick={()=>open(action,{versionId:v.id,version:v.version,context:s.title+' · '+v.label})}>{action==='accept'?'验收通过':'退回修改'}</button>)}
   {v.status==='已验收'&&canClaim(s)&&<button className="btn" onClick={()=>open('claim',{versionId:v.id,site:s.source==='creator'?data.writeSites.find((t:string)=>s.allowedSites.includes(t)):data.writeSites[0],context:s.title+' · '+v.label,traffic:'自然'})}>认领发布</button>}
   {v.status==='已验收'&&ops&&data.writeSites.length>0&&<button className="btn" onClick={()=>open('create',{...newValues,parentId:v.id,sku:s.sku,title:s.title,audience:s.audience,sellingPoint:s.selling_point,brief:v.storyboard,context:'沿用脚本 · '+s.title+' / '+v.label})}>用此脚本创作</button>}</div>
  </div>;
 }
 function metricsFor(p:Row,s:Row){
   const days=p.original?[1,7,30]:[1,7];
   return <div className="cc-windows">{days.map(days=>{
     const m=selectedMetric(data,p,s,days);
     return <div key={days}><strong>{days===1?'24 小时':days+' 天'}{p.original&&days>1?' · 达人模块':''}</strong>
     {m?<><span>播放 {number(m.views)} · 点击 {number(m.clicks)} · 订单 {number(m.orders)}</span><small>前 3 秒留存 {m.retention==null?'待补录':m.retention+'%'} · 取数 {stamp(m.observed_at)}</small>
      {m.note&&<small>{m.note}{m.evidence?' · '+m.evidence:''}</small>}</>:<span>{windowStatus(p.published_at,days)}</span>}</div>;
   })}</div>;
 }
 function postCard(p:Row,analysis=false){
   const s=sFor(p),v=byVersion.get(p.version_id)!,own=ownsSite(p.site),reviewable=camera||own;
   let typical='';
   if(analysis&&p.traffic!=='待核实'){const cohort=posts.filter(other=>other.id!==p.id&&other.published_at&&other.site===p.site&&other.account===p.account&&other.traffic===p.traffic)
    .map(other=>selectedMetric(data,other,sFor(other),7)?.views).filter((n):n is number=>typeof n==='number').sort((a,b)=>a-b);
    if(cohort.length){const mid=Math.floor(cohort.length/2);typical='同站同账号同流量类型 · 其他 '+cohort.length+' 条的 7 天播放中位数 '+number(cohort.length%2?cohort[mid]:(cohort[mid-1]+cohort[mid])/2);}}
   return <article className="cc-card" key={p.id}><div className="cc-tagline"><span>{p.site} · @{p.account}</span><span>{p.traffic} · {p.language}</span></div><h4>{s.title} / {v.label}</h4>
    <p>{s.sku} · {p.changes}</p><p>{name(p.owner_id)} · {p.published_at?'已发布 '+stamp(p.published_at):'计划 '+p.planned}</p>
    <div className="cc-actions"><Link href={p.url}>发布链接</Link><Link href={p.local_url}>本地成片</Link></div>
    {analysis&&<>{metricsFor(p,s)}{typical&&<small>{typical}</small>}</>}
    <div className="cc-actions">{!p.published_at&&own&&(manager||actor.id===p.owner_id)&&<button className="btn" onClick={()=>open('publish',{postId:p.id,version:p.version,publishedAt:inputTime(),context:s.title+' · @'+p.account})}>登记已发布视频</button>}
     {p.published_at&&own&&<button className="btn" onClick={()=>open('observe',{postId:p.id,version:p.version,days:'1',observedAt:inputTime(),context:s.title+' · @'+p.account})}>记录数据</button>}
     {p.published_at&&reviewable&&<button className="btn" onClick={()=>open('review',{postId:p.id,decision:'复拍',site:p.site,ownerId:p.owner_id,scene:'公司静拍',traffic:'自然',context:s.title+' · @'+p.account})}>复盘决定</button>}</div>
   </article>;
 }
 return <section className="cc"><header className="cc-heading"><div><h2>内容协作工作台</h2></div>
  <div className="cc-actions"><button className="btn" disabled={busy||!!form} onClick={()=>void refresh()}>刷新</button>{ops&&data.writeSites.length>0&&<button className="btn primary" disabled={!!form} onClick={()=>open('create',newValues)}>＋ 新建需求</button>}</div></header>
  <div className="cc-summary">{[['待排期',scripts.filter(s=>s.status==='待排期').length,0],['待验收版本',versions.filter(v=>v.status==='待验收').length,1],['待发布',posts.filter(p=>!p.published_at).length,2],['已发布',posts.filter(p=>p.published_at).length,3]].map(([l,n,i])=><button key={l} disabled={!!form} onClick={()=>go(Number(i))}><span>{l}</span><b>{n}</b></button>)}</div>
  <nav aria-label="内容工作区">{tabs.map((label,i)=><button key={label} aria-current={i===tab?'page':undefined} disabled={!!form} onClick={()=>go(i)}>{label}</button>)}</nav>
  {notice&&<p role="status">{notice}</p>}{error&&!form&&<p className="cc-error" role="alert">{error}</p>}
  {form&&<div ref={formBox}><ContentForm key={form.operationId} initial={form} data={data} error={error} busy={busy} onClose={()=>{setForm(null);setError('');}} onSave={save}/></div>}
  <fieldset disabled={!!form} className="cc-body"><div className="cc-filters">
    <input aria-label="搜索内容" placeholder="搜索 SKU、卖点、脚本或账号" value={filter} onChange={e=>setFilter(e.target.value)}/>
    <select aria-label="筛选站点" value={site} onChange={e=>setSite(e.target.value)}><option value="">全部站点</option>{data.sites.map((s:string)=><option key={s}>{s}</option>)}</select>
    <select aria-label="筛选来源" value={source} onChange={e=>setSource(e.target.value)}><option value="">全部来源</option>{Object.entries(sourceLabels).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select>
    {tab===0&&<label>排期起始日 <input type="date" aria-label="从此日起七天" value={week} onChange={e=>setWeek(e.target.value)}/></label>}</div>
  {tab===0&&<><h3>需求与拍摄排期</h3>{!queue.length&&<Empty>当前没有符合条件的需求。运营可从「新建需求」指定包款和必拍镜头。</Empty>}
    <div className="cc-grid">{queue.map(s=><article className="cc-card" key={s.id}>{cardTitle(s)}<div className="cc-meta"><b>{s.status}</b><span>{name(s.owner_id)} · 期望 {s.due}</span></div><p>{s.brief}</p>
    {s.shoot_date&&<small>拍摄 {s.shoot_date} · 交付 {s.delivery_date}{s.joint_with?' · 合拍 '+byScript.get(s.joint_with)?.title:''}</small>}{actionsFor(s)}</article>)}</div></>}
  {tab===1&&<><h3>脚本与素材库</h3>{!visibleScripts.length&&<Empty>没有匹配的脚本。可按包款、容量、材质或穿搭搜索。</Empty>}
    {visibleScripts.map(s=><article className="cc-card cc-library" key={s.id}>{cardTitle(s)}<p>{s.audience} · 原作者 {name(s.created_by)}</p><p>{s.brief}</p>
     {s.parent_version_id&&<small>源自 {byScript.get(byVersion.get(s.parent_version_id)?.script_id)?.title} / {byVersion.get(s.parent_version_id)?.label}</small>}
     {s.source==='creator'&&<small>素材使用 · {s.allowedSites.length?(s.rightsMode==='direct'?'原版发布':'可二剪发布')+' · '+s.allowedSites.join('、')+' · 截止 '+s.expires:'仅参考创意'}</small>}
     {actionsFor(s)}{versions.filter(v=>v.script_id===s.id).map(v=>asset(v,s))}</article>)}</>}
  {tab===2&&<><h3>站点发布记录</h3>{!visiblePosts.length&&<Empty>暂无发布任务。在素材库中认领一个已验收版本即可排入本站计划。</Empty>}<div className="cc-grid">{visiblePosts.map(p=>postCard(p))}</div></>}
  {tab===3&&<><h3>按脚本对照发布效果</h3>{!visiblePosts.some(p=>p.published_at)&&<Empty>发布后可按脚本对照各站版本，并记录 24 小时和 7 天表现。</Empty>}
    {scripts.map(s=>{const group=visiblePosts.filter(p=>p.published_at&&sFor(p).id===s.id);return group.length?<section key={s.id} className="cc-group"><h4>{s.title} <small>{s.sku} · {group.length} 条发布</small></h4><div className="cc-grid">{group.map(p=>postCard(p,true))}</div></section>:null;})}</>}
  {tab===4&&<><h3>复盘决定与验证任务</h3>{!reviews.filter(r=>(!site||r.site===site)&&find(sFor(posts.find(p=>p.id===r.post_id)!))).length&&<Empty>暂无复盘决定。可在已发布视频下记录复拍、跨站测试或暂缓的原因。</Empty>}
   {reviews.filter(r=>(!site||r.site===site)&&find(sFor(posts.find(p=>p.id===r.post_id)!))).map(r=>{const original=posts.find(p=>p.id===r.post_id)!,next=posts.filter(p=>p.id===r.next_post_id||sFor(p).id===r.next_script_id),shot=byScript.get(r.next_script_id);
    return <article className="cc-card" key={r.id}><div className="cc-tagline"><span>{r.decision}</span><span>{r.site} · {name(r.owner_id)} · {r.due}</span></div><h4>{sFor(original).title}</h4>
     <p>观察 · {r.finding}</p><p>假设 · {r.hypothesis}</p><p>下一步 · {r.change_note}</p><Link href={original.url}>来源视频</Link>
     {shot&&<small>复拍需求 · {shot.title} · {shot.status}</small>}{next.map(p=><div className="cc-version" key={p.id}><strong>验证进度 · {p.published_at?'已发布':'待发布'}</strong> <Link href={p.url}>验证视频</Link>{p.published_at&&metricsFor(p,sFor(p))}</div>)}</article>;})}</>}
  </fieldset></section>;
}
