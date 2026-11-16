"use client";
import {useEffect,useState} from 'react';
import {parseWorkspaceResponse} from '../lib/workspace-response.mjs';

type SiteRow={site:string;videos:number;views:number|null;orders:number|null;gmvMinor:number|null;
  viewCount:number;orderCount:number;gmvCount:number;missingRate:number};
const indicators=[
  {name:'总播放量',field:'views',count:'viewCount',unit:'次'},
  {name:'总出单量',field:'orders',count:'orderCount',unit:'单'},
  {name:'总 GMV',field:'gmvMinor',count:'gmvCount',unit:'人民币'}
] as const;
function Measure({rows,metric}:{rows:SiteRow[];metric:typeof indicators[number]}){
  const videos=rows.reduce((n,r)=>n+r.videos,0);
  if(!videos)return <span className="cc-compass-empty">暂无发布</span>;
  const known=rows.reduce((n,r)=>n+r[metric.count],0);
  const fx=metric.field==='gmvMinor'?rows.reduce((n,r)=>n+r.missingRate,0):0;
  const sum=rows.reduce((n,r)=>n+(r[metric.field]??0),0);
  return <><strong>{!known?'—':metric.field==='gmvMinor'?'¥'+(sum/100).toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2}):sum.toLocaleString('zh-CN')}</strong>
    {known<videos&&<small>{known?'已知小计 · ':''}{videos-known-fx>0?(videos-known-fx)+' 条待补录':''}{fx>0?' '+fx+' 条待核汇率':''}</small>}</>;
}

export function ContentCompass({sites,refreshKey}:{sites:string[];refreshKey:number}){
  const [period,setPeriod]=useState('month'),[site,setSite]=useState(''),[attempt,retry]=useState(0);
  const [result,setResult]=useState<{period:string;rows:SiteRow[]}|null>(null),[error,setError]=useState('');
  useEffect(()=>{
    const ctl=new AbortController();
    setError('');
    fetch('/api/content-center?view=compass&period='+encodeURIComponent(period),{cache:'no-store',signal:ctl.signal})
      .then(parseWorkspaceResponse).then(data=>{if(!ctl.signal.aborted)setResult(data);})
      .catch(e=>{if(!ctl.signal.aborted)setError(e.message||'数据读取失败');});
    return ()=>ctl.abort();
  },[period,refreshKey,attempt]);
  const ready=result?.period===period,rows=(ready?result.rows:[]).filter(r=>!site||r.site===site);
  return <section className="cc-compass" aria-label="短视频拍摄剪辑数据罗盘">
    <header><div><h3>短视频拍摄剪辑数据罗盘</h3><p>按视频在各站点的实际发布日期统计。</p></div>
      <div className="cc-compass-filters"><label>统计期间<select value={period} onChange={e=>setPeriod(e.target.value)}>
        <option value="month">本月</option><option value="previous">上月</option><option value="week">近 7 天</option>
        <option value="thirty">近 30 天</option><option value="all">全部期间</option></select></label>
      <label>发布站点<select value={site} onChange={e=>setSite(e.target.value)}><option value="">全部站点</option>{sites.map(s=><option key={s}>{s}</option>)}</select></label></div></header>
    {error?<div role="alert">{error} <button className="btn" onClick={()=>retry(n=>n+1)}>重试</button></div>:
      !ready?<p role="status">正在读取效果复盘数据…</p>:<>
      <div className="cc-compass-cards">{indicators.map(m=><article key={m.field}><h4>{m.name} <small>{m.unit}</small></h4><Measure rows={rows} metric={m}/></article>)}</div>
      <h4>各站点数据明细</h4><div className="cc-table-scroll"><table><thead><tr><th>站点</th><th>播放量</th><th>出单量</th><th>GMV（人民币）</th></tr></thead>
        <tbody>{rows.map(row=><tr key={row.site}><th scope="row">{row.site}</th>{indicators.map(m=><td key={m.field}><Measure rows={[row]} metric={m}/></td>)}</tr>)}</tbody></table></div>
      <p>每条视频取已录入的最长累计窗口，同一窗口取最新修订。GMV 按发布月的财务汇率折算，缺报或缺汇率的部分单独标明。</p></>}
  </section>;
}
