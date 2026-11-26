"use client";
import {useEffect,useState} from 'react';
import {advertisingTrendRoles} from '../lib/advertising-trend-model.mjs';
import {SITE_CURRENCIES} from '../lib/sales-data.mjs';
import './advertising-trend.css';
type Row=Record<string,any>;
type Props={actor:Row;month?:string;refreshToken?:unknown};
const amount=(value:unknown)=>value==null?'—':Number(value).toLocaleString('zh-CN',{maximumFractionDigits:2});
const statusText:Record<string,string>={reported:'费用已报',missing:'费用待补',partial:'仅有部分费用',review:'疑似重复，待核对'};

function DailyChart({days,currency}:{days:Row[];currency:string}){
 const width=900,height=190,left=66,right=18,top=18,bottom=32;
 const points:Row[]=days.map((day,index)=>{const row=day.entries.find((e:Row)=>e.currency===currency);return {...day,amount:row?.amount??null,reliable:!!row?.complete&&!row?.repeated,x:days.length===1?width/2:left+index*(width-left-right)/(days.length-1)};});
 const max=Math.max(1,...points.map(p=>p.amount??0)),y=(v:number)=>height-bottom-v/max*(height-top-bottom);
 const labels=[0,Math.floor((days.length-1)/2),days.length-1].filter((n,i,a)=>a.indexOf(n)===i);
 return <div className="advertising-trend-chart"><svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${currency} 每日广告费用趋势，空缺日期断开，黄色点为待核对或部分数据`}>
  {[0,.5,1].map(scale=><g key={scale}><line x1={left} y1={y(max*scale)} x2={width-right} y2={y(max*scale)} stroke="#e5ebf3"/><text x={left-9} y={y(max*scale)+4} textAnchor="end">{amount(max*scale)}</text></g>)}
  {points.map((p,i)=>{const previous=points[i-1];return p.amount!=null&&previous?.amount!=null?<line key={`line-${p.date}`} x1={previous.x} y1={y(previous.amount)} x2={p.x} y2={y(p.amount)} stroke={p.reliable&&previous.reliable?'#4277b0':'#bd8a3c'} strokeWidth="2.5" strokeDasharray={p.reliable&&previous.reliable?undefined:'5 4'}/>:null;})}
  {points.map(p=>p.amount==null?null:<circle key={p.date} cx={p.x} cy={y(p.amount)} r={days.length>60?2.5:4} fill={p.reliable?'#4277b0':'#bd8a3c'}><title>{p.date} · {amount(p.amount)} {currency} · {statusText[p.status]}{p.provisional?' · 今日未结束':''}</title></circle>)}
  {labels.map(index=><text key={index} x={points[index]?.x} y={height-9} textAnchor="middle">{days[index]?.date}</text>)}
 </svg><p className="advertising-trend-legend"><span>● 费用已完整填报</span><span>● 部分费用或待核对</span><span>断线表示该币种没有费用记录；不补成 0。</span></p></div>;
}
export default function AdvertisingTrend(props:Props){
 if(!advertisingTrendRoles.includes(props.actor.role))return null;
 return <AdvertisingTrendView key={`${props.actor.id}|${props.actor.role}|${props.actor.site}|${props.actor.channel}`} {...props}/>;
}
function AdvertisingTrendView({actor,month,refreshToken}:Props){
 const [filters,setFilters]=useState({site:actor.site||'印尼',channel:actor.channel||'TikTok',month:month||'',from:'',to:''});
 const [report,setReport]=useState<Row|null>(null),[loading,setLoading]=useState(true),[error,setError]=useState(''),[retry,setRetry]=useState(0),[currency,setCurrency]=useState(''),[page,setPage]=useState(0);
 useEffect(()=>{setFilters(f=>({...f,month:month||'',from:'',to:''}));},[month]);
 useEffect(()=>{
  const controller=new AbortController();setLoading(true);setError('');setReport(null);setPage(0);
  fetch(`/api/advertising-trend?${new URLSearchParams(filters)}`,{signal:controller.signal,cache:'no-store'}).then(async response=>{const body=await response.json();if(!response.ok)throw Error(body.error||'趋势读取失败');return body;}).then(body=>{if(!controller.signal.aborted)setReport(body);}).catch(e=>{if(!controller.signal.aborted)setError(e.message);}).finally(()=>{if(!controller.signal.aborted)setLoading(false);});
  return()=>controller.abort();
 },[filters,refreshToken,retry]);
 const currencies:string[]=report?.currencies||[],selected=currencies.includes(currency)?currency:currencies.includes(SITE_CURRENCIES[filters.site as keyof typeof SITE_CURRENCIES])?SITE_CURRENCIES[filters.site as keyof typeof SITE_CURRENCIES]:currencies[0]||SITE_CURRENCIES[filters.site as keyof typeof SITE_CURRENCIES];
 const total=report?.totals.find((r:Row)=>r.currency===selected),rows:Row[]=[...(report?.days||[])].reverse(),pages=Math.max(1,Math.ceil(rows.length/10)),current=Math.min(page,pages-1);
 const changeDate=(field:'from'|'to',value:string)=>setFilters(f=>({...f,month:'',from:f.from||report?.filters.from||'',to:f.to||report?.filters.to||'',[field]:value}));
 return <section className="panel advertising-trend" aria-label="广告费用趋势">
  <header className="advertising-trend-heading"><div><h3>广告费用趋势</h3><p>{actor.role==='运营'?'你的站点、你的平台，费用每天看得清。':'选择站点与平台，按实际日期核对广告消耗。'} 申请和付款金额不代替实际投放费用。</p></div><button type="button" className="btn" disabled={loading} onClick={()=>setRetry(n=>n+1)}>刷新趋势</button></header>
  <div className="advertising-trend-filters"><label>站点<select disabled={actor.role==='运营'} value={filters.site} onChange={e=>setFilters({...filters,site:e.target.value})}>{Object.keys(SITE_CURRENCIES).map(site=><option key={site}>{site}</option>)}</select></label><label>平台<select disabled={actor.role==='运营'} value={filters.channel} onChange={e=>setFilters({...filters,channel:e.target.value})}><option>TikTok</option><option>Shopee</option></select></label><label>开始日期<input type="date" value={filters.from||report?.filters.from||''} max={report?.filters.today} onChange={e=>changeDate('from',e.target.value)}/></label><label>结束日期<input type="date" value={filters.to||report?.filters.to||''} max={report?.filters.today} onChange={e=>changeDate('to',e.target.value)}/></label>{currencies.length>1&&<label>原币<select value={selected} onChange={e=>setCurrency(e.target.value)}>{currencies.map(code=><option key={code} value={code}>{code==='UNKNOWN'?'币种待核对':code}</option>)}</select></label>}</div>
  {loading&&<p role="status">正在核对广告费用台账…</p>}{error&&<p className="notice warn" role="alert">{error}</p>}
  {report&&<><div className="advertising-trend-summary"><div><span>已登记广告费用 · {selected==='UNKNOWN'?'币种待核对':selected}</span><strong>{amount(total?.amount)}</strong><small>{total?.knownDays||0} 天有该币种金额；{total?.reviewDays?'包含疑似重复费用，请先核对':'不同币种分别查看'}</small></div><div><span>费用已报</span><strong>{report.summary.reportedDays}<em> / {report.summary.days} 天</em></strong><small>店铺费用或完整日报的 SKU 费用</small></div><div><span>还需补齐 / 核对</span><strong>{report.summary.missingDays+report.summary.partialDays+report.summary.reviewDays}<em> 天</em></strong><small>缺报 {report.summary.missingDays} · 部分 {report.summary.partialDays} · 疑似重复 {report.summary.reviewDays}</small></div></div>
   {total?.change?<p className="advertising-trend-observation">{total.change.date} 较 {total.change.previousDate} 的已登记费用{total.change.amount===0?'持平':`${total.change.amount>0?'增加':'减少'} ${amount(Math.abs(total.change.amount))} ${selected}${total.change.percent==null?'':`（${amount(Math.abs(total.change.percent)*100)}%）`}`}。费用变化本身不代表投放效果变好或变差。</p>:<p className="advertising-trend-observation">最近两个完整日期的费用或币种未齐，暂不比较增减。先把缺口补上，再看变化更稳。</p>}
   {report.days.some((d:Row)=>d.provisional)&&<p className="advertising-trend-note">已包含站点当地今天，今日数据尚未结束，不参与日环比。</p>}
   <DailyChart days={report.days} currency={selected}/>
   <div className="table-wrap"><table><thead><tr><th>实际费用日期</th><th>已登记广告费用（原币）</th><th>费用来源</th><th>核对状态</th></tr></thead><tbody>{rows.slice(current*10,current*10+10).map(day=><tr key={day.date}><td>{day.date}{day.provisional&&<small>今日未结束</small>}</td><td>{day.entries.length?day.entries.map((entry:Row)=><div key={entry.currency}>{amount(entry.amount)} {entry.currency==='UNKNOWN'?'币种待核对':entry.currency}</div>):'未填报'}</td><td>{day.entries.length?(day.entries.some((e:Row)=>e.source==='channel')?'店铺广告总费用':'销售日报 SKU 费用'):'—'}</td><td><span className={`advertising-trend-state ${day.status}`}>{statusText[day.status]}</span>{!day.salesComplete&&<small>销售日报未确认完整</small>}</td></tr>)}</tbody></table></div>
   {pages>1&&<div className="report-pagination"><span>每日明细 · 第 {current+1}/{pages} 页</span><button type="button" className="btn" disabled={!current} onClick={()=>setPage(current-1)}>上一页</button><button type="button" className="btn" disabled={current===pages-1} onClick={()=>setPage(current+1)}>下一页</button></div>}
   <details className="advertising-trend-method"><summary>这些费用从哪里来？</summary><p>按选定站点、平台和实际费用日期读取有效记录。同一天有店铺广告总费用时，优先取店铺总费用并覆盖全部 SKU 费用；销售与广告可以使用不同币种。没有店铺总费用时，展示日报已填的 SKU 费用，缺报和疑似重复单独提示。</p><p>这里只显示账单原币，不自动换算、不混加币种。空白不等于 0；明确登记 0 才代表零费用。此页不将整店销售额除以广告费称为广告归因 ROAS，也不据此判断利润。</p></details>
  </>}
 </section>;
}
