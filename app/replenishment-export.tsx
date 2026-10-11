"use client";
import {useState} from 'react';
import {hasPermission} from '../lib/permissions.mjs';
import {replenishmentDownloadName,replenishmentExportSheets,toReplenishmentWorkbook} from '../lib/replenishment-export.mjs';
import {planStatusLabels,replenishmentPlans,replenishmentOrderSheets,replenishmentOrderWorkbook,replenishmentOrderName} from '../lib/replenishment-order-export.mjs';
type Row=Record<string,any>;

export default function ReplenishmentExport({snapshot,approvalId,showForecast=true}:{snapshot:Row;approvalId?:string;showForecast?:boolean}){
  const plans=replenishmentPlans(snapshot);
  const [selection,setSelection]=useState(''),[busy,setBusy]=useState(false),[feedback,setFeedback]=useState<{error:boolean;text:string}|null>(null);
  const selected=approvalId||selection||plans.find((p:Row)=>p.month===snapshot.currentMonth)?.id||plans[0]?.id||'';
  const plan=plans.find((p:Row)=>p.id===selected);
  if(!hasPermission(snapshot.actor?.role,'planning.export'))return null;
  const download=async(forecast=false)=>{
    setBusy(true);setFeedback(null);
    try{
      const sheets=forecast?replenishmentExportSheets(snapshot):replenishmentOrderSheets(snapshot,selected);
      const name=forecast?replenishmentDownloadName(snapshot.generatedAt):replenishmentOrderName(plan);
      const XLSX=await import('xlsx');
      const book=forecast?toReplenishmentWorkbook(XLSX,sheets):replenishmentOrderWorkbook(XLSX,sheets);
      const bytes=XLSX.write(book,{type:'array',bookType:'xlsx',compression:true});
      const url=URL.createObjectURL(new Blob([bytes],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}));
      const link=document.createElement('a');link.href=url;link.download=name;document.body.appendChild(link);
      try{link.click();}finally{link.remove();window.setTimeout(()=>URL.revokeObjectURL(url),60000);}
      setFeedback({error:false,text:forecast?'补货测算已导出，包含库存与动态建议。':`${plan.month} V${plan.version} 备货订单已导出，包含 SKU 数量、站点渠道分配和对应采购单。`});
    }catch(error){setFeedback({error:true,text:error instanceof Error?error.message:'导出失败，请刷新后重试'});}
    finally{setBusy(false);}
  };
  return <div className="replenishment-export">
    {!approvalId&&<label>备货计划<select aria-label="选择导出的备货计划" disabled={busy||!plans.length} value={selected} onChange={e=>{setSelection(e.target.value);setFeedback(null);}}>{!plans.length&&<option value="">暂无已送审计划</option>}{plans.map((p:Row)=><option key={p.id} value={p.id}>{p.month} · {planStatusLabels[p.status as keyof typeof planStatusLabels]||p.status} · V{p.version}</option>)}</select></label>}
    <div className="replenishment-export-buttons"><button type="button" className="btn primary" disabled={busy||!plan} onClick={()=>download()}>{busy?'正在生成 Excel…':'导出备货订单明细 Excel'}</button>{showForecast&&<button type="button" className="btn" disabled={busy} onClick={()=>download(true)}>导出补货测算 Excel</button>}</div>
    {!plan?<p>尚无可导出的备货计划，请由供应链在月度计划中核对送审。</p>:plan.status!=='approved'?<p>当前版本尚未批准，导出用于核对，不代表已下单。</p>:null}
    {!approvalId&&<p>订单明细取自已保存的计划；补货测算为随销售变化的建议。</p>}
    {feedback&&<p className={feedback.error?'export-error':''} role={feedback.error?'alert':'status'}>{feedback.text}</p>}
  </div>;
}
