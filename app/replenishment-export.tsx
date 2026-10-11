"use client";
import {useState} from 'react';
import {hasPermission} from '../lib/permissions.mjs';
import {replenishmentDownloadName,replenishmentExportSheets,toReplenishmentWorkbook} from '../lib/replenishment-export.mjs';

export default function ReplenishmentExport({snapshot}:{snapshot:Record<string,any>}){
  const [busy,setBusy]=useState(false),[feedback,setFeedback]=useState<{error:boolean;text:string}|null>(null);
  if(!hasPermission(snapshot.actor?.role,'planning.export'))return null;
  const download=async()=>{
    setBusy(true);setFeedback(null);
    try{
      const sheets=replenishmentExportSheets(snapshot),name=replenishmentDownloadName(snapshot.generatedAt);
      const XLSX=await import('xlsx');
      const bytes=XLSX.write(toReplenishmentWorkbook(XLSX,sheets),{type:'array',bookType:'xlsx',compression:true});
      const url=URL.createObjectURL(new Blob([bytes],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}));
      const link=document.createElement('a');link.href=url;link.download=name;document.body.appendChild(link);
      try{link.click();}finally{link.remove();window.setTimeout(()=>URL.revokeObjectURL(url),60000);}
      setFeedback({error:false,text:`Excel 已生成，含 ${snapshot.suggestions.length} 行明细及汇总，请查看浏览器下载。`});
    }catch(error){setFeedback({error:true,text:error instanceof Error?error.message:'导出失败，请刷新后重试'});}
    finally{setBusy(false);}
  };
  return <div className="replenishment-export"><button type="button" className="btn primary" disabled={busy} onClick={download}>{busy?'正在生成 Excel…':'导出备货明细 Excel'}</button>{feedback&&<p className={feedback.error?'export-error':''} role={feedback.error?'alert':'status'}>{feedback.text}</p>}</div>;
}
