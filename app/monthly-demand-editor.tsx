"use client";

import {useRef,useState} from 'react';
import TableImport,{type ImportRow} from './table-import';
import {applyMonthlyImport,initialMonthlyDemand,monthlyDemandItems} from '../lib/monthly-demand.mjs';

type Draft={sku:string;name:string;qty:string;reason:string};
type DraftState={drafts:Draft[];zeroDemand:boolean;zeroReason:string};
type Props={actor:ImportRow;month:string;submissions:ImportRow[];suggestions:ImportRow[];skuSettings:ImportRow[];busy:boolean;act:(action:string,payload:ImportRow,success:string)=>Promise<ImportRow|null>};

export default function MonthlyDemandEditor({actor,month,submissions,suggestions,skuSettings,busy,act}:Props) {
  const [initial]=useState(()=>initialMonthlyDemand({actor,month,submissions,suggestions}));
  const [state,setState]=useState<DraftState>(initial);
  const [newSku,setNewSku]=useState('');
  const [mode,setMode]=useState<'replace'|'merge'>('replace');
  const [notice,setNotice]=useState(initial.saved?'已载入本月已提交的备货计划，可调整后重新提交。':'已按系统建议生成备货清单，可导入文件或手动调整。');
  const [error,setError]=useState('');
  const [undo,setUndo]=useState<DraftState|null>(null);
  const submitting=useRef(false);
  const {drafts,zeroDemand,zeroReason}=state;
  const knownSkus=[...suggestions.filter(row=>row.site===actor.site&&row.channel===actor.channel),...skuSettings];
  const scopeReady=Boolean(actor.site&&['TikTok','Shopee'].includes(actor.channel));
  let validation='';
  try { if(!zeroDemand)monthlyDemandItems(drafts); }
  catch(err) { validation=err instanceof Error?err.message:'请检查备货明细'; }
  const change=(next:DraftState)=>{setState(next);setUndo(null);setNotice('清单已调整，提交后保存。');setError('');};
  const remove=(sku:string)=>{setUndo(state);setState({...state,drafts:drafts.filter(row=>row.sku!==sku)});setError('');setNotice(`已从本次备货清单删除 ${sku}，提交后生效。`);};
  const submit=async()=>{
    if(submitting.current||busy||!scopeReady)return;
    setError('');
    try {
      if(zeroDemand&&zeroReason.trim().length<4)throw Error('无需备货也需填写至少4个字的确认说明');
      const items=zeroDemand?[]:monthlyDemandItems(drafts);
      submitting.current=true;
      const result=await act('monthlySubmit',{month,site:actor.site,channel:actor.channel,zeroDemand,zeroReason,items},'本月备货需求已保存并进入完整度检查');
      if(result){setUndo(null);setNotice(`已保存 ${month} 备货需求，${items.length} 个SKU。`);}
    }catch(err){setError(err instanceof Error?err.message:'提交失败，请检查备货清单');}
    finally{submitting.current=false;}
  };

  return <div className="monthly-demand-editor">
    <div className="monthly-demand-context"><strong>{month} · {actor.site||'未绑定站点'} / {actor.channel||'未绑定渠道'}</strong><span>导入和删除先更新当前清单，点击下方提交后保存。</span></div>
    {!scopeReady&&<p className="notice warn">账号需绑定站点和 TikTok / Shopee 渠道后，才能提交月度备货计划。</p>}
    <label className="monthly-import-mode">导入方式<select value={mode} disabled={busy} onChange={event=>setMode(event.target.value as 'replace'|'merge')}><option value="replace">替换当前清单：以文件内容为准</option><option value="merge">合并到当前清单：同SKU覆盖数量</option></select></label>
    <TableImport kind="monthlyPlan" busy={busy||!scopeReady} contextKey={`${actor.id}|${month}|${mode}`} templateRows={drafts.length?drafts:skuSettings.map(row=>({sku:row.sku,name:row.name,qty:'',reason:''}))} description={`每行填写SKU、备货数量，可选商品名称和调整原因；每次最多1000行。${mode==='replace'?'确认后用文件替换当前备货清单':'确认后保留其他SKU，同SKU覆盖数量，不累加'}。导入后可修改或删除，再提交保存。`} confirmLabel={mode==='replace'?'确认替换备货清单':'确认合并备货清单'} onApply={rows=>{
      const next=applyMonthlyImport(rows,drafts,knownSkus,mode);
      setUndo(state);setState({drafts:next,zeroDemand:false,zeroReason:''});setNewSku('');setError('');setNotice(`已导入 ${rows.length} 行，当前共 ${next.length} 个SKU，请核对后提交。`);return true;
    }}/>
    <div className="monthly-demand-tools"><label htmlFor="monthly-add-sku">增加备货SKU<select id="monthly-add-sku" value={newSku} disabled={busy||zeroDemand} onChange={event=>setNewSku(event.target.value)}><option value="">请选择SKU</option>{skuSettings.filter(row=>!drafts.some(item=>item.sku===row.sku)).map(row=><option key={row.sku} value={row.sku}>{row.sku} · {row.name}</option>)}</select></label><button className="btn" type="button" disabled={busy||zeroDemand||!newSku||drafts.length>=1000} onClick={()=>{const row=skuSettings.find(item=>item.sku===newSku);if(row){change({...state,drafts:[...drafts,{sku:row.sku,name:row.name||row.sku,qty:'1',reason:'运营补充需求'}]});setNewSku('');}}}>增加SKU</button><label className="monthly-zero-check"><input type="checkbox" checked={zeroDemand} disabled={busy} onChange={event=>change({...state,zeroDemand:event.target.checked})}/>确认本月无需备货</label></div>
    {notice&&<div className="monthly-demand-notice"><span role="status">{notice}</span>{undo&&<button className="btn" disabled={busy} onClick={()=>{setState(undo);setUndo(null);setError('');setNotice('已撤销上一步，提交后保存。');}}>撤销上一步</button>}</div>}
    {zeroDemand?<label className="monthly-zero-reason">无需备货确认说明<input value={zeroReason} maxLength={500} disabled={busy} onChange={event=>change({...state,zeroReason:event.target.value})} placeholder="请说明本月无需备货的原因"/></label>:<>
      <div className="monthly-demand-summary"><strong>{drafts.length} 个SKU</strong><span>合计 {drafts.reduce((sum,row)=>sum+(Number(row.qty)||0),0).toLocaleString('zh-CN')} 件</span></div>
      <div className="table-wrap"><table className="monthly-demand-table"><thead><tr><th>SKU</th><th>商品</th><th className="num">提交数量</th><th>调整原因</th><th>操作</th></tr></thead><tbody>{drafts.length?drafts.map(row=><tr key={row.sku}><td>{row.sku}</td><td>{row.name}</td><td className="num"><input className="qty-input" type="number" inputMode="numeric" min="1" max="1000000000" step="1" aria-label={`${row.sku}提交数量`} disabled={busy} value={row.qty} onChange={event=>change({...state,drafts:drafts.map(item=>item.sku===row.sku?{...item,qty:event.target.value}:item)})}/></td><td><input className="monthly-reason-input" aria-label={`${row.sku}调整原因`} maxLength={240} disabled={busy} value={row.reason} onChange={event=>change({...state,drafts:drafts.map(item=>item.sku===row.sku?{...item,reason:event.target.value}:item)})}/></td><td><button className="btn danger" type="button" disabled={busy} aria-label={`删除备货SKU ${row.sku}`} onClick={()=>remove(row.sku)}>删除</button></td></tr>):<tr><td colSpan={5}><div className="empty">备货清单为空。可导入文件、增加SKU，或勾选“确认本月无需备货”。</div></td></tr>}</tbody></table></div>
    </>}
    {error&&<p className="notice warn" role="alert">{error}</p>}
    {!zeroDemand&&drafts.length>0&&validation&&<p className="notice warn" role="alert">{validation}</p>}
    <div className="form-actions"><button className="btn primary" disabled={busy||!scopeReady||(zeroDemand?zeroReason.trim().length<4:Boolean(validation))} onClick={submit}>{busy?'正在提交…':zeroDemand?'提交本月无需备货':`提交 ${month} 需求`}</button></div>
  </div>;
}
