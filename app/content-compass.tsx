"use client";
import {useEffect,useState} from 'react';
import {PlatformReports} from './content-platform-reports';
import {parseWorkspaceResponse} from '../lib/workspace-response.mjs';

const basisLabels={cny:'原币为人民币',finance:'财务月度汇率',closed:'已关账汇率',reference:'参考汇率',closedMissing:'关账快照缺汇率',missing:'暂无可用汇率',zero:'原币金额为零'};
type Conversion={month:string;currency:string|null;amountMinor:number;rate:number|null;cnyMinor:number|null;basis:keyof typeof basisLabels;asOf:string|null};
type Metrics={site:string;views:number|null;orders:number|null;gmvMinor:number|null;
  viewCount:number;orderCount:number;gmvCount:number;missingRate:number;referenceCount:number;conversions:Conversion[]};
type SiteRow=Metrics & {entries:number;overlaps:number};
type Result={period:string;range:string;rows:(Metrics & {videos:number})[];
  reports:{rows:SiteRow[];ranges:{site:string;start:string;end:string}[]}};
export type CompassSelection={site:string;source:'reports'|'published';range:string};
const indicators=[
  {name:'总播放量',field:'views',count:'viewCount',unit:'次'},
  {name:'总出单量',field:'orders',count:'orderCount',unit:'单'},
  {name:'总 GMV',field:'gmvMinor',count:'gmvCount',unit:'人民币'}
] as const;
const money=(minor:number)=>(minor/100).toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2});
function Measure({rows,metric,empty}:{rows:SiteRow[];metric:typeof indicators[number];empty:string}){
  const entries=rows.reduce((n,r)=>n+r.entries,0);
  if(!entries)return <span className="cc-compass-empty">{rows.some(r=>r.overlaps)?'期间交叉待核对':empty}</span>;
  const known=rows.reduce((n,r)=>n+r[metric.count],0);
  const fx=metric.field==='gmvMinor'?rows.reduce((n,r)=>n+r.missingRate,0):0;
  const estimated=metric.field==='gmvMinor'?rows.reduce((n,r)=>n+r.referenceCount,0):0;
  const sum=rows.reduce((n,r)=>n+(r[metric.field]??0),0);
  return <><strong>{!known?'—':metric.field==='gmvMinor'?'¥'+money(sum):sum.toLocaleString('zh-CN')}</strong>
    {estimated>0&&<small>{estimated} 条按参考汇率折算</small>}
    {known<entries&&<small>{known?'已知小计 · ':''}{entries-known-fx>0?(entries-known-fx)+' 条待补录':''}{fx>0?' '+fx+' 条待核汇率':''}</small>}</>;
}

export function ContentCompass({sites,reportSites,refreshKey,initial}:{sites:string[];reportSites:string[];refreshKey:number;initial?:CompassSelection}){
  const [period,setPeriod]=useState(initial?'all':'month'),[site,setSite]=useState(initial?.site||'');
  const [range,setRange]=useState(initial?.range||''),[source,setSource]=useState(initial?.source),[attempt,retry]=useState(0);
  const [result,setResult]=useState<Result|null>(null),[error,setError]=useState('');
  useEffect(()=>{
    const ctl=new AbortController();
    setError('');
    fetch('/api/content-center?'+new URLSearchParams({view:'compass',period,range}),{cache:'no-store',signal:ctl.signal})
      .then(parseWorkspaceResponse).then(data=>{if(!ctl.signal.aborted)setResult(data);})
      .catch(e=>{if(!ctl.signal.aborted)setError(e.message||'数据读取失败');});
    return ()=>ctl.abort();
  },[period,range,refreshKey,attempt]);
  const ready=result?.period===period&&result.range===range;
  const imported=reportSites.length>0&&(source?source==='reports':
    !!result?.reports.ranges.length||!result?.rows.some(row=>row.videos));
  const visibleSites=imported?reportSites:sites;
  const rows=(ready?(imported?result.reports.rows:result.rows.map(row=>({...row,entries:row.videos,overlaps:0}))):[]).filter(r=>!site||r.site===site);
  const ranges=Array.from(new Set(result?.reports.ranges.filter(r=>!site||r.site===site).map(r=>r.start+'~'+r.end)));
  const overlaps=rows.reduce((n,r)=>n+r.overlaps,0);
  const empty=imported?'暂无导入报表':'暂无发布';
  return <section className="cc-compass" aria-label="短视频拍摄剪辑数据罗盘">
    <header><div><h3>短视频拍摄剪辑数据罗盘</h3><p>{imported?'按运营报表的结束日统计，含尚未关联发布记录的视频。':'按视频在各站点的实际发布日期统计。'}</p></div>
      <div className="cc-compass-filters">{reportSites.length>0&&<label>数据来源<select value={imported?'reports':'published'} onChange={e=>{
        const next=e.target.value==='reports'?'reports':'published';setSource(next);setRange('');
        if(next==='reports'&&site&&!reportSites.includes(site))setSite('');
      }}><option value="reports">运营导入报表</option><option value="published">已发布视频观察</option></select></label>}
      <label>统计期间<select value={period} onChange={e=>{setSource(imported?'reports':'published');setPeriod(e.target.value);setRange('');}}>
        <option value="month">本月</option><option value="previous">上月</option><option value="week">近 7 天</option>
        <option value="thirty">近 30 天</option><option value="all">全部期间</option></select></label>
      <label>站点<select value={site} onChange={e=>{setSite(e.target.value);setRange('');setSource(imported?'reports':'published');}}>
        <option value="">全部站点</option>{visibleSites.map(s=><option key={s}>{s}</option>)}</select></label>
      {imported&&(ranges.length>1||range)&&<label>报表起止日期<select value={range} onChange={e=>setRange(e.target.value)}>
        <option value="">合计</option>{ranges.map(r=><option key={r} value={r}>{r.replace('~',' 至 ')}</option>)}</select></label>}</div></header>
    {error?<div role="alert">{error} <button className="btn" onClick={()=>retry(n=>n+1)}>重试</button></div>:
      !ready?<p role="status">正在读取罗盘数据…</p>:<>
      {overlaps>0&&<p role="status">有 {overlaps} 组同一视频的报表日期交叉，无法确定重叠天数的销量，已从合计中扣除整组。请选择具体报表起止日期查看。</p>}
      <div className="cc-compass-cards">{indicators.map(m=><article key={m.field}><h4>{m.name} <small>{m.unit}</small></h4><Measure rows={rows} metric={m} empty={empty}/></article>)}</div>
      {imported&&!ranges.length&&period!=='all'&&<p>当前期间没有符合条件的报表。 <button className="btn" onClick={()=>{setSource('reports');setPeriod('all');setRange('');}}>查看全部期间</button></p>}
      <h4>各站点数据明细</h4><div className="cc-table-scroll"><table><thead><tr><th>站点</th><th>播放量</th><th>出单量</th><th>GMV（人民币）</th></tr></thead>
        <tbody>{rows.map(row=><tr key={row.site}><th scope="row">{row.site}</th>{indicators.map(m=><td key={m.field}><Measure rows={[row]} metric={m} empty={empty}/></td>)}</tr>)}</tbody></table></div>
      {rows.some(row=>row.conversions.length>0)&&<details className="cc-compass-fx"><summary>查看 GMV 换算明细</summary>
        <p>按站点、月份和币种汇总原币金额，折算到人民币分后相加。优先使用{imported?'报表结束月':'视频发布月'}的财务汇率，已关账月份使用封存值。</p>
        {rows.some(row=>row.referenceCount>0)&&<p>尚未核定汇率的月份使用最近可用的参考报价估算，核定后自动改用财务汇率。报价来源为 <a href="https://www.exchangerate-api.com" target="_blank" rel="noreferrer">ExchangeRate-API</a>。</p>}
        <div className="cc-table-scroll"><table><thead><tr><th>站点 / 月份</th><th>原币 GMV</th><th>1 原币兑人民币</th><th>汇率依据</th><th>折合人民币</th></tr></thead>
        <tbody>{rows.flatMap(row=>row.conversions.map(c=><tr key={[row.site,c.month,c.currency].join('/')}><th scope="row">{row.site} · {c.month}</th>
          <td>{money(c.amountMinor)} {c.currency||'币种未填'}</td><td>{c.rate?.toLocaleString('zh-CN',{maximumSignificantDigits:9})??'—'}</td>
          <td>{basisLabels[c.basis]}{c.asOf&&<small>{c.asOf.slice(0,10)} UTC</small>}</td><td>{c.cnyMinor===null?'待核汇率':'¥'+money(c.cnyMinor)}</td></tr>))}</tbody></table></div>
      </details>}
      <p>{imported?'出单取归属订单，GMV 取视频归属 GMV。同一视频取最新修订，日期分开的报表可累加，日期完全包含时取覆盖整个区间的报表。':'每条视频取已录入的最长累计窗口，同一窗口取最新修订。'}</p>
      {imported&&<PlatformReports key={[period,site,range].join('/')} site={site} period={period} range={range} refreshKey={refreshKey}/>}
    </>}
  </section>;
}
