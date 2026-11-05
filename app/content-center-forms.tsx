"use client";
import {useState} from 'react';
import {useDirtyGuard} from './workspace-hooks';
export type Row=Record<string,any>;
type Choice=string|[string,string];
export const sourceLabels:Record<string,string>={studio:'公司实拍原创',ai:'运营 AI 创作',creator:'达人视频'};
export const actions:Record<string,string>={create:'新建内容需求',schedule:'安排拍摄',deliver:'交付新版本',accept:'验收通过',return:'退回修改',rights:'设置达人素材授权',claim:'认领发布',publish:'登记已发布视频',observe:'记录观察数据',review:'提交复盘决定'};
const scenes=['公司静拍','外景拍摄','室内＋外景'];
type Field={key:string;label:string;type?:string;options?:Choice[];optional?:boolean;hint?:string};
const f=(key:string,label:string,type='text',optional=false):Field=>({key,label,type,optional});
const select=(key:string,label:string,options:Choice[],optional=false):Field=>({key,label,options,optional});
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
    f('title','脚本标题'),f('audience','目标顾客'),f('sellingPoint','本条要证明的卖点'),f('brief','脚本、开头和必拍镜头','textarea'),
    ...(input.source==='studio'?[select('scene','拍摄场景',scenes)]:[]),f('due','期望交付日期','date')];
  case 'schedule':return [f('shoot','拍摄日期','date'),f('delivery','交付日期','date'),
    select('jointWith','与同款需求合拍',scripts.filter(r=>r.id!==s?.id&&r.sku===s?.sku&&r.source==='studio'&&r.shoot_date&&r.shoot_date===input.shoot&&!r.joint_with).map(r=>[r.id,r.site+' · '+r.title]),true)];
  case 'deliver':return [f('label','版本名称'),f('storyboard','本版脚本和镜头顺序','textarea'),f('master','可访问的无字幕母版／成片链接','url'),f('raw','原始素材文件夹链接','url',true),
    ...(s?.source==='ai'?[f('prompt','完整 AI 提示词','textarea'),f('productRef','产品实物参考链接','url'),f('productChecked','已核对实物特征和发布标识要求','checkbox')]:[])];
  case 'accept':case 'return':return [f('feedback',input.action==='return'?'需修改的镜头和原因':'验收意见','textarea',input.action==='accept')];
  case 'rights':return [select('mode','允许的使用方式',[['reference','仅参考创意'],['direct','可直接发布原版'],['edit','可二剪及发布']]),
    ...(input.mode==='reference'?[]:[{key:'sites',label:'允许使用的站点',type:'multi',options:d.sites},f('end','授权截止日（使用站当地日期）','date')]),f('evidence','授权凭据、用途范围或撤销依据','textarea')];
  case 'claim':return [select('site','发布站点',s?.source==='creator'?sites.filter(site=>s.allowedSites.includes(site)):sites),f('planned','计划发布日期','date'),...claimFields];
  case 'publish':return [f('url','TikTok 视频完整链接','url'),f('publishedAt','实际发布时间（本机时区）','datetime-local')];
  case 'observe':return [select('days','累计观察窗口',post?.original?[['1','24 小时']]:[['1','24 小时'],['7','7 天']]),f('observedAt','实际取数时间（本机时区）','datetime-local'),
    f('views','播放量','number',true),f('retention','前 3 秒留存率（%）','percent',true),f('clicks','商品点击数','number',true),f('orders','视频归属订单数','number',true),
    f('evidence','数据出处或凭据'),f('note','统计口径、修订或缺失原因','textarea')];
  case 'review':return [select('decision','复盘决定',['复拍','跨站测试','暂缓']),f('finding','观察到的实际表现','textarea'),f('hypothesis','可能原因','textarea'),f('change','下一次具体改什么／暂缓原因','textarea'),
    select('site','执行站点',(manager||d.actor.role==='拍摄剪辑'?d.sites:sites).filter((site:string)=>input.decision!=='跨站测试'||site!==post?.site)),
    select('ownerId','负责运营',d.people.filter((u:Row)=>u.sites.includes(input.site)).map((u:Row)=>[u.id,u.name+' · '+u.role])),f('due','验证／跟进日期','date'),
    ...(input.decision==='复拍'?[select('scene','复拍场景',scenes)]:input.decision==='跨站测试'?claimFields:[])];
  default:return [];
 }
}
export function ContentForm({initial,data,onClose,onSave,busy,error}:{initial:Row;data:Row;onClose:()=>void;onSave:(v:Row)=>Promise<void>;busy:boolean;error:string}){
 const [value,set]=useState(initial);const dirty=JSON.stringify(value)!==JSON.stringify(initial);const confirm=useDirtyGuard(dirty);
 const update=(key:string,v:any)=>set(old=>({...old,[key]:v,...(key==='site'?{ownerId:''}:{}),...(key==='shoot'?{jointWith:''}:{}),
   ...(key==='decision'?{site:'',ownerId:''}:{}),...(key==='source'?{sourceContentId:''}:{})}));
 return <form className="cc-form" aria-label={actions[value.action]} onSubmit={e=>{
   e.preventDefault();const payload={...value};
   const submitted=new FormData(e.currentTarget);
   for(const item of fields(value,data)){
     if(item.type==='multi')payload[item.key]=submitted.getAll(item.key);
     else if(item.type==='checkbox')payload[item.key]=submitted.has(item.key);
     else payload[item.key]=submitted.get(item.key)??'';
   }
   for(const k of ['observedAt','publishedAt'])if(payload[k])payload[k]=new Date(payload[k]).toISOString();
   void onSave(payload);
 }}>
  <header><h3>{actions[value.action]}</h3><button type="button" className="btn" disabled={busy} onClick={()=>{if(!dirty||confirm())onClose();}}>关闭</button></header>
  {value.context&&<p className="cc-note">{value.context}</p>}
  <div className="cc-fields">{fields(value,data).map(item=><label key={item.key} className={item.type==='textarea'||item.type==='multi'?'wide':''}>
    <span>{item.label}{item.optional&&'（选填）'}</span>
    {item.type==='multi'?<span className="cc-checks">{item.options?.map(op=>{const v=String(op);return <span key={v}><input type="checkbox" name={item.key} value={v} checked={(value[item.key]||[]).includes(v)} onChange={e=>update(item.key,e.target.checked?[...(value[item.key]||[]),v]:(value[item.key]||[]).filter((x:string)=>x!==v))}/>{v}</span>;})}</span>:
    item.options?<select name={item.key} aria-label={item.label} required={!item.optional} value={value[item.key]||''} onChange={e=>update(item.key,e.target.value)}><option value="">{item.optional?'不指定':'请选择'}</option>{item.options.map(option=>{const [k,v]=Array.isArray(option)?option:[option,option];return <option key={k} value={k}>{v}</option>;})}</select>:
    item.type==='checkbox'?<input type="checkbox" name={item.key} required checked={value[item.key]===true} onChange={e=>update(item.key,e.target.checked)}/>:
    item.type==='textarea'?<textarea name={item.key} aria-label={item.label} required={!item.optional} value={value[item.key]||''} rows={3} onChange={e=>update(item.key,e.target.value)}/>:
    <input name={item.key} aria-label={item.label} onInput={e=>update(item.key,e.currentTarget.value)} type={item.type==='percent'?'number':item.type} min={['number','percent'].includes(item.type||'')?0:undefined} max={item.type==='percent'?100:undefined} step={item.type==='percent'?'any':undefined}
      required={!item.optional} value={value[item.key]??''} onChange={e=>update(item.key,e.target.value)}/>}
  </label>)}</div>
  {error&&<p className="cc-error" role="alert">{error}</p>}
  <footer><button className="btn primary" disabled={busy}>{busy?'正在提交…':'保存'+(value.action==='return'?'退回意见':'')}</button></footer>
 </form>;
}
