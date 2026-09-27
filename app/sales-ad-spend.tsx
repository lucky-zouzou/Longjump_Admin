"use client";
import {useState,useEffect} from 'react';
import {hasPermission} from '../lib/permissions.mjs';
import {SITE_CURRENCIES,SALES_CURRENCIES} from '../lib/sales-data.mjs';
type R=Record<string,any>;
export default function SalesAdSpend({data,act,busy}:{data:R;act:any;busy:boolean}){
 const actor=data.actor,[scope,setScope]=useState({site:actor.site||'印尼',channel:actor.channel||'TikTok',businessDate:new Date(Date.now()+8*3600000-86400000).toISOString().slice(0,10),currency:SITE_CURRENCIES[actor.site as keyof typeof SITE_CURRENCIES]||'IDR'}),[amount,setAmount]=useState(''),[note,setNote]=useState(''),[error,setError]=useState(''),[deleting,setDeleting]=useState(false);
 const old=(data.adSpend||[]).find((r:R)=>r.site===scope.site&&r.channel===scope.channel&&r.business_date===scope.businessDate&&r.currency===scope.currency);
 useEffect(()=>{setAmount(old&&!old.deleted_at?String(old.amount):'');setNote('');setError('');setDeleting(false);},[scope.site,scope.channel,scope.businessDate,scope.currency,old?.version]);
 if(!hasPermission(actor.role,'sales.ad_spend'))return null;
 const save=async()=>{setError('');await act(deleting?'salesAdSpendDelete':'salesAdSpendSave',{...scope,amount,note,version:old?.version||0},deleting?'渠道费用已删除，原记录与原因保留':'渠道广告总费用已更新，销售看板同步计算',setError);};
 return <section className="panel ad-spend-panel"><div className="panel-head"><div><h4>渠道广告总费用</h4><p>无法取得 SKU 成本时，在此登记广告后台的每日总费用。相同日期、站点、渠道、币种的总费用优先使用，不与 SKU 费用重复累加。</p></div><span className="pill blue">不需要分摊到 SKU</span></div>
 <div className="maintenance-grid"><label>费用日期<input type="date" value={scope.businessDate} onChange={e=>setScope({...scope,businessDate:e.target.value})}/></label><label>站点<select disabled={actor.role==='运营'} value={scope.site} onChange={e=>setScope({...scope,site:e.target.value,currency:SITE_CURRENCIES[e.target.value as keyof typeof SITE_CURRENCIES]})}>{Object.keys(SITE_CURRENCIES).map(s=><option key={s}>{s}</option>)}</select></label><label>渠道<select disabled={actor.role==='运营'} value={scope.channel} onChange={e=>setScope({...scope,channel:e.target.value})}><option>TikTok</option><option>Shopee</option></select></label><label>币种<select value={scope.currency} onChange={e=>setScope({...scope,currency:e.target.value})}>{SALES_CURRENCIES.map(s=><option key={s}>{s}</option>)}</select></label><label>当天总费用<input type="number" min="0" step="0.01" placeholder="无投放填0；未知不填" disabled={deleting} value={amount} onChange={e=>setAmount(e.target.value)}/></label><label className="wide">核对依据 / 修改原因<input maxLength={500} placeholder="例如广告后台日报编号、核对日期及调整原因" value={note} onChange={e=>setNote(e.target.value)}/></label></div>
 <p className="muted">{old&&!old.deleted_at?`已登记 ${old.currency} ${Number(old.amount).toLocaleString()} · 版本 ${old.version} · ${old.note}`:'该日期与币种尚无有效渠道总费用。'} SKU 成本未知仍不计算该 SKU 的投产比；请使用整体或渠道投产比评估投放。</p>
 {deleting&&<p className="notice warn">确认删除后，整体报表恢复使用已填报的 SKU 成本；成本缺失时不计算投产比。此操作不改变销量与库存。</p>}{error&&<p role="alert" className="notice error">{error}</p>}
 <div className="maintenance-actions">{old&&!old.deleted_at&&<button className="btn danger" disabled={busy} onClick={()=>setDeleting(!deleting)}>{deleting?'取消删除':'删除费用记录'}</button>}<button className={`btn ${deleting?'danger':'primary'}`} disabled={busy||note.trim().length<4||(!deleting&&amount==='')} onClick={save}>{deleting?'确认删除费用':'保存当天总费用'}</button></div>
 </section>;
}
