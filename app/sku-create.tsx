"use client";
import {useId,useRef,useState} from 'react';
import {catalogSku,skuRegistration} from '../lib/sku-catalog-model.mjs';
// Catalog responses share the system API's row representation.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row=Record<string,any>;
type Act=(action:string,payload:Row,success:string,onError?:(message:string)=>void)=>Promise<Row|null>;

export default function SkuCreate({catalog,act,busy,initial={},source,onCreated,onCancel}:{catalog:Row[];act:Act;busy:boolean;initial?:Row;source:'inbound'|'settings';onCreated:(row:Row)=>void;onCancel:()=>void}){
  const [form,setForm]=useState({sku:initial.sku||'',name:initial.name||'',productSeries:'',productType:''});
  const [error,setError]=useState(''),[saving,setSaving]=useState(false);
  const lock=useRef(false),seriesId=useId();
  const duplicate=catalog.some(r=>catalogSku(r.sku)===catalogSku(form.sku));
  const change=(key:string,value:string)=>{setError('');setForm(f=>({...f,[key]:value}));};
  const save=async()=>{
    if(lock.current)return;
    setError('');let item;
    try{item=skuRegistration(form);if(duplicate)throw Error('该SKU已存在，请选择已有SKU维护');}catch(e){setError(e instanceof Error?e.message:'请核对商品资料');return;}
    lock.current=true;setSaving(true);
    try{const result=await act('createSku',{...item,source},`SKU ${item.sku} 已建档，尚未增加库存`,setError);if(result?.sku)onCreated(result.sku);}
    finally{lock.current=false;setSaving(false);}
  };
  return <section className="sku-create" aria-label="新增SKU档案">
    <div className="sku-create-heading"><div><h4>新增 SKU 档案</h4><p>先建立商品资料，再办理到仓入库或维护供应参数。</p></div><span className="pill blue">库存由入库单登记</span></div>
    <fieldset disabled={busy||saving}>
      <div className="sku-create-grid">
        <label>SKU 编码（必填）<input value={form.sku} maxLength={120} onChange={e=>change('sku',e.target.value)} placeholder="与仓库商品编码一致" autoComplete="off" autoCapitalize="characters"/></label>
        <label>商品名称（必填）<input value={form.name} maxLength={120} onChange={e=>change('name',e.target.value)} placeholder="例如：龙耀系列布包 · 棕色 · 大号"/></label>
        <label>商品类型（必选）<select value={form.productType} onChange={e=>change('productType',e.target.value)}><option value="">请选择</option><option>新品</option><option>老款</option></select></label>
        <label>产品系列（可稍后补充）<input value={form.productSeries} maxLength={120} list={seriesId} onChange={e=>change('productSeries',e.target.value)} placeholder="选择已有系列或填写新系列"/><datalist id={seriesId}>{Array.from(new Set(catalog.map(r=>r.product_series).filter(v=>v&&v!=='待归类'))).map(v=><option key={v} value={v}/>)}</datalist></label>
      </div>
      <p className="sku-create-help">首次入系统的历史商品也可在此建档。供应商、工厂及交期可随后维护，资料完整后才能进入采购生产流程；这里不会发起新品孵化项目。</p>
      {duplicate&&<p className="notice warn" role="alert">该 SKU 已存在，请选择已有 SKU；新增操作不会覆盖原资料。</p>}
      {error&&<p className="notice warn" role="alert">{error}</p>}
      <div className="form-actions"><button type="button" className="btn primary" disabled={duplicate||!form.sku.trim()||!form.name.trim()||!form.productType} onClick={save}>{saving?'正在建档…':'确认新增 SKU'}</button><button type="button" className="btn" onClick={onCancel}>取消建档</button></div>
    </fieldset>
  </section>;
}
