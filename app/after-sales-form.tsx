"use client";
import {useState} from 'react';
import {useDirtyGuard} from './workspace-hooks';
import {reasons,qualityReasons,discoveryStages,discoveryZones} from '../lib/after-sales.mjs';
import {SITE_CURRENCIES,SALES_CURRENCIES} from '../lib/sales-data.mjs';
type Row=Record<string,any>;
const today=()=>new Date(Date.now()+8*3600000).toISOString().slice(0,10);
export default function CaseForm({busy,act,onCancel,row,actor,kind='after_sale',error=''}:{busy:boolean;act:(p:Row)=>Promise<boolean>;onCancel:()=>void;row?:Row;actor:Row;kind?:string;error?:string}){
 const quality=kind==='quality',supply=actor.role==='供应链';
 const [editVersion]=useState(row?.version);
 const [v,setV]=useState<Row>(row?{...row.data,lossAmount:row.data.lossCents==null?'':row.data.lossCents/100,refundAmount:row.data.refundCents/100,site:row.site,channel:row.channel,businessDate:row.business_date,caseNo:row.case_no,sku:row.sku}:{businessDate:today(),site:actor.role==='销售'?'印尼':actor.role==='运营'?actor.site:quality?'国内':actor.site||'',channel:actor.role==='销售'?'线下批发':actor.role==='运营'?actor.channel:quality?'跨渠道':actor.channel||'',currency:'CNY',discoveredAt:'',discoveryZone:'+08:00',discoveryStage:'domestic',location:'',purchaseNo:'',transportNo:'',containment:'',lossAmount:'',caseNo:'',orderNo:'',sku:'',qty:1,refundAmount:'',reason:(quality?qualityReasons:reasons)[0],description:'',factory:'',warehouse:'',batch:'',improvement:''});
 useDirtyGuard(Boolean(v.caseNo||v.orderNo||v.sku||v.description||v.improvement));
 const field=(key:string,label:string,type='text',required=false)=><label key={key}>{label}<input type={type} required={required} value={v[key]??''} disabled={Boolean(row&&['businessDate','caseNo','sku'].includes(key))} min={type==='number'?'0':undefined} max={type==='date'?today():undefined} step={type==='number'?(key==='qty'?'1':'0.01'):undefined} maxLength={160} onChange={e=>setV({...v,[key]:e.target.value})}/></label>;
 return <form className="panel as-form" onSubmit={async e=>{e.preventDefault();if(await act({...v,kind,action:row?'save':'create',id:row?.id,version:editVersion}))onCancel()}}>
  <h3>{row?'修改草稿':quality?'登记品质与交付异常':'登记每日售后'}</h3><p>先保存草稿，再上传截图或照片并提交。请遮挡客户电话、收货地址等无关信息。</p>
  <div className="as-fields">
   {supply&&<><label>{quality?'涉及站点 / 仓库区域':'销售站点'}<select required disabled={Boolean(row)} value={v.site} onChange={e=>setV({...v,site:e.target.value})}><option value="">请选择</option>{[...(quality?['国内']:[]),...Object.keys(SITE_CURRENCIES)].map(s=><option key={s}>{s}</option>)}</select></label><label>渠道<select required disabled={Boolean(row)} value={v.channel} onChange={e=>setV({...v,channel:e.target.value})}><option value="">请选择</option>{['TikTok','Shopee','线下批发',...(quality?['跨渠道']:[])].map(c=><option key={c}>{c}</option>)}</select></label></>}
   {quality?<><label>发现环节<select value={v.discoveryStage} onChange={e=>setV({...v,discoveryStage:e.target.value})}>{discoveryStages.map(s=><option value={s.id} key={s.id}>{s.phase} · {s.label}</option>)}</select></label><label>实际发现时间<input required type="datetime-local" value={v.discoveredAt} min={row?row.business_date+'T00:00':undefined} max={row?row.business_date+'T23:59':undefined} onChange={e=>setV({...v,discoveredAt:e.target.value,businessDate:row?row.business_date:e.target.value.slice(0,10)})}/></label><label>发现时间的时区<select value={v.discoveryZone} onChange={e=>setV({...v,discoveryZone:e.target.value})}>{discoveryZones.map(z=><option key={z.id} value={z.id}>{z.label}</option>)}</select></label>{field('location','发现地点 / 交接环节','text',true)}</>:field('businessDate','售后发生日期','date',true)}
   {field('caseNo',quality?'异常编号（稳定内部编号）':'平台售后单号（无单号填写稳定内部编号）','text',true)}
   {field('orderNo',quality?'关联销售订单（如有）':'平台订单号','text',!quality)}{field('sku','SKU / 商品标识','text',true)}{field('qty','本行涉及件数','number',true)}
   {!quality&&field('refundAmount',`本行退款金额 · ${SITE_CURRENCIES[v.site as keyof typeof SITE_CURRENCIES]||'站点原币'}（无退款填0）`,'number',true)}
   <label>{quality?'异常现象':'客户售后原因'}<select value={v.reason} onChange={e=>setV({...v,reason:e.target.value})}>{(quality?qualityReasons:reasons).map(r=><option key={r}>{r}</option>)}</select></label>
   {field('factory','工厂名称 / 编码（线索，未知可留空）')}{field('warehouse','涉及仓库（线索，未知可留空）')}{field('batch','生产批次 / 入库或发货凭证')}
   {quality&&<>{field('purchaseNo','采购订单号（追溯线索）')}{field('transportNo','运输批次 / 提单号（追溯线索）')}<label>估计损失币种<select value={v.currency} onChange={e=>setV({...v,currency:e.target.value})}>{SALES_CURRENCIES.map(c=><option key={c}>{c}</option>)}</select></label>{field('lossAmount','估计损失金额（未知留空）','number')}</>}
  </div>
  {quality&&<p className="notice info">按实际发现时间及所选时区归集月份。采购单、运输单、批次凭证至少填写一项用于追溯；估计损失不等于确认应赔。发现日期保存后锁定，录错可作废并重新登记。</p>}
  <label>情况描述（至少4字）<textarea required minLength={4} maxLength={2000} rows={4} value={v.description} onChange={e=>setV({...v,description:e.target.value})}/></label>
  {quality&&<label>即时处理 / 隔离 / 暂停发货措施<textarea maxLength={2000} rows={3} value={v.containment} onChange={e=>setV({...v,containment:e.target.value})}/></label>}
  <label>{quality?'整改措施及跟进人 / 期限':'客户沟通 / 链接优化 / 改进措施'}<textarea maxLength={2000} rows={3} value={v.improvement} onChange={e=>setV({...v,improvement:e.target.value})}/></label>
  {error&&<p className="notice error" role="alert">{error}</p>}
  <div className="as-controls"><button className="btn primary" disabled={busy} type="submit">保存草稿，上传证据</button><button type="button" className="btn" onClick={onCancel}>取消</button></div>
 </form>;
}
