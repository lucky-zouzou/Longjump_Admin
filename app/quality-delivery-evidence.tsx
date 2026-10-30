"use client";
import {useState} from 'react';
type R=Record<string,any>;
export default function QualityDeliveryEvidence({data,act,busy}:{data:R;act:(p:R)=>Promise<boolean>;busy:boolean}){
 const [v,setV]=useState<R>({factoryId:'',reference:'',qty:'',note:''});
 const prior=data.denominators?.find((d:R)=>d.factory_id===v.factoryId&&d.month===data.month&&d.reference===v.reference);
 return <details><summary>核实交付分母 · 按采购批次与实际到仓月</summary>
  <p>先在问题记录关联采购单；只有同采购来源且月份一致、分母已核实，才展示该批次反馈件数占交付量。跨批次或分母不足保持未知，不把件数排名当作质量率。</p>
  <div className="as-fields">
   <label>工厂<select value={v.factoryId} onChange={e=>setV({...v,factoryId:e.target.value,reference:'',qty:''})}><option value="">请选择</option>{data.factories.map((f:R)=><option key={f.id} value={f.id}>{f.name}</option>)}</select></label>
   <label>本月实际到仓的采购单<select value={v.reference} onChange={e=>{const c=data.deliveryChoices.find((c:R)=>c.id===e.target.value);setV({...v,reference:e.target.value,qty:c?String(c.qty):''});}}><option value="">选择原采购单</option>{(data.deliveryChoices||[]).filter((c:R)=>c.factoryId===v.factoryId).map((c:R)=><option key={c.id} value={c.id}>{c.reference} · 实收到仓 {c.qty} 件</option>)}</select></label>
   {[['qty','本月已登记到仓件数'],['note','交付凭据及核对说明']].map(([k,l])=><label key={k}>{l}<input value={v[k]} onChange={e=>setV({...v,[k]:e.target.value})}/></label>)}
  </div>
  <button className="btn" disabled={busy||!v.reference} onClick={()=>void act({...v,action:'deliveryEvidence',month:data.month,qty:Number(v.qty),revision:prior?.revision||0})}>核验数量并保存分母新版本</button>
 </details>;
}
