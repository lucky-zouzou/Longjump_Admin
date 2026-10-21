"use client";
type Row=Record<string,any>;
const n=(v:number)=>v.toLocaleString('zh-CN');
const zero=(r:Row)=>r.assessed?n(r.zero):r.stocked?'—':'0';
const units=(r:Row)=>r.assessed?n(r.zeroUnits):r.stocked?'—':'0';
export default function ZeroSalesDashboard({dashboard,onDrill}:{dashboard:Row;onDrill:(site:string,channel:string,filter:string,query?:string)=>void}){
 const t=dashboard.total;
 return <div className="zero-dashboard">
  <div className="promo-kpis zero-kpis">
   <button className="zero-kpi" onClick={()=>onDrill('','','reported_zero')}><span>近7天日报零销量</span><strong>{zero(t)}<em> 条</em></strong><small>涉及 {n(t.uniqueSkus)} 个去重 SKU · {n(t.assessed)} 条资料完整</small></button>
   <button className="zero-kpi" onClick={()=>onDrill('','','reported_zero')}><span>对应可售库存</span><strong>{t.assessed?n(t.zeroUnits):t.stocked?'—':'0'}<em> 件</em></strong><small>已扣预留 · 不含待上架及隔离</small></button>
   <button className="zero-kpi" onClick={()=>onDrill('','','open')}><span>已确认连续在售预警</span><strong>{n(t.confirmed)}<em> 条</em></strong><small>日报完整且连续在售有货 ≥7天</small></button>
   <button className="zero-kpi zero-kpi-warning" onClick={()=>onDrill('','','missing')}><span>日报待补齐</span><strong>{n(t.missing)}<em> 条</em></strong><small>另有 {n(t.availability)} 条零销量待核实在售</small></button>
  </div>
  <section className="panel zero-site-panel"><div className="zero-section-heading"><div><h3>站点总览</h3><p>比较积压商品与库存规模，点击站点查看明细</p></div><span className="pill">{dashboard.sites.length}站 · {dashboard.channels.length}个渠道</span></div>
   <div className="zero-sites">{dashboard.sites.map((s:Row)=><button key={s.site} className="zero-site" onClick={()=>onDrill(s.site,'','reported_zero')} aria-label={`查看${s.site}零销量明细`}><span className="zero-site-name">{s.site}<span>查看明细 ↗</span></span><strong>{zero(s)}<em> 条零销量</em></strong><span>可售库存 <b>{units(s)}</b> 件</span><div className="zero-bar" aria-hidden="true"><i style={{width:`${(s.zeroRate||0)*100}%`}}/></div><small>{s.zeroRate==null?'暂无完整日报可判断':`占已报齐商品 ${(s.zeroRate*100).toFixed(1)}%`}</small><div className="zero-site-footer"><span>已确认 {n(s.confirmed)}</span><span className={s.missing?'zero-warning':''}>待补报 {n(s.missing)}</span></div></button>)}</div>
   <p className="promo-help">“条”按站点＋渠道＋SKU计数；同款跨站、跨渠道分别统计。去重 SKU 数单独显示。仅完整日报认定零销量，资料不足时显示“—”；部分渠道报齐时，数字仅代表已核实部分。</p>
  </section>
  <section className="panel"><div className="zero-section-heading"><div><h3>五站 × 渠道对比</h3><p>零销量数量、可售库存和日报完整度一起看</p></div></div>
   <div className="zero-matrix" role="table" aria-label="站点渠道零销量对比"><div className="zero-matrix-head" role="row"><span role="columnheader">站点 / 统计区间</span><span role="columnheader">TikTok</span><span role="columnheader">Shopee</span></div>
    {dashboard.sites.map((s:Row)=><div className="zero-matrix-row" role="row" key={s.site}><div className="zero-matrix-site" role="rowheader"><b>{s.site}</b><small>{s.channels[0].start} — {s.channels[0].cutoff}</small><small>当地时间 UTC+{['马来西亚','菲律宾'].includes(s.site)?8:7}</small></div>{['TikTok','Shopee'].map(channel=>{const c=s.channels.find((x:Row)=>x.channel===channel);return c?<div className="zero-channel" role="cell" key={channel}><span className="zero-mobile-channel">{channel}</span><button className="zero-channel-main" onClick={()=>onDrill(s.site,channel,'reported_zero')} aria-label={`查看${s.site}${channel}零销量明细`}><strong>{zero(c)}<em> 条零销量</em></strong><span>{units(c)} 件库存 <span aria-hidden="true">→</span></span></button><button className={`zero-report ${c.coverage<7?'zero-warning':''}`} onClick={()=>onDrill(s.site,channel,c.coverage<7?'missing':'all')} aria-label={`查看${s.site}${channel}日报覆盖情况`}>完整日报 {c.coverage}/7 天{c.missingDates.length>0?' · 待补齐':' · 已报齐'}</button><small>负责运营：{c.owners.join('、')||'尚未绑定'}</small>{c.missingDates.length>0&&<small>缺报：{c.missingDates.map((d:string)=>d.slice(5)).join('、')}</small>}</div>:<div className="zero-channel" role="cell" key={channel}>不在本账号范围</div>})}</div>)}
   </div>
  </section>
  <div className="zero-bottom"><section className="panel"><div className="zero-section-heading"><div><h3>优先处理 · 库存最多的10条</h3><p>仅列日报完整的零销量商品，按可售件数排序</p></div></div>{dashboard.top.length?<ol className="zero-ranking">{dashboard.top.map((r:Row,i:number)=><li key={`${r.site}|${r.channel}|${r.sku}`}><span className="zero-rank">{i+1}</span><button onClick={()=>onDrill(r.site,r.channel,'reported_zero',r.sku)}><b>{r.sku}</b><small>{r.site} · {r.channel} · {r.owners.join('、')||'未绑定运营'}</small></button><strong>{n(r.available)}<small>件</small></strong></li>)}</ol>:<div className="zero-empty">{t.missing?'日报尚未补齐，暂不生成零销量库存排行。':'暂无日报完整的零销量商品。'}</div>}</section>
   <section className="panel"><div className="zero-section-heading"><div><h3>连续零销量分层</h3><p>已确认持续在售有货，最长观察30天</p></div></div><div className="zero-tiers">{t.tiers.map((r:Row)=><div key={r.label}><span>{r.label}</span><strong>{n(r.count)}<em> 条</em></strong><div className="zero-bar"><i style={{width:`${t.confirmed?r.count/t.confirmed*100:0}%`}}/></div></div>)}</div><button className="btn" onClick={()=>onDrill('','','open')}>查看已确认预警 →</button><div className="zero-next"><b>管理跟进顺序</b><p>先补日报 → 核实连续在售 → 确认去化措施 → 跟踪销量改善</p><p>优惠审批目前适用于印尼。其余站点可核验在售情况并记录优化措施。</p></div></section></div>
 </div>;
}
