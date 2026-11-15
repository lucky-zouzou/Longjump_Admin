'use client';
import {useEffect,useState} from 'react';
import Icon from './workspace-icons';
import SkuLabel from './sku-label';
import {transportSteps} from '../lib/transport-workflow.mjs';
import './style-operations.css';

// The backend projects existing business records into this read-only view.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row=Record<string,any>;
type Go=(page:string,task?:Row)=>void;
type Entry=[page:string,label:string,view?:string];
const stages:{name:string;icon:string;entries:Entry[]}[]=[
 {name:'产品',icon:'master',entries:[['cost-profit','商品资料','information'],['cost-profit','商品成本与动销','products'],['new-products','新品孵化']]},
 {name:'制造与交付',icon:'fulfillment',entries:[['fulfillment','采购与生产'],['batches','海运批次'],['production-tracking','生产动态']]},
 {name:'渠道销售',icon:'sales',entries:[['sales','销售日报与看板'],['distribution','分销商家'],['creators','达人与直播 BD']]},
 {name:'服务与改进',icon:'quality-incidents',entries:[['quality-incidents','品质与售后'],['business-actions','经营行动与复查']]}
];
const num=(n:number|null)=>n==null?'待核实':n.toLocaleString('zh-CN',{maximumFractionDigits:2});
const money=(n:number|null,unit:string)=>n==null?'待核实':num(n)+' '+unit;
const stageName=(key:string)=>transportSteps.find(([k])=>k===key)?.[1]||key;
function useRead(url:string){
 const [answer,setAnswer]=useState<{url:string;data?:Row;error?:string}|null>(null);
 const [revision,setRevision]=useState(0);
 useEffect(()=>{
  const controller=new AbortController();
  fetch(url,{signal:controller.signal,cache:'no-store'}).then(async response=>{
   const data=await response.json();
   if(!response.ok)throw Error(data.error||'读取失败');
   if(!controller.signal.aborted)setAnswer({url,data});
  }).catch(e=>{if(!controller.signal.aborted)setAnswer({url,error:e.message});});
  return ()=>controller.abort();
 },[url,revision]);
 return {...(answer?.url===url?answer:{}),retry:()=>{setAnswer(null);setRevision(n=>n+1);}};
}
function Finance({series}:{series:string}){
 const {data,error,retry}=useRead('/api/style-operations?view=finance&series='+encodeURIComponent(series));
 if(!data)return <p role="status">{error||'正在核对财务账…'} {error&&<button onClick={retry}>重新读取</button>}</p>;
 return <div className="style-finance"><dl>
  <div><dt>本月已核贡献利润</dt><dd>{money(data.confirmedCny,'CNY')}</dd><small>{data.covered} 条已核 · {data.pending} 条待对账</small></div>
  <div><dt>印尼批发期末应收</dt><dd>{money(data.receivableIdr,'IDR')}</dd><small>截至 {data.asOf} 已实现销售与净回款之差，按单核算</small></div>
  <div><dt>印尼批发本月净回款</dt><dd>{money(data.netReceiptsIdr,'IDR')}</dd><small>{data.from} 至 {data.asOf} · 已核销收款扣除退款</small></div>
 </dl><small>应收与回款归入 {data.orders} 笔纯本系列订单，另有 {data.mixed} 笔混款订单待分摊。</small></div>;
}
function Sales({sites,offline}:{sites:Row[];offline:Row}){
 const period=(row:Row)=>row.qty===null?'待核实':num(row.qty)+' 件';
 const combined=(channels:Row[],field:string)=>{
  const periods=channels.map(c=>c[field]),covered=periods.reduce((s,p)=>s+p.completeDays,0);
  return <>{covered?(covered<periods[0].days*channels.length?'已核 ':'')+num(periods.reduce((s,p)=>s+(p.qty??0),0))+' 件':'待核实'}<small>{covered}/{periods[0].days*channels.length} 份完整日报</small></>;
 };
 return <><p>线上销量取截至各站当地昨日的 TikTok、Shopee 完整日报。可售库存已扣预留，货值取已确认的站点到仓成本。</p>
  <div className="table-wrap"><table><thead><tr><th>站点 / 截至</th><th>近7天销量</th><th>近28天销量</th><th>当前可售</th><th>海运在途</th><th>可售库存货值</th></tr></thead><tbody>
  {sites.map(s=><tr key={s.site}><th>{s.site}<small>{s.cutoff}</small></th><td>{combined(s.channels,'week')}</td><td>{combined(s.channels,'fourWeeks')}</td><td>{num(s.available)}{s.available!=null&&' 件'}{s.missingStock>0&&<small>{s.missingStock} 项库存待核</small>}</td><td>{num(s.transit)} 件</td><td>{money(s.inventoryValueCny,'CNY')}{(s.missingStock>0||s.missingCost>0)&&<small>已知部分 · {s.missingCost} 项缺完整成本</small>}</td></tr>)}
  </tbody></table></div><details><summary>按平台核对销量</summary><div className="table-wrap"><table><thead><tr><th>站点 / 平台</th><th>近7天已核销量</th><th>近28天已核销量</th></tr></thead><tbody>{sites.flatMap(s=>s.channels.map((c:Row)=><tr key={s.site+c.channel}><td>{s.site} · {c.channel}</td><td>{period(c.week)} · {c.week.completeDays}/7 天</td><td>{period(c.fourWeeks)} · {c.fourWeeks.completeDays}/28 天</td></tr>))}</tbody></table></div></details><p>印尼线下批发与分销 · 截至 {offline.cutoff}，近7天净售 {num(offline.week)} 件，近28天净售 {num(offline.fourWeeks)} 件。现销按发货，寄售按确认售出，均扣已登退货。</p></>;
}
function Dossier({go,allowed}:{go:Go;allowed:string[]}){
 const [series,setSeries]=useState(''),[tab,setTab]=useState(0),[finance,setFinance]=useState(false);
 const {data,error,retry}=useRead('/api/style-operations'+(series?'?series='+encodeURIComponent(series):''));
 const link=(page:string,label:string,task:Row)=>allowed.includes(page)?<button className="overview-link" onClick={()=>go(page,task)}>{label}</button>:label;
 if(!data)return <p role="status">{error||'正在读取款式档案…'} {error&&<button className="btn" onClick={retry}>重试</button>}</p>;
 if(!data.series)return <p>尚无已归类商品，请先在 SKU 供应参数中维护商品系列。</p>;
 return <div className="style-dossier">
  <div className="style-picker"><label>商品系列 <select value={data.series} onChange={e=>{setSeries(e.target.value);setFinance(false);}}>{data.options.map((o:Row)=><option key={o.name} value={o.name}>{o.name} · {o.qty} 个 SKU</option>)}</select></label><button className="overview-link" onClick={()=>{setFinance(false);retry();}}>刷新档案</button></div>
  <nav className="style-tabs" aria-label="款式经营环节">{stages.map((s,i)=><button key={s.name} aria-pressed={tab===i} onClick={()=>setTab(i)}>{s.name}</button>)}</nav>
  {tab===0&&<div className="table-wrap"><table><thead><tr><th>SKU / 商品</th><th>当前资料版本</th><th>材质 / 装箱</th><th>工厂</th></tr></thead><tbody>{data.profiles.map((p:Row)=><tr key={p.sku}><td><SkuLabel sku={p.sku}/><small>{p.name}</small></td><td>{link('cost-profit',p.version?'V'+p.version:'待补资料',{view:'information',entity:p.sku})}<small>{p.actor_name||''}{p.missing>0?' · '+p.missing+' 项待补':''}</small></td><td>{p.material||'待补材质'}<small>{p.cartonQty?p.cartonQty+' 件/箱':'装箱数待补'}</small></td><td>{p.factory_name||'待登记'}</td></tr>)}</tbody></table></div>}
  {tab===1&&<><h3>生产进度</h3>{data.production.length?<div className="table-wrap"><table><thead><tr><th>生产工厂</th><th>当前节点</th><th>本系列计划 / 完工</th><th>承诺交期</th></tr></thead><tbody>{data.production.map((p:Row)=><tr key={p.id}><td>{p.factory_name||'待登记'}</td><td>{p.stageLabel}</td><td>{num(p.planned)} / {num(p.produced)} 件</td><td>{p.promised_completion_date||'待确认'}</td></tr>)}</tbody></table></div>:<p>尚无关联生产单。</p>}</>}
  {tab===1&&data.manufacturing&&<><h3>关联采购单</h3>{data.purchases.length?<div className="table-wrap"><table><thead><tr><th>采购单</th><th>供应商 / 生产负责人</th><th>本系列件数</th><th>承诺交期 / 质检</th></tr></thead><tbody>{data.purchases.map((p:Row)=><tr key={p.id}><td>{link('fulfillment',p.order_ref||p.id,{entity:p.id,month:p.month})}</td><td>{p.supplier_name||'待登记'}<small>{p.owner||'待分配'}</small></td><td>{num(p.qty)}</td><td>{p.promised_completion_date||'待确认'}<small>{p.qc_status==='passed'?'质检通过':p.qc_status==='rejected'?'质检未通过':'待质检'}</small></td></tr>)}</tbody></table></div>:<p>尚无关联采购单。</p>}
  <h3>发货通知与装箱</h3>{data.notices.length?<div className="table-wrap"><table><thead><tr><th>发货通知 / SKU</th><th>目的地 / 件数</th><th>发单时资料版本</th><th>装箱单 / 主批次</th><th>供应链跟进</th></tr></thead><tbody>{data.notices.map((n:Row,i:number)=><tr key={n.notice_no+i}><td>{link('fulfillment',n.notice_no,{entity:n.purchase_order_id})}<small><SkuLabel sku={n.sku}/></small></td><td>{n.site} · {n.channel}<small>{n.qty} 件 · {n.status==='cancelled'?'已取消':n.approval_status==='pending'?'待审核':'已登记'}</small></td><td>{n.profileVersion?'V'+n.profileVersion:'当时未登记'}</td><td>{n.packing_no||'待装箱'}<small>{n.batch_no||'待关联海运'}</small></td><td>{n.owner||'待分配'}</td></tr>)}</tbody></table></div>:<p>尚无本系列的发货通知。</p>}
  <h3>目的地运输分批</h3>{data.legs.length?<div className="table-wrap"><table><thead><tr><th>运输分批</th><th>目的地</th><th>节点 / 负责人</th><th>发运 / 实收</th><th>预计到仓</th></tr></thead><tbody>{data.legs.map((r:Row)=><tr key={r.id}><td>{link('batches',r.leg_no,{entity:r.id})}</td><td>{r.site} · {r.channel}</td><td>{stageName(r.stage)}<small>{r.owner||r.stage_owner}</small></td><td>{r.qty} / {r.received} 件</td><td>{r.eta||'待补'}</td></tr>)}</tbody></table></div>:<p>尚无关联目的地分批。</p>}</>}
  {tab===2&&<Sales sites={data.sites} offline={data.offline}/>}
  {tab===3&&<><h3>近28天品质原因</h3>{data.ranking.length?<ol className="style-causes">{data.ranking.map((r:Row)=><li key={r.reason}>{r.reason} · {r.qty} 件 / {r.count} 条</li>)}</ol>:<p>这段时间没有已提交的品质反馈。</p>}
  {data.cases.length>0&&<div className="table-wrap"><table><thead><tr><th>反馈单 / SKU</th><th>原因 / 责任</th><th>跟进人 / 复查批次</th><th>工厂应赔 / 已登记赔付</th></tr></thead><tbody>{data.cases.map((r:Row)=><tr key={r.id}><td>{link('quality-incidents',r.case_no,{entity:r.id,month:r.business_date.slice(0,7)})}<small><SkuLabel sku={r.sku}/> · {r.site}</small></td><td>{r.reason}<small>{r.factory||''} · {r.responsibility||'待定责'}</small></td><td>{r.owner||'待分配'}<small>{r.validationBatch||'复查批次待补'}{r.reviewDate&&' · '+r.reviewDate}{r.outcome==='failed'?' · 复查未通过':r.outcome==='effective'?' · 复查通过':''}</small></td><td>{r.claim==null?'待核定':money(r.claim/100,r.currency)} / {r.paid==null?'—':money(r.paid/100,r.currency)}</td></tr>)}</tbody></table></div>}</>}
  <div className="style-books"><button className="overview-link" aria-expanded={finance} onClick={()=>setFinance(!finance)}>{finance?'收起财务核算':'查看本系列贡献、应收与回款'}<Icon name="chevron"/></button>{finance&&<Finance key={data.series} series={data.series}/>}</div>
 </div>;
}
export default function StyleOperations({role,allowed,go}:{role:string;allowed:string[];go:Go}){
 const [open,setOpen]=useState(false);
 const manager=['管理员','财务'].includes(role);
 return <section className="overview-card style-operations"><header><div><h2>全链路经营</h2><p>从商品资料到售后复查，按业务环节进入工作。</p></div>{manager&&<button className="overview-link" aria-expanded={open} onClick={()=>setOpen(!open)}>{open?'收起款式档案':'按款式查看'}<Icon name="chevron"/></button>}</header>
 <div className="style-stages">{stages.map(s=>{
  const entries=s.entries.filter(([page,,view])=>allowed.includes(page)&&(view!=='information'||['管理员','财务','供应链'].includes(role))&&(view!=='products'||role!=='供应链'));
  if(!entries.length)return null;
  return <div key={s.name}><h3><Icon name={s.icon}/>{s.name}</h3>{entries.map(([page,label,view])=><button key={page+view} onClick={()=>go(page,{view})}>{label}</button>)}</div>;
 })}</div>
 {manager&&open&&<Dossier allowed={allowed} go={go}/>}</section>;
}
