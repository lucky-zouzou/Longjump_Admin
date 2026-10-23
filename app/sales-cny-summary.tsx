"use client";
type R=Record<string,any>;
const n=(value:any)=>value==null?'未填报':Number(value).toLocaleString('zh-CN',{maximumFractionDigits:2});
function Original({rows,field}:{rows:R[];field:string}){
 const sums=new Map<string,{amount:number|null;missing:boolean}>();
 for(const row of rows){const old=sums.get(row.currency)||{amount:null,missing:false};if(row[field]!=null)old.amount=(old.amount??0)+row[field];old.missing ||= Boolean(row[field==='revenue'?'revenueMissing':'costMissing']);sums.set(row.currency,old);}
 return <>{[...sums].map(([currency,value])=><div key={currency}>{n(value.amount)} {currency==='UNKNOWN'?'币种未标':currency}{value.missing&&<small className="report-missing">部分未填报</small>}</div>)}{!rows.length&&'暂无数据'}</>;
}
export default function SalesCnySummary({report}:{report:R}){
 const c=report.cny;if(!c)return null;const {fx,total,sites}=c;
 const amountLabel=(complete:boolean)=>complete?'参考汇率折算':'仅已知部分 · 未齐全';
 const cards=[['人民币销售额合计',n(total.revenueCny)+' CNY',amountLabel(total.revenueComplete)],['销售总数量',n(report.totalQty)+' 件','当前日期、站点和渠道 · 全币种'],['产生销量的 SKU',n(report.skuCount),'同一 SKU 跨站点合并去重'],['人民币广告费合计',n(total.adCostCny)+' CNY',amountLabel(total.costComplete)],['整体投产比',total.roas==null?total.revenueComplete&&total.costComplete&&total.adCostCny===0?'无投放':'资料不完整':n(total.roas)+'×','人民币销售额 ÷ 人民币广告费'],['整体成交均价',total.averagePrice==null?'资料不完整':n(total.averagePrice)+' CNY','人民币销售额 ÷ 同范围销售件数']];
 return <section className="cny-summary" aria-label="人民币经营汇总">
  <div className="panel-head"><div><h3>人民币经营汇总</h3><p>{report.filters.from} — {report.filters.to} · {report.filters.site||'全部可见站点'} · {report.filters.channel||'全部渠道'}</p></div><span className="pill blue">原始金额保留</span></div>
  <div className="report-metrics cny-metrics">{cards.map(([label,value,note])=><div className="metric" key={label}><div className="label">{label}</div><div className="value">{value}</div><div className="foot">{note}</div></div>)}</div>
  <div className={`notice ${fx.status==='fresh'&&!fx.refreshFailed?'info':'warn'}`} role="status">
   {fx.effectiveAt?<>汇率更新时间：{new Date(fx.effectiveAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})}（北京时间）。{fx.status==='stale'?'当前使用旧汇率，折算结果仅供参考。':''}{fx.refreshFailed?'本次更新未成功，正在使用最近有效快照。':''}</>:<>汇率暂不可用，外币金额尚未折算；已标记的人民币金额仍保留。请稍后刷新。</>}
   <span> 按最新可用参考汇率估算，历史期间也使用此汇率；不作为交易日汇率或财务结算金额。</span> <a href="https://www.exchangerate-api.com" target="_blank" rel="noreferrer">Rates By Exchange Rate API</a>
  </div>
  {(!total.revenueComplete||!total.costComplete)&&<p className="notice warn">{total.revenueMissing>0?`${n(total.revenueMissing)} 条记录未填销售额；`:''}{total.costMissing>0?`${n(total.costMissing)} 条记录未填广告费；`:''}{total.unconverted>0?`${n(total.unconverted)} 个站点／渠道／币种组合缺少可用汇率；`:''}不完整金额只展示已知部分，整体投产比暂不计算。没有销售记录也不代表零销售。</p>}
  <section className="panel"><div className="panel-head"><div><h4>站点原币与人民币对照</h4><p>原币按币种分别列示；人民币合计由当前范围逐项折算后相加。</p></div></div>
   <div className="table-wrap"><table><thead><tr><th>站点</th><th className="num">销量</th><th className="num">原币销售额</th><th className="num">折合人民币</th><th className="num">原币广告费</th><th className="num">折合人民币</th></tr></thead><tbody>{sites.map((s:R)=><tr key={s.site}><td><strong>{s.site}</strong></td><td className="num">{s.rows.length?n(s.qty):'暂无记录'}</td><td className="num"><Original rows={s.rows} field="revenue"/></td><td className="num">{n(s.revenueCny)}{s.rows.length>0&&!s.revenueComplete&&<small className="report-missing">部分数据</small>}</td><td className="num"><Original rows={s.rows} field="adCost"/></td><td className="num">{n(s.adCostCny)}{s.rows.length>0&&!s.costComplete&&<small className="report-missing">部分数据</small>}</td></tr>)}</tbody></table></div>
   <details className="chart-details"><summary>查看折算汇率与统计口径</summary><p>{c.method}</p><div className="table-wrap"><table><thead><tr><th>原币</th><th>1 原币折合人民币</th></tr></thead><tbody>{report.currencies.map((r:R)=><tr key={r.currency}><td>{r.currency==='UNKNOWN'?'币种未标':r.currency}</td><td>{fx.rates[r.currency]?(1/fx.rates[r.currency]).toLocaleString('zh-CN',{maximumFractionDigits:8})+' CNY':'暂不折算'}</td></tr>)}</tbody></table></div></details>
  </section>
 </section>;
}
