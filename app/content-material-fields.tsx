"use client";
import {useId,useState} from 'react';
export type MaterialMetadata={productName:string;colors:string[];directions:string[];sellingPoints:string[]};
export const emptyMetadata:MaterialMetadata={productName:'',colors:[],directions:[],sellingPoints:[]};
export type MaterialOptions={colors:string[];directions:string[];sellingPoints:string[]};
export const defaultOptions:MaterialOptions={colors:['黑色','白色','棕色','米色','蓝色','卡其色','军绿','粉色','灰色'],directions:['新品种草','产品展示','开箱测评','容量展示','细节展示','场景搭配'],sellingPoints:['大容量','可折叠','防水','多颜色','材质质感','轻便']};
export function remembered(actor:string){try{return JSON.parse(localStorage.getItem('lj.material-recent.'+actor)||'{}');}catch{return {};}}
export function remember(actor:string,data:Record<string,unknown>){try{const previous=remembered(actor),history=[data,...(Array.isArray(previous.history)?previous.history:[])].filter((v,i,all)=>v?.sku&&all.findIndex(other=>other.sku===v.sku)===i).slice(0,20);localStorage.setItem('lj.material-recent.'+actor,JSON.stringify({...data,history}));}catch{/* Browser storage is optional. */}}
function Tags({label,options,value,onChange}:{label:string;options:string[];value:string[];onChange:(value:string[])=>void}){
 const id=useId(),[custom,setCustom]=useState(''),[customMode,setCustomMode]=useState(false);
 function add(v:string){v=v.trim();if(v&&!value.includes(v)&&value.length<20)onChange([...value,v]);setCustom('');setCustomMode(false);}
 return <div className="cc-quick-tags"><span>{label}</span><div className="cc-tag-values">{value.map(v=><button type="button" key={v} onClick={()=>onChange(value.filter(x=>x!==v))}>{v} ×</button>)}</div>
  <select aria-label={label+'快捷选择'} value="" onChange={e=>e.target.value==='__custom'?setCustomMode(true):add(e.target.value)}><option value="">请选择，可多选</option>{options.filter(v=>!value.includes(v)).map(v=><option key={v}>{v}</option>)}<option value="__custom">其他 / 自定义…</option></select>
  {customMode&&<div className="cc-inline"><input autoFocus aria-label={'自定义'+label} list={id} maxLength={80} value={custom} placeholder="自定义内容后添加" onChange={e=>setCustom(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();add(custom);}}}/><button type="button" className="btn" disabled={!custom.trim()} onClick={()=>add(custom)}>添加</button></div>}<datalist id={id}>{options.map(v=><option key={v} value={v}/>)}</datalist>
 </div>;
}
export function MaterialFields({sku,metadata,products,options=defaultOptions,onSku,onChange,locked=false}:{sku:string;metadata:MaterialMetadata;products:{sku:string;name:string}[];options?:MaterialOptions;onSku:(v:string)=>void;onChange:(v:MaterialMetadata)=>void;locked?:boolean}){
 const id=useId();
 return <div className="cc-input-grid"><label>产品编码 / SKU<input aria-label="产品编码 / SKU" list={id} maxLength={120} value={sku} disabled={locked} placeholder="选择产品或手动输入编码" onChange={e=>{onSku(e.target.value);const item=products.find(p=>p.sku===e.target.value);onChange({...metadata,productName:item?.name||''});}}/><datalist id={id}>{products.map(p=><option key={p.sku} value={p.sku}>{p.name}</option>)}</datalist></label>
  <label>产品名称<input aria-label="产品名称" maxLength={180} list={id+'-names'} value={metadata.productName} placeholder="按编码自动带出，也可手动补充" onChange={e=>{const name=e.target.value;onChange({...metadata,productName:name});const matches=products.filter(p=>p.name===name);if(!locked&&matches.length===1)onSku(matches[0].sku);}}/><datalist id={id+'-names'}>{[...new Set(products.map(p=>p.name).filter(Boolean))].map(n=><option key={n}>{n}</option>)}</datalist></label>
  {(['colors','directions','sellingPoints'] as const).map((key,i)=><Tags key={key} label={['拍摄颜色','内容方向','视频卖点'][i]} options={options[key]||[]} value={metadata[key]||[]} onChange={v=>onChange({...metadata,[key]:v})}/>)}
 </div>;
}
