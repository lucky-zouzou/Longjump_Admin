"use client";
import {useRef,useState} from 'react';
import {metricColumns,metricSheetRows,parseMetricSheet} from '../lib/content-metrics-import.mjs';
import {parseWorkspaceResponse} from '../lib/workspace-response.mjs';
import type {Row} from './content-center-forms';

export function ContentMetricsImport({posts,refresh}:{posts:Row[];refresh:()=>Promise<void>}){
 const [batch,setBatch]=useState<{rows:Row[];id:string;name:string}|null>(null);
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const input=useRef<HTMLInputElement>(null);
 async function template(){
  try{
    const x=await import('xlsx'),book=x.utils.book_new(),sheet=x.utils.aoa_to_sheet([metricColumns.map(c=>c[1])]);
    sheet['!cols']=metricColumns.map(([key])=>({wch:key==='url'?55:24}));
    x.utils.book_append_sheet(book,sheet,'效果数据');
    x.utils.book_append_sheet(book,x.utils.aoa_to_sheet([
      ['填写说明'],['一行对应一条已登记的视频及一个累计观察窗口。窗口填 1（24 小时）或 7。'],
      ['取数时间填本机时区的日期及时间，例如 2026-11-16 09:00；留存率按百分数填写，35 表示 35%。'],
      ['未知的指标留空，实际为零填 0。填写数据出处和统计口径。GMV 填该视频窗口的成交金额，币种留空时按发布站点原币处理。']
    ]),'填写说明');x.writeFile(book,'运营视频效果数据模板.xlsx');
  }catch(e){setError(e instanceof Error?e.message:'下载模板失败');}
 }
 async function read(file:File){
  setBusy(true);setBatch(null);setError('');setNotice('');
  try{
   if(file.size>3*1024*1024||!(/\.(xlsx|csv)$/i.test(file.name)))throw Error('请选择 3 MB 以内的 XLSX 或 CSV 文件');
   const x=await import('xlsx'),csv=/\.csv$/i.test(file.name);
   const book=x.read(csv?await file.text():await file.arrayBuffer(),{type:csv?'string':'array',raw:csv,cellDates:true});
   const sheet=book.Sheets[book.SheetNames.includes('效果数据')?'效果数据':book.SheetNames[0]];
   if(!sheet?.['!ref'])throw Error('文件没有数据');
   const range=x.utils.decode_range(sheet['!ref']);
   if(range.e.r>3000||range.e.c>100)throw Error('工作表范围过大，请按模板整理后导入');
   const matrix=metricSheetRows(x,sheet);
   const rows=parseMetricSheet(matrix,posts);setBatch({id:crypto.randomUUID(),rows,name:file.name});
  }catch(e){setError(e instanceof Error?e.message:'读取文件失败');}
  finally{setBusy(false);if(input.current)input.current.value='';}
 }
 async function submit(){
  if(!batch||busy)return;
  setBusy(true);setError('');
  try{
   await parseWorkspaceResponse(await fetch('/api/content-center',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'importMetrics',operationId:batch.id,rows:batch.rows})}));
   setNotice('已核对 '+batch.rows.length+' 行，相同观察记录自动跳过。');setBatch(null);await refresh();
  }catch(e){setError(e instanceof Error?e.message:'导入失败');}finally{setBusy(false);}
 }
 return <section className="cc-card cc-metric-import"><header className="cc-row"><h3>运营效果数据导入</h3><button className="btn" type="button" onClick={()=>void template()}>下载模板</button></header>
  <p>按已登记的视频链接匹配 24 小时或 7 天表现。未知指标留空，实际为零填 0。</p>
  <label>上传效果数据（Excel / CSV）<input ref={input} type="file" accept=".xlsx,.csv" disabled={busy} onChange={e=>{const f=e.target.files?.[0];if(f)void read(f);}}/></label>
  {batch&&<><p>{batch.name} · 已匹配 {batch.rows.length} 行</p><div className="cc-table-scroll"><table><thead><tr>{['行','视频','窗口','播放','订单','视频归属 GMV'].map(k=><th key={k}>{k}</th>)}</tr></thead><tbody>{batch.rows.map(r=><tr key={r.line}><td>{r.line}</td><td><a href={r.url} target="_blank" rel="noreferrer">查看视频</a></td><td>{r.days===1?'24 小时':'7 天'}</td><td>{r.views===''?'待补录':r.views}</td><td>{r.orders===''?'待补录':r.orders}</td><td>{r.gmv==null?'待补录':r.gmv+' '+(r.currency||'站点原币')}</td></tr>)}</tbody></table></div>
  <button className="btn primary" disabled={busy} onClick={()=>void submit()}>确认导入 {batch.rows.length} 行</button></>}
  {notice&&<p role="status">{notice}</p>}{error&&<p role="alert" className="cc-error">{error}</p>}</section>;
}
