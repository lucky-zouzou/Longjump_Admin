"use client";
import {useState} from 'react';
import Icon from './workspace-icons';
import './supply-chain.css';
const stages=[
 {key:'supply_confirm',label:'备货确认',icon:'monthly',group:'计划与生产',page:'monthly',owner:'运营 · 供应链',next:'核对站点需求，完成采购审批与工厂交接。'},
 {key:'factory_production',label:'工厂生产',icon:'fulfillment',group:'计划与生产',page:'fulfillment',owner:'工厂 · 供应链',next:'跟进接单、生产和质检，准备发货资料。'},
 {key:'booking',label:'订舱',icon:'batches',group:'跨境履约',page:'batches',owner:'供应链 · 海运',next:'核对柜号、承运商、目的仓与装箱数量。'},
 {key:'sea_freight',label:'海运',icon:'batches',group:'跨境履约',page:'batches',owner:'海运',next:'跟进实际开船、预计到港与运输异常。'},
 {key:'port_arrived',label:'到港',icon:'receipt',group:'跨境履约',page:'batches',owner:'海运',next:'登记到港凭据，确认清关安排。'},
 {key:'customs_clearance',label:'清关',icon:'approval',group:'跨境履约',page:'batches',owner:'海运',next:'跟进清关资料及放行时间。'},
 {key:'last_mile_delivery',label:'派送',icon:'batches',group:'跨境履约',page:'batches',owner:'海运 · 仓库协作',next:'核实派送安排与仓库收货时间。'},
 {key:'awaiting_receipt',label:'待到仓',icon:'inventory',group:'跨境履约',page:'batches',owner:'海运 · 仓库协作',next:'按实际收货数量登记到仓，核对短少与异常。'},
 {key:'shelf_pending',label:'待上架',icon:'inventory',group:'入仓与可售',page:'batches',owner:'站点运营',next:'核实仓库上架数量，确认后计入可售库存。'},
 {key:'on_shelf',label:'已上架',icon:'approval',group:'入仓与可售',page:'batches',owner:'站点运营',next:'上架环节完成，继续跟踪销售及库存变化。'},
];
type Props={metrics:Record<string,any>;allowed:string[];go:(page:string)=>void};
const count=(v:unknown)=>v==null?'—':Number(v).toLocaleString('zh-CN');
export default function SupplyChain({metrics:m,allowed,go}:Props){
 const [selected,setSelected]=useState<string|null>(null);
 const current=stages.find(s=>s.key===selected);
 return <section className="lj-chain" aria-label="全链路实时状态">
 <header className="lj-chain-head"><div><span className="lj-chain-kicker">SUPPLY CHAIN · 履约全景</span><h2>全链路实时状态</h2><p>从需求确认到商品上架，沿着链路追踪每一步。</p></div>{allowed.includes('batches')&&<button className="btn" onClick={()=>go('batches')}>查看全部批次 <span aria-hidden="true">↗</span></button>}</header>
 <div className="lj-chain-summary"><span><i/ >在途批次 <b>{count(m.activeBatchCount)}</b></span><span className={m.stalledBatchCount?'lj-chain-alert':''}>节点停滞 <b>{count(m.stalledBatchCount)}</b></span><span>待上架 <b>{count(m.pendingShelfCount)}</b></span><small>点击节点查看下一步 · 窄屏可横向滑动</small></div>
 <div className="lj-chain-scroll" tabIndex={0} aria-label="履约节点，可横向滚动"><div className="lj-chain-groups" aria-hidden="true"><span>01 <b>计划与生产</b></span><span>02 <b>跨境履约</b></span><span>03 <b>入仓与可售</b></span></div>
 <ol className="lj-chain-track">{stages.map((s,index)=>{const qty=m.batchStageCounts==null?null:(m.batchStageCounts[s.key]??0),active=Number(qty)>0;return <li key={s.key} className={`${active?'is-active':''} ${s.key==='on_shelf'?'is-finished':''}`}><button className="lj-chain-node" aria-pressed={selected===s.key} onClick={()=>setSelected(selected===s.key?null:s.key)} aria-label={`${s.label}，${count(qty)}，查看节点说明`}><span className="lj-chain-step">{String(index+1).padStart(2,'0')}</span><span className="lj-chain-orb"><Icon name={s.icon}/></span><strong>{s.label}</strong><span className="lj-chain-quantity">{count(qty)}<small>{active?(s.key==='on_shelf'?'已完成':'进行中'):qty==null?'待读取':'暂无'}</small></span></button></li>;})}</ol></div>
 {current?<div className="lj-chain-detail" role="status"><div><span>{current.group} / {current.label}</span><h3>{current.next}</h3><p>协作岗位：{current.owner}。请在明细中核对具体责任人、数量和凭据。</p></div>{allowed.includes(current.page)&&<button className="btn" onClick={()=>go(current.page)}>进入处理工作区 →</button>}</div>:<footer className="lj-chain-foot"><span><i/>有业务的节点高亮显示</span><p>各节点为当前可见范围的汇总，不代表同一订单的完成比例；动效仅用于展示链路方向。</p></footer>}
 </section>;
}
