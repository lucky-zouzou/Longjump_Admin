"use client";
import Icon from './workspace-icons';
type Row=Record<string,any>;
const num=(n:number)=>Number(n).toLocaleString('zh-CN',{maximumFractionDigits:2});
export default function ZeroSalesNotifications({tasks,actor,go}:{tasks:Row[];actor:Row;go:(tab:string,task?:Row)=>void}){
 if(!['管理员','运营主管','财务','运营'].includes(actor.role))return null;
 const alerts=tasks.filter(t=>t.kind==='zero-sales-alert');
 const total=alerts.reduce((n,t)=>n+t.alert.confirmed,0),pending=alerts.reduce((n,t)=>n+t.alert.verify+t.alert.pending,0);
 return <section className="overview-card zero-notices" aria-label="每日零动销预警">
  <header><div><h2><Icon name="promotions"/>每日零动销预警 <span className="zero-notice-daily">滚动 30 天</span></h2><p>{actor.role==='运营'?`${actor.site} · ${actor.channel} · 您负责的商品`:'五站汇总 · 管理、财务与运营共同跟进'} · 按当地昨日截止</p></div><button className="overview-link" onClick={()=>go('clearance')}>进入月度清仓<Icon name="arrow"/></button></header>
  {alerts.length?<>
   <div className="zero-notice-summary"><strong>{num(total)}<span>个已确认零动销 SKU</span></strong><strong>{num(pending)}<span>个待核实 SKU</span></strong><small>同站 SKU 按最高提醒级别计一次；不同站点分别统计。部分平台零销量单独标明。</small></div>
   <div className={`zero-notice-grid${alerts.length===1?' single':''}`}>{alerts.map(t=>{const a=t.alert;return <article key={t.id} className={a.confirmed?'confirmed':'pending'}>
    <div className="zero-notice-site"><h3>{a.site}</h3><span>{a.channel||'TikTok + Shopee'}</span></div>
    <p className="zero-notice-window">{a.start} — {a.cutoff}</p>
    <dl><div><dt>已确认零动销</dt><dd>{num(a.confirmed)}</dd></div><div><dt>连续有货待核实</dt><dd>{num(a.verify)}</dd></div><div><dt>日报 / 库存待核实</dt><dd>{num(a.pending)}</dd></div></dl>
    <div className="zero-notice-stock"><span>{a.unknownStocks?'已知待跟进库存':'待跟进库存'} <b>{num(a.available)} 件</b></span><span>已知成本货值 <b>{a.missingCosts===a.total?'待补成本':'¥'+num(a.knownValueCny)}</b></span><small>含待核实商品，仅汇总需跟进平台{a.unknownStocks?` · ${a.unknownStocks} 个库存待核实`:''}{a.missingCosts?` · ${a.missingCosts} 个缺成本`:''}{a.partialCosts?` · ${a.partialCosts} 个费用范围待核实`:''}</small></div>
    <p className="zero-notice-next">{a.next}</p><button className="zero-notice-open" onClick={()=>go(t.tab,t)}>查看 {num(a.total)} 个 SKU 与处理入口 <Icon name="arrow"/></button><small className="zero-notice-following">{a.following} 个 SKU 已有跟进记录</small>
   </article>;})}</div>
  </>:<div className="zero-notice-empty">当前没有符合条件的零动销提醒。可进入商品池查看销售、库存及数据完整性。</div>}
  <p className="zero-notice-note">每日滚动统计，页面停留时及返回后台自动更新。同一问题持续跟进，恢复销量或可售库存归零后移出；新品上架未满30天单列观察，不纳入零动销预警；缺报不当作零销量。</p>
 </section>;
}
