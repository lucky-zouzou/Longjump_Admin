"use client";
import {useState} from 'react';
import {useDirtyGuard} from './workspace-hooks';
type Rules=Record<string,number|string>;
type Data={actor:{site?:string};rulesBySite:Record<string,Rules>;reviewedSites:string[];canSetRules:boolean;ruleVersion:number};
const fields=[['heroDaily','28天爆款日均 ≥'],['hotDaily','28天热卖日均 ≥'],['heroRecentDaily','7天爆款日均 ≥'],['hotRecentDaily','7天热卖日均 ≥'],['slowDaily','滞销28天日均 <'],['slowCover','滞销库存覆盖天数 ≥'],['minAge','上架观察天数 ≥']];
export default function SiteClassificationRules({data,onSave}:{data:Data;onSave:(payload:Record<string,unknown>)=>Promise<void>}){
 const [site,setSite]=useState(data.actor.site&&data.rulesBySite[data.actor.site]?data.actor.site:'印尼'),[draft,setDraft]=useState<Rules|null>(null),[version,setVersion]=useState(data.ruleVersion),[reason,setReason]=useState(''),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[error,setError]=useState('');
 const leave=useDirtyGuard(!!draft),selected=data.rulesBySite[site]?site:Object.keys(data.rulesBySite)[0],rules=draft||data.rulesBySite[selected];
 const choose=(value:string)=>{if(value===selected||busy||!leave())return;setSite(value);setDraft(null);setReason('');setMessage('');setError('');};
 const save=async()=>{setBusy(true);setError('');setMessage('');try{await onSave({action:'rules',site:selected,rules:draft,version,reason});setDraft(null);setReason('');setMessage(`${selected}分类规则已保存，其余站点规则保持原值。`);}catch(e){setError((e as Error).message);}finally{setBusy(false);}};
 return <section className="pc-card"><div className="pc-heading"><div><h2>按站点设置分类规则</h2><p>同站点、同SKU合并 TikTok 与 Shopee；7天和28天分别判断，单位为件／天。</p></div><span>规则版本 {data.ruleVersion}</span></div>
  <div className="pc-tabs" aria-label="分类规则站点">{Object.keys(data.rulesBySite).map(s=><button key={s} className={'btn '+(s===selected?'primary':'')} aria-pressed={s===selected} disabled={busy} onClick={()=>choose(s)}>{s}</button>)}</div>
  <h3>{selected} · {data.reviewedSites.includes(selected)?'已保存站点规则':'试运行初始参数'}</h3>
  <p className="pc-note">初始参数来自已核对的站点销量分布，建议补齐日报后按月复核。规则不会每日自动漂移，修改仅作用于当前站点，并记录修改人、依据和版本。</p>
  <div className="pc-rule-grid">
   <article className="pc-rule pc-hero"><h3>爆款</h3><p>28天日均 ≥ {rules.heroDaily}；7天日均 ≥ {rules.heroRecentDaily}。两个周期独立判断，同时达到才标“持续爆款”。</p></article>
   <article className="pc-rule pc-hot"><h3>热卖款</h3><p>28天日均 ≥ {rules.hotDaily} 且低于 {rules.heroDaily}；7天日均 ≥ {rules.hotRecentDaily} 且低于 {rules.heroRecentDaily}。</p></article>
   <article className="pc-rule pc-steady"><h3>平销款</h3><p>健康证据完整，未达到28天爆款、热卖或滞销条件。近期起量、放缓另行显示。</p></article>
   <article className="pc-rule pc-slow"><h3>滞销款</h3><p>可售库存大于0，上架至少{rules.minAge}天；连续有货7天零销售，或28天日均低于{rules.slowDaily}且库存覆盖至少{rules.slowCover}天。须有连续有货证据。</p></article>
  </div>
  <p className="notice info">销售分级按各周期完整日报判断；健康四类以28天为基础，另外核对上架和库存。缺报不计零，库存异常或观察期不足显示“待核实／观察”，销量不代表利润。</p>
  {error&&<p className="notice warn" role="alert">{error}</p>}{message&&<p className="notice info" role="status">{message}</p>}
  {data.canSetRules&&<><div className="pc-form">{fields.map(([key,label])=><label className="pc-field" key={key}><span>{label}</span><input type="number" min="0" step={['minAge','slowCover'].includes(key)?'1':'0.1'} disabled={busy} value={rules[key]} onChange={e=>{if(!draft)setVersion(data.ruleVersion);setDraft({...rules,[key]:e.target.value});}}/></label>)}<label className="pc-field"><span>规则调整依据</span><input value={reason} disabled={busy} onChange={e=>setReason(e.target.value)}/></label></div><button className="btn primary" disabled={busy||!draft||reason.trim().length<4} onClick={()=>void save()}>{busy?'保存中…':`保存${selected}规则新版本`}</button></>}
 </section>;
}
