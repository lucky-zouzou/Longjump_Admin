"use client";
import {useRef,useState} from 'react';
import {Tags,defaultOptions} from './content-material-fields';
import {useDirtyGuard} from './workspace-hooks';
export type Row=Record<string,any>;
type Choice=string|[string,string];
export const sourceLabels:Record<string,string>={studio:'公司实拍原创',ai:'运营 AI 创作',creator:'达人视频'};
export const actions:Record<string,string>={create:'新建内容需求',schedule:'安排拍摄',deliver:'交付新版本',accept:'验收通过',return:'退回修改',rights:'设置达人素材授权',claim:'认领发布',publish:'登记已发布视频',observe:'记录观察数据',review:'提交复盘决定'};
const scenes=['公司静拍','外景拍摄','室内＋外景'];
type Field={key:string;label:string;type?:string;options?:Choice[];optional?:boolean;hint?:string};
const f=(key:string,label:string,type='text',optional=false):Field=>({key,label,type,optional});
const select=(key:string,label:string,options:Choice[],optional=false):Field=>({key,label,options,optional});
function SkuSearch({options,value,onChange}:{options:Choice[];value:string;onChange:(v:string)=>void}){
 const [query,setQuery]=useState('');const picker=useRef<HTMLSelectElement>(null);
 const matches=options.map(o=>Array.isArray(o)?o:[o,o]).filter(([sku,label])=>sku===value||label.toLowerCase().includes(query.trim().toLowerCase()));
 function chooseMatch(){
  const found=matches.filter(([,label])=>label.toLowerCase().includes(query.trim().toLowerCase()));
  if(query.trim()&&found.length===1)onChange(found[0][0]);
  picker.current?.focus();
 }
 return <div className="cc-sku-search"><div><label>搜索商品<input type="search" value={query} placeholder="输入 SKU 或商品名称" onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();chooseMatch();}}} onChange={e=>setQuery(e.target.value)}/></label>
  <button type="button" className="btn" onClick={chooseMatch}>搜索 SKU</button></div>
  <label>指定产品 SKU<select ref={picker} name="sku" required value={value} onChange={e=>onChange(e.target.value)}><option value="">请选择商品</option>{matches.map(([k,v])=><option key={k} value={k}>{v}</option>)}</select></label>
  {!matches.length&&<small role="status">没有匹配的商品，请调整关键词。</small>}</div>;
}
function fields(input:Row,d:Row):Field[]{
 const scripts=d.scripts as Row[],versions=d.versions as Row[],posts=d.posts as Row[];
 const post=posts.find(r=>r.id===input.postId),v=versions.find(r=>r.id===(input.versionId||post?.version_id));
 const s=scripts.find(r=>r.id===(input.scriptId||v?.script_id));
 const sites=d.writeSites as string[],manager=['管理员','运营主管'].includes(d.actor.role);
 const claimFields=[f('account','TikTok 账号（例如 loongjump.id）'),f('language','发布语言'),
   select('traffic','流量类型',['自然','投流']),...(s?.source==='creator'&&s.rightsMode==='direct'?[]:[f('changes','本地改动或原版发布','textarea'),f('localUrl','本地成片链接','url',true)])];
 switch(input.action){
  case 'create':return [select('source','内容来源',Object.entries(sourceLabels).filter(([key])=>!input.parentId||key!=='creator')),
    ...(input.source==='creator'?[select('sourceContentId','已验收的达人原视频',d.sources.filter((r:Row)=>!scripts.some(s=>s.source_content_id===r.id)).map((r:Row)=>[r.id,r.site+' · '+r.shop+' · @'+r.platform_id+' · '+r.sku]))]:
     [select('site','需求站点',sites),select('sku','指定产品 SKU',d.skus.map((r:Row)=>[r.sku,r.sku+' · '+r.name]))]),
    f('brief','补充要求','textarea',true),
    ...(input.source==='studio'?[f('originalCount','需要几条原创','number'),f('colors','拍摄颜色','text',true),select('scene','拍摄场景',scenes),f('directions','内容方向','text',true),f('referenceUrl','参考拍摄视频链接','url',true)]:[]),f('due','期望交付日期','date')];
  case 'schedule':return [...(['管理员','运营主管'].includes(d.actor.role)?[select('studioUserId','负责拍摄剪辑',d.people.filter((u:Row)=>u.role==='拍摄剪辑').map((u:Row)=>[u.id,u.name]),true)]:[]),f('shoot','拍摄日期','date'),f('delivery','交付日期','date'),
    select('jointWith','与同款需求合拍',scripts.filter(r=>r.id!==s?.id&&r.sku===s?.sku&&r.source==='studio'&&r.shoot_date&&r.shoot_date===input.shoot&&!r.joint_with).map(r=>[r.id,r.site+' · '+r.title]),true)];
  case 'deliver':return [...(s&&s.original_count>1?[select('originalNo','对应哪条原创',Array.from({length:s.original_count},(_,i)=>[String(i+1),'第 '+(i+1)+' 条原创'] as [string,string]))]:[]),f('label','版本名称'),f('storyboard','本版脚本和镜头顺序','textarea'),f('master','可访问的无字幕母版／成片链接','url'),f('raw','原始素材文件夹链接','url',true),
    ...(s?.source==='ai'?[f('prompt','完整 AI 提示词','textarea'),f('productRef','产品实物参考链接','url'),f('productChecked','已核对实物特征和发布标识要求','checkbox')]:[])];
  case 'accept':case 'return':return [f('feedback',input.action==='return'?'需修改的镜头和原因':'验收意见','textarea',input.action==='accept')];
  case 'rights':return [select('mode','允许的使用方式',[['reference','仅参考创意'],['direct','可直接发布原版'],['edit','可二剪及发布']]),
    ...(input.mode==='reference'?[]:[{key:'sites',label:'允许使用的站点',type:'multi',options:d.sites},f('end','授权截止日（使用站当地日期）','date')]),f('evidence','授权凭据、用途范围或撤销依据','textarea')];
  case 'claim':return [select('site','发布站点',s?.source==='creator'?sites.filter(site=>s.allowedSites.includes(site)):sites),f('planned','计划发布日期','date'),...claimFields];
  case 'publish':return [f('url','TikTok 视频完整链接','url'),f('publishedAt','实际发布时间（本机时区）','datetime-local')];
  case 'observe':return [select('days','累计观察窗口',post?.original?[['1','24 小时']]:[['1','24 小时'],['7','7 天']]),f('observedAt','实际取数时间（本机时区）','datetime-local'),
    f('views','播放量','number',true),f('retention','前 3 秒留存率（%）','percent',true),f('clicks','商品点击数','number',true),f('cartAdds','加购次数','number',true),f('orders','视频归属订单数','number',true),
    f('gmv','视频归属 GMV（未知留空）','number',true),select('currency','GMV 原币种', ['IDR','MYR','THB','VND','PHP','CNY','USD']),
    f('evidence','数据出处或凭据'),f('note','统计口径、修订或缺失原因','textarea')];
  case 'review':return [select('decision','复盘决定',['复拍','跨站测试','暂缓']),f('finding','观察到的实际表现','textarea'),f('hypothesis','可能原因','textarea'),f('change','下一次具体改什么／暂缓原因','textarea'),
    select('site','执行站点',(manager||d.actor.role==='拍摄剪辑'?d.sites:sites).filter((site:string)=>input.decision!=='跨站测试'||site!==post?.site)),
    select('ownerId','负责运营',d.people.filter((u:Row)=>u.sites.includes(input.site)).map((u:Row)=>[u.id,u.name+' · '+u.role])),f('due','验证／跟进日期','date'),
    ...(input.decision==='复拍'?[select('scene','复拍场景',scenes)]:input.decision==='跨站测试'?claimFields:[])];
  default:return [];
 }
}
export function ContentForm({initial,data,onClose,onSave,busy,error}:{initial:Row;data:Row;onClose:()=>void;onSave:(v:Row,reference?:File)=>Promise<void>;busy:boolean;error:string}){
 const [value,set]=useState(initial),[reference,setReference]=useState<File>();const dirty=!!reference||JSON.stringify(value)!==JSON.stringify(initial);const confirm=useDirtyGuard(dirty);
 const update=(key:string,v:any)=>{if(key==='source')setReference(undefined);set(old=>({...old,[key]:v,...(key==='site'?{ownerId:''}:{}),...(key==='shoot'?{jointWith:''}:{}),
   ...(key==='decision'?{site:'',ownerId:''}:{}),...(key==='source'?{sourceContentId:''}:{})}));};
 return <form className="cc-form" aria-label={actions[value.action]} onSubmit={e=>{
   e.preventDefault();const payload={...value};
   const submitted=new FormData(e.currentTarget);
   for(const item of fields(value,data)){
     if(['colors','directions'].includes(item.key))payload[item.key]=(value[item.key]||[]).join('、');
     else if(item.type==='multi')payload[item.key]=submitted.getAll(item.key);
     else if(item.type==='checkbox')payload[item.key]=submitted.has(item.key);
     else payload[item.key]=submitted.get(item.key)??'';
   }
   for(const k of ['observedAt','publishedAt'])if(payload[k])payload[k]=new Date(payload[k]).toISOString();
   void onSave(payload,payload.action==='create'&&payload.source==='studio'?reference:undefined);
 }}>
  <header><h3>{actions[value.action]}</h3><button type="button" className="btn" disabled={busy} onClick={()=>{if(!dirty||confirm())onClose();}}>关闭</button></header>
  {value.context&&<p className="cc-note">{value.context}</p>}
  <div className="cc-fields">{fields(value,data).map(item=>item.key==='colors'||item.key==='directions'?<Tags key={item.key} label={item.label} value={value[item.key]||[]} onChange={v=>update(item.key,v)} options={item.key==='colors'?defaultOptions.colors:['新品种草','多场景展示','产品展示','卖点展示','容量展示','五金和拉链细节','活动大促','口播','暴力测试','开箱展示']}/>:item.key==='sku'?<SkuSearch key={item.key} options={item.options||[]} value={value.sku||''} onChange={v=>update('sku',v)}/>:<label key={item.key} className={item.type==='textarea'||item.type==='multi'?'wide':''}>
    <span>{item.label}{item.optional&&'（选填）'}</span>
    {item.type==='multi'?<span className="cc-checks">{item.options?.map(op=>{const v=String(op);return <span key={v}><input type="checkbox" name={item.key} value={v} checked={(value[item.key]||[]).includes(v)} onChange={e=>update(item.key,e.target.checked?[...(value[item.key]||[]),v]:(value[item.key]||[]).filter((x:string)=>x!==v))}/>{v}</span>;})}</span>:
    item.options?<select name={item.key} aria-label={item.label} required={!item.optional} value={value[item.key]||''} onChange={e=>update(item.key,e.target.value)}><option value="">{item.optional?'不指定':'请选择'}</option>{item.options.map(option=>{const [k,v]=Array.isArray(option)?option:[option,option];return <option key={k} value={k}>{v}</option>;})}</select>:
    item.type==='checkbox'?<input type="checkbox" name={item.key} required checked={value[item.key]===true} onChange={e=>update(item.key,e.target.checked)}/>:
    item.type==='textarea'?<textarea name={item.key} aria-label={item.label} required={!item.optional} value={value[item.key]||''} rows={3} onChange={e=>update(item.key,e.target.value)}/>:
    <input name={item.key} aria-label={item.label} onInput={e=>update(item.key,e.currentTarget.value)} type={item.type==='percent'?'number':item.type} min={item.key==='originalCount'?1:['number','percent'].includes(item.type||'')?0:undefined} max={item.key==='originalCount'||item.type==='percent'?100:undefined} step={item.key==='gmv'?'0.01':item.type==='percent'?'any':undefined}
      required={!item.optional} value={value[item.key]??''} onChange={e=>update(item.key,e.target.value)}/>}
  </label>)}</div>
  {value.action==='create'&&value.source==='studio'&&<label className="cc-reference-upload">上传参考视频（选填，16 MB 以内）
    <input type="file" accept=".mp4,.mov,.webm,video/mp4,video/quicktime,video/webm" onChange={e=>{const file=e.target.files?.[0];e.target.setCustomValidity(file&&file.size>16*1024*1024?'视频超过 16 MB，可改填参考链接':'');setReference(file);}}/></label>}
  {error&&<p className="cc-error" role="alert">{error}</p>}
  <footer><button className="btn primary" disabled={busy}>{busy?'正在提交…':'保存'+(value.action==='return'?'退回意见':'')}</button></footer>
 </form>;
}
