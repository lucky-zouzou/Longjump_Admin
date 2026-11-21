import {assertWritable} from './atomic.mjs';
const n=v=>v==null?null:Number(v);
const supplyBasis=r=>[...(r.arrivalLots||[]).map(l=>({...l,type:'sea'})),...(r.productionArrivalLots||[]).map(l=>({...l,type:'production'}))].map(l=>({type:l.type,qty:n(l.qty),date:l.days!=null&&Number.isFinite(l.days)?new Date(Date.parse(r.asOf)+l.days*86400000).toISOString().slice(0,10):null})).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
export function forecastBasis(r){
 return {version:r.forecastVersion,ready:r.recommendationReady!==false,qty:n(r.suggestedProduction),daily:n(r.forecastDaily),stock:n(r.qty),pending:n(r.pendingShelfQty),sea:n(r.seaInTransit),production:n(r.productionInProgress),supply:supplyBasis(r),target:n(r.targetQty),horizon:r.horizonDays,safety:r.safetyStock,limits:r.limits||[],policy:r.policy||{},reasons:r.readinessReasons||[],shortage:r.projection?.firstShortageDate||null};
}
export async function recordForecastObservations(db,rows,at=new Date().toISOString()){
 await assertWritable(db);
 const statements=rows.map(r=>{const json=JSON.stringify(forecastBasis(r));return db.prepare(`INSERT INTO forecast_daily_observations VALUES(?,?,?,?,?,?,?,?)
 ON CONFLICT(business_date,site,channel,sku) DO UPDATE SET latest_json=excluded.latest_json,updated_at=excluded.updated_at
 WHERE forecast_daily_observations.latest_json<>excluded.latest_json`).bind(r.asOf,r.site,r.channel,r.sku,json,json,at,at);});
 for(let i=0;i<statements.length;i+=80)await db.batch(statements.slice(i,i+80));
 // These are derived observations, not approvals or accounting records. Keep 90 days.
 const cutoff=new Date(Date.parse(at)-90*86400000).toISOString().slice(0,10);
 await db.prepare('DELETE FROM forecast_daily_observations WHERE business_date<?').bind(cutoff).run();
}
export function explainForecastChange(previous,current){
 if(!previous)return {available:false,delta:null,reasons:['昨日尚未留存快照，暂不推算变化量']};
 const reasons=[];
 if(previous.version!==current.version)reasons.push('测算规则版本已变化');
 if(previous.ready!==current.ready)reasons.push(current.ready?'资料补齐，重新纳入可计算范围':'资料不齐，移出确定数量汇总；不代表需求下降');
 if(previous.daily!==current.daily)reasons.push('销量窗口、活动日期或需求参数变化');
 if(previous.stock!==current.stock)reasons.push('可售库存变化');
 if(previous.sea!==current.sea||previous.production!==current.production||previous.pending!==current.pending)reasons.push('在途、在产或待上架供应变化');
 if(JSON.stringify(previous.supply||[])!==JSON.stringify(current.supply||[]))reasons.push('分批供应数量或承诺到仓日期变化');
 if(JSON.stringify(previous.policy)!==JSON.stringify(current.policy))reasons.push('供应参数已调整');
 if(previous.horizon!==current.horizon||previous.safety!==current.safety||previous.target!==current.target)reasons.push('交期、目标覆盖或安全库存变化');
 if(JSON.stringify(previous.limits)!==JSON.stringify(current.limits))reasons.push('产能、资金或起订约束变化');
 if(previous.shortage!==current.shortage)reasons.push('预计缺货日期变化');
 const comparable=previous.ready&&current.ready&&previous.qty!=null&&current.qty!=null&&previous.version===current.version;
 return {available:true,comparable,previousQty:previous.qty,delta:comparable?current.qty-previous.qty:null,reasons:reasons.length?reasons:['测算依据未发生变化']};
}
export async function forecastChanges(db,actor,rows){
 if(!rows.length)return {items:[],comparable:0,pending:0,delta:null};
 const dates=[...new Set(rows.map(r=>new Date(Date.parse(r.asOf)-86400000).toISOString().slice(0,10)))];
 const scoped=actor.role==='运营';
 const prior=(await db.prepare('SELECT * FROM forecast_daily_observations WHERE business_date IN (SELECT value FROM json_each(?))'+(scoped?' AND site=? AND channel=?':'')).bind(JSON.stringify(dates),...(scoped?[actor.site,actor.channel]:[])).all()).results||[];
 const index=new Map(prior.map(r=>[[r.business_date,r.site,r.channel,r.sku].join('|'),r]));
 const items=rows.filter(r=>!scoped||(r.site===actor.site&&r.channel===actor.channel)).map(r=>{
 const day=new Date(Date.parse(r.asOf)-86400000).toISOString().slice(0,10),old=index.get([day,r.site,r.channel,r.sku].join('|'));
 return {site:r.site,channel:r.channel,sku:r.sku,date:r.asOf,previousDate:day,...explainForecastChange(old?JSON.parse(old.latest_json):null,forecastBasis(r))};});
 const comparable=items.filter(r=>r.comparable);
 return {items,comparable:comparable.length,pending:items.length-comparable.length,delta:comparable.length?comparable.reduce((s,r)=>s+r.delta,0):null};
}
