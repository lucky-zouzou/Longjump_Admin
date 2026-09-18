"use client";
import SalesDashboard from "./sales-dashboard";
import {SITE_CURRENCIES,SALES_CURRENCIES} from "../lib/sales-data.mjs";

import TableImport from "./table-import";
import {matchImportItems,groupInboundRows} from "../lib/tabular-import.mjs";
import ForecastSettings from "./forecast-settings";
import PlanChanges,{SupplyPicker,PurchaseReassign} from "./plan-changes";
import Wholesale from "./wholesale";
import UserManagement,{type ManagedUser} from "./user-management";
import { WholesaleLanguageContext,useWholesalePreference } from "./wholesale-language";
import { translateWholesale } from "../lib/wholesale-i18n.mjs";
import { useCallback, useEffect, useState } from "react";
import { dataDomainsForRole, DATA_DOMAIN_LABELS, hasPermission, navigationForRole, PERMISSION_LABELS, permissionsForRole, ROLE_PERMISSIONS } from "../lib/permissions.mjs";

const SITES = ["马来西亚", "印尼", "泰国", "越南", "菲律宾"];
const CHANNELS = ["TikTok", "Shopee", "线下分销"];
const REQUIRED_CHANNELS = ["TikTok", "Shopee"];
const ROLE_LABEL:Record<string,string> = { 管理员:"全局管理", 销售:"印尼线下销售", 运营:"站点运营", 运营主管:"运营统筹", 新品开发:"新品开发", 财务:"财务测算", 供应链:"供应链协同", 工厂:"工厂生产", 海运:"跨境物流" };
const BATCH_LABEL:Record<string,string> = {
  supply_confirm:"供应链确认", factory_production:"工厂生产", channel_allocation:"渠道分配",
  sea_freight:"海运运输", port_arrived:"已到港", last_mile_delivery:"派送中",
  booking:"订舱", awaiting_order:"待下单", awaiting_factory:"待工厂接单", in_production:"生产中", customs_clearance:"清关中",
  awaiting_receipt:"等待到仓", shelf_pending:"待上架", on_shelf:"已上架",
  arrived:"已到仓（历史）", completed:"已完成",
};
const BATCH_STEPS=[
  ["supply_confirm","备货"],["factory_production","生产"],["channel_allocation","分配"],
  ["sea_freight","海运"],["port_arrived","到港"],["last_mile_delivery","派送"],
  ["awaiting_receipt","到仓"],["shelf_pending","上架确认"],["on_shelf","已上架"],
];
const MOVEMENT_TONE:Record<string,string> = { "到仓入库":"green", "销售出库":"blue", "盘点调整":"amber" };
const ALERT_TONE:Record<string,string> = { critical:"red", data:"amber", eta:"amber", warning:"amber", watch:"blue", healthy:"green" };
const NEW_PRODUCT_STAGE:Record<string,string> = { selection:"选款立项", parallel_test:"调研与种草", finance:"财务测算", sample:"打板确认", production:"首批生产", abandoned:"已放弃" };

type Identity = { userId:string; displayName:string; email:string; fullName:string|null };
// Snapshot rows come from several server-side tables and contain different fields.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string,any>;
type Snapshot = {
  actor:Row; currentMonth:string; metrics:Row; inventory:Row[]; movements:Row[]; sales:Row[]; imports:Row[];
  supplyPolicies:Row[]; forecastHistory:Row[]; planChanges:Row[]; receipts:Row[]; submissions:Row[]; approvals:Row[]; batches:Row[]; skuSettings:Row[]; audit:Row[];
  users:ManagedUser[]; suggestions:Row[]; monthlyStatus:Row[]; issues:Row[]; newProductProjects:Row[];
  salesScopeStatus:Row[]; salesTopSkus:Row[]; purchaseOrders:Row[]; productionOrders:Row[];
  shipmentBatches:Row[]; shipmentReceipts:Row[];
  transportBatches:Row[]; transportReceipts:Row[]; businessPartners:Row[]; warehouses:Row[]; countRequests:Row[]; myTasks:Row[];
};
type PlanDraft = { sku:string; name:string; qty:string; reason:string };
type AllocationDraft = { site:string; channel:string; qty:string };
type Act = (action:string,payload:Row,success:string)=>Promise<Row|null>;

const navItems = [
  ["overview","总览","◫"], ["users","用户管理","♙"], ["wholesale","印尼线下批发","▣"], ["suggestions","补货驾驶舱","◎"], ["new-products","新品孵化","◇"], ["sales","销售数据","↗"], ["inventory","库存流水","▦"],
  ["receipt","历史到仓","↓"], ["monthly","月度计划","▤"], ["approval","审批中心","✓"], ["fulfillment","系列采购生产","▥"], ["batches","海运批次","⇢"],
  ["master","主数据","⌘"], ["audit","审计日志","◷"], ["permissions","权限测试","⊙"],
];
const fmt = (value:unknown) => Number(value || 0).toLocaleString("zh-CN");
const pct = (value:unknown) => `${(Number(value || 0) * 100).toFixed(0)}%`;
const days = (value:unknown) => value===null||value===undefined ? "—" : `${Number(value).toFixed(1)}天`;
const localDate = () => new Date(Date.now()+8*3600_000).toISOString().slice(0,10);
const readableDate = (value:unknown) => {
  if(!value)return "—";
  const parsed=new Date(String(value));
  return Number.isNaN(parsed.valueOf())?String(value):new Intl.DateTimeFormat("zh-CN",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hour12:false}).format(parsed);
};
const classNames = (...values:Array<string|false|undefined>) => values.filter(Boolean).join(" ");
const permissionLabel = (key:string) => (PERMISSION_LABELS as Readonly<Record<string,string>>)[key]||key;
const isKnownRole = (role:string) => Object.prototype.hasOwnProperty.call(ROLE_PERMISSIONS,role);

async function parseResponse(response:Response) {
  const result = await response.json().catch(() => ({ error:"服务器返回了无法识别的结果" }));
  if (!response.ok) throw new Error(result.error || "操作失败");
  return result;
}

export default function ControlTower({ identity }: { identity:Identity }) {
  const wholesaleLocale=useWholesalePreference(identity.userId);
  const [selectedTab,setTab] = useState("overview");
  const [data,setData] = useState<Snapshot|null>(null);
  const [loading,setLoading] = useState(true);
  const [busy,setBusy] = useState(false);
  const [toast,setToast] = useState("");
  const [showWelcome,setShowWelcome] = useState(true);
  const [welcomeLeaving,setWelcomeLeaving] = useState(false);

  const refresh = useCallback(async () => {
    const response = await fetch("/api/system", { cache:"no-store" });
    const result = await parseResponse(response);
    setData(result);
  },[]);

  useEffect(() => {
    let active=true;
    fetch("/api/system",{cache:"no-store"})
      .then(parseResponse)
      .then(result=>{if(active)setData(result);})
      .catch(error=>{if(active)setToast(error.message);})
      .finally(()=>{if(active)setLoading(false);});
    return ()=>{active=false;};
  },[]);

  useEffect(()=>{const timer=window.setInterval(()=>{if(document.visibilityState==="visible")void refresh().catch(()=>{});},30000);return ()=>window.clearInterval(timer);},[refresh]);

  const act = useCallback(async (action:string,payload:Row,success:string) => {
    setBusy(true);
    try {
      const response = await fetch("/api/system", { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({action,...payload}) });
      const result = await parseResponse(response);
      setToast(success);
      await refresh();
      return result;
    } catch (error) {
      setToast(error instanceof Error ? error.message : "操作失败");
      return null;
    } finally { setBusy(false); }
  },[refresh]);

  const exportBackup = useCallback(async () => {
    try {
      const response = await fetch("/api/backup", {cache:"no-store"});
      const blob = await response.blob();
      if(!response.ok) {
        const result = JSON.parse(await blob.text());
        throw new Error(result.error || "备份导出失败");
      }
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href=url;
      anchor.download=`LOONG-JUMP-全量备份-${localDate()}.tar`;
      anchor.click();
      URL.revokeObjectURL(url);
      setToast("数据库和凭证原文件完整备份已导出");
    } catch(error) {
      setToast(error instanceof Error?error.message:"备份导出失败");
    }
  },[]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""),4200);
    return () => clearTimeout(timer);
  },[toast]);

  useEffect(() => {
    const startLeaving = window.setTimeout(() => setWelcomeLeaving(true),2800);
    const finish = window.setTimeout(() => setShowWelcome(false),3350);
    return () => { window.clearTimeout(startLeaving); window.clearTimeout(finish); };
  },[]);

  const enterSystem = () => {
    setWelcomeLeaving(true);
    window.setTimeout(() => setShowWelcome(false),520);
  };

  if (showWelcome) return <BrandWelcome leaving={welcomeLeaving} ready={!loading && Boolean(data)} onEnter={enterSystem}/>;
  if (loading) return <div className="empty" style={{paddingTop:160}}>正在连接供应链数据库…</div>;
  if (!data) return <div className="empty" style={{paddingTop:160}}>系统暂时无法读取数据，请刷新页面重试。</div>;
  const actor=data.actor;
  const roleNav=navigationForRole(actor.role).filter(key=>key!=="wholesale"||actor.role!=="运营"||actor.site==="印尼");
  const tab=roleNav.includes(selectedTab)?selectedTab:roleNav[0];
  const visibleNav = navItems.filter(([key]) => roleNav.includes(key));
  const taskCount=(key:string)=>key==="overview"?data.myTasks.length:data.myTasks.filter(task=>task.tab===key).length;
  const taskBadge=(key:string)=>taskCount(key)>0?<span className="nav-task-count" aria-label={`${taskCount(key)}项待办`}>{taskCount(key)>99?"99+":taskCount(key)}</span>:null;
  const shellT=(key:string)=>translateWholesale(tab==="wholesale"?wholesaleLocale.language:"zh",key);

  return <div className="app-shell" lang={tab==="wholesale"&&wholesaleLocale.language==="id"?"id":"zh-CN"}>
    <aside className="sidebar">
      <div className="brand"><img className="brand-logo" src="/loong-jump-logo-white.png" alt="LOONG JUMP"/><p>{shellT("品牌出海供应链控制塔")}</p></div>
      <nav className="nav" aria-label={shellT("系统导航")}>
        {visibleNav.map(([key,label,icon]) => <button key={key} className={classNames("nav-button",tab===key&&"active")} onClick={()=>setTab(key)}>
          <span className="nav-icon">{icon}</span><span>{shellT(key==="sales"?(actor.role==="运营"?"每日销售导入":"销售看板"):label)}</span>{taskBadge(key)}
        </button>)}
      </nav>
      <div className="account">
        <strong>{actor.name} · {shellT(actor.role)}</strong>
        <span>{actor.site ? `${shellT(actor.site)} / ${actor.channel||""}` : shellT(ROLE_LABEL[actor.role])}</span>
        <span>{identity.email}</span>
        {identity.userId!=="local-admin" && <a href="/signout-with-chatgpt?return_to=%2F" style={{display:"inline-block",color:"#aeb8ca",fontSize:10,marginTop:9}}>{shellT("退出登录")}</a>}
      </div>
    </aside>
    <main className="main">
      <header className="topbar">
        <div><h2>{shellT("全链路可视化协同")}</h2><p>{shellT("SKU需求 → 系列采购 → 系列生产 → 海运批次 → 到仓上架")}</p></div>
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          {hasPermission(actor.role,"backup.export")&&<button className="btn" onClick={exportBackup}>{shellT("导出备份")}</button>}
          <span className="status-pill">{shellT("● 数据库已连接")}</span>
        </div>
      </header>
      <div className="content">
        {actor.role==="运营" && (!actor.site || !actor.channel) && <div className="notice warn">当前账号尚未绑定站点和渠道，请联系管理员在“用户管理”中完成分配后再录入业务数据。</div>}
        {tab==="wholesale" && <WholesaleLanguageContext.Provider value={wholesaleLocale}><Wholesale onChanged={refresh}/></WholesaleLanguageContext.Provider>}
        {tab==="overview" && <Overview data={data} go={setTab}/>}
        {tab==="suggestions" && <Suggestions data={data} act={act} busy={busy}/>}
        {tab==="new-products" && <NewProducts data={data} act={act} busy={busy}/>}
        {tab==="sales" && <SalesImport data={data} act={act} busy={busy}/>}
        {tab==="inventory" && <Inventory data={data} act={act} busy={busy}/>}
        {tab==="receipt" && <Receipt data={data} act={act} busy={busy}/>}
        {tab==="monthly" && <Monthly data={data} act={act} busy={busy}/>}
        {tab==="approval" && <Approvals data={data} act={act} busy={busy} goWholesale={()=>setTab("wholesale")}/>}
        {tab==="fulfillment" && <Fulfillment data={data} act={act} busy={busy}/>}
        {tab==="batches" && <Batches data={data} act={act} busy={busy}/>}
        {tab==="master" && <MasterData data={data} act={act} busy={busy}/>}
        {tab==="audit" && <Audit data={data}/>}
        {tab==="users" && <UserManagement users={data.users} actorId={actor.id} act={act} busy={busy} onCreated={refresh}/>}
        {tab==="permissions" && <PermissionTest data={data}/>}
      </div>
    </main>
    <nav className="mobile-nav" aria-label={shellT("移动端导航")}>
      {visibleNav.map(([key,label,icon]) => <button key={key} className={classNames("nav-button",tab===key&&"active")} onClick={()=>setTab(key)}><span>{icon}</span><span>{shellT(key==="sales"?(actor.role==="运营"?"销售导入":"销售看板"):label)}</span>{taskBadge(key)}</button>)}
    </nav>
    {toast && <div className="toast">{shellT(toast)}</div>}
  </div>;
}

function BrandWelcome({leaving,ready,onEnter}:{leaving:boolean;ready:boolean;onEnter:()=>void}) {
  return <section className={classNames("welcome-screen",leaving&&"leaving")} aria-labelledby="welcome-title">
    <div className="welcome-orbit orbit-one" aria-hidden="true"/>
    <div className="welcome-orbit orbit-two" aria-hidden="true"/>
    <div className="welcome-stars" aria-hidden="true"/>
    <div className="welcome-card">
      <div className="welcome-brand"><img className="welcome-logo" src="/loong-jump-logo-white.png" alt="LOONG JUMP"/></div>
      <div className="welcome-rule"><i/><span>致敬</span><i/></div>
      <h1 id="welcome-title">每一位奋斗者！</h1>
      <p>以热爱奔赴山海，以行动抵达远方。<br/>让每一次努力，都被世界看见。</p>
      <button className="welcome-enter" onClick={onEnter}>进入品牌出海供应链控制塔 <span aria-hidden="true">→</span></button>
      <div className="welcome-state"><span className={ready?"ready":""}/>{ready?"系统准备就绪":"正在载入运营数据"}</div>
      <div className="welcome-progress" aria-hidden="true"><i/></div>
    </div>
    <footer>销售 · 库存 · 备货 · 生产 · 跨境运输 · 到仓</footer>
  </section>;
}

function PageHead({title,desc,children}:{title:string;desc:string;children?:React.ReactNode}) {
  return <div className="page-head"><div><h3>{title}</h3><p>{desc}</p></div>{children}</div>;
}
function Panel({title,desc,children,action}:{title:string;desc?:string;children:React.ReactNode;action?:React.ReactNode}) {
  return <section className="panel"><div className="panel-head"><div><h4>{title}</h4>{desc&&<p>{desc}</p>}</div>{action}</div>{children}</section>;
}
function Pill({children,tone="blue"}:{children:React.ReactNode;tone?:string}) { return <span className={`pill ${tone}`}>{children}</span>; }
function Empty({children}:{children:React.ReactNode}) { return <div className="empty">{children}</div>; }

function Overview({data,go}:{data:Snapshot;go:(tab:string)=>void}) {
  const [showAllTasks,setShowAllTasks]=useState(false);
  const m=data.metrics;
  const completeness=m.monthlyRequired ? m.monthlySubmitted/m.monthlyRequired : 0;
  return <>
    <PageHead title="经营协同总览" desc={`${data.currentMonth} · 销量、库存、海运与生产一屏联动`}>
      <Pill tone={m.actionAlertCount?"red":"green"}>{m.actionAlertCount ? `${m.actionAlertCount}项需行动` : "供应覆盖正常"}</Pill>
    </PageHead>
    <div className="metrics">
      <div className="metric"><div className="label">当前可售库存</div><div className="value">{fmt(m.inventoryQty)}</div><div className="foot">待上架 {fmt(m.pendingShelfQty)} · 隔离 {fmt(m.quarantineQty)}</div></div>
      <div className="metric"><div className="label">近7天销量</div><div className="value">{fmt(m.sales7Qty)}</div><div className="foot">仅用已导入日期计算，缺失日不当作零</div></div>
      <div className="metric"><div className="label">海运在途</div><div className="value">{fmt(m.seaTransitQty)}</div><div className="foot">只统计已进入海运的数量</div></div>
      <div className="metric"><div className="label">建议启动生产</div><div className="value" style={{color:m.suggestedProductionQty?"var(--amber)":"var(--ink)"}}>{fmt(m.suggestedProductionQty)}</div><div className="foot">已扣库存、海运在途和生产中</div></div>
    </div>
    {data.myTasks.length>0&&<Panel title={`我的待办 · ${data.myTasks.length} 项`} desc="红色事项需要处理；完成相应业务后自动移出待办" action={data.myTasks.length>8&&<button className="btn danger" onClick={()=>setShowAllTasks(!showAllTasks)}>{showAllTasks?"收起待办":`展开全部 ${data.myTasks.length} 项`}</button>}><div className="task-grid">{(showAllTasks?data.myTasks:data.myTasks.slice(0,8)).map((task,index)=><button className={`task-card ${task.level}`} key={`${task.title}-${index}`} onClick={()=>go(task.tab)}><strong>{task.title}</strong><span>{task.detail}</span><i>{task.level==="red"?"优先处理":"待处理"} →</i></button>)}</div></Panel>}
    <div className="grid-2">
      <Panel title="本月提交完整度" desc="五个站点 × TikTok/Shopee，全部提交后才能进入审批" action={<button className="btn" onClick={()=>go("monthly")}>查看明细</button>}>
        <div style={{display:"flex",justifyContent:"space-between",fontSize:11,marginBottom:8}}><span>{m.monthlySubmitted}/{m.monthlyRequired} 已提交</span><strong>{pct(completeness)}</strong></div>
        <div className="bar"><i style={{width:`${Math.min(100,completeness*100)}%`}}/></div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:8,marginTop:14}}>
          {data.monthlyStatus.map((r)=><div key={`${r.site}-${r.channel}`} style={{fontSize:9,color:r.submitted?"var(--green)":"var(--muted)"}}>{r.submitted?"●":"○"} {r.site}<br/>{r.channel}</div>)}
        </div>
      </Panel>
      <Panel title="动态预警" desc="断货、数据缺口和在途缺ETA优先处理" action={<button className="btn" onClick={()=>go("suggestions")}>打开驾驶舱</button>}>
        {data.issues.length===0?<Empty>暂无高优先级供应风险</Empty>:data.issues.slice(0,6).map((issue,i)=><div key={i} className={`notice ${issue.level==="critical"?"error":"warn"}`} style={{marginBottom:7}}><strong>{issue.type}</strong><br/>{issue.detail}</div>)}
      </Panel>
    </div>
    <Panel title="全链路实时状态" desc={`当前 ${fmt(m.activeBatchCount)} 个在途批次，${fmt(m.stalledBatchCount)} 个节点停滞，${fmt(m.pendingShelfCount)} 个待上架`} action={<button className="btn" onClick={()=>go("batches")}>查看全部批次</button>}>
      <div className="workflow chain-overview">
        {[["supply_confirm","备货确认"],["factory_production","工厂生产"],["booking","订舱"],["sea_freight","海运"],["port_arrived","到港"],["customs_clearance","清关"],["last_mile_delivery","派送"],["awaiting_receipt","待到仓"],["shelf_pending","待上架"],["on_shelf","已上架"]].map(([key,label])=><div className="workflow-step" key={key}><strong>{fmt(m.batchStageCounts?.[key])}</strong><span>{label}</span></div>)}
      </div>
    </Panel>
  </>;
}

function supplyKey(row:Row) { return `${row.site}|${row.channel}|${row.sku}`; }

function SalesTrendChart({row}:{row:Row}) {
  const series:Array<{date:string;qty:number}> = row?.dailySeries||[];
  if(!series.length) return <Empty>暂无连续销售数据</Empty>;
  const width=780,height=232,padX=38,padTop=18,padBottom=34,innerW=width-padX*2,innerH=height-padTop-padBottom;
  const rolling=series.map((_,index)=>{
    const values=series.slice(Math.max(0,index-6),index+1);
    return values.reduce((sum,item)=>sum+Number(item.qty||0),0)/values.length;
  });
  const maxValue=Math.max(1,...series.map(item=>Number(item.qty||0)),...rolling);
  const slot=innerW/series.length,barWidth=Math.max(4,slot*.56);
  const y=(value:number)=>padTop+innerH-(value/maxValue)*innerH;
  const path=rolling.map((value,index)=>`${index?"L":"M"} ${padX+slot*(index+.5)} ${y(value)}`).join(" ");
  return <div className="trend-chart">
    <div className="chart-legend"><span><i className="legend-sales"/>每日销量</span><span><i className="legend-average"/>7日滚动日均</span><strong>预测日均 {Number(row.forecastDaily||0).toFixed(1)}</strong></div>
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${row.site}${row.channel}${row.sku}近28天销量趋势`}>
      <title>{row.site} {row.channel} {row.sku} 近28天销量趋势</title>
      {[0,.5,1].map(ratio=><g key={ratio}><line x1={padX} x2={width-padX} y1={padTop+innerH*ratio} y2={padTop+innerH*ratio} className="chart-grid"/><text x={padX-7} y={padTop+innerH*ratio+4} textAnchor="end" className="chart-label">{Math.round(maxValue*(1-ratio))}</text></g>)}
      {series.map((item,index)=><rect key={item.date} x={padX+slot*index+(slot-barWidth)/2} y={y(Number(item.qty||0))} width={barWidth} height={Math.max(0,padTop+innerH-y(Number(item.qty||0)))} rx="2" className="chart-bar"/>)}
      <path d={path} className="chart-line"/>
      {series.map((item,index)=>[0,6,13,20,27].includes(index)?<text key={item.date} x={padX+slot*(index+.5)} y={height-9} textAnchor="middle" className="chart-label">{item.date.slice(5)}</text>:null)}
    </svg>
  </div>;
}

function SupplyCoverage({rows}:{rows:Row[]}) {
  if(!rows.length) return <Empty>暂无可展示的站点SKU</Empty>;
  return <div className="coverage-list">{rows.slice(0,8).map(row=>{
    const stock=Math.max(0,Number(row.qty||0)),sea=Math.max(0,Number(row.seaInTransit||0)),production=Math.max(0,Number(row.productionInProgress||0));
    const scale=Math.max(1,Number(row.targetQty||0),stock+sea+production);
    return <div className="coverage-row" key={supplyKey(row)}>
      <div className="coverage-name"><strong>{row.sku}</strong><span>{row.site} · {row.channel}</span></div>
      <div className="coverage-visual">
        <div className="coverage-track" aria-label={`${row.sku}目标${fmt(row.targetQty)}件，库存${fmt(row.qty)}件，海运${fmt(sea)}件，生产中${fmt(production)}件`}>
          <i className="coverage-stock" style={{width:`${stock/scale*100}%`}}/><i className="coverage-sea" style={{width:`${sea/scale*100}%`}}/><i className="coverage-production" style={{width:`${production/scale*100}%`}}/>
          <b className="coverage-target" style={{left:`${Math.min(99,Number(row.targetQty||0)/scale*100)}%`}} title={`目标库存位 ${fmt(row.targetQty)}`}/>
        </div>
        <div className="coverage-meta"><span>库存 {fmt(row.qty)}</span><span>海运 {fmt(sea)}</span><span>生产中 {fmt(production)}</span><span>目标 {fmt(row.targetQty)}</span></div>
      </div>
      <div className="coverage-action"><Pill tone={ALERT_TONE[row.alertLevel]||"blue"}>{row.alertLabel}</Pill><strong>生产 {fmt(row.suggestedProduction)}</strong></div>
    </div>;
  })}</div>;
}

function Suggestions({data,act,busy}:{data:Snapshot;act:Act;busy:boolean}) {
  const actor=data.actor;
  const [newDraftSku,setNewDraftSku]=useState("");
  const [zeroDemand,setZeroDemand]=useState(false),[zeroReason,setZeroReason]=useState("");
  const [drafts,setDrafts]=useState<PlanDraft[]>(()=>data.suggestions.filter((r)=>r.suggestedProduction>0).map((r)=>({sku:r.sku,name:r.name,qty:String(r.suggestedProduction),reason:r.alertLabel||"系统动态建议"})));
  const [selectedKey,setSelectedKey]=useState(data.suggestions[0]?supplyKey(data.suggestions[0]):"");
  const [setting,setSetting]=useState({sku:"",name:"",productSeries:"",supplierName:"",factoryName:"",productType:"老款",unitPrice:"0",productionLeadDays:"21",seaLeadDays:"35",reviewCycleDays:"7",serviceLevel:"0.95",minOrderQty:"1",orderMultiple:"1",cartonQty:"1",unitVolumeCbm:"0"});
  const selected=data.suggestions.find(row=>supplyKey(row)===selectedKey)||data.suggestions[0];
  const effectiveSelectedKey=selected?supplyKey(selected):"";
  const submit=async()=>{
    if(!actor.site||!actor.channel) return;
    await act("monthlySubmit",{month:data.currentMonth,site:actor.site,channel:actor.channel,zeroDemand,zeroReason,items:drafts.filter(r=>Number(r.qty)>0).map((r)=>({...r,qty:Number(r.qty)}))},"本月备货需求已保存并进入完整度检查");
  };
  const chooseSetting=(sku:string)=>{
    const row=data.skuSettings.find(item=>item.sku===sku);
    if(!row)return;
    setSetting({sku:row.sku,name:row.name||"",productSeries:row.product_series==="待归类"?"":row.product_series||"",supplierName:row.supplier_name||"",factoryName:row.factory_name||"",productType:row.product_type||"老款",unitPrice:String(row.unit_price??0),productionLeadDays:String(row.production_lead_days??21),seaLeadDays:String(row.sea_lead_days??35),reviewCycleDays:String(row.review_cycle_days??7),serviceLevel:String(row.service_level??.95),minOrderQty:String(row.min_order_qty??1),orderMultiple:String(row.order_multiple??1),cartonQty:String(row.carton_qty??1),unitVolumeCbm:String(row.unit_volume_cbm??0)});
  };
  const m=data.metrics;
  return <>
    <PageHead title="补货与生产驾驶舱" desc="每日销量驱动，按站点＋渠道＋SKU独立判断断货、补货和生产时点">
      <Pill tone={m.actionAlertCount?"red":"green"}>{m.actionAlertCount?`${m.actionAlertCount}项需行动`:"供应覆盖正常"}</Pill>
    </PageHead>
    <div className="model-strip">
      <div><span>需求速度</span><strong>滚动7／21／56天加权，结合需求修正</strong></div><b>×</b><div><span>覆盖周期</span><strong>生产＋海运＋7天复盘</strong></div><b>＋</b><div><span>安全库存</span><strong>销量波动 × 服务水平</strong></div><b>－</b><div><span>供应链库存位</span><strong>库存＋海运＋生产中</strong></div>
    </div>
    <div className="metrics">
      <div className="metric"><div className="label">当前库存</div><div className="value">{fmt(m.inventoryQty)}</div><div className="foot">实际可售库存</div></div>
      <div className="metric"><div className="label">海运在途</div><div className="value">{fmt(m.seaTransitQty)}</div><div className="foot">须维护预计到仓日期</div></div>
      <div className="metric"><div className="label">生产中</div><div className="value">{fmt(m.productionInProgressQty)}</div><div className="foot">尚未进入海运的批次</div></div>
      <div className="metric"><div className="label">建议启动生产</div><div className="value" style={{color:m.suggestedProductionQty?"var(--amber)":undefined}}>{fmt(m.suggestedProductionQty)}</div><div className="foot">动态缺口合计</div></div>
    </div>
    <Panel title="供应覆盖图" desc="横向比较最需关注的站点SKU；竖线为目标库存位">
      <div className="coverage-legend"><span><i className="stock"/>当前库存</span><span><i className="sea"/>海运在途</span><span><i className="production"/>生产中</span><span><i className="target"/>目标库存位</span></div>
      <SupplyCoverage rows={data.suggestions}/>
    </Panel>
    <Panel title="56天销量趋势" desc={selected?`${selected.site} · ${selected.channel} · ${selected.sku}｜数据可信度：${selected.confidence}（已导入${selected.dataDays}天）`:"先录入销售数据"} action={data.suggestions.length?<select className="compact-select" aria-label="选择趋势SKU" value={effectiveSelectedKey} onChange={event=>setSelectedKey(event.target.value)}>{data.suggestions.map(row=><option key={supplyKey(row)} value={supplyKey(row)}>{row.site} · {row.channel} · {row.sku}</option>)}</select>:undefined}>
      {selected?<SalesTrendChart row={selected}/>:<Empty>请先录入库存和每日销售数据</Empty>}
    </Panel>
    <Panel title="动态建议清单" desc="海运补货量解决运输周期缺口；启动生产量覆盖生产＋海运全周期">
      <div className="table-wrap"><table className="supply-table"><thead><tr><th>状态</th><th>站点/渠道</th><th>SKU</th><th className="num">7日日均</th><th className="num">趋势</th><th className="num">库存/可售天数</th><th className="num">海运/ETA</th><th className="num">生产中</th><th className="num">建议海运补货</th><th className="num">建议启动生产</th></tr></thead>
      <tbody>{data.suggestions.length===0?<tr><td colSpan={10}><Empty>请先录入库存和销售数据，系统将自动形成动态建议</Empty></td></tr>:data.suggestions.map((r)=><tr key={supplyKey(r)}><td><Pill tone={ALERT_TONE[r.alertLevel]||"blue"}>{r.alertLabel}</Pill><div className="cell-note">{r.alertReason}</div></td><td>{r.site}<br/><span className="cell-note">{r.channel}</span></td><td><strong>{r.sku}</strong><br/><span className="cell-note">{r.name||"—"}</span></td><td className="num">{Number(r.avg7).toFixed(1)}</td><td className="num" style={{color:r.trendRate>=.2?"var(--blue)":r.trendRate<0?"var(--green)":undefined}}>{r.previous7>0?`${r.trendRate>=0?"+":""}${pct(r.trendRate)}`:"—"}</td><td className="num" style={{color:r.qty<0?"var(--red)":undefined}}>{fmt(r.qty)}<div className="cell-note">{days(r.stockCoverDays)}</div></td><td className="num">{fmt(r.seaInTransit)}<div className="cell-note">{r.nextSeaEta||"未填写ETA"}</div></td><td className="num">{fmt(r.productionInProgress)}</td><td className="num">{fmt(r.suggestedReplenishment)}</td><td className="num"><strong>{fmt(r.suggestedProduction)}</strong><div className="cell-note">目标 {fmt(r.targetQty)}</div></td></tr>)}</tbody></table></div>
    </Panel>
    {actor.role==="运营" && <Panel title="提交本月备货需求" desc="系统建议可调整；调整原因与最终提交量一并存档">
      <label>增加备货SKU<select value={newDraftSku} onChange={e=>setNewDraftSku(e.target.value)}><option value="">请选择SKU</option>{data.skuSettings.filter(r=>!drafts.some(d=>d.sku===r.sku)).map(r=><option key={r.sku} value={r.sku}>{r.sku} · {r.name}</option>)}</select><button className="btn" disabled={!newDraftSku} onClick={()=>{const r=data.skuSettings.find(r=>r.sku===newDraftSku);if(r)setDrafts([...drafts,{sku:r.sku,name:r.name,qty:"1",reason:"运营补充需求"}]);setNewDraftSku("");}}>增加</button></label>
      <label><input type="checkbox" checked={zeroDemand} onChange={e=>setZeroDemand(e.target.checked)}/>确认本月无需备货</label>{zeroDemand&&<label>确认说明<input value={zeroReason} onChange={e=>setZeroReason(e.target.value)}/><button className="btn primary" disabled={busy||zeroReason.length<4} onClick={submit}>提交无需备货</button></label>}
      {!zeroDemand&&(drafts.length===0?<Empty>当前没有建议启动生产的SKU，可提交无需备货确认</Empty>:<>
        <div className="table-wrap"><table><thead><tr><th>SKU</th><th>商品</th><th className="num">提交数量</th><th>调整原因</th></tr></thead><tbody>{drafts.map((r,i)=><tr key={r.sku}><td>{r.sku}</td><td>{r.name}</td><td><input aria-label={`${r.sku}提交数量`} value={r.qty} onChange={e=>setDrafts(drafts.map((x,j)=>j===i?{...x,qty:e.target.value}:x))} style={{width:90,border:"1px solid var(--line)",borderRadius:7,padding:6,textAlign:"right"}}/></td><td><input aria-label={`${r.sku}调整原因`} value={r.reason} onChange={e=>setDrafts(drafts.map((x,j)=>j===i?{...x,reason:e.target.value}:x))} style={{width:"100%",border:"1px solid var(--line)",borderRadius:7,padding:6}}/></td></tr>)}</tbody></table></div>
        <div className="form-actions"><button className="btn primary" disabled={busy||!actor.site} onClick={submit}>提交 {data.currentMonth} 需求</button></div>
      </>)}
    </Panel>}
    {hasPermission(actor.role,"sku.manage")&&<Panel title="SKU系列与供应参数" desc="产品系列是供应链合并下单、工厂合并生产的必要依据">
      {data.skuSettings.some(row=>!row.product_series||row.product_series==="待归类")&&<div className="notice warn">还有 <strong>{data.skuSettings.filter(row=>!row.product_series||row.product_series==="待归类").length}</strong> 个SKU未归入产品系列。涉及这些SKU的月度计划会暂停进入审批。</div>}
      <div className="form-grid">
        <Field label="选择已有SKU"><select value={data.skuSettings.some(row=>row.sku===setting.sku)?setting.sku:""} onChange={event=>chooseSetting(event.target.value)}><option value="">选择后自动带出参数</option>{data.skuSettings.map(row=><option key={row.sku} value={row.sku}>{row.sku} · {row.product_series||"待归类"}</option>)}</select></Field>
        <Field label="SKU"><input value={setting.sku} onChange={e=>setSetting({...setting,sku:e.target.value})}/></Field>
        <Field label="商品名称"><input value={setting.name} onChange={e=>setSetting({...setting,name:e.target.value})}/></Field>
        <Field label="产品系列（必填）"><input value={setting.productSeries} onChange={e=>setSetting({...setting,productSeries:e.target.value})} placeholder="例如：城市通勤包系列"/></Field>
        <Field label="供应商（主数据）"><select value={setting.supplierName} onChange={e=>setSetting({...setting,supplierName:e.target.value})}><option value="">请选择</option>{data.businessPartners.filter(row=>row.type==="supplier"&&Number(row.active)).map(row=><option key={row.id}>{row.name}</option>)}</select></Field>
        <Field label="生产工厂（主数据）"><select value={setting.factoryName} onChange={e=>setSetting({...setting,factoryName:e.target.value})}><option value="">请选择</option>{data.businessPartners.filter(row=>row.type==="factory"&&Number(row.active)).map(row=><option key={row.id}>{row.name}</option>)}</select></Field>
        <Field label="商品类型"><select value={setting.productType} onChange={e=>setSetting({...setting,productType:e.target.value})}><option>老款</option><option>新品</option></select></Field>
        <Field label="参考售价（人民币）"><input type="number" min="0" value={setting.unitPrice} onChange={e=>setSetting({...setting,unitPrice:e.target.value})}/></Field>
        <Field label="生产周期（天）"><input type="number" min="1" max="180" value={setting.productionLeadDays} onChange={e=>setSetting({...setting,productionLeadDays:e.target.value})}/></Field>
        <Field label="海运周期（天）"><input type="number" min="1" max="180" value={setting.seaLeadDays} onChange={e=>setSetting({...setting,seaLeadDays:e.target.value})}/></Field>
        <Field label="复盘周期（天）"><input type="number" min="1" max="30" value={setting.reviewCycleDays} onChange={e=>setSetting({...setting,reviewCycleDays:e.target.value})}/></Field>
        <Field label="目标服务水平"><select value={setting.serviceLevel} onChange={e=>setSetting({...setting,serviceLevel:e.target.value})}><option value="0.90">90%</option><option value="0.95">95%（推荐）</option><option value="0.98">98%</option><option value="0.99">99%</option></select></Field>
        <Field label="最小起订量 MOQ"><input type="number" min="1" value={setting.minOrderQty} onChange={e=>setSetting({...setting,minOrderQty:e.target.value})}/></Field>
        <Field label="下单倍数"><input type="number" min="1" value={setting.orderMultiple} onChange={e=>setSetting({...setting,orderMultiple:e.target.value})}/></Field>
        <Field label="每箱数量"><input type="number" min="1" value={setting.cartonQty} onChange={e=>setSetting({...setting,cartonQty:e.target.value})}/></Field>
        <Field label="单件体积（m³）"><input type="number" min="0" step="0.0001" value={setting.unitVolumeCbm} onChange={e=>setSetting({...setting,unitVolumeCbm:e.target.value})}/></Field>
      </div>
      <div className="form-actions"><button className="btn primary" disabled={busy||!setting.sku||!setting.productSeries||!setting.supplierName||!setting.factoryName} onClick={()=>act("saveSkuSetting",{...setting,unitPrice:Number(setting.unitPrice),productionLeadDays:Number(setting.productionLeadDays),seaLeadDays:Number(setting.seaLeadDays),reviewCycleDays:Number(setting.reviewCycleDays),serviceLevel:Number(setting.serviceLevel),minOrderQty:Number(setting.minOrderQty),orderMultiple:Number(setting.orderMultiple),cartonQty:Number(setting.cartonQty),unitVolumeCbm:Number(setting.unitVolumeCbm)},"SKU系列与供应参数已保存")}>保存参数</button></div>
    </Panel>}
    <ForecastSettings data={data} act={act} busy={busy}/>
  </>;
}

const NPI_STEPS=[
  {key:"selection",label:"1 选款立项",owner:"新品开发＋管理层",duration:"3天"},
  {key:"research",label:"2 运营调研",owner:"五站双渠道运营",duration:"3天"},
  {key:"seeding",label:"3 内容种草",owner:"运营主管＋运营",duration:"7天"},
  {key:"finance",label:"4 财务测算",owner:"财务",duration:"2天"},
  {key:"sample",label:"5 打板确认",owner:"工厂＋新品＋运营",duration:"10天"},
  {key:"production",label:"6 首批生产",owner:"供应链＋工厂",duration:"30＋3天"},
];

function npiStepState(project:Row,index:number) {
  const current:Record<string,number>={selection:0,parallel_test:1,finance:3,sample:4,production:5,abandoned:6};
  const active=current[project.stage]??0;
  if(project.stage==="parallel_test"&&(index===1||index===2)) return "active";
  if(project.stage==="abandoned") return "stopped";
  return index<active?"complete":index===active?"active":"pending";
}

function NewProducts({data,act,busy}:{data:Snapshot;act:Act;busy:boolean}) {
  const actor=data.actor,projects=data.newProductProjects||[];
  const [supplyUserId,setSupplyUserId]=useState("");
  const [selectedId,setSelectedId]=useState(projects[0]?.id||"");
  const selected=projects.find(project=>project.id===selectedId)||projects[0];
  const effectiveId=selected?.id||"";
  const [start,setStart]=useState({cycleMonth:data.currentMonth,sku:"",name:"",firstBatchQty:"3000"});
  const [candidate,setCandidate]=useState({developerReason:"",evidenceRef:"",conclusion:"建议进入测试"});
  const [scope,setScope]=useState({site:actor.site||SITES[0],channel:actor.channel||"TikTok"});
  const [research,setResearch]=useState({sellingStatus:"已有人销售",competitorCount:"",priceMin:"",priceMax:"",estimatedMonthlySales:"",competitorLinks:"",conclusion:"建议继续"});
  const [seeding,setSeeding]=useState({contentCount:"",views:"",likes:"",comments:"",addToCart:"",inquiries:"",conclusion:"建议继续"});
  const [finance,setFinance]=useState({currency:"IDR",exchangeRateToCny:"0.00045",materialCost:"",unitCost:"",plannedPrice:"",platformFeeRate:"0.10",paymentFeeRate:"0.02",refundRate:"0.03",taxRate:"0",importDutyRate:"0",logisticsCost:"",adCost:"",fixedCost:"",targetGrossMarginRate:"0.40",conclusion:"毛利达到目标"});
  const [sample,setSample]=useState({sampleRef:"",appearanceResult:"通过",qualityResult:"通过",note:"",conclusion:"建议量产"});
  const [developmentConfirmation,setDevelopmentConfirmation]=useState("");
  const [operationsConfirmation,setOperationsConfirmation]=useState("");
  const [allocations,setAllocations]=useState<AllocationDraft[]>([{site:SITES[0],channel:"TikTok",qty:""}]);
  const [finalFirstBatchQty,setFinalFirstBatchQty]=useState("");
  const record=(stageKey:string,scopeKey="global")=>selected?.records?.find((row:Row)=>row.stage_key===stageKey&&row.scope_key===scopeKey);
  const decide=async(decision:string,withAllocations=false)=>{
    if(!selected)return;
    const promptLabel=decision==="continue"?"请输入继续进入下一阶段的决策理由":decision==="reprice"?"请输入重新定价原因":"请输入放弃原因";
    const note=window.prompt(promptLabel);
    if(!note)return;
    await act("decideNewProduct",{projectId:selected.id,decision,note,supplyUserId,finalFirstBatchQty:withAllocations?Number(finalFirstBatchQty||selected.recommended_first_batch_qty||selected.first_batch_qty):undefined,allocations:withAllocations?allocations.map(row=>({...row,qty:Number(row.qty)})):undefined},decision==="continue"?"新品已进入下一阶段":decision==="reprice"?"新品已退回重新定价":"新品项目已停止并存档");
  };
  const financePreview=(()=>{const price=Number(finance.plannedPrice)*Number(finance.exchangeRateToCny),net=price*(1-Number(finance.refundRate)-Number(finance.taxRate)),landed=Number(finance.unitCost)+Number(finance.logisticsCost)+Number(finance.unitCost)*Number(finance.importDutyRate),contribution=net-price*(Number(finance.platformFeeRate)+Number(finance.paymentFeeRate))-landed-Number(finance.adCost);return {contribution,margin:price>0?contribution/price:0,breakEven:contribution>0?Math.ceil(Number(finance.fixedCost)/contribution):null};})();
  const allocationTotal=allocations.reduce((sum,row)=>sum+(Number(row.qty)||0),0);
  const canScope=["管理员","运营","运营主管"].includes(actor.role);
  const thisMonthCount=projects.filter(project=>project.cycle_month===data.currentMonth).length;
  return <>
    <PageHead title="新品孵化与首批备货" desc="管理员每月7号发起；22天完成打板判断，通过后自动生成首批生产批次">
      <Pill tone={thisMonthCount?"green":"red"}>{thisMonthCount?`本月已发起 ${thisMonthCount} 款`:"本月待发起"}</Pill>
    </PageHead>
    <div className="notice info"><strong>固定节奏：</strong>7号发起 → 选款3天 → 调研3天与种草7天并行 → 财务2天 → 打板10天 → 首批生产30天＋交付确认。种草差或毛利不达标时必须提前止损。</div>
    {actor.role==="管理员"&&<Panel title="发起本月新品测试" desc="同一SKU每月只能发起一次；首批计划默认3000件，可按实际调整">
      <div className="form-grid">
        <Field label="测试月份"><input type="month" value={start.cycleMonth} disabled/></Field>
        <Field label="新品SKU"><input value={start.sku} onChange={event=>setStart({...start,sku:event.target.value})}/></Field>
        <Field label="新品名称"><input value={start.name} onChange={event=>setStart({...start,name:event.target.value})}/></Field>
        <Field label="首批计划数量"><input type="number" min="1" max="100000" value={start.firstBatchQty} onChange={event=>setStart({...start,firstBatchQty:event.target.value})}/></Field>
      </div>
      <div className="form-actions"><button className="btn primary" disabled={busy||!start.sku||!start.name} onClick={()=>act("startNewProductTest",{...start,firstBatchQty:Number(start.firstBatchQty)},"本月新品测试已发起")}>发起新品测试</button></div>
    </Panel>}
    <Panel title="新品项目" desc="选择项目查看当前节点、站点完成度和下一步动作">
      {projects.length===0?<Empty>本月7号后由管理员发起第一款新品测试</Empty>:<div className="npi-project-list">{projects.map(project=><button key={project.id} className={classNames("npi-project-card",effectiveId===project.id&&"active")} onClick={()=>setSelectedId(project.id)}><span>{project.cycle_month}</span><strong>{project.sku} · {project.name}</strong><small>{NEW_PRODUCT_STAGE[project.stage]||project.stage}｜首批 {fmt(project.first_batch_qty)} 件</small>{project.overdue&&<em>已逾期</em>}</button>)}</div>}
    </Panel>
    {selected&&<>
      <Panel title={`${selected.sku} 六阶段进度`} desc={`当前节点：${NEW_PRODUCT_STAGE[selected.stage]||selected.stage}｜截止：${readableDate(selected.current_due_at)}`}>
        <div className="npi-flow">{NPI_STEPS.map((step,index)=>{const state=npiStepState(selected,index);return <div key={step.key} className={`npi-step ${state}`}><div><span>{state==="complete"?"✓":state==="active"?"●":state==="stopped"?"×":"○"}</span><b>{step.label}</b></div><small>{step.owner}</small><strong>{step.duration}</strong></div>})}</div>
        {selected.status==="abandoned"&&<div className="notice error" style={{marginTop:14}}>已停止：{selected.abandon_reason}</div>}
        {selected.stage==="production"&&<div className="notice info" style={{marginTop:14}}>已生成系列生产单 <strong>{selected.production_batch_id}</strong>，当前状态：{selected.productionOrder?.status==="completed"?"已完工":selected.productionOrder?.status==="completed_with_variance"?"差异完工":"等待工厂生产"}。完工后由供应链创建海运批次。</div>}
      </Panel>
      {selected.stage==="selection"&&selected.status==="active"&&<div className="grid-2 npi-action-grid">
        <Panel title="阶段1 选款立项" desc="新品开发提交候选款SKU和开发理由">
          {["管理员","新品开发"].includes(actor.role)?<>
            <div className="form-grid">
              <Field label="开发理由" span={4}><textarea value={candidate.developerReason} onChange={event=>setCandidate({...candidate,developerReason:event.target.value})} placeholder="市场趋势、竞品对标、客户反馈或现有产品空缺"/></Field>
              <Field label="参考资料编号" span={2}><input value={candidate.evidenceRef} onChange={event=>setCandidate({...candidate,evidenceRef:event.target.value})}/></Field>
              <Field label="开发结论" span={2}><input value={candidate.conclusion} onChange={event=>setCandidate({...candidate,conclusion:event.target.value})}/></Field>
            </div>
            <div className="form-actions"><button className="btn primary" disabled={busy||candidate.developerReason.length<5} onClick={()=>act("submitNewProductStage",{projectId:selected.id,stageKey:"candidate",...candidate},"候选款开发理由已提交")}>提交候选款</button></div>
          </>:<Empty>等待新品开发提交候选款资料</Empty>}
        </Panel>
        <Panel title="管理层决策" desc="通过后阶段2和阶段3并行启动">
          {record("candidate")?<div className="stage-summary"><strong>开发理由</strong><p>{record("candidate").data.developerReason}</p><span>{record("candidate").actor_name} · {readableDate(record("candidate").submitted_at)}</span></div>:<Empty>尚未提交候选款资料</Empty>}
          {actor.role==="管理员"&&<div className="form-actions"><button className="btn danger" disabled={busy} onClick={()=>decide("abandon")}>放弃</button><button className="btn primary" disabled={busy||!record("candidate")} onClick={()=>decide("continue")}>通过选款</button></div>}
        </Panel>
      </div>}
      {selected.stage==="parallel_test"&&selected.status==="active"&&<>
        <Panel title="五站双渠道测试矩阵" desc={`调研 ${selected.researchCount}/10（截止 ${readableDate(selected.researchDueAt)}）｜种草 ${selected.seedingCount}/10（截止 ${readableDate(selected.current_due_at)}）`}>
          <div className="npi-matrix">{SITES.map(site=><div key={site}><strong>{site}</strong>{REQUIRED_CHANNELS.map(channel=>{const key=`${site}|${channel}`;return <span key={key}>{channel}<i className={record("research",key)?"done":""}>调研</i><i className={record("seeding",key)?"done":""}>种草</i></span>})}</div>)}</div>
        </Panel>
        {canScope&&<div className="grid-2 npi-action-grid">
          <Panel title="阶段2 运营市场调研" desc="3天内完成平台、价格带、竞品和预估销量">
            <div className="form-grid">
              <Field label="站点"><select disabled={actor.role==="运营"} value={scope.site} onChange={event=>setScope({...scope,site:event.target.value})}>{SITES.map(site=><option key={site}>{site}</option>)}</select></Field>
              <Field label="渠道"><select disabled={actor.role==="运营"} value={scope.channel} onChange={event=>setScope({...scope,channel:event.target.value})}>{REQUIRED_CHANNELS.map(channel=><option key={channel}>{channel}</option>)}</select></Field>
              <Field label="市场销售状态"><select value={research.sellingStatus} onChange={event=>setResearch({...research,sellingStatus:event.target.value})}><option>已有人销售</option><option>暂未发现</option><option>不确定</option></select></Field>
              <Field label="主要竞品数"><input type="number" min="0" value={research.competitorCount} onChange={event=>setResearch({...research,competitorCount:event.target.value})}/></Field>
              <Field label="价格带最低"><input type="number" min="0" value={research.priceMin} onChange={event=>setResearch({...research,priceMin:event.target.value})}/></Field>
              <Field label="价格带最高"><input type="number" min="0" value={research.priceMax} onChange={event=>setResearch({...research,priceMax:event.target.value})}/></Field>
              <Field label="预估月销量"><input type="number" min="0" value={research.estimatedMonthlySales} onChange={event=>setResearch({...research,estimatedMonthlySales:event.target.value})}/></Field>
              <Field label="调研结论"><input value={research.conclusion} onChange={event=>setResearch({...research,conclusion:event.target.value})}/></Field>
              <Field label="竞品链接" span={4}><textarea value={research.competitorLinks} onChange={event=>setResearch({...research,competitorLinks:event.target.value})}/></Field>
            </div>
            <div className="form-actions"><button className="btn primary" disabled={busy||!research.competitorCount||!research.conclusion} onClick={()=>act("submitNewProductStage",{projectId:selected.id,stageKey:"research",...scope,...research,competitorCount:Number(research.competitorCount),priceMin:Number(research.priceMin),priceMax:Number(research.priceMax),estimatedMonthlySales:Number(research.estimatedMonthlySales)},"运营调研已提交")}>提交调研</button></div>
          </Panel>
          <Panel title="阶段3 内容/素材测试" desc="TikTok记录内容兴趣指标；Shopee记录素材曝光、点击、加购和咨询">
            <div className="form-grid">
              <Field label="内容数量"><input type="number" min="1" value={seeding.contentCount} onChange={event=>setSeeding({...seeding,contentCount:event.target.value})}/></Field>
              <Field label="曝光/播放"><input type="number" min="0" value={seeding.views} onChange={event=>setSeeding({...seeding,views:event.target.value})}/></Field>
              <Field label="点赞"><input type="number" min="0" value={seeding.likes} onChange={event=>setSeeding({...seeding,likes:event.target.value})}/></Field>
              <Field label="评论"><input type="number" min="0" value={seeding.comments} onChange={event=>setSeeding({...seeding,comments:event.target.value})}/></Field>
              <Field label="加购"><input type="number" min="0" value={seeding.addToCart} onChange={event=>setSeeding({...seeding,addToCart:event.target.value})}/></Field>
              <Field label="咨询"><input type="number" min="0" value={seeding.inquiries} onChange={event=>setSeeding({...seeding,inquiries:event.target.value})}/></Field>
              <Field label="测试结论" span={2}><input value={seeding.conclusion} onChange={event=>setSeeding({...seeding,conclusion:event.target.value})}/></Field>
            </div>
            <div className="form-actions"><button className="btn primary" disabled={busy||!seeding.contentCount||!seeding.conclusion} onClick={()=>act("submitNewProductStage",{projectId:selected.id,stageKey:"seeding",...scope,...seeding,contentCount:Number(seeding.contentCount),views:Number(seeding.views),likes:Number(seeding.likes),comments:Number(seeding.comments),addToCart:Number(seeding.addToCart),inquiries:Number(seeding.inquiries)},"内容种草测试已提交")}>提交种草数据</button></div>
          </Panel>
        </div>}
        {["管理员","运营主管"].includes(actor.role)&&<div className="form-actions npi-gate-actions"><button className="btn danger" disabled={busy} onClick={()=>decide("abandon")}>测试效果差 放弃</button><button className="btn primary" disabled={busy||selected.researchCount<10||selected.seedingCount<10} onClick={()=>decide("continue")}>数据齐全 进入财务测算</button></div>}
      </>}
      {selected.stage==="finance"&&selected.status==="active"&&<div className="grid-2 npi-action-grid">
        <Panel title="阶段4 财务测算" desc="系统自动计算贡献毛利、毛利率和盈亏平衡销量">
          {["管理员","财务"].includes(actor.role)?<>
            <div className="form-grid">
              <Field label="材料成本"><input type="number" min="0" value={finance.materialCost} onChange={event=>setFinance({...finance,materialCost:event.target.value})}/></Field>
              <Field label="销售币种"><select value={finance.currency} onChange={event=>setFinance({...finance,currency:event.target.value})}><option>CNY</option><option>MYR</option><option>IDR</option><option>THB</option><option>VND</option><option>PHP</option></select></Field>
              <Field label="兑人民币汇率"><input type="number" min="0" step="0.000001" value={finance.exchangeRateToCny} onChange={event=>setFinance({...finance,exchangeRateToCny:event.target.value})}/></Field>
              <Field label="单位总成本"><input type="number" min="0" value={finance.unitCost} onChange={event=>setFinance({...finance,unitCost:event.target.value})}/></Field>
              <Field label="计划售价"><input type="number" min="0" value={finance.plannedPrice} onChange={event=>setFinance({...finance,plannedPrice:event.target.value})}/></Field>
              <Field label="平台费率"><input type="number" min="0" max="1" step=".01" value={finance.platformFeeRate} onChange={event=>setFinance({...finance,platformFeeRate:event.target.value})}/></Field>
              <Field label="支付费率"><input type="number" min="0" max="1" step=".01" value={finance.paymentFeeRate} onChange={event=>setFinance({...finance,paymentFeeRate:event.target.value})}/></Field>
              <Field label="预计退款率"><input type="number" min="0" max="1" step=".01" value={finance.refundRate} onChange={event=>setFinance({...finance,refundRate:event.target.value})}/></Field>
              <Field label="税费率"><input type="number" min="0" max="1" step=".01" value={finance.taxRate} onChange={event=>setFinance({...finance,taxRate:event.target.value})}/></Field>
              <Field label="进口关税率"><input type="number" min="0" max="1" step=".01" value={finance.importDutyRate} onChange={event=>setFinance({...finance,importDutyRate:event.target.value})}/></Field>
              <Field label="单件物流成本"><input type="number" min="0" value={finance.logisticsCost} onChange={event=>setFinance({...finance,logisticsCost:event.target.value})}/></Field>
              <Field label="单件广告成本"><input type="number" min="0" value={finance.adCost} onChange={event=>setFinance({...finance,adCost:event.target.value})}/></Field>
              <Field label="前期固定投入"><input type="number" min="0" value={finance.fixedCost} onChange={event=>setFinance({...finance,fixedCost:event.target.value})}/></Field>
              <Field label="目标毛利率"><input type="number" min=".01" max=".99" step=".01" value={finance.targetGrossMarginRate} onChange={event=>setFinance({...finance,targetGrossMarginRate:event.target.value})}/></Field>
              <Field label="财务结论" span={4}><input value={finance.conclusion} onChange={event=>setFinance({...finance,conclusion:event.target.value})}/></Field>
            </div>
            <div className="finance-preview"><span>单件贡献 <strong>{financePreview.contribution.toFixed(2)}</strong></span><span>测算毛利率 <strong>{pct(financePreview.margin)}</strong></span><span>盈亏平衡 <strong>{financePreview.breakEven===null?"不可达":`${fmt(financePreview.breakEven)}件`}</strong></span></div>
            <div className="form-actions"><button className="btn primary" disabled={busy||!finance.plannedPrice||!finance.unitCost} onClick={()=>act("submitNewProductStage",{projectId:selected.id,stageKey:"finance",...finance,...Object.fromEntries(Object.entries(finance).filter(([key])=>!["conclusion","currency"].includes(key)).map(([key,value])=>[key,Number(value)]))},"财务测算已提交，并生成首批数量建议")}>提交财务测算</button></div>
          </>:<Empty>等待财务提交成本与毛利测算</Empty>}
        </Panel>
        <Panel title="继续或止损" desc="毛利低于本项目目标时，只能重新定价或放弃">
          {record("finance")?<div className="stage-summary"><strong>测算结果</strong><p>毛利率 {pct(record("finance").data.grossMarginRate)}｜目标 {pct(record("finance").data.targetGrossMarginRate)}｜盈亏平衡 {record("finance").data.breakEvenQty===null?"不可达":`${fmt(record("finance").data.breakEvenQty)}件`}</p><span>{record("finance").actor_name} · {readableDate(record("finance").submitted_at)}</span></div>:<Empty>尚未提交测算</Empty>}
          {actor.role==="管理员"&&<div className="form-actions"><button className="btn danger" disabled={busy} onClick={()=>decide("abandon")}>放弃</button><button className="btn" disabled={busy||!record("finance")} onClick={()=>decide("reprice")}>重新定价</button><button className="btn primary" disabled={busy||!record("finance")} onClick={()=>decide("continue")}>进入打板</button></div>}
        </Panel>
      </div>}
      {selected.stage==="sample"&&selected.status==="active"&&<div className="grid-2 npi-action-grid">
        <Panel title="阶段5 打板确认" desc="工厂提交样品结果，新品开发与运营主管分别确认">
          {["管理员","工厂"].includes(actor.role)?<>
            <div className="form-grid">
              <Field label="样品/打板编号" span={2}><input value={sample.sampleRef} onChange={event=>setSample({...sample,sampleRef:event.target.value})}/></Field>
              <Field label="外观结果"><select value={sample.appearanceResult} onChange={event=>setSample({...sample,appearanceResult:event.target.value})}><option>通过</option><option>不通过</option></select></Field>
              <Field label="质量结果"><select value={sample.qualityResult} onChange={event=>setSample({...sample,qualityResult:event.target.value})}><option>通过</option><option>不通过</option></select></Field>
              <Field label="样品说明" span={4}><input value={sample.note} onChange={event=>setSample({...sample,note:event.target.value})}/></Field>
            </div>
            <div className="form-actions"><button className="btn primary" disabled={busy||!sample.sampleRef||!sample.note} onClick={()=>act("submitNewProductStage",{projectId:selected.id,stageKey:"sample",...sample},"打板结果已提交")}>提交打板结果</button></div>
          </>:<Empty>等待工厂提交实物样品结果</Empty>}
          <div className="sample-confirmations">
            <div><Pill tone={(record("sample_development")?.source_version===record("sample")?.version?record("sample_development"):null)?"green":"red"}>{(record("sample_development")?.source_version===record("sample")?.version?record("sample_development"):null)?"新品开发已确认":"新品开发待确认"}</Pill>{["管理员","新品开发"].includes(actor.role)&&!(record("sample_development")?.source_version===record("sample")?.version?record("sample_development"):null)&&<><input value={developmentConfirmation} onChange={event=>setDevelopmentConfirmation(event.target.value)} placeholder="填写确认意见"/><button className="btn" disabled={busy||!developmentConfirmation} onClick={()=>act("submitNewProductStage",{projectId:selected.id,stageKey:"sample_development",confirmationNote:developmentConfirmation,conclusion:"确认通过"},"新品开发确认已记录")}>确认</button></>}</div>
            <div><Pill tone={(record("sample_operations")?.source_version===record("sample")?.version?record("sample_operations"):null)?"green":"red"}>{(record("sample_operations")?.source_version===record("sample")?.version?record("sample_operations"):null)?"运营主管已确认":"运营主管待确认"}</Pill>{["管理员","运营主管"].includes(actor.role)&&!(record("sample_operations")?.source_version===record("sample")?.version?record("sample_operations"):null)&&<><input value={operationsConfirmation} onChange={event=>setOperationsConfirmation(event.target.value)} placeholder="填写确认意见"/><button className="btn" disabled={busy||!operationsConfirmation} onClick={()=>act("submitNewProductStage",{projectId:selected.id,stageKey:"sample_operations",confirmationNote:operationsConfirmation,conclusion:"确认通过"},"运营主管确认已记录")}>确认</button></>}</div>
          </div>
        </Panel>
        <Panel title="首批备货数量与分配" desc={`系统建议 ${fmt(selected.recommended_first_batch_qty||selected.first_batch_qty)} 件；管理员确认最终数量后生成正式采购生产单`}>
          <Field label="最终首批数量"><input type="number" min="1" value={finalFirstBatchQty||String(selected.recommended_first_batch_qty||selected.first_batch_qty)} onChange={event=>setFinalFirstBatchQty(event.target.value)}/></Field>
          {allocations.map((row,index)=><div className="allocation-line" key={index}><select value={row.site} onChange={event=>setAllocations(allocations.map((item,i)=>i===index?{...item,site:event.target.value}:item))}>{SITES.map(site=><option key={site}>{site}</option>)}</select><select value={row.channel} onChange={event=>setAllocations(allocations.map((item,i)=>i===index?{...item,channel:event.target.value}:item))}>{REQUIRED_CHANNELS.map(channel=><option key={channel}>{channel}</option>)}</select><input aria-label="分配数量" type="number" min="1" value={row.qty} onChange={event=>setAllocations(allocations.map((item,i)=>i===index?{...item,qty:event.target.value}:item))}/>{index===0?<button className="btn" onClick={()=>setAllocations([...allocations,{site:SITES[0],channel:"Shopee",qty:""}])}>＋</button>:<button className="btn danger" onClick={()=>setAllocations(allocations.filter((_,i)=>i!==index))}>－</button>}</div>)}
          <div className={classNames("notice",allocationTotal===Number(finalFirstBatchQty||selected.recommended_first_batch_qty||selected.first_batch_qty)?"info":"warn")}>已分配 {fmt(allocationTotal)} / {fmt(finalFirstBatchQty||selected.recommended_first_batch_qty||selected.first_batch_qty)} 件</div>
          {actor.role==="管理员"&&<SupplyPicker users={data.users} value={supplyUserId} onChange={setSupplyUserId}/>}
          {actor.role==="管理员"&&<div className="form-actions"><button className="btn danger" disabled={busy} onClick={()=>decide("abandon")}>打板不通过 放弃</button><button className="btn primary" disabled={busy||!record("sample")||!(record("sample_development")?.source_version===record("sample")?.version?record("sample_development"):null)||!(record("sample_operations")?.source_version===record("sample")?.version?record("sample_operations"):null)||allocationTotal!==Number(finalFirstBatchQty||selected.recommended_first_batch_qty||selected.first_batch_qty)} onClick={()=>decide("continue",true)}>确认打板并生成采购生产单</button></div>}
        </Panel>
      </div>}
    </>}
  </>;
}

function Field({label,children,span}:{label:string;children:React.ReactNode;span?:number}) { return <div className={classNames("field",span===2&&"span-2",span===4&&"span-4")}><label>{label}{children}</label></div>; }

function SalesImport({data,act,busy}:{data:Snapshot;act:Act;busy:boolean}) {
  const actor=data.actor;
  const [form,setForm]=useState({businessDate:localDate(),site:actor.site||SITES[0],channel:actor.channel||"TikTok",sourceBatchRef:""});
  const [manual,setManual]=useState({sku:"",name:"",qty:"",unitPrice:"",amount:"",adCost:"",currency:SITE_CURRENCIES[actor.site as keyof typeof SITE_CURRENCIES]||"MYR"});
  const addManual=async()=>{
    const result=await act("salesImport",{...form,rows:[{...manual,qty:Number(manual.qty)}],fileName:"手工录入",importKey:`manual|${form.businessDate}|${form.site}|${form.channel}|${crypto.randomUUID()}`},"销售已录入并统一扣减库存");
    if(!result)return;
    setManual({...manual,sku:"",name:"",qty:"",unitPrice:"",amount:"",adCost:""});
  };
  const reverse=async(row:Row)=>{const reason=window.prompt("请输入冲销原因（将恢复对应库存并保留审计记录）");if(reason)await act("reverseSalesImport",{importId:row.id,reason},"错误导入已冲销，库存已恢复");};
  const canImport=hasPermission(actor.role,"sales.import");
  const updated=data.salesScopeStatus.filter(row=>row.updatedToday).length;
  return <>
    <PageHead title={canImport?"每日销售数据导入":"销售数据监控"} desc={canImport?`${actor.site} · ${actor.channel}｜由当前站点运营每日批量导入，系统自动扣减库存并更新补货建议`:"销售数据仅由各站点运营每日导入；当前页面为只读监控，可用于提前安排备货与产能"}>
      <Pill tone={updated===data.salesScopeStatus.length?"green":"red"}>今日已更新 {updated}/{data.salesScopeStatus.length}</Pill>
    </PageHead>
    <SalesDashboard actor={actor} refreshToken={data}/>
    <Panel title="每日销售更新状态" desc="当天未导入的站点显示红色待更新提醒">
      <div className="sales-scope-grid">{data.salesScopeStatus.map(row=><div className={classNames("sales-scope-card",row.updatedToday?"updated":"pending")} key={`${row.site}-${row.channel}`}><div><strong>{row.site}</strong><span>{row.channel}</span></div><Pill tone={row.updatedToday?"green":"red"}>{row.updatedToday?"今日已更新":"今日待更新"}</Pill><b>今日 {fmt(row.salesToday)}件</b><small>7天 {fmt(row.sales7Qty)}件｜最近 {row.lastSaleDate||"无记录"}</small></div>)}</div>
    </Panel>
    {canImport&&<>
    <Panel title="导入 Excel / CSV" desc="同一文件或平台报表编号不能重复导入；错误行需全部修正后再提交">
      <div className="form-grid">
        <Field label="销售日期"><input type="date" value={form.businessDate} onChange={e=>setForm({...form,businessDate:e.target.value})}/></Field>
        <Field label="站点"><select disabled={actor.role==="运营"} value={form.site} onChange={e=>setForm({...form,site:e.target.value})}>{SITES.map(s=><option key={s}>{s}</option>)}</select></Field>
        <Field label="渠道"><select disabled={actor.role==="运营"} value={form.channel} onChange={e=>setForm({...form,channel:e.target.value})}>{REQUIRED_CHANNELS.map(s=><option key={s}>{s}</option>)}</select></Field>
        <Field label="平台报表/订单批次号"><input value={form.sourceBatchRef} onChange={e=>setForm({...form,sourceBatchRef:e.target.value})} placeholder="必填，用于识别重复数据"/></Field>
      </div>
      <TableImport kind="sales" busy={busy} defaults={{currency:SITE_CURRENCIES[form.site as keyof typeof SITE_CURRENCIES]}} contextKey={JSON.stringify(form)} confirmLabel="确认导入销售并扣库" description="每行填写SKU、销量、成交单价或销售额、投放成本、币种（默认站点本币）。销售额优先于单价×销量；金额使用英文小数点、最多两位小数。未提供金额或成本请留空，明确无投放填0；有投放未出单可填销量0。投放成本填写该行SKU的分摊金额，同一笔费用只计一次，勿把整店成本复制到每行。" onApply={async(rows,meta)=>{
        if(form.sourceBatchRef.trim().length<3)throw Error("请先填写至少3个字符的平台报表/订单批次号");
        return Boolean(await act("salesImport",{...form,rows,...meta,importKey:`file|${form.businessDate}|${form.site}|${form.channel}|${meta.fileHash}`},"销售已导入，库存流水同步生成"));
      }}/>
    </Panel>
    <Panel title="单条销售录入" desc="与批量导入一致：销售记录、库存余额和库存流水同时写入">
      <div className="form-grid">
        <Field label="SKU"><input value={manual.sku} onChange={e=>setManual({...manual,sku:e.target.value})}/></Field>
        <Field label="商品名称"><input value={manual.name} onChange={e=>setManual({...manual,name:e.target.value})}/></Field>
        <Field label="销量"><input type="number" min="0" value={manual.qty} onChange={e=>setManual({...manual,qty:e.target.value})}/></Field>
        <Field label="成交单价（选填）"><input type="number" min="0" step="0.01" value={manual.unitPrice} onChange={e=>setManual({...manual,unitPrice:e.target.value})}/></Field>
        <Field label="实际销售额（优先于单价）"><input type="number" min="0" step="0.01" value={manual.amount} onChange={e=>setManual({...manual,amount:e.target.value})}/></Field>
        <Field label="投放成本（无投放填0）"><input type="number" min="0" step="0.01" value={manual.adCost} onChange={e=>setManual({...manual,adCost:e.target.value})}/></Field>
        <Field label="币种"><select value={manual.currency} onChange={e=>setManual({...manual,currency:e.target.value})}>{SALES_CURRENCIES.map(c=><option key={c}>{c}</option>)}</select></Field>
        <Field label="平台订单/汇总编号"><input value={form.sourceBatchRef} onChange={e=>setForm({...form,sourceBatchRef:e.target.value})} placeholder="必填且不可重复"/></Field>
      </div>
      <div className="form-actions"><button className="btn primary" disabled={busy||!manual.sku||!manual.qty||!form.sourceBatchRef||!actor.site&&actor.role==="运营"} onClick={addManual}>录入并扣库</button></div>
    </Panel>
    </>}
    <Panel title="最近导入批次" desc="唯一导入标识可追溯">
      <div className="table-wrap"><table><thead><tr><th>日期</th><th>站点/渠道</th><th>来源编号</th><th>文件</th><th className="num">SKU数</th><th className="num">销量</th><th>状态/导入时间</th><th></th></tr></thead><tbody>{data.imports.length===0?<tr><td colSpan={8}><Empty>暂无导入记录</Empty></td></tr>:data.imports.map(r=><tr key={r.id}><td>{r.business_date}</td><td>{r.site} · {r.channel}</td><td>{r.source_batch_ref||"—"}</td><td>{r.file_name}</td><td className="num">{r.row_count}</td><td className="num">{fmt(r.total_qty)}</td><td><Pill tone={r.reversed_at?"red":"green"}>{r.reversed_at?"已冲销":"有效"}</Pill><div className="cell-note">{readableDate(r.created_at)}</div></td><td>{!r.reversed_at&&hasPermission(actor.role,"sales.reverse")&&<button className="btn danger" disabled={busy} onClick={()=>reverse(r)}>冲销</button>}</td></tr>)}</tbody></table></div>
    </Panel>
  </>;
}

function Inventory({data,act,busy}:{data:Snapshot;act:Act;busy:boolean}) {
  const actor=data.actor;
  const [adjust,setAdjust]=useState({site:actor.site||SITES[0],channel:actor.channel||"TikTok",sku:"",countedQty:"",reason:""});
  const select=(r:Row)=>setAdjust({site:r.site,channel:r.channel,sku:r.sku,countedQty:String(Math.max(0,Number(r.qty))),reason:""});
  const submitCount=()=>act(actor.role==="管理员"?"inventoryAdjust":"submitInventoryCount",{...adjust,countedQty:Number(adjust.countedQty)},actor.role==="管理员"?"管理员库存修正已写入审计流水":"盘点差异已提交供应链复核");
  const decide=async(request:Row,decision:string)=>{const comment=window.prompt(decision==="approve"?"请输入复核意见":"请输入驳回原因");if(comment)await act("decideInventoryCount",{requestId:request.id,decision,comment},decision==="approve"?"盘点差异已批准并修正库存":"盘点差异已驳回");};
  const resolve=async(row:Row,resolution:string)=>{const qty=window.prompt(`本次处理数量（最多${row.quarantine_qty}）`,String(row.quarantine_qty));const reason=window.prompt(resolution==="release"?"请输入质检放行依据":"请输入报损原因");if(qty&&reason)await act("resolveInventoryHold",{site:row.site,channel:row.channel,sku:row.sku,qty:Number(qty),resolution,reason},resolution==="release"?"质检放行已记录：退货恢复可售，运输隔离品进入待上架":"隔离库存已报损");};
  const canSubmit=hasPermission(actor.role,"inventory.count.submit")||hasPermission(actor.role,"inventory.adjust");
  return <>
    <PageHead title="库存余额与流水" desc="预留是可售账面中的锁定部分；可用等于账面可售减预留；运营盘点差异须经供应链复核"/>
    {canSubmit&&<Panel title={actor.role==="管理员"?"批量导入期初库存 / 盘点修正":"批量导入盘点实数"} desc={actor.role==="管理员"?"按站点、渠道、SKU设置实盘数，直接修正可售库存；同一文件仅可成功导入一次":"只提交当前账号站点渠道的盘点差异，供应链复核后生效"}>
      <TableImport kind="inventory" busy={busy} defaults={{site:actor.site||"",channel:actor.channel||""}} contextKey={actor.id} templateRows={data.inventory.map(r=>({site:r.site,channel:r.channel,sku:r.sku,name:r.name,countedQty:"",reason:""}))} confirmLabel={actor.role==="管理员"?"确认批量修正库存":"确认批量提交复核"} description="盘点实数是目标可售库存，不是新增数量；0代表清零。请填写调整原因，预留、待上架和隔离数量保持原业务口径。每次最多200行，整批成功或整批撤销。" onApply={async(rows,meta)=>{
        const result=await act("bulkImport",{kind:"inventory",rows,...meta},actor.role==="管理员"?"库存文件已导入":"盘点文件已提交复核");
        if(result)window.alert(`已处理 ${result.imported} 条，${result.skipped} 条与系统数量一致，无需调整。`);
        return Boolean(result);
      }}/>
    </Panel>}
    <Panel title="库存余额" desc="运输到仓先进入待上架或隔离；退货经质检放行后恢复原渠道可售库存">
      <div className="table-wrap"><table><thead><tr><th>站点</th><th>渠道</th><th>SKU</th><th>商品</th><th className="num">账面可售 / 可用</th><th className="num">待上架</th><th className="num">已预留</th><th className="num">隔离</th><th>更新时间</th><th></th></tr></thead><tbody>{data.inventory.length===0?<tr><td colSpan={10}><Empty>暂无库存，请通过到仓单或管理员建立期初库存</Empty></td></tr>:data.inventory.map(r=><tr key={`${r.site}-${r.channel}-${r.sku}`}><td>{r.site}</td><td>{r.channel}</td><td><strong>{r.sku}</strong></td><td>{r.name||"—"}</td><td className="num"><strong>{fmt(r.qty)} / {fmt(Number(r.qty)-Number(r.reserved_qty||0))}</strong></td><td className="num">{fmt(r.pending_shelf_qty)}</td><td className="num">{fmt(r.reserved_qty)}</td><td className="num" style={{color:r.quarantine_qty>0?"var(--amber)":undefined}}>{fmt(r.quarantine_qty)}</td><td>{readableDate(r.updated_at)}</td><td><div style={{display:"flex",gap:5,flexWrap:"wrap"}}>{canSubmit&&<button className="btn" onClick={()=>select(r)}>盘点</button>}{r.quarantine_qty>0&&hasPermission(actor.role,"inventory.hold.resolve")&&<><button className="btn" onClick={()=>resolve(r,"release")}>质检放行</button><button className="btn danger" onClick={()=>resolve(r,"writeoff")}>报损</button></>}</div></td></tr>)}</tbody></table></div>
    </Panel>
    {canSubmit&&<Panel title={actor.role==="管理员"?"管理员库存修正":"提交盘点差异"} desc={actor.role==="管理员"?"用于期初库存或经过核实的例外修正；全程记录审计":"运营只提交实盘数，供应链复核通过后才改变可售库存"}>
      <div className="form-grid">
        <Field label="站点"><select disabled={actor.role==="运营"} value={adjust.site} onChange={e=>setAdjust({...adjust,site:e.target.value})}>{SITES.map(s=><option key={s}>{s}</option>)}</select></Field>
        <Field label="渠道"><select disabled={actor.role==="运营"} value={adjust.channel} onChange={e=>setAdjust({...adjust,channel:e.target.value})}>{CHANNELS.map(s=><option key={s}>{s}</option>)}</select></Field>
        <Field label="SKU"><input value={adjust.sku} onChange={e=>setAdjust({...adjust,sku:e.target.value})}/></Field>
        <Field label="盘点实数"><input type="number" min="0" value={adjust.countedQty} onChange={e=>setAdjust({...adjust,countedQty:e.target.value})}/></Field>
        <Field label="调整原因" span={4}><textarea value={adjust.reason} onChange={e=>setAdjust({...adjust,reason:e.target.value})} placeholder="例如：平台仓盘点差异、退件重新上架、破损报损"/></Field>
      </div>
      <div className="form-actions"><button className="btn primary" disabled={busy||!adjust.sku||adjust.reason.length<4} onClick={submitCount}>{actor.role==="管理员"?"确认修正":"提交复核"}</button></div>
    </Panel>}
    {hasPermission(actor.role,"inventory.count.approve")&&<Panel title="待复核盘点差异" desc="批准前系统会再次核对提交时库存，防止覆盖后续变动"><div className="table-wrap"><table><thead><tr><th>站点/渠道</th><th>SKU</th><th className="num">系统数</th><th className="num">实盘数</th><th>原因</th><th>状态</th><th></th></tr></thead><tbody>{data.countRequests.length===0?<tr><td colSpan={7}><Empty>暂无盘点差异单</Empty></td></tr>:data.countRequests.map(row=><tr key={row.id}><td>{row.site} · {row.channel}</td><td>{row.sku}</td><td className="num">{fmt(row.system_qty)}</td><td className="num">{fmt(row.counted_qty)}</td><td>{row.reason}</td><td><Pill tone={row.status==="approved"?"green":"red"}>{row.status==="pending"?"待复核":row.status==="approved"?"已批准":"已驳回"}</Pill></td><td>{row.status==="pending"&&<><button className="btn primary" disabled={busy} onClick={()=>decide(row,"approve")}>批准</button> <button className="btn danger" disabled={busy} onClick={()=>decide(row,"reject")}>驳回</button></>}</td></tr>)}</tbody></table></div></Panel>}
    <Panel title="最近库存流水" desc="每一笔库存变化均可追溯到业务凭证">
      <div className="table-wrap"><table><thead><tr><th>时间</th><th>类型</th><th>站点/渠道</th><th>SKU</th><th className="num">变动</th><th className="num">变动后</th><th>凭证</th><th>说明</th></tr></thead><tbody>{data.movements.length===0?<tr><td colSpan={8}><Empty>暂无库存流水</Empty></td></tr>:data.movements.map(r=><tr key={r.id}><td>{String(r.created_at).replace("T"," ").slice(0,16)}</td><td><Pill tone={MOVEMENT_TONE[r.movement_type]||"blue"}>{r.movement_type}</Pill></td><td>{r.site} · {r.channel}</td><td>{r.sku}</td><td className="num" style={{color:r.qty_delta<0?"var(--red)":"var(--green)"}}>{r.qty_delta>0?"+":""}{fmt(r.qty_delta)}</td><td className="num">{fmt(r.balance_after)}</td><td>{r.reference_type}<br/><span style={{color:"var(--muted)"}}>{r.reference_id}</span></td><td>{r.note}</td></tr>)}</tbody></table></div>
    </Panel>
  </>;
}

function Receipt({data,act,busy}:{data:Snapshot;act:Act;busy:boolean}) {
  const [form,setForm]=useState({receiptNo:"",sku:"",name:"",sourceBatch:"",proofRef:""});
  const [allocations,setAllocations]=useState<AllocationDraft[]>([{site:SITES[0],channel:"TikTok",qty:""}]);
  const totalQty=allocations.reduce((s,r)=>s+(Number(r.qty)||0),0);
  const submit=async()=>{
    const result=await act("receiveInbound",{...form,totalQty,allocations:allocations.map(r=>({...r,qty:Number(r.qty)}))},form.sourceBatch?"到仓已入库，下一步由各站点运营确认上架":"到仓单已按真实站点和渠道入库");
    if(!result)return;
    setForm({receiptNo:"",sku:"",name:"",sourceBatch:"",proofRef:""});setAllocations([{site:SITES[0],channel:"TikTok",qty:""}]);
  };
  return <>
    <PageHead title="渠道级到仓入库" desc="不再按平台各半估算；到仓单号唯一，重复提交会被系统阻止"/>
    {hasPermission(data.actor.role,"inbound.receive")&&<Panel title="批量导入到仓单" desc="可一次导入多张到仓单及其站点渠道分配">
      <TableImport kind="inbound" busy={busy} confirmLabel="确认整批到仓入库" description="每行填写到仓单号、SKU、站点、渠道、实收数量和到仓凭证。同一单号对应一个SKU，可分配到多个渠道；不同SKU请使用不同单号。供应链必须填写历史生产批次，管理员可导入例外入库。每次最多200行。" validate={rows=>{groupInboundRows(rows);}} onApply={async(rows,meta)=>Boolean(await act("bulkImport",{kind:"inbound",rows,...meta},"到仓文件已整批导入，库存与流水已更新"))}/>
    </Panel>}
    {hasPermission(data.actor.role,"inbound.receive")&&<Panel title="新建到仓单" desc="每一行必须明确站点、渠道和实收数量">
      <div className="form-grid">
        <Field label="到仓单号"><input value={form.receiptNo} onChange={e=>setForm({...form,receiptNo:e.target.value})} placeholder="例如 WH-202609-001"/></Field>
        <Field label="SKU"><input value={form.sku} onChange={e=>setForm({...form,sku:e.target.value})}/></Field>
        <Field label="商品名称"><input value={form.name} onChange={e=>setForm({...form,name:e.target.value})}/></Field>
        <Field label="关联历史生产批次"><select value={form.sourceBatch} onChange={e=>setForm({...form,sourceBatch:e.target.value})}>{data.actor.role==="管理员"&&<option value="">管理员例外入库</option>}{data.actor.role!=="管理员"&&<option value="">必须选择批次</option>}{data.batches.filter(b=>b.stage==="awaiting_receipt").map(b=><option key={b.id} value={b.id}>{b.id} · {b.sku}</option>)}</select></Field>
        <Field label="到仓凭证/文件编号" span={4}><input value={form.proofRef} onChange={e=>setForm({...form,proofRef:e.target.value})} placeholder="必填：海外仓入库单、签收单或共享文件编号"/></Field>
      </div>
      <div style={{marginTop:16}}>
        {allocations.map((r,i)=><div className="form-grid" key={i} style={{marginBottom:9}}>
          <Field label={i===0?"站点":""}><select value={r.site} onChange={e=>setAllocations(allocations.map((x,j)=>j===i?{...x,site:e.target.value}:x))}>{SITES.map(s=><option key={s}>{s}</option>)}</select></Field>
          <Field label={i===0?"渠道":""}><select value={r.channel} onChange={e=>setAllocations(allocations.map((x,j)=>j===i?{...x,channel:e.target.value}:x))}>{CHANNELS.map(c=><option key={c}>{c}</option>)}</select></Field>
          <Field label={i===0?"实收数量":""}><input type="number" min="1" value={r.qty} onChange={e=>setAllocations(allocations.map((x,j)=>j===i?{...x,qty:e.target.value}:x))}/></Field>
          <div style={{alignSelf:"end"}}>{i===0?<button className="btn" onClick={()=>setAllocations([...allocations,{site:SITES[0],channel:"TikTok",qty:""}])}>＋ 增加分配</button>:<button className="btn danger" onClick={()=>setAllocations(allocations.filter((_,j)=>j!==i))}>移除</button>}</div>
        </div>)}
      </div>
      <div className="notice info">本次实收合计：<strong>{fmt(totalQty)} 件</strong>。系统将逐行写入对应渠道库存和库存流水。</div>
      <div className="form-actions"><button className="btn primary" disabled={busy||!form.receiptNo||!form.sku||!form.proofRef||totalQty<=0} onClick={submit}>确认到仓入库</button></div>
    </Panel>}
    <Panel title="最近到仓单">
      <div className="table-wrap"><table><thead><tr><th>到仓时间</th><th>单号</th><th>SKU</th><th className="num">实收</th><th>关联批次</th><th>凭证</th><th>渠道分配</th></tr></thead><tbody>{data.receipts.length===0?<tr><td colSpan={7}><Empty>暂无到仓单</Empty></td></tr>:data.receipts.map(r=><tr key={r.id}><td>{String(r.received_at).replace("T"," ").slice(0,16)}</td><td>{r.receipt_no}</td><td>{r.sku}<br/>{r.name}</td><td className="num">{fmt(r.total_qty)}</td><td>{r.source_batch||"—"}</td><td>{r.proof_ref}</td><td>{String(r.allocations||"").split(";;").filter(Boolean).map((a:string)=>{const [s,c,q]=a.split("|");return <div key={a}>{s} · {c}：{fmt(q)}</div>})}</td></tr>)}</tbody></table></div>
    </Panel>
  </>;
}

function Monthly({data,act,busy}:{data:Snapshot;act:Act;busy:boolean}) {
  const submitted=data.monthlyStatus.filter(r=>r.submitted).length;
  return <>
    <PageHead title="月度备货计划" desc="提交完整度是进入审批的硬门槛，不允许部分站点计划提前审批">
      {submitted===data.monthlyStatus.length?<Pill tone="green">已全部提交</Pill>:<Pill tone="red">待提交 {data.monthlyStatus.length-submitted} 项</Pill>}
    </PageHead>
    <Panel title={`${data.currentMonth} 提交矩阵`} desc="五个站点的TikTok与Shopee">
      <div className="table-wrap"><table><thead><tr><th>站点</th><th>TikTok</th><th>Shopee</th></tr></thead><tbody>{SITES.map(site=><tr key={site}><td><strong>{site}</strong></td>{REQUIRED_CHANNELS.map(channel=>{const r=data.monthlyStatus.find(x=>x.site===site&&x.channel===channel);return <td key={channel}>{r?.submitted?<Pill tone="green">已提交</Pill>:<Pill tone="red">未提交</Pill>}</td>})}</tr>)}</tbody></table></div>
      {hasPermission(data.actor.role,"plan.submit")&&<div className="form-actions"><button className="btn primary" disabled={busy||submitted!==data.monthlyStatus.length} onClick={()=>act("submitPlan",{month:data.currentMonth},"已按产品系列汇总并提交管理员审批")}>按系列汇总并提交审批</button></div>}
    </Panel>
    <Panel title="各站点提交记录" desc="进入审批后锁定；已批准计划通过变更审批调整">
      <div className="table-wrap"><table><thead><tr><th>月份</th><th>站点/渠道</th><th className="num">SKU数</th><th className="num">备货量</th><th>提交时间</th></tr></thead><tbody>{data.submissions.length===0?<tr><td colSpan={5}><Empty>暂无月度提交记录</Empty></td></tr>:data.submissions.map(r=><tr key={r.id}><td>{r.month}</td><td>{r.site} · {r.channel}</td><td className="num">{r.items.length}</td><td className="num">{fmt(r.total_qty)}</td><td>{String(r.submitted_at).replace("T"," ").slice(0,16)}</td></tr>)}</tbody></table></div>
    </Panel>
    <PlanChanges data={data} act={act} busy={busy}/>
  </>;
}

function Approvals({data,act,busy,goWholesale}:{data:Snapshot;act:Act;busy:boolean;goWholesale:()=>void}) {
  const [supplyUserId,setSupplyUserId]=useState("");
  const decide=async(id:string,decision:string)=>{
    const comment=window.prompt(decision==="approve"?"请输入批准意见":"请输入驳回原因");
    if(!comment) return;
    await act("decideApproval",{approvalId:id,decision,comment,supplyUserId},decision==="approve"?"计划已批准并生成系列采购单与生产单":"计划已驳回");
  };
  return <>
    <SupplyPicker users={data.users} value={supplyUserId} onChange={setSupplyUserId}/>
    <PageHead title="审批中心" desc="申请人不能审批自己的计划；审批通过后按产品系列生成采购单与生产单"/>
    {hasPermission(data.actor.role,"wholesale.approve")&&<div className="notice info">印尼线下出库待审批 {data.myTasks.filter(t=>t.title==="审批线下出库").length} 笔。<button className="btn" onClick={goWholesale}>前往线下批发审批</button></div>}
    <Panel title="计划审批记录">
      <div className="table-wrap"><table><thead><tr><th>月份</th><th>状态</th><th className="num">系列数</th><th className="num">SKU数</th><th className="num">总数量</th><th>审批意见</th><th></th></tr></thead><tbody>{data.approvals.length===0?<tr><td colSpan={7}><Empty>暂无审批记录</Empty></td></tr>:data.approvals.map(r=>{const items=r.payload?.items||[],seriesOrders=r.payload?.seriesOrders||[];return <tr key={r.id}><td>{r.month}</td><td><Pill tone={r.status==="approved"?"green":"red"}>{r.status==="approved"?"已批准":r.status==="rejected"?"已驳回":"待审批"}</Pill></td><td className="num">{fmt(seriesOrders.length)}</td><td className="num">{items.length}</td><td className="num">{fmt(items.reduce((s:number,x:Row)=>s+Number(x.total||0),0))}</td><td>{r.decision_comment||"—"}</td><td>{r.status==="pending"&&hasPermission(data.actor.role,"approval.decide")&&<div style={{display:"flex",gap:6}}><button disabled={busy} className="btn primary" onClick={()=>decide(r.id,"approve")}>批准</button><button disabled={busy} className="btn danger" onClick={()=>decide(r.id,"reject")}>驳回</button></div>}</td></tr>})}</tbody></table></div>
    </Panel>
  </>;
}

function Fulfillment({data,act,busy}:{data:Snapshot;act:Act;busy:boolean}){
  const [productionEdit,setProductionEdit]=useState("");
  const [producedDraft,setProducedDraft]=useState<Record<string,string>>({});
  const statusLabel:Record<string,string>={draft:"待供应商确认",supplier_confirmed:"供应商已接单",in_production:"生产中",awaiting_qc:"待质检",ready_to_ship:"可发货",qc_rejected:"质检不通过",awaiting_order:"待采购确认",awaiting_factory:"待工厂接单",pending:"历史待生产",completed:"已完工",completed_with_variance:"差异完工"};
  const startProduction=(order:Row)=>{setProductionEdit(order.id);setProducedDraft(Object.fromEntries(order.items.map((item:Row)=>[item.id,String(item.planned_qty)])));};
  const finishProduction=async(order:Row)=>{
    const evidenceRef=window.prompt("请输入工厂生产单号或完工凭证");if(!evidenceRef)return;
    const note=window.prompt("请输入完工说明；如有短装或超产请说明原因")||"系列生产已完成";
    const result=await act("completeProductionOrder",{productionOrderId:order.id,evidenceRef,note,items:order.items.map((item:Row)=>({id:item.id,producedQty:Number(producedDraft[item.id]||0)}))},"系列生产完工数量已登记");
    if(result)setProductionEdit("");
  };
  const confirmPurchase=async(order:Row)=>{const orderRef=window.prompt("供应商订单号");const expectedCompletionDate=window.prompt("预计完工日（YYYY-MM-DD）",localDate());const note=window.prompt("接单说明")||"供应商已确认";if(orderRef&&expectedCompletionDate)await act("confirmPurchaseOrder",{purchaseOrderId:order.id,orderRef,expectedCompletionDate,note},"供应商接单已确认并推送工厂");};
  const acceptProduction=async(order:Row)=>{const promisedCompletionDate=window.prompt("工厂承诺完工日（YYYY-MM-DD）",order.promised_completion_date||localDate());const evidenceRef=window.prompt("工厂接单凭证编号");const note=window.prompt("接单说明")||"已排产";if(promisedCompletionDate&&evidenceRef)await act("acceptProductionOrder",{productionOrderId:order.id,promisedCompletionDate,evidenceRef,note},"工厂已接单并进入生产");};
  const updateProgress=async(order:Row)=>{const progressPct=window.prompt("最新生产进度（1—99）",String(Math.max(1,Number(order.progress_pct||1))));const evidenceRef=window.prompt("进度凭证编号");const note=window.prompt("进度说明")||"生产进度更新";if(progressPct&&evidenceRef)await act("updateProductionProgress",{productionOrderId:order.id,progressPct:Number(progressPct),evidenceRef,note},"生产进度已更新");};
  const qc=async(order:Row,decision:string)=>{const evidenceRef=window.prompt("质检报告/抽检单编号");const note=window.prompt(decision==="pass"?"质检通过说明":"不通过原因与返工要求");if(evidenceRef&&note)await act("confirmProductionQc",{productionOrderId:order.id,decision,evidenceRef,note},decision==="pass"?"质检通过，可进入发货":"质检不通过，已暂停发货");};
  return <>
    <PageHead title="系列采购与生产" desc="运营需求保留SKU，供应链和工厂按产品系列协同">
      <Pill tone={data.metrics.readyToShipProductionOrderCount?"red":"green"}>{data.metrics.readyToShipProductionOrderCount?`${data.metrics.readyToShipProductionOrderCount}张生产单待发货`:"生产发货衔接正常"}</Pill>
    </PageHead>
    <div className="metrics">
      <div className="metric"><div className="label">系列采购单</div><div className="value">{fmt(data.purchaseOrders.length)}</div><div className="foot">按系列＋供应商合并</div></div>
      <div className="metric"><div className="label">生产执行中</div><div className="value">{fmt(data.metrics.activeProductionOrderCount)}</div><div className="foot">工厂按系列排产</div></div>
      <div className="metric"><div className="label">待创建海运批次</div><div className="value">{fmt(data.metrics.readyToShipProductionOrderCount)}</div><div className="foot">可按SKU拆分发货</div></div>
      <div className="metric"><div className="label">运输主批次</div><div className="value">{fmt(data.transportBatches.length)}</div><div className="foot">可跨系列合柜，多目的地分腿</div></div>
    </div>
    <Panel title="系列采购单" desc="默认只展示系列汇总；SKU明细在生产单中追溯">
      <div className="table-wrap"><table><thead><tr><th>月份</th><th>系列</th><th>供应商</th><th className="num">SKU数</th><th className="num">下单数量</th><th>订单/交期</th><th>状态</th><th></th></tr></thead><tbody>{data.purchaseOrders.length===0?<tr><td colSpan={8}><Empty>管理员批准月度计划后自动生成系列采购单</Empty></td></tr>:data.purchaseOrders.map(order=><tr key={order.id}><td>{order.month}</td><td><strong>{order.series_name}</strong><div className="cell-note">{order.id}</div></td><td>{order.supplier_name}</td><td className="num">{fmt(order.visibleSkuCount)}</td><td className="num">{fmt(order.visibleQty)}</td><td>{order.order_ref||"—"}<div className="cell-note">{order.expected_completion_date||"待确认"}</div></td><td><Pill tone={order.status==="draft"?"red":order.status==="qc_rejected"?"red":"green"}>{statusLabel[order.status]||order.status}</Pill></td><td>{["draft","ordered"].includes(order.status)&&hasPermission(data.actor.role,"purchase.confirm")&&<button className="btn primary" disabled={busy} onClick={()=>confirmPurchase(order)}>确认接单</button>}<PurchaseReassign data={data} order={order} act={act} busy={busy}/></td></tr>)}</tbody></table></div>
    </Panel>
    <Panel title="系列生产单" desc="工厂登记各SKU完工数量；供应链按剩余可发量创建一个或多个海运批次">
      {data.productionOrders.length===0?<Empty>暂无系列生产单</Empty>:<div className="order-card-list">{data.productionOrders.map(order=><article className={classNames("order-card",order.producedVariance&&["completed","completed_with_variance"].includes(order.status)&&"has-warning")} key={order.id}>
        <header><div><span>{order.id}</span><h4>{order.series_name}</h4><p>{order.factory_name}｜{order.items.length} 个SKU</p></div><div><Pill tone={order.status==="completed"?"green":order.status==="completed_with_variance"?"amber":"blue"}>{statusLabel[order.status]||order.status}</Pill></div></header>
        <div className="order-summary"><span>计划<strong>{fmt(order.visiblePlannedQty)}</strong></span><span>进度<strong>{fmt(order.progress_pct)}%</strong></span><span>完工<strong>{fmt(order.visibleProducedQty)}</strong></span><span>待发<strong>{fmt(order.remainingToShip)}</strong></span><span>质检<strong>{order.qc_status==="passed"?"通过":order.qc_status==="rejected"?"不通过":"待确认"}</strong></span></div>
        <div className="table-wrap"><table className="trace-table"><thead><tr><th>SKU</th><th>商品</th><th className="num">下单</th><th className="num">计划生产</th><th className="num">实际完工</th><th className="num">累计发货</th><th className="num">剩余可发</th></tr></thead><tbody>{order.items.map((item:Row)=><tr key={item.id}><td><strong>{item.sku}</strong></td><td>{item.name||"—"}</td><td className="num">{fmt(item.orderedQty)}</td><td className="num">{fmt(item.visiblePlanned)}</td><td className="num">{productionEdit===order.id?<input className="qty-input" type="number" min="0" max={Number(item.planned_qty)*2} value={producedDraft[item.id]??""} onChange={event=>setProducedDraft({...producedDraft,[item.id]:event.target.value})}/>:fmt(item.visibleProduced)}</td><td className="num">{fmt(item.shippedQty)}</td><td className="num"><strong>{fmt(item.remainingToShip)}</strong></td></tr>)}</tbody></table></div>
        {productionEdit===order.id&&<div className="inline-editor"><div className="notice info">完工数量可以与计划不同，系统会自动形成生产差异预警。</div><div className="form-actions"><button className="btn" onClick={()=>setProductionEdit("")}>取消</button><button className="btn primary" disabled={busy} onClick={()=>finishProduction(order)}>提交完工数量</button></div></div>}
        <footer>
          {order.status==="awaiting_factory"&&hasPermission(data.actor.role,"production.accept")&&<button className="btn primary" disabled={busy} onClick={()=>acceptProduction(order)}>工厂接单</button>}
          {order.status==="in_production"&&hasPermission(data.actor.role,"production.progress")&&<button className="btn" disabled={busy} onClick={()=>updateProgress(order)}>更新进度</button>}
          {["in_production","pending"].includes(order.status)&&hasPermission(data.actor.role,"production.complete")&&productionEdit!==order.id&&<button className="btn primary" disabled={busy} onClick={()=>startProduction(order)}>登记系列完工</button>}
          {['completed','completed_with_variance'].includes(order.status)&&order.qc_status!=="passed"&&hasPermission(data.actor.role,"production.qc")&&<><button className="btn primary" disabled={busy} onClick={()=>qc(order,"pass")}>质检通过</button><button className="btn danger" disabled={busy} onClick={()=>qc(order,"reject")}>不通过</button></>}
          {order.qc_status==="passed"&&order.remainingToShip>0&&<span className="success-text">已通过质检，请到“海运批次”跨系列合并发货</span>}
          {order.producedVariance&&['completed','completed_with_variance'].includes(order.status)&&<span className="warning-text">计划与完工相差 {fmt(Math.abs(Number(order.total_planned_qty)-Number(order.total_produced_qty)))} 件</span>}
        </footer>
      </article>)}</div>}
    </Panel>
  </>;
}

function prorateForClient(allocations:Row[],total:number):Row[]{
  const base=allocations.reduce((sum,row)=>sum+Number(row.qty||0),0);if(base<=0||total<=0)return [];
  let used=0;return allocations.map((row,index)=>{const qty=index===allocations.length-1?total-used:Math.floor(total*Number(row.qty||0)/base);used+=qty;return {...row,qty};}).filter(row=>row.qty>0);
}

function TransportControl({data,act,busy}:{data:Snapshot;act:Act;busy:boolean}){
  const [receivingLeg,setReceivingLeg]=useState("");
  const activeLeg=data.transportBatches.flatMap(batch=>batch.legs).find(leg=>leg.id===receivingLeg);
  const ready=data.productionOrders.filter(order=>order.qc_status==="passed").flatMap(order=>order.items.filter((item:Row)=>Number(item.remainingToShip)>0).map((item:Row)=>({...item,seriesName:order.series_name,productionOrderId:order.id})));
  const [creating,setCreating]=useState(false),[form,setForm]=useState({batchNo:`TR-${localDate().replaceAll("-","")}-001`,containerNo:"",billNo:"",carrierName:"",note:""}),[selected,setSelected]=useState<Record<string,string>>({}),[allocationDraft,setAllocationDraft]=useState<Record<string,string>>({}),[warehouseDraft,setWarehouseDraft]=useState<Record<string,string>>({});
  const changeShipQty=(item:Row,value:string)=>{const total=Number(value)||0,nextAlloc={...allocationDraft},nextWarehouse={...warehouseDraft};for(const row of prorateForClient(item.allocations||[],total)){const key=`${item.id}|${row.site}|${row.channel}`;nextAlloc[key]=String(row.qty);nextWarehouse[key]=nextWarehouse[key]||data.warehouses.find(warehouse=>Number(warehouse.active)&&warehouse.site===row.site&&warehouse.channel===row.channel)?.id||"";}setSelected({...selected,[item.id]:value});setAllocationDraft(nextAlloc);setWarehouseDraft(nextWarehouse);};
  const create=async()=>{
    const items=ready.filter(item=>Number(selected[item.id])>0).map(item=>{const shippedQty=Number(selected[item.id]);return {productionOrderItemId:item.id,shippedQty,allocations:(item.allocations||[]).map((allocation:Row)=>({...allocation,qty:Number(allocationDraft[`${item.id}|${allocation.site}|${allocation.channel}`]||0),warehouseId:warehouseDraft[`${item.id}|${allocation.site}|${allocation.channel}`]||""})).filter((row:Row)=>row.qty>0)};});
    if(items.some(item=>item.allocations.reduce((sum:number,row:Row)=>sum+Number(row.qty),0)!==item.shippedQty)){alert("每个SKU的目的地分配合计必须等于本批发货量");return;}
    if(items.some(item=>item.allocations.some((row:Row)=>!row.warehouseId))){alert("存在目的地尚未维护启用仓库，请先到主数据页维护");return;}
    const result=await act("createTransportBatch",{...form,items},"跨系列运输主批次已建立，并按目的地拆分运输分腿");if(result){setCreating(false);setSelected({});setAllocationDraft({});setWarehouseDraft({});}
  };
  const advance=async(leg:Row)=>{const evidenceRef=window.prompt("业务凭证/单据编号");if(!evidenceRef)return;const note=window.prompt("节点说明")||"按流程推进";let etd="",eta="",ata="",portName="";if(leg.stage==="booking"){etd=window.prompt("ETD（YYYY-MM-DD）",localDate())||"";eta=window.prompt("ETA（YYYY-MM-DD）",localDate())||"";}if(leg.stage==="port_arrived"){ata=window.prompt("实际到港日（YYYY-MM-DD）",localDate())||"";portName=window.prompt("到港港口")||"";}await act("advanceTransportLeg",{legId:leg.id,version:leg.version,evidenceRef,note,etd,eta,ata,portName},"目的地运输节点已推进");};
  const updateEta=async(leg:Row)=>{const eta=window.prompt("新ETA（YYYY-MM-DD）",leg.eta||localDate());const reason=window.prompt("调整原因");if(eta&&reason)await act("updateTransportLegPlan",{legId:leg.id,eta,etd:leg.etd||"",reason},"目的地ETA已更新");};
  const receive=(leg:Row)=>setReceivingLeg(leg.id);
  const shelf=async(item:Row)=>{const listingRef=window.prompt(`${item.sku} 上架凭证/链接`);const note=window.prompt("上架说明")||"平台已上架";if(listingRef)await act("confirmTransportShelf",{legItemId:item.id,shelvedQty:Number(item.pending_shelf_qty),listingRef,note},"待上架库存已转为可售");};
  return <>
    {hasPermission(data.actor.role,"transport.create")&&<Panel title="创建跨系列运输主批次" desc="同一柜可合并多个产品系列；系统按目的地仓拆分独立ETA和状态" action={<button className="btn primary" onClick={()=>setCreating(!creating)}>{creating?"收起":"新建运输批次"}</button>}>
      {!creating?<div className="notice info">当前有 <strong>{ready.length}</strong> 个质检通过且未发完的SKU。建立主批次后仍保留生产单、系列和SKU追溯。</div>:<div className="inline-editor"><div className="form-grid"><Field label="运输主批次号"><input value={form.batchNo} onChange={e=>setForm({...form,batchNo:e.target.value})}/></Field><Field label="柜号"><input value={form.containerNo} onChange={e=>setForm({...form,containerNo:e.target.value})}/></Field><Field label="提单号"><input value={form.billNo} onChange={e=>setForm({...form,billNo:e.target.value})}/></Field><Field label="承运商"><select value={form.carrierName} onChange={e=>setForm({...form,carrierName:e.target.value})}><option value="">请选择</option>{data.businessPartners.filter(row=>row.type==="carrier"&&Number(row.active)).map(row=><option key={row.id}>{row.name}</option>)}</select></Field></div><div className="table-wrap"><table><thead><tr><th>系列</th><th>SKU</th><th className="num">剩余可发</th><th className="num">本批发货</th><th>目的地分配（可手调）/目的仓</th></tr></thead><tbody>{ready.length===0?<tr><td colSpan={5}><Empty>暂无质检通过且待发的SKU</Empty></td></tr>:ready.map(item=><tr key={item.id}><td>{item.seriesName}</td><td>{item.sku}</td><td className="num">{fmt(item.remainingToShip)}</td><td className="num"><input className="qty-input" type="number" min="0" max={item.remainingToShip} value={selected[item.id]||"0"} onChange={e=>changeShipQty(item,e.target.value)}/></td><td>{(item.allocations||[]).map((row:Row)=>{const key=`${item.id}|${row.site}|${row.channel}`;return <div className="destination-allocation" key={key}><span>{row.site} · {row.channel}</span><input className="qty-input" type="number" min="0" value={allocationDraft[key]||"0"} onChange={e=>setAllocationDraft({...allocationDraft,[key]:e.target.value})}/><select value={warehouseDraft[key]||""} onChange={e=>setWarehouseDraft({...warehouseDraft,[key]:e.target.value})}><option value="">目的仓</option>{data.warehouses.filter(warehouse=>Number(warehouse.active)&&warehouse.site===row.site&&warehouse.channel===row.channel).map(warehouse=><option value={warehouse.id} key={warehouse.id}>{warehouse.name}</option>)}</select></div>})}</td></tr>)}</tbody></table></div><div className="notice info">短装或分批发货时，请人工确认每个SKU的目的地分配；系统会校验累计数量不能超过原始运营需求。</div><div className="form-actions"><button className="btn primary" disabled={busy||!form.batchNo||!form.carrierName||!Object.values(selected).some(value=>Number(value)>0)} onClick={create}>生成主批次与目的地分腿</button></div></div>}
    </Panel>}
    {activeLeg&&<TransportReceipt key={activeLeg.id} leg={activeLeg} act={act} busy={busy} close={()=>setReceivingLeg("")}/>}
    <Panel title="运输主批次（默认汇总、异常优先）" desc="主批次可跨系列；每个目的地分腿拥有独立ETD、ETA、到港、清关、派送、到仓和上架状态">
      {data.transportBatches.length===0?<Empty>暂无新版运输主批次</Empty>:<div className="batch-card-list">{data.transportBatches.map(batch=><article className={classNames("batch-card",batch.exceptions.length&&"has-warning")} key={batch.id}><header><div><span>{batch.batch_no}</span><h4>{batch.carrier_name}</h4><p>{fmt(batch.series_count)}个系列 · {fmt(batch.visibleSkuCount)}个SKU · {fmt(batch.visibleQty)}件</p></div><Pill tone={batch.status==="completed"?"green":batch.exceptions.length?"amber":"blue"}>{batch.status==="completed"?"已完成":"运输中"}</Pill></header>{batch.legs.map((leg:Row)=><div className="transport-leg" key={leg.id}><div><strong>{leg.leg_no}</strong><span>{leg.site} · {leg.channel} · {leg.warehouse_name}</span></div><Pill tone={leg.exceptions.length?"amber":leg.stage==="on_shelf"?"green":"blue"}>{BATCH_LABEL[leg.stage]||leg.stage}</Pill><span>ETA {leg.eta||"待填写"}</span><span>到仓 {fmt(leg.receivedQty)}/{fmt(leg.total_qty)} · 待上架 {fmt(leg.pendingShelfQty)} · 隔离 {fmt(leg.quarantineQty)}</span><div className="leg-actions">{["booking","sea_freight","port_arrived","customs_clearance","last_mile_delivery"].includes(leg.stage)&&((leg.stage==="booking"&&hasPermission(data.actor.role,"transport.advance.supply"))||(leg.stage!=="booking"&&hasPermission(data.actor.role,"transport.advance.sea")))&&<button className="btn primary" disabled={busy} onClick={()=>advance(leg)}>推进节点</button>}{["booking","sea_freight","port_arrived","customs_clearance","last_mile_delivery"].includes(leg.stage)&&hasPermission(data.actor.role,"transport.eta")&&<button className="btn" disabled={busy} onClick={()=>updateEta(leg)}>更新ETA</button>}{leg.stage==="awaiting_receipt"&&hasPermission(data.actor.role,"transport.receive")&&<button className="btn primary" disabled={busy} onClick={()=>receive(leg)}>登记到仓</button>}{leg.stage==="shelf_pending"&&hasPermission(data.actor.role,"transport.shelf")&&leg.items.filter((item:Row)=>Number(item.pending_shelf_qty)>0).map((item:Row)=><button className="btn primary" key={item.id} disabled={busy} onClick={()=>shelf(item)}>{item.sku} 上架</button>)}</div>{leg.exceptions.map((issue:Row,index:number)=><div className="notice warn" key={index}><strong>{issue.type}</strong> {issue.detail}</div>)}</div>)}</article>)}</div>}
    </Panel>
  </>;
}

function TransportReceipt({leg,act,busy,close}:{leg:Row;act:Act;busy:boolean;close:()=>void}){
  const [form,setForm]=useState({receiptNo:"",proofRef:"",note:"目的地仓签收"});
  const [draft,setDraft]=useState<Record<string,{qty:string;quarantine:string}>>({});
  const items=leg.items.filter((item:Row)=>Number(item.qty)>Number(item.received_qty||0)).map((item:Row)=>({...item,remaining:Number(item.qty)-Number(item.received_qty||0)}));
  const submit=async()=>{const result=await act("receiveTransportLeg",{legId:leg.id,...form,items:items.filter((item:Row)=>Number(draft[item.id]?.qty)>0).map((item:Row)=>({id:item.id,receivedQty:Number(draft[item.id]?.qty),quarantineQty:Number(draft[item.id]?.quarantine||0)}))},"到仓已登记：合格品进入待上架，异常品进入隔离");if(result)close();};
  return <Panel title={`到仓登记 · ${leg.leg_no}`} desc={`${leg.site} · ${leg.channel} · ${leg.warehouse_name}`} action={<button type="button" className="btn" disabled={busy} onClick={close}>关闭</button>}>
    <TableImport kind="receipt" busy={busy} contextKey={leg.id} templateRows={items.map((item:Row)=>({itemId:item.id,sku:item.sku,qty:"",quarantineQty:0}))} description="导入当前目的地的实收和隔离数量；同SKU有多条明细时请保留明细编号。导入后核对单号及凭证再提交。" onApply={rows=>{const matched=matchImportItems(rows,items);setDraft(Object.fromEntries(matched.map((row:Row)=>[row.itemId,{qty:String(row.qty),quarantine:String(row.quarantineQty)}])));return true;}}/>
    <div className="form-grid"><Field label="到仓单号"><input value={form.receiptNo} onChange={e=>setForm({...form,receiptNo:e.target.value})}/></Field><Field label="到仓凭证"><input value={form.proofRef} onChange={e=>setForm({...form,proofRef:e.target.value})}/></Field><Field label="说明" span={2}><input value={form.note} onChange={e=>setForm({...form,note:e.target.value})}/></Field></div>
    <div className="table-wrap"><table><thead><tr><th>SKU</th><th>剩余可收</th><th>本次实收</th><th>其中隔离 / 破损</th></tr></thead><tbody>{items.map((item:Row)=><tr key={item.id}><td>{item.sku}</td><td>{item.remaining}</td><td><input aria-label={`${item.sku}实收数量`} type="number" min="0" max={item.remaining} step="1" value={draft[item.id]?.qty||""} onChange={e=>setDraft({...draft,[item.id]:{qty:e.target.value,quarantine:draft[item.id]?.quarantine||"0"}})}/></td><td><input aria-label={`${item.sku}隔离数量`} type="number" min="0" max={draft[item.id]?.qty||0} step="1" value={draft[item.id]?.quarantine||"0"} onChange={e=>setDraft({...draft,[item.id]:{qty:draft[item.id]?.qty||"",quarantine:e.target.value}})}/></td></tr>)}</tbody></table></div>
    <div className="form-actions"><button className="btn primary" type="button" disabled={busy||!form.receiptNo||!form.proofRef||!Object.values(draft).some(row=>Number(row.qty)>0)} onClick={submit}>确认到仓入库</button></div>
  </Panel>;
}

function Batches({data,act,busy}:{data:Snapshot;act:Act;busy:boolean}) {
  const [filter,setFilter]=useState("all"),[query,setQuery]=useState(""),[expanded,setExpanded]=useState("");
  const [receiving,setReceiving]=useState(""),[receiptNo,setReceiptNo]=useState(""),[proofRef,setProofRef]=useState(""),[receiptDraft,setReceiptDraft]=useState<Record<string,string>>({});
  const advance=async(batch:Row)=>{const evidenceRef=window.prompt("请输入当前节点的业务凭证或单据编号");if(!evidenceRef)return;const estimatedArrivalDate=batch.stage==="channel_allocation"?window.prompt("请输入预计到仓日期（YYYY-MM-DD）",localDate()):"";if(batch.stage==="channel_allocation"&&!estimatedArrivalDate)return;const note=window.prompt("填写推进说明；管理员越级操作必须说明原因")||"按流程推进";await act("advanceShipmentBatch",{batchId:batch.id,evidenceRef,note,estimatedArrivalDate},"海运批次已推进到下一节点");};
  const updateEta=async(batch:Row)=>{const estimatedArrivalDate=window.prompt("更新预计到仓日期（YYYY-MM-DD）",batch.estimated_arrival_date||localDate());if(estimatedArrivalDate)await act("updateShipmentEta",{batchId:batch.id,estimatedArrivalDate},"海运预计到仓日期已更新");};
  const startReceipt=(batch:Row)=>{setExpanded(batch.id);setReceiving(batch.id);setReceiptNo(`RCV-${localDate().replaceAll("-","")}-${String(data.shipmentReceipts.length+1).padStart(3,"0")}`);setProofRef("");setReceiptDraft(Object.fromEntries(batch.items.map((item:Row)=>[item.id,String(Math.max(0,Number(item.shipped_qty)-Number(item.received_qty||0)))])));};
  const submitReceipt=async(batch:Row)=>{const result=await act("receiveShipmentBatch",{batchId:batch.id,receiptNo,proofRef,items:batch.items.map((item:Row)=>({id:item.id,receivedQty:Number(receiptDraft[item.id]||0)})).filter((item:Row)=>item.receivedQty>0)},"批次实收已登记并写入各站点库存");if(result){setReceiving("");setReceiptDraft({});}};
  const confirmShelf=async(item:Row,allocation:Row)=>{const listingRef=window.prompt(`请输入${item.sku}在${allocation.site} · ${allocation.channel}的平台上架凭证`);if(!listingRef)return;const note=window.prompt("请输入上架说明")||"已完成平台上架";await act("confirmShipmentShelf",{batchItemId:item.id,site:allocation.site,channel:allocation.channel,listingRef,note},"该SKU已完成站点上架确认");};
  const canConfirm=(allocation:Row)=>hasPermission(data.actor.role,"shelf.confirm")&&(data.actor.role==="管理员"||(data.actor.role==="运营"&&data.actor.site===allocation.site&&data.actor.channel===allocation.channel));
  const isConfirmed=(item:Row,allocation:Row)=>item.confirmations.some((row:Row)=>row.site===allocation.site&&row.channel===allocation.channel);
  const visible=data.shipmentBatches.filter(batch=>filter==="exceptions"?batch.exceptions.length:filter==="active"?batch.stage!=="on_shelf":filter==="completed"?batch.stage==="on_shelf":true).filter(batch=>!query||`${batch.batch_no} ${batch.series_name} ${batch.items.map((item:Row)=>item.sku).join(" ")}`.toLowerCase().includes(query.toLowerCase()));
  const stepState=(batch:Row,index:number)=>{if(batch.stage==="on_shelf")return "complete";const active=BATCH_STEPS.findIndex(([key])=>key===batch.stage);return index<active?"complete":index===active?"active":"pending";};
  const advanceLegacy=async(batch:Row)=>{const evidenceRef=window.prompt("请输入当前节点凭证");if(!evidenceRef)return;const estimatedArrivalDate=batch.stage==="channel_allocation"?window.prompt("请输入预计到仓日期（YYYY-MM-DD）",localDate()):"";const note=window.prompt("请输入推进说明")||"历史批次按流程推进";await act("advanceBatch",{batchId:batch.id,evidenceRef,note,estimatedArrivalDate},"历史批次已推进");};
  const confirmLegacy=async(batch:Row,allocation:Row)=>{const listingRef=window.prompt(`请输入${allocation.site} · ${allocation.channel}的平台上架凭证`);if(!listingRef)return;const note=window.prompt("请输入上架说明")||"历史批次已完成平台上架";await act("confirmBatchShelf",{batchId:batch.id,site:allocation.site,channel:allocation.channel,listingRef,note},"历史批次已确认上架");};
  const legacyConfirmed=(batch:Row,allocation:Row)=>batch.evidence.some((row:Row)=>row.stage==="on_shelf"&&row.site===allocation.site&&row.channel===allocation.channel);
  return <>
    <PageHead title="海运批次控制塔" desc="默认按批次汇总并将异常置顶；展开后追溯到每个SKU">
      <Pill tone={data.metrics.exceptionBatchCount?"red":"green"}>{data.metrics.exceptionBatchCount?`${data.metrics.exceptionBatchCount}个异常批次`:"批次运行正常"}</Pill>
    </PageHead>
    <div className="metrics">
      <div className="metric"><div className="label">进行中主批次</div><div className="value">{fmt(data.metrics.activeTransportBatchCount)}</div><div className="foot">跨系列、多目的地履约</div></div>
      <div className="metric"><div className="label">目的地异常</div><div className="value" style={{color:data.metrics.transportExceptionCount?"var(--red)":undefined}}>{fmt(data.metrics.transportExceptionCount)}</div><div className="foot">停滞、ETA或隔离库存</div></div>
      <div className="metric"><div className="label">海运至派送</div><div className="value">{fmt(["sea_freight","port_arrived","last_mile_delivery"].reduce((sum,key)=>sum+Number(data.metrics.batchStageCounts?.[key]||0),0))}</div><div className="foot">运输状态实时更新</div></div>
      <div className="metric"><div className="label">待上架</div><div className="value">{fmt(data.metrics.pendingShelfCount)}</div><div className="foot">由各站点运营确认</div></div>
    </div>
    <TransportControl data={data} act={act} busy={busy}/>
    <div className="batch-toolbar"><div className="segmented"><button className={filter==="all"?"active":""} onClick={()=>setFilter("all")}>全部</button><button className={filter==="exceptions"?"active":""} onClick={()=>setFilter("exceptions")}>异常优先</button><button className={filter==="active"?"active":""} onClick={()=>setFilter("active")}>进行中</button><button className={filter==="completed"?"active":""} onClick={()=>setFilter("completed")}>已上架</button></div><input aria-label="搜索批次或SKU" value={query} onChange={event=>setQuery(event.target.value)} placeholder="搜索批次号、系列或SKU"/></div>
    <Panel title="历史单系列海运批次" desc="旧版本记录继续保留并可完成原流程；新发货请使用上方跨系列运输主批次">
      {visible.length===0?<Empty>{data.shipmentBatches.length?"没有符合筛选条件的批次":"系列生产完工后，由供应链创建第一个多SKU海运批次"}</Empty>:<div className="batch-card-list">{visible.map(batch=><article className={classNames("batch-card","shipment-card",batch.exceptions.some((row:Row)=>row.level==="red")&&"stalled",batch.exceptions.length>0&&"has-warning")} key={batch.id}>
        <header><div><span>{batch.batch_no}</span><h4>{batch.series_name}</h4><p>{fmt(batch.visibleSkuCount)} 个SKU｜{fmt(batch.visibleShippedQty)} 件｜{fmt(batch.destinationCount)} 个目的站点渠道</p></div><div><Pill tone={batch.stage==="on_shelf"?"green":batch.exceptions.some((row:Row)=>row.level==="red")?"red":batch.exceptions.length?"amber":"blue"}>{BATCH_LABEL[batch.stage]||batch.stage}</Pill>{batch.exceptions.length>0&&<small>{batch.exceptions.length} 项异常</small>}</div></header>
        <div className="batch-facts"><span>当前负责人<strong>{batch.stage_owner}</strong></span><span>预计到仓<strong>{batch.estimated_arrival_date||"待填写"}</strong></span><span>到仓进度<strong>{fmt(batch.visibleReceivedQty)} / {fmt(batch.visibleShippedQty)}</strong></span><span>上架进度<strong>{fmt(batch.visibleShelvedQty)} / {fmt(batch.visibleShippedQty)}</strong></span></div>
        {batch.exceptions.length>0&&<div className="exception-strip">{batch.exceptions.map((issue:Row,index:number)=><span className={issue.level} key={`${issue.type}-${index}`}><strong>{issue.type}</strong>{issue.detail}</span>)}</div>}
        <footer><button className="btn" onClick={()=>setExpanded(expanded===batch.id?"":batch.id)}>{expanded===batch.id?"收起SKU追溯":"展开SKU追溯"}</button>{["channel_allocation","sea_freight","port_arrived","last_mile_delivery"].includes(batch.stage)&&<button className="btn primary" disabled={busy||!(data.actor.role===batch.stage_owner||data.actor.role==="管理员")} onClick={()=>advance(batch)}>凭证推进节点</button>}{["sea_freight","port_arrived","last_mile_delivery"].includes(batch.stage)&&hasPermission(data.actor.role,"shipment.eta")&&<button className="btn" disabled={busy} onClick={()=>updateEta(batch)}>更新ETA</button>}{batch.stage==="awaiting_receipt"&&hasPermission(data.actor.role,"inbound.receive")&&receiving!==batch.id&&<button className="btn primary" onClick={()=>startReceipt(batch)}>登记多SKU到仓</button>}</footer>
        {expanded===batch.id&&<div className="batch-detail">
          <div className="batch-timeline">{BATCH_STEPS.map(([key,label],index)=><div className={stepState(batch,index)} key={key}><i>{stepState(batch,index)==="complete"?"✓":index+1}</i><span>{label}</span></div>)}</div>
          <div className="table-wrap"><table className="trace-table"><thead><tr><th>SKU</th><th>商品</th><th className="num">运营需求/下单</th><th className="num">计划生产</th><th className="num">实际完工</th><th className="num">本批发货</th><th className="num">累计到仓</th><th className="num">累计上架</th></tr></thead><tbody>{batch.items.map((item:Row)=><tr key={item.id}><td><strong>{item.sku}</strong></td><td>{item.name||"—"}</td><td className="num">{fmt(item.orderedQty)}</td><td className="num">{fmt(item.plannedQty)}</td><td className="num">{fmt(item.producedQty)}</td><td className="num">{fmt(item.visibleShipped)}</td><td className="num">{fmt(item.visibleReceived)}</td><td className="num">{fmt(item.visibleShelved)}</td></tr>)}</tbody></table></div>
          {receiving===batch.id&&<div className="inline-editor"><TableImport kind="receipt" busy={busy} contextKey={batch.id} templateRows={batch.items.filter((item:Row)=>Number(item.shipped_qty)>Number(item.received_qty||0)).map((item:Row)=>({itemId:item.id,sku:item.sku,qty:"",quarantineQty:0}))} description="下载当前批次明细，填写本次实收数量；本历史流程不支持隔离数量，请保持0。导入后补齐单号和凭证，再确认入库。" onApply={rows=>{if(rows.some(row=>row.quarantineQty>0))throw Error("历史单系列批次不支持隔离数量，请使用对应业务流程处理");const matched=matchImportItems(rows,batch.items.map((item:Row)=>({...item,remaining:Number(item.shipped_qty)-Number(item.received_qty||0)})));setReceiptDraft(Object.fromEntries(matched.map((row:Row)=>[row.itemId,String(row.qty)])));return true;}}/><h5>登记本次到仓</h5><div className="form-grid"><Field label="到仓单号"><input value={receiptNo} onChange={event=>setReceiptNo(event.target.value)}/></Field><Field label="到仓凭证"><input value={proofRef} onChange={event=>setProofRef(event.target.value)} placeholder="提货单、签收单或照片编号"/></Field></div><div className="table-wrap"><table><thead><tr><th>SKU</th><th className="num">发货</th><th className="num">已收</th><th className="num">本次实收</th></tr></thead><tbody>{batch.items.map((item:Row)=><tr key={item.id}><td>{item.sku} · {item.name}</td><td className="num">{fmt(item.shipped_qty)}</td><td className="num">{fmt(item.received_qty)}</td><td className="num"><input className="qty-input" type="number" min="0" max={Number(item.shipped_qty)-Number(item.received_qty)} value={receiptDraft[item.id]??"0"} onChange={event=>setReceiptDraft({...receiptDraft,[item.id]:event.target.value})}/></td></tr>)}</tbody></table></div><div className="form-actions"><button className="btn" onClick={()=>setReceiving("")}>取消</button><button className="btn primary" disabled={busy||!receiptNo||!proofRef||!Object.values(receiptDraft).some(value=>Number(value)>0)} onClick={()=>submitReceipt(batch)}>确认到仓并入库存</button></div></div>}
          {batch.stage==="shelf_pending"&&<div className="sku-allocation-list"><h5>站点SKU上架确认</h5>{batch.items.flatMap((item:Row)=>item.allocations.map((allocation:Row)=>{const confirmed=isConfirmed(item,allocation);return <div key={`${item.id}-${allocation.site}-${allocation.channel}`}><span><strong>{item.sku}</strong><small>{allocation.site} · {allocation.channel}</small></span><b>{fmt(allocation.qty)} 件</b><Pill tone={confirmed?"green":"red"}>{confirmed?"已上架":"待确认"}</Pill>{!confirmed&&canConfirm(allocation)&&<button className="btn primary" disabled={busy} onClick={()=>confirmShelf(item,allocation)}>确认上架</button>}</div>}))}</div>}
        </div>}
      </article>)}</div>}
    </Panel>
    {data.batches.length>0&&<Panel title="历史单SKU批次" desc="旧版本产生的批次继续保留并可完成原流程；新计划不再生成此类记录">
      <div className="table-wrap"><table><thead><tr><th>批次</th><th>SKU</th><th className="num">数量</th><th>节点</th><th>负责人</th><th>更新时间</th><th></th></tr></thead><tbody>{data.batches.map(batch=><tr key={batch.id}><td>{batch.id}</td><td>{batch.sku} · {batch.name}</td><td className="num">{fmt(batch.qty)}</td><td><Pill tone={batch.stalled?"red":"blue"}>{BATCH_LABEL[batch.stage]||batch.stage}</Pill></td><td>{batch.stage_owner}</td><td>{readableDate(batch.updated_at)}</td><td><div style={{display:"flex",gap:5,flexWrap:"wrap"}}>{["supply_confirm","factory_production","channel_allocation","sea_freight","port_arrived","last_mile_delivery"].includes(batch.stage)&&<button className="btn" disabled={busy||!(data.actor.role===batch.stage_owner||data.actor.role==="管理员")} onClick={()=>advanceLegacy(batch)}>继续原流程</button>}{batch.stage==="shelf_pending"&&batch.allocations.filter((allocation:Row)=>canConfirm(allocation)&&!legacyConfirmed(batch,allocation)).map((allocation:Row)=><button className="btn" key={`${allocation.site}-${allocation.channel}`} disabled={busy} onClick={()=>confirmLegacy(batch,allocation)}>{allocation.site}上架</button>)}</div></td></tr>)}</tbody></table></div>
    </Panel>}
  </>;
}

function Audit({data}:{data:Snapshot}) {
  return <>
    <PageHead title="审计日志" desc="关键写入由服务端记录账号、时间、对象和变更内容"/>
    <Panel title="最近操作">
      <div className="table-wrap"><table><thead><tr><th>时间</th><th>操作</th><th>对象</th><th>操作人</th><th>内容</th></tr></thead><tbody>{data.audit.length===0?<tr><td colSpan={5}><Empty>暂无审计记录</Empty></td></tr>:data.audit.map(r=><tr key={r.id}><td>{String(r.created_at).replace("T"," ").slice(0,19)}</td><td><strong>{r.action}</strong></td><td>{r.entity_type}<br/>{r.entity_id}</td><td>{r.actor_name}</td><td style={{maxWidth:420,wordBreak:"break-word"}}>{Object.entries(r.detail||{}).map(([k,v])=><div key={k}><span style={{color:"var(--muted)"}}>{k}：</span>{typeof v==="object"?JSON.stringify(v):String(v)}</div>)}</td></tr>)}</tbody></table></div>
    </Panel>
  </>;
}

function MasterData({data,act,busy}:{data:Snapshot;act:Act;busy:boolean}){
  const [partner,setPartner]=useState({type:"supplier",code:"",name:"",contact:"",defaultLeadDays:"21",assignedUserId:"",active:true});
  const [warehouse,setWarehouse]=useState({site:SITES[0],channel:"TikTok",code:"",name:"",capacityQty:"0",active:true});
  const partnerRole=partner.type==="factory"?"工厂":partner.type==="carrier"?"海运":"供应链";
  const savePartner=async()=>{const result=await act("saveBusinessPartner",{...partner,defaultLeadDays:Number(partner.defaultLeadDays)},"合作方主数据已保存");if(result)setPartner({...partner,code:"",name:"",contact:"",assignedUserId:""});};
  const saveWarehouse=async()=>{const result=await act("saveWarehouse",{...warehouse,capacityQty:Number(warehouse.capacityQty)},"仓库主数据已保存");if(result)setWarehouse({...warehouse,code:"",name:""});};
  return <>
    <PageHead title="供应链主数据" desc="先绑定供应商、工厂账号、承运商账号和目的仓，再允许生成采购、生产与发运单"/>
    <div className="grid-2">
      <Panel title="新增合作方" desc="工厂和承运商必须绑定具体责任账号">
        <div className="form-grid"><Field label="类型"><select value={partner.type} onChange={e=>setPartner({...partner,type:e.target.value,assignedUserId:""})}><option value="supplier">供应商</option><option value="factory">工厂</option><option value="carrier">承运商</option></select></Field><Field label="编码"><input value={partner.code} onChange={e=>setPartner({...partner,code:e.target.value})}/></Field><Field label="名称"><input value={partner.name} onChange={e=>setPartner({...partner,name:e.target.value})}/></Field><Field label="默认交期（天）"><input type="number" min="0" value={partner.defaultLeadDays} onChange={e=>setPartner({...partner,defaultLeadDays:e.target.value})}/></Field><Field label="联系方式" span={2}><input value={partner.contact} onChange={e=>setPartner({...partner,contact:e.target.value})}/></Field><Field label={`绑定${partnerRole}账号`} span={2}><select value={partner.assignedUserId} onChange={e=>setPartner({...partner,assignedUserId:e.target.value})}><option value="">{partner.type==="supplier"?"可不绑定":"请选择负责人"}</option>{data.users.filter(user=>user.role===partnerRole&&Number(user.active)).map(user=><option value={user.id} key={user.id}>{user.name} · {user.email}</option>)}</select></Field></div><div className="form-actions"><button className="btn primary" disabled={busy||!partner.code||!partner.name||(partner.type!=="supplier"&&!partner.assignedUserId)} onClick={savePartner}>保存合作方</button></div>
      </Panel>
      <Panel title="新增目的仓" desc="运输按目的仓拆分独立状态，并监控容量">
        <div className="form-grid"><Field label="站点"><select value={warehouse.site} onChange={e=>setWarehouse({...warehouse,site:e.target.value})}>{SITES.map(site=><option key={site}>{site}</option>)}</select></Field><Field label="渠道"><select value={warehouse.channel} onChange={e=>setWarehouse({...warehouse,channel:e.target.value})}>{CHANNELS.map(channel=><option key={channel}>{channel}</option>)}</select></Field><Field label="仓库编码"><input value={warehouse.code} onChange={e=>setWarehouse({...warehouse,code:e.target.value})}/></Field><Field label="仓库名称"><input value={warehouse.name} onChange={e=>setWarehouse({...warehouse,name:e.target.value})}/></Field><Field label="容量（件，0为不限）"><input type="number" min="0" value={warehouse.capacityQty} onChange={e=>setWarehouse({...warehouse,capacityQty:e.target.value})}/></Field></div><div className="form-actions"><button className="btn primary" disabled={busy||!warehouse.code||!warehouse.name} onClick={saveWarehouse}>保存目的仓</button></div>
      </Panel>
    </div>
    <Panel title="合作方清单"><div className="table-wrap"><table><thead><tr><th>类型</th><th>编码</th><th>名称</th><th>默认交期</th><th>绑定账号</th><th>状态</th></tr></thead><tbody>{data.businessPartners.length===0?<tr><td colSpan={6}><Empty>请先创建合作方主数据</Empty></td></tr>:data.businessPartners.map(row=><tr key={row.id}><td>{row.type==="supplier"?"供应商":row.type==="factory"?"工厂":"承运商"}</td><td>{row.code}</td><td><strong>{row.name}</strong><div className="cell-note">{row.contact}</div></td><td>{row.default_lead_days}天</td><td>{data.users.find(user=>user.id===row.assigned_user_id)?.name||"—"}</td><td><Pill tone={Number(row.active)?"green":"red"}>{Number(row.active)?"启用":"停用"}</Pill></td></tr>)}</tbody></table></div></Panel>
    <Panel title="目的仓清单"><div className="table-wrap"><table><thead><tr><th>站点/渠道</th><th>编码</th><th>仓库</th><th className="num">容量</th><th>状态</th></tr></thead><tbody>{data.warehouses.length===0?<tr><td colSpan={5}><Empty>请维护各站点渠道目的仓</Empty></td></tr>:data.warehouses.map(row=><tr key={row.id}><td>{row.site} · {row.channel}</td><td>{row.code}</td><td>{row.name}</td><td className="num">{Number(row.capacity_qty)>0?fmt(row.capacity_qty):"不限"}</td><td><Pill tone={Number(row.active)?"green":"red"}>{Number(row.active)?"启用":"停用"}</Pill></td></tr>)}</tbody></table></div></Panel>
  </>;
}

const ROLE_TEST_ORDER=["管理员","销售","运营","供应链","工厂","海运","运营主管","新品开发","财务"];
const ROLE_BOUNDARY:Record<string,string>={
  销售:"仅印尼本人客户和批发订单；申请出库、查询发货、回款和开票，不能自审或确认收款",
  管理员:"全局查看、配置、审批和必要越级处理；销售仍由运营导入，越级推进必须填写原因",
  运营:"仅本人绑定的站点＋渠道：销售导入、盘点差异提交、月度需求和上架确认",
  供应链:"主数据、系列汇总、供应商接单、生产质检、跨系列发运、到仓与盘点复核",
  工厂:"仅处理分配给本账号的生产单：接单、进度、完工和新品打板",
  海运:"仅处理分配给本账号的目的地运输分腿：海运、到港、清关、派送与ETA",
  运营主管:"运营调研统筹、新品测试关口和样品运营确认，不代替站点运营上架",
  新品开发:"候选款提交及样品开发确认",
  财务:"新品成本、售价、毛利和盈亏平衡测算",
};

function PermissionTest({data}:{data:Snapshot}) {
  const [selectedUserId,setSelectedUserId]=useState(data.users[0]?.id||"");
  const selected=data.users.find(user=>user.id===selectedUserId)||data.users[0];
  const selectedRole=String(selected?.role||"");
  const selectedPermissions=permissionsForRole(selectedRole);
  const selectedDomains=dataDomainsForRole(selectedRole);
  const selectedNav=navigationForRole(selectedRole);
  const navLabels=Object.fromEntries(navItems.map(([key,label])=>[key,label]));
  const active=Boolean(selected)&&Number(selected.active)===1;
  const scopeReady=selectedRole!=="运营"||Boolean(selected?.site&&selected?.channel);
  const recognized=isKnownRole(selectedRole);
  const checks=[
    {label:"账号处于启用状态",pass:active},
    {label:"岗位已进入服务端权限白名单",pass:recognized},
    {label:selectedRole==="运营"?"已绑定唯一站点和渠道":"该岗位不需要站点渠道绑定",pass:scopeReady},
    {label:"菜单已按岗位隔离",pass:recognized&&selectedNav.length>0},
    {label:"写入动作由服务端再次校验",pass:recognized},
  ];
  const userReady=(user:Row)=>Number(user.active)===1&&isKnownRole(String(user.role))&&(user.role!=="运营"||Boolean(user.site&&user.channel));
  return <>
    <PageHead title="账号权限测试" desc="管理员可逐个用户核对菜单、业务动作和站点范围；检查过程不会修改业务数据">
      <Pill tone={data.users.every(userReady)?"green":"amber"}>{data.users.filter(userReady).length}/{data.users.length} 个账号配置通过</Pill>
    </PageHead>
    <div className="metrics">
      <div className="metric"><div className="label">系统账号</div><div className="value">{fmt(data.users.length)}</div><div className="foot">管理员创建或成员首次登录后进入列表</div></div>
      <div className="metric"><div className="label">启用账号</div><div className="value">{fmt(data.users.filter(user=>Number(user.active)===1).length)}</div><div className="foot">停用账号无法进入系统</div></div>
      <div className="metric"><div className="label">运营范围完整</div><div className="value">{data.users.filter(user=>user.role==="运营"&&user.site&&user.channel).length}/{data.users.filter(user=>user.role==="运营").length}</div><div className="foot">运营必须绑定站点＋渠道</div></div>
      <div className="metric"><div className="label">权限岗位</div><div className="value">{ROLE_TEST_ORDER.length}</div><div className="foot">所有写入动作采用岗位白名单</div></div>
    </div>
    <div className="grid-2 permission-test-grid">
      <Panel title="逐用户配置检查" desc="选择成员后显示其真实岗位权限">
        {selected?<>
          <Field label="选择用户"><select value={selected.id} onChange={event=>setSelectedUserId(event.target.value)}>{data.users.map(user=><option key={user.id} value={user.id}>{user.name} · {user.role}</option>)}</select></Field>
          <div className="permission-user-card"><div><strong>{selected.name}</strong><span>{selected.email}</span></div><Pill tone={userReady(selected)?"green":"red"}>{userReady(selected)?"配置通过":"需要处理"}</Pill><p>{ROLE_BOUNDARY[selectedRole]||"尚未配置岗位权限"}</p><small>{selectedRole==="运营"?`操作范围：${selected.site||"未绑定站点"} · ${selected.channel||"未绑定渠道"}`:"操作范围：按岗位负责节点"}</small></div>
          <div className="permission-checks">{checks.map(check=><div className={check.pass?"pass":"fail"} key={check.label}><i>{check.pass?"✓":"!"}</i><span>{check.label}</span></div>)}</div>
        </>:<Empty>暂无成员账号，请到“用户管理”中确认账号开通方式</Empty>}
      </Panel>
      <Panel title="该用户可见与可操作范围" desc="页面可见不等于可写，写入仍以右侧动作清单为准">
        {selected?<>
          <h5 className="permission-subtitle">可见模块</h5><div className="permission-chips">{selectedNav.map(key=><span key={key}>{key==="sales"?(selectedRole==="运营"?"每日销售导入":"销售看板"):(navLabels[key]||key)}</span>)}</div>
          <h5 className="permission-subtitle">可读取数据域</h5><div className="permission-chips">{selectedDomains.map(key=><span key={key}>{(DATA_DOMAIN_LABELS as Readonly<Record<string,string>>)[key]||key}</span>)}</div>
          <h5 className="permission-subtitle">允许写入动作</h5><div className="permission-action-list">{selectedPermissions.length?selectedPermissions.map(key=><div key={key}><i>✓</i><span>{permissionLabel(key)}</span></div>):<Empty>该岗位没有写入权限</Empty>}</div>
        </>:<Empty>请选择用户</Empty>}
      </Panel>
    </div>
    <Panel title="岗位权限矩阵" desc="管理员为最高管理权限；各岗位只能写入自己的业务节点">
      <div className="table-wrap"><table className="permission-table"><thead><tr><th>岗位</th><th>数据范围</th><th>允许写入动作</th><th>禁止越权示例</th></tr></thead><tbody>{ROLE_TEST_ORDER.map(role=><tr key={role}><td><strong>{role}</strong></td><td>{ROLE_BOUNDARY[role]}</td><td><div className="permission-inline-actions">{permissionsForRole(role).map(key=><span key={key}>{permissionLabel(key)}</span>)}</div></td><td>{role==="管理员"?"不直接导入销售；运输越级需留原因":role==="运营"?"不能跨站点、跨渠道操作":role==="供应链"?"不能登记工厂完工或推进海运":role==="工厂"?"不能创建批次、收货或上架":role==="海运"?"不能收货入库或确认上架":"不能处理其他岗位节点"}</td></tr>)}</tbody></table></div>
    </Panel>
    <Panel title="到仓上架自动闭环" desc="“自动上架”不是独立账号角色，而是系统闭环规则">
      <div className="plan-visibility"><div className="done"><span>1</span><strong>供应链登记到仓</strong><small>按批次、SKU和站点渠道写入实际收货数量。</small></div><div className="active"><span>2</span><strong>运营确认上架</strong><small>仅负责该站点与渠道的运营可以提交上架凭证。</small></div><div className="active"><span>3</span><strong>系统逐项校验</strong><small>检查批次内所有SKU、站点和渠道是否全部确认。</small></div><div className="done"><span>4</span><strong>自动完成批次</strong><small>全部通过后状态自动切换为“已上架”，无需人工关闭。</small></div></div>
    </Panel>
  </>;
}
