import {SALES_CURRENCIES,SITE_CURRENCIES} from './sales-data.mjs';
import {assertWritable} from './atomic.mjs';

export const FX_PROVIDER='ExchangeRate-API';
export const FX_SOURCE='https://www.exchangerate-api.com';
const ENDPOINT='https://open.er-api.com/v6/latest/CNY';
const DAY=86400000,MAX_AGE=7*DAY;
const requests=new WeakMap(),retryAfter=new WeakMap();
const round=n=>Math.round((n+Number.EPSILON)*100)/100;
async function readPayload(response){
 if(Number(response.headers.get('content-length'))>65536)throw Error('汇率响应过大');
 const reader=response.body?.getReader();if(!reader)throw Error('缺少汇率响应');
 let bytes=0,text='';const decoder=new TextDecoder();
 try{while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>65536)throw Error('汇率响应过大');text+=decoder.decode(value,{stream:true});}return JSON.parse(text+decoder.decode());}finally{await reader.cancel();}
}

export function validateFxPayload(data,now=Date.now()){
 const effective=Number(data?.time_last_update_unix)*1000,next=Number(data?.time_next_update_unix)*1000;
 if(data?.result!=='success'||data.base_code!=='CNY'||!Number.isFinite(effective)||effective>now+300000||now-effective>MAX_AGE||!Number.isFinite(next)||next<=effective||next-effective>3*DAY)throw Error('汇率响应或日期无效');
 const rates={};
 for(const currency of SALES_CURRENCIES){const rate=data.rates?.[currency];if(typeof rate!=='number'||!Number.isFinite(rate)||rate<=0||rate>1e9)throw Error('缺少有效汇率');rates[currency]=rate;}
 if(rates.CNY!==1)throw Error('汇率基准错误');
 return {id:`${FX_PROVIDER}:${effective}`,provider:FX_PROVIDER,effective_at:new Date(effective).toISOString(),fetched_at:new Date(now).toISOString(),next_update_at:new Date(next).toISOString(),rates};
}
function expose(row,now,refreshFailed=false){
 if(!row)return {status:'unavailable',provider:FX_PROVIDER,source:FX_SOURCE,rates:{CNY:1},effectiveAt:null,fetchedAt:null,refreshFailed};
 try{
  const rates=row.rates||JSON.parse(row.rates_json),age=now-Date.parse(row.effective_at);
  if(age>MAX_AGE||age< -300000||!Number.isFinite(age)||SALES_CURRENCIES.some(c=>!Number.isFinite(rates[c])||rates[c]<=0)||rates.CNY!==1)throw Error('缓存不可用');
  return {status:age>36*3600000?'stale':'fresh',provider:row.provider,source:FX_SOURCE,effectiveAt:row.effective_at,fetchedAt:row.fetched_at,rates,refreshFailed};
 }catch{return expose(null,now,true);}
}
// Only currency codes leave the server. No sales or account information is sent.
export async function loadSalesFx(db,{fetcher=fetch,now=Date.now()}={}){
 const cached=await db.prepare('SELECT * FROM sales_fx_snapshots ORDER BY effective_at DESC LIMIT 1').first();
 const usable=expose(cached,now);
 if(usable.status!=='unavailable'&&now<Date.parse(cached.next_update_at)&&now-Date.parse(cached.fetched_at)<DAY)return usable;
 if(requests.has(db))return requests.get(db);
 const retry=retryAfter.get(db);if(retry&&now<retry.until)return expose(cached,now,retry.failed);
 const task=(async()=>{try{
  await assertWritable(db);
  const response=await fetcher(ENDPOINT,{signal:AbortSignal.timeout(5000),redirect:'error',headers:{Accept:'application/json'}});
  if(!response.ok)throw Error('汇率服务暂不可用');
  const row=validateFxPayload(await readPayload(response),now);
  if(cached&&Date.parse(row.effective_at)<Date.parse(cached.effective_at))throw Error('汇率日期倒退');
  await assertWritable(db);
  await db.prepare('INSERT INTO sales_fx_snapshots(id,provider,effective_at,fetched_at,next_update_at,rates_json) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET fetched_at=excluded.fetched_at,next_update_at=excluded.next_update_at').bind(row.id,row.provider,row.effective_at,row.fetched_at,row.next_update_at,JSON.stringify(row.rates)).run();
  retryAfter.set(db,{until:now+3600000,failed:false});
  // Keep an already-published provider timestamp immutable, including retries.
  return expose(await db.prepare('SELECT * FROM sales_fx_snapshots WHERE id=?').bind(row.id).first(),now);
 }catch{retryAfter.set(db,{until:now+3600000,failed:true});return expose(cached,now,true);}})();
 requests.set(db,task);try{return await task;}finally{requests.delete(db);}
}

export function convertSalesSummary(report,fx){
 const scopes=report.scopes.map(row=>{
  const rate=row.currency==='CNY'?1:fx.rates[row.currency];
  return {...row,cnyRate:rate?1/rate:null,revenueCny:row.revenue==null||!rate?null:round(row.revenue/rate),adCostCny:row.adCost==null||!rate?null:round(row.adCost/rate)};
 });
 const sum=(rows,key)=>{const values=rows.filter(r=>r[key]!=null);return values.length?round(values.reduce((n,r)=>n+r[key],0)):null;};
 const summarize=rows=>{
  const qty=rows.reduce((n,r)=>n+Number(r.qty||0),0),revenueMissing=rows.reduce((n,r)=>n+Number(r.revenueMissing||0),0),costMissing=rows.reduce((n,r)=>n+Number(r.costMissing||0),0);
  const revenueCny=sum(rows,'revenueCny'),adCostCny=sum(rows,'adCostCny'),unconverted=rows.filter(r=>!r.cnyRate).length;
  const revenueComplete=rows.length>0&&!revenueMissing&&!unconverted&&rows.every(r=>r.revenueCny!=null),costComplete=rows.length>0&&!costMissing&&!unconverted&&rows.every(r=>r.adCostCny!=null);
  return {qty,revenueCny,adCostCny,revenueMissing,costMissing,unconverted,revenueComplete,costComplete,roas:revenueComplete&&costComplete&&adCostCny>0?revenueCny/adCostCny:null,averagePrice:revenueComplete&&qty>0?revenueCny/qty:null};
 };
 const sites=Object.keys(SITE_CURRENCIES).filter(site=>!report.filters.site||report.filters.site===site).map(site=>({site,...summarize(scopes.filter(r=>r.site===site)),rows:scopes.filter(r=>r.site===site)}));
 return {fx,scopes,sites,total:summarize(scopes),method:'按当前筛选的站点、渠道、原币汇总后，用同一批最新参考汇率折算；逐项保留两位小数再合计。历史期间也使用此参考汇率，不代表交易日汇率或财务结算金额。'};
}
