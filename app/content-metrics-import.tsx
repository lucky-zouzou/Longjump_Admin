"use client";
import {useRef,useState} from 'react';
import {metricColumns,metricSheetRows,parseMetricSheet} from '../lib/content-metrics-import.mjs';
import {findReportHeader,parseReport,platformSheetRows,reportHeaders} from '../lib/content-platform-report.mjs';
import {SITE_CURRENCIES} from '../lib/sales-data.mjs';
import {parseWorkspaceResponse} from '../lib/workspace-response.mjs';
import {PlatformReports,amountFields} from './content-platform-reports';
import type {Row} from './content-center-forms';

type Batch={rows:Row[];id:string;name:string;platform:boolean};
export function ContentMetricsImport({sites,posts,refresh}:{sites:string[];posts:Row[];refresh:()=>Promise<void>}){
 const [batch,setBatch]=useState<Batch|null>(null),[site,setSite]=useState(sites[0]);
 const [start,setStart]=useState(''),[end,setEnd]=useState(''),[revision,next]=useState(0);
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const input=useRef<HTMLInputElement>(null),currency=(SITE_CURRENCIES as Record<string,string>)[site];
 async function template(platform:boolean){
  try{
    const x=await import('xlsx'),book=x.utils.book_new(),headers=platform?reportHeaders(site):metricColumns.map(c=>c[1]);
    const sheet=x.utils.aoa_to_sheet([headers]);sheet['!cols']=headers.map(()=>({wch:24}));
    if(platform){
      for(let i=2;i<=501;i++)sheet['A'+i]={t:'s',v:'',z:'@'};
      sheet['!ref']=x.utils.encode_range({s:{r:0,c:0},e:{r:500,c:headers.length-1}});
    }
    x.utils.book_append_sheet(book,sheet,platform?'Video performance':'效果数据');
    x.utils.book_append_sheet(book,x.utils.aoa_to_sheet(platform?[
      ['填写说明'],['将 Video ID 按文本格式粘贴，也可使用 Video URL 列并填写完整发布链接。'],['金额以 '+currency+' 填写；未知留空。上传时填写与平台导出一致的起止日期。']
    ]:[['填写说明'],['一行对应一条已登记的视频及一个累计观察窗口。窗口填 1（24 小时）或 7。'],['填写本机取数日期和时间、出处和口径。百分数填 35 表示 35%。未知留空。']]),'填写说明');
    x.writeFile(book,platform?site+'-TikTok运营效果-'+currency+'.xlsx':'运营视频观察窗口模板.xlsx');
  }catch(e){setError(e instanceof Error?e.message:'下载模板失败');}
 }
 async function read(file:File){
  setBusy(true);setBatch(null);setError('');setNotice('');
  try{
   if(file.size>3*1024*1024||!(/\.(xlsx|csv)$/i.test(file.name)))throw Error('请选择 3 MB 以内的 XLSX 或 CSV 文件');
   const x=await import('xlsx'),csv=/\.csv$/i.test(file.name);
   const book=x.read(csv?await file.text():await file.arrayBuffer(),{type:csv?'string':'array',raw:csv,cellDates:true});
   let found:Batch|null=null;
   for(const name of book.SheetNames){
     const sheet=book.Sheets[name];if(!sheet?.['!ref']||name==='填写说明')continue;
     const range=x.utils.decode_range(sheet['!ref']);
     if(range.e.r>3000||range.e.c>150)throw Error('工作表范围过大，请分批导入');
     const matrix=metricSheetRows(x,sheet);
     const legacy=(matrix[0]||[]).includes(metricColumns[1][1]),head=findReportHeader(matrix);
     if(!legacy&&head<0)continue;
     if(found)throw Error('文件包含多张效果报表，请按站点和期间分别导入');
     const rows=legacy?parseMetricSheet(matrix,posts.filter(p=>p.site===site)):parseReport(platformSheetRows(x,sheet,matrix,head),site);
     found={id:crypto.randomUUID(),rows,name:file.name,platform:!legacy};
   }
   if(!found)throw Error('未找到效果报表。请检查 Video ID 或 Video URL 和指标列，或下载本站点模板。');
   setBatch(found);
  }catch(e){setError(e instanceof Error?e.message:'读取文件失败');}
  finally{setBusy(false);if(input.current)input.current.value='';}
 }
 async function submit(){
  if(!batch||busy)return;
  setBusy(true);setError('');
  try{
   const payload=batch.platform?{action:'importPlatformReport',site,start,end,currency,file:batch.name}:{action:'importMetrics'};
   await parseWorkspaceResponse(await fetch('/api/content-center',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...payload,operationId:batch.id,rows:batch.rows})}));
   setNotice('已核对 '+batch.rows.length+' 行，相同记录自动跳过。');setBatch(null);next(n=>n+1);await refresh();
  }catch(e){setError(e instanceof Error?e.message:'导入失败');}finally{setBusy(false);}
 }
 return <><section className="cc-card cc-metric-import"><header className="cc-row"><h3>运营效果数据导入</h3><div className="cc-actions"><button className="btn" type="button" onClick={()=>void template(true)}>下载本站点运营模板</button><button className="btn" type="button" onClick={()=>void template(false)}>下载观察窗口模板</button></div></header>
  <p>平台报表按站点、期间和视频编号保存。登记发布后自动关联。24 小时／7 天观察表按已登记的发布链接导入。</p>
  <label>报表所属站点<select disabled={busy} value={site} onChange={e=>{setSite(e.target.value);setBatch(null);setError('');setNotice('');}}>{sites.map(s=><option key={s}>{s}</option>)}</select></label>
  <label>上传效果数据（Excel / CSV）<input ref={input} type="file" accept=".xlsx,.csv" disabled={busy} onChange={e=>{const f=e.target.files?.[0];if(f)void read(f);}}/></label>
  {batch&&<><p>{batch.name} · 已读取 {batch.rows.length} 行</p>
    {batch.platform&&<div className="cc-fields"><label>报表开始日期<input disabled={busy} type="date" value={start} max={end||undefined} onChange={e=>setStart(e.target.value)}/></label><label>报表结束日期<input disabled={busy} type="date" min={start||undefined} value={end} onChange={e=>setEnd(e.target.value)}/></label></div>}
    <div className="cc-table-scroll"><table><thead><tr>{['行','视频',...(batch.platform?amountFields.map(([,l])=>l+' · '+currency):['窗口','播放','订单','视频归属 GMV'])].map(k=><th key={k}>{k}</th>)}</tr></thead>
    <tbody>{batch.rows.map(r=><tr key={r.line}><td>{r.line}</td>{batch.platform?<><td>{r.videoId}</td>{amountFields.map(([k])=><td key={k}>{r[k]??'—'}</td>)}</>:<><td><a href={r.url} target="_blank" rel="noreferrer">查看视频</a></td><td>{r.days===1?'24 小时':'7 天'}</td><td>{r.views===''?'待补录':r.views}</td><td>{r.orders===''?'待补录':r.orders}</td><td>{r.gmv==null?'待补录':r.gmv+' '+(r.currency||'站点原币')}</td></>}</tr>)}</tbody></table></div>
    <button className="btn primary" disabled={busy||batch.platform&&(!start||!end||end<start)} onClick={()=>void submit()}>确认导入 {batch.rows.length} 行</button></>}
  {notice&&<p role="status">{notice}</p>}{error&&<p role="alert" className="cc-error">{error}</p>}</section>
  <PlatformReports key={site} site={site} refreshKey={revision}/></>;
}
