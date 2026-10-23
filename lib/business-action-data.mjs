import {loadForecast} from './forecast.ts';
import {actionWindow,evaluateActions,scopeKey,skuKey} from './business-action-model.mjs';
import {zeroSalesSites} from './promotion-model.mjs';
export const rows=async(db,sql,args=[])=>(await db.prepare(sql).bind(...args).all()).results||[];
export async function digest(value){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value))))].map(x=>x.toString(16).padStart(2,'0')).join('');}
const group=(rs,key)=>{const m=new Map();for(const r of rs){const k=key(r);if(!m.has(k))m.set(k,[]);m.get(k).push(r);}return m;};

// Read only: regeneration never changes sales, money, inventory or platform settings.
export async function actionCandidates(db,a,now=new Date()){
 const sourceVersion=((await db.prepare("SELECT version FROM business_action_source_clock WHERE id='global'").first())?.version||0);
 const scoped=a.role==='运营',args=scoped?[a.site,a.channel]:[],filter=scoped?' AND site=? AND channel=?':'';
 const supported="site IN ('马来西亚','印尼','泰国','越南','菲律宾') AND channel IN ('TikTok','Shopee')";
 const windows=Object.fromEntries(zeroSalesSites.map(site=>[site,actionWindow(site,now)]));
 const first=Object.values(windows).map(w=>w.previousStart).sort()[0],last=Object.values(windows).map(w=>w.cutoff).sort().at(-1);
 const [stocks,sales,imports,availability,observations,settings,finances,adSpend,afters,fxRow]=await Promise.all([
  rows(db,'SELECT * FROM inventory_balances WHERE '+supported+filter,args),
  rows(db,'SELECT id,import_id,site,channel,sku,business_date,qty,currency,reported_amount,ad_cost FROM sales_records WHERE reversed_at IS NULL AND '+supported+' AND business_date BETWEEN ? AND ?'+filter+' ORDER BY id',[first,last,...args]),
  rows(db,'SELECT id,site,channel,business_date,report_kind FROM sales_imports WHERE reversed_at IS NULL AND '+supported+' AND business_date BETWEEN ? AND ?'+filter+' ORDER BY id',[first,last,...args]),
  rows(db,'SELECT * FROM promotion_availability WHERE '+supported+filter,args),
  rows(db,'SELECT * FROM promotion_stock_days WHERE '+supported+' AND day>=?'+filter,[first,...args]),
  rows(db,'SELECT * FROM sku_settings'),rows(db,'SELECT * FROM business_action_finance WHERE '+supported+filter+' ORDER BY created_at DESC,rowid DESC',args),
  rows(db,'SELECT * FROM sales_ad_spend WHERE '+supported+' AND business_date BETWEEN ? AND ?'+filter+' ORDER BY id',[first,last,...args]),
  rows(db,"SELECT site,channel,sku,business_date FROM after_sales WHERE record_kind='after_sale' AND status NOT IN ('draft','void') AND "+supported+' AND business_date BETWEEN ? AND ?'+filter,[first,last,...args]),
  db.prepare('SELECT * FROM sales_fx_snapshots ORDER BY effective_at DESC LIMIT 1').first()
 ]);
 // No network call is necessary to open an action list. Existing FX snapshots are reference rates only.
 let fx={status:'unavailable',rates:{}};
 if(fxRow){try{const age=+now-Date.parse(fxRow.effective_at),rates=JSON.parse(fxRow.rates_json);if(age>=-300000&&age<=7*86400000&&Object.values(rates).every(n=>Number.isFinite(n)&&n>0))fx={status:age>36*3600000?'stale':'fresh',rates,effectiveAt:fxRow.effective_at};}catch{}}
 const forecasts=new Map();
 for(const day of [...new Set(Object.values(windows).map(w=>w.today))]){
  const loaded=await loadForecast(db,a,day);for(const r of loaded.suggestions)if(windows[r.site]?.today===day)forecasts.set(skuKey(r),r);
 }
 const sm=group(sales,skuKey),im=group(imports,scopeKey),am=new Map(availability.map(r=>[skuKey(r),r])),om=group(observations,skuKey),settingsMap=new Map(settings.map(r=>[r.sku,r])),fm=group(finances,skuKey),ads=group(adSpend,scopeKey),af=group(afters,skuKey);
 const stockMap=new Map(stocks.map(r=>[skuKey(r),r]));
 for(const r of sales)if(!stockMap.has(skuKey(r)))stockMap.set(skuKey(r),{site:r.site,channel:r.channel,sku:r.sku,qty:null});
 const output=[];
 for(const [key,stock] of stockMap){
  const w=windows[stock.site],ss=sm.get(key)||[],recent=ss.filter(r=>r.business_date>=w.start&&r.business_date<=w.cutoff),ii=(im.get(scopeKey(stock))||[]).filter(r=>r.business_date<=w.cutoff);
  const financialBasis={start:w.start,end:w.cutoff,sales:recent,reports:ii.filter(r=>r.business_date>=w.start),shopAds:(ads.get(scopeKey(stock))||[]).filter(r=>r.business_date>=w.start&&r.business_date<=w.cutoff)};
  const fingerprint=await digest(financialBasis),finance=(fm.get(key)||[]).find(f=>f.start_date===w.start&&f.end_date===w.cutoff&&f.basis_hash===fingerprint);
  output.push(...evaluateActions({site:stock.site,channel:stock.channel,sku:stock.sku,name:settingsMap.get(stock.sku)?.name||stock.name||stock.sku,window:w,available:stock.qty==null?null:Number(stock.qty)-Number(stock.reserved_qty||0),sales:ss,complete:ii.filter(r=>['complete','zero'].includes(r.report_kind)).map(r=>r.business_date),availability:am.get(key),observations:om.get(key)||[],finance:finance?{...finance,data:JSON.parse(finance.data_json)}:null,financeFingerprint:fingerprint,forecast:forecasts.get(key),setting:settingsMap.get(stock.sku),fx,afterCount:(af.get(key)||[]).filter(r=>r.business_date>=w.start&&r.business_date<=w.cutoff).length}));
 }
 if(((await db.prepare("SELECT version FROM business_action_source_clock WHERE id='global'").first())?.version||0)!==sourceVersion){const e=new Error('分析期间数据发生变化，请刷新后重试');e.status=409;throw e;}
 return output.map(s=>({...s,sourceVersion}));
}
