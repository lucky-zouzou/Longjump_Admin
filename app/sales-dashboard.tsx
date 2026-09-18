"use client";
import {useEffect,useMemo,useState} from 'react';
import {SalesTrend,RankingBars} from './sales-charts';
import {SITE_CURRENCIES} from '../lib/sales-data.mjs';
type Row=Record<string,any>;
const number=(n:unknown)=>Number(n||0).toLocaleString('zh-CN',{maximumFractionDigits:2});
const money=(n:unknown)=>n==null?'未填报':number(n);
const today=()=>new Date(Date.now()+8*3600000).toISOString().slice(0,10);
const ago=(n:number)=>new Date(Date.parse(today())-n*86400000).toISOString().slice(0,10);
const status=(r:Row)=>r.revenueMissing||r.costMissing?'资料不完整':r.adCost===0?'无投放':'可排名';
const ratio=(r:Row)=>r.roas==null?status(r):`${number(r.roas)}×`;
function Card({label,value,note}:{label:string;value:string;note:string}){return <div className="metric"><div className="label">{label}</div><div className="value">{value}</div><div className="foot">{note}</div></div>;}
function Panel({title,desc,children}:{title:string;desc:string;children:React.ReactNode}){return <section className="panel"><div className="panel-head"><div><h4>{title}</h4><p>{desc}</p></div></div>{children}</section>;}
type Column={label:string;render:(row:Row)=>React.ReactNode;numeric?:boolean};
function ReportTable({rows,columns,empty='所选范围暂无数据'}:{rows:Row[];columns:Column[];empty?:string}){
  const [page,setPage]=useState(0);const pages=Math.max(1,Math.ceil(rows.length/10)),current=Math.min(page,pages-1);
  return <><div className="table-wrap"><table><thead><tr>{columns.map(c=><th key={c.label} className={c.numeric?'num':''}>{c.label}</th>)}</tr></thead><tbody>{rows.slice(current*10,current*10+10).map((r,i)=><tr key={i}>{columns.map(c=><td key={c.label} className={c.numeric?'num':''}>{c.render(r)}</td>)}</tr>)}{!rows.length&&<tr><td colSpan={columns.length}><div className="empty">{empty}</div></td></tr>}</tbody></table></div>{rows.length>10&&<div className="report-pagination"><span>共 {number(rows.length)} 条 · 第 {current+1}/{pages} 页</span><button className="btn" disabled={!current} onClick={()=>setPage(current-1)}>上一页</button><button className="btn" disabled={current===pages-1} onClick={()=>setPage(current+1)}>下一页</button></div>}</>;
}
export default function SalesDashboard({actor,refreshToken}:{actor:Row;refreshToken:unknown}){
  const [filters,setFilters]=useState({from:ago(29),to:today(),site:actor.role==='运营'?actor.site:'',channel:actor.role==='运营'?actor.channel:''});
  const [report,setReport]=useState<Row|null>(null),[loading,setLoading]=useState(true),[error,setError]=useState(''),[retry,setRetry]=useState(0),[currency,setCurrency]=useState(''),[search,setSearch]=useState(''),[showUnranked,setShowUnranked]=useState(false),[exporting,setExporting]=useState(false),[chartMode,setChartMode]=useState<'qty'|'money'>('qty');
  useEffect(()=>{const controller=new AbortController();setLoading(true);setError('');setReport(previous=>previous&&JSON.stringify(previous.filters)===JSON.stringify(filters)?previous:null);fetch(`/api/sales-dashboard?${new URLSearchParams(filters)}`,{signal:controller.signal,cache:'no-store'}).then(async r=>{const data=await r.json();if(!r.ok)throw Error(data.error||'看板加载失败');return data;}).then(setReport).catch(e=>{if(e.name!=='AbortError')setError(e.message);}).finally(()=>{if(!controller.signal.aborted)setLoading(false);});return()=>controller.abort();},[filters,refreshToken,retry]);
  const selected=report?.currencies.find((r:Row)=>r.currency===currency)?.currency||report?.currencies.find((r:Row)=>r.currency!=='UNKNOWN')?.currency||'UNKNOWN';
  const financial=report?.currencies.find((r:Row)=>r.currency===selected);
  const rankings=useMemo(()=>report?.skuRanking.filter((r:Row)=>`${r.sku} ${r.name}`.toLowerCase().includes(search.toLowerCase()))||[],[report,search]);
  const roiRows=useMemo(()=>{let rank=0;return (report?.roiRanking||[]).filter((r:Row)=>r.currency===selected).map((r:Row)=>({...r,rank:r.roas==null?null:++rank})).filter((r:Row)=>showUnranked||r.roas!==null);},[report,selected,showUnranked]);
  const daily=useMemo(()=>report?.daily.filter((r:Row)=>r.currency===selected)||[],[report,selected]);
  const scopes=useMemo(()=>report?.scopes.filter((r:Row)=>r.currency===selected)||[],[report,selected]);
  const channelVolumes=useMemo(()=>{const grouped=new Map<string,Row>();for(const r of report?.scopes||[]){const label=`${r.site} · ${r.channel}`,old=grouped.get(label);grouped.set(label,{label,qty:(old?.qty||0)+r.qty});}return [...grouped.values()].sort((a,b)=>b.qty-a.qty);},[report]);
  const exportReport=async()=>{if(!report)return;setExporting(true);try{const XLSX=await import('xlsx'),book=XLSX.utils.book_new();
    const add=(name:string,rows:Row[])=>XLSX.utils.book_append_sheet(book,XLSX.utils.json_to_sheet(rows),name);
    const financialRows=(rows:Row[])=>rows.map(r=>({日期:r.date||'',站点:r.site||'',渠道:r.channel||'',SKU:r.sku||'',币种:r.currency,销量:r.qty,已填报销售额:r.revenue,已填报投放成本:r.adCost,缺销售额记录:r.revenueMissing,缺成本记录:r.costMissing,ROAS:r.roas,状态:status(r)}));
    add('统计口径',[{起始日期:report.filters.from,截止日期:report.filters.to,站点:report.filters.site||'全部可见站点',渠道:report.filters.channel||'全部可见渠道',总销量:report.totalQty,说明:'ROAS=销售额÷广告成本；不同币种不相加，金额为已填报部分；缺金额或成本不排名；旧估算价格不计销售额；不代表利润率。'}]);
    add('全站SKU销量',report.skuRanking.map((r:Row)=>({排名:r.rank,SKU:r.sku,商品:r.name,销售总数量:r.qty,站点数:r.siteCount,销量占比:r.share})));
    add('币种汇总',financialRows(report.currencies));add('SKU投产比',financialRows(report.roiRanking));add('站点渠道',financialRows(report.scopes));add('每日明细',financialRows(report.daily));
    XLSX.writeFile(book,`销售看板_${report.filters.from}_${report.filters.to}.xlsx`);
  }catch(e){setError(e instanceof Error?e.message:'导出失败，请重试');}finally{setExporting(false);}};
  const moneyColumns:Column[]=[{label:'销量',numeric:true,render:r=>number(r.qty)},{label:'销售额',numeric:true,render:r=><>{money(r.revenue)}{r.revenueMissing>0&&<small className="report-missing">部分未填报</small>}</>},{label:'投放成本',numeric:true,render:r=><>{money(r.adCost)}{r.costMissing>0&&<small className="report-missing">部分未填报</small>}</>},{label:'投产比 ROAS',numeric:true,render:r=>ratio(r)}];
  return <section className="sales-dashboard" aria-label="销售经营看板">
    <Panel title="销售经营看板" desc="销量跨站点汇总；金额按币种分别统计。ROAS是销售额÷广告投放成本，不代表利润率。">
      <div className="report-filters"><label>开始日期<input type="date" value={filters.from} max={filters.to} onChange={e=>setFilters({...filters,from:e.target.value})}/></label><label>结束日期<input type="date" value={filters.to} min={filters.from} max={today()} onChange={e=>setFilters({...filters,to:e.target.value})}/></label><label>站点<select disabled={actor.role==='运营'} value={filters.site} onChange={e=>setFilters({...filters,site:e.target.value})}><option value="">全部可见站点</option>{Object.keys(SITE_CURRENCIES).map(s=><option key={s}>{s}</option>)}</select></label><label>渠道<select disabled={actor.role==='运营'} value={filters.channel} onChange={e=>setFilters({...filters,channel:e.target.value})}><option value="">全部渠道</option>{['TikTok','Shopee','线下分销'].map(s=><option key={s}>{s}</option>)}</select></label></div>
      <div className="report-actions">{[{label:'近7天',from:ago(6)},{label:'近30天',from:ago(29)},{label:'本月',from:`${today().slice(0,7)}-01`}].map(r=><button className="btn" key={r.label} onClick={()=>setFilters({...filters,from:r.from,to:today()})}>{r.label}</button>)}<button className="btn" disabled={loading} onClick={()=>setRetry(retry+1)}>刷新</button><button className="btn" disabled={!report||exporting} onClick={exportReport}>{exporting?'正在导出…':'导出完整看板'}</button></div>
    </Panel>
    {loading&&<p className="notice info" role="status">{report?"正在更新，当前展示上次成功汇总的数据…":"正在汇总销售数据…"}</p>}{error&&<p className="notice warn" role="alert">{error}</p>}
    {report&&<>
      <div className="report-currencies" aria-label="金额统计币种"><strong>金额币种</strong>{report.currencies.map((r:Row)=><button key={r.currency} className={`btn ${selected===r.currency?'primary':''}`} aria-pressed={selected===r.currency} onClick={()=>setCurrency(r.currency)}>{r.currency==='UNKNOWN'?'历史未标币种':r.currency}</button>)}{!report.currencies.length&&<span>暂无销售数据</span>}<span>切换币种只影响金额、投产比和金额明细；销量榜保持所选站点总计。</span></div>
      {report.currencies.some((r:Row)=>r.currency==="UNKNOWN")&&<p className="notice info">包含未标币种的历史记录：这些记录仅计入销量，不混入当前币种的销售额或投产比。可切换“历史未标币种”查看。</p>}
      <div className="report-metrics">
        <Card label="销售总数量" value={`${number(report.totalQty)} 件`} note="当前日期、站点及渠道范围 · 全币种"/><Card label="产生销量的SKU" value={number(report.skuCount)} note="同一SKU跨站点合并后去重"/>
        <Card label={`销售额 · ${selected==='UNKNOWN'?'币种未标':selected}`} value={money(financial?.revenue)} note={financial?.revenueMissing?`有 ${number(financial.revenueMissing)} 条未填报；这里只计已填报金额`:'按实际成交金额统计'}/>
        <Card label={`投放成本 · ${selected==='UNKNOWN'?'币种未标':selected}`} value={money(financial?.adCost)} note={financial?.costMissing?`有 ${number(financial.costMissing)} 条未填报；这里只计已填报成本`:'明确填写0才视为无投放'}/>
        <Card label="整体投产比 ROAS" value={financial?ratio(financial):'暂无数据'} note="同币种全量金额与成本齐全后计算"/>
        <Card label="成交均价" value={financial?.averagePrice!=null?`${money(financial.averagePrice)} ${selected}`:'资料不完整'} note="该币种销售额 ÷ 该币种销量"/>
      </div>
      {financial&&(financial.revenueMissing>0||financial.costMissing>0)&&<p className="notice warn">当前币种有销售额或投放成本未填报，整体投产比暂不计算。旧记录中的估算价格不作为实际销售额；SKU资料齐全且投放成本大于0，才进入排名。线下销售按发货减退货汇总，尚无广告成本时不参加投产比排名。</p>}
      <div className="sales-visual-grid">
        <Panel title="销售走势" desc={chartMode==='qty'?"全部可见站点净销量，按天比较":"当前币种的销售额与投放成本；金额不完整的日期不连线"}>
          <div className="chart-mode" role="group" aria-label="趋势指标"><button aria-pressed={chartMode==='qty'} onClick={()=>setChartMode('qty')}>销售数量</button><button aria-pressed={chartMode==='money'} onClick={()=>setChartMode('money')}>销售额 / 投放</button><span>{report.filters.from} — {report.filters.to}</span></div>
          <SalesTrend rows={chartMode==='qty'?report.daily:daily} from={report.filters.from} to={report.filters.to} mode={chartMode} currency={selected}/>
        </Panel>
        <Panel title="站点与渠道销量" desc="按净销售件数比较；与当前销量总数使用同一范围"><RankingBars rows={channelVolumes} labelKey="label" valueKey="qty" color="mixed" limit={6}/></Panel>
      </div>
      <div className="sales-ranking-grid">
      <Panel title="全站SKU销量排名" desc={`所选范围销售总数量 ${number(report.totalQty)} 件；同一SKU合并所有站点、渠道及币种，按销量从高到低排列。运营账号仅显示所负责范围。`}>
        <RankingBars rows={report.skuRanking} valueKey="qty" onSelect={sku=>setSearch(search===sku?"":sku)}/>
        <details className="chart-details" open={search?true:undefined}><summary>查看完整销量排名与商品明细</summary>
        <label className="report-search">搜索SKU或商品<input type="search" placeholder="输入SKU或商品名称" value={search} onChange={e=>setSearch(e.target.value)}/></label>
        <ReportTable rows={rankings} columns={[{label:'排名',render:r=><span className={r.rank<=3?'rank-medal':''}>{r.rank}</span>},{label:'SKU / 商品',render:r=><><strong>{r.sku}</strong><small className="report-secondary">{r.name}</small></>},{label:'销售总数量',numeric:true,render:r=><strong>{number(r.qty)}</strong>},{label:'销量占比',numeric:true,render:r=>r.share==null?'—':`${number(r.share*100)}%`},{label:'覆盖站点',numeric:true,render:r=>number(r.siteCount)}]}/></details>
      </Panel>
      <Panel title={`SKU投产比排名 · ${selected==='UNKNOWN'?'历史未标币种':selected}`} desc="按同一SKU在所选范围的销售额合计 ÷ 投放成本合计排序；没有投放的SKU不显示无限大。">
        <RankingBars rows={roiRows.filter((r:Row)=>r.roas!==null)} valueKey="roas" unit="×" color="teal"/>
        <details className="chart-details"><summary>查看完整投产比与未排名商品</summary>
        <label className="report-toggle"><input type="checkbox" checked={showUnranked} onChange={e=>setShowUnranked(e.target.checked)}/>同时显示未填报和无投放SKU（不排名）</label>
        <ReportTable rows={roiRows} empty="暂无符合条件的SKU：请导入实际销售额及大于0的投放成本" columns={[{label:'排名',render:r=>r.rank??'—'},{label:'SKU',render:r=><strong>{r.sku}</strong>},...moneyColumns]}/></details>
      </Panel>
      </div>
      <details className="panel chart-details"><summary>每日销售明细 · {selected}</summary><ReportTable rows={daily} columns={[{label:`日期 · ${selected}`,render:r=>r.date},...moneyColumns]}/></details>
      <Panel title={`站点 / 渠道表现 · ${selected}`} desc="同币种比较，销售额完整的渠道进入图形；全部数据可展开核对。"><RankingBars rows={scopes.filter((r:Row)=>!r.revenueMissing).map((r:Row)=>({...r,label:`${r.site} · ${r.channel}`})).sort((a:Row,b:Row)=>(b.revenue||0)-(a.revenue||0))} labelKey="label" valueKey="revenue" unit={selected} color="mixed"/><details className="chart-details"><summary>查看渠道金额与费用明细</summary><ReportTable rows={scopes} columns={[{label:'站点 / 渠道',render:r=>`${r.site} · ${r.channel}`},...moneyColumns]}/></details></Panel>
      <p className="report-timestamp">最近成功汇总：{new Date(report.generatedAt).toLocaleString('zh-CN')} · 销量为净件数，ROAS不代表利润</p>
    </>}
  </section>;
}
