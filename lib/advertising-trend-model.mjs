import {SITE_CURRENCIES} from './sales-data.mjs';
import {localDay,shiftDay,validDay} from './promotion-model.mjs';
import {ROLE_DATA_DOMAINS,canReadDomain} from './permissions.mjs';

// Match the existing monetary sales view; factories receive quantities only.
export const advertisingTrendRoles=Object.freeze(Object.keys(ROLE_DATA_DOMAINS).filter(role=>role!=='工厂'&&canReadDomain(role,'sales')));
export class AdvertisingTrendError extends Error{constructor(status,message){super(message);this.status=status;}}
const fail=(status,message)=>{throw new AdvertisingTrendError(status,message);};
export function advertisingDateRange(month='',site='印尼',now=new Date()){
 const today=localDay(now,site);
 if(!month)return {from:shiftDay(today,-30),to:shiftDay(today,-1),today};
 if(!/^20\d{2}-(0[1-9]|1[0-2])$/.test(month)||month>today.slice(0,7))fail(400,'请选择已开始的有效月份');
 const from=month+'-01',last=new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5)),0)).toISOString().slice(0,10);
 return {from,to:last<today?last:today,today};
}
export function advertisingTrendFilters(actor,input={},now=new Date()){
 if(!advertisingTrendRoles.includes(actor.role))fail(403,'当前岗位无权查看运营广告费用趋势');
 let site=input.site||actor.site||'印尼',channel=input.channel||actor.channel||'TikTok';
 if(actor.role==='运营'){
  if(!actor.site||!actor.channel||site!==actor.site||channel!==actor.channel)fail(403,'只能查看本人负责的站点和平台');
  site=actor.site;channel=actor.channel;
 }
 if(!Object.hasOwn(SITE_CURRENCIES,site)||!['TikTok','Shopee'].includes(channel))fail(400,'请选择有效电商站点和平台');
 const defaults=advertisingDateRange(input.month||'',site,now),from=input.from||defaults.from,to=input.to||defaults.to;
 if(!validDay(from)||!validDay(to)||from>to||to>defaults.today||(Date.parse(to)-Date.parse(from))/86400000>365)fail(400,'日期范围须有效且不超过366天，结束日期不能晚于站点当地今天');
 return {site,channel,from,to,today:defaults.today};
}
const cents=value=>value==null?null:Math.round(Number(value)*100);
const sameScope=(r,f)=>r.site===f.site&&r.channel===f.channel&&r.date>=f.from&&r.date<=f.to;

// Totals remain in the recorded currency. Never infer zero from absent reports.
export function buildAdvertisingTrend({sales=[],spend=[],coverage=[]},filters){
 const dailySales=new Map(),dailySpend=new Map();
 for(const [source,target] of [[sales,dailySales],[spend,dailySpend]])for(const r of source.filter(r=>sameScope(r,filters))){const list=target.get(r.date)||[];list.push(r);target.set(r.date,list);}
 const complete=new Set(coverage.filter(r=>sameScope(r,filters)).map(r=>r.date));
 const days=[];
 for(let date=filters.from;date<=filters.to;date=shiftDay(date,1)){
  const channel=dailySpend.get(date)||[],sku=dailySales.get(date)||[],salesComplete=complete.has(date);
  const entries=channel.length?channel.map(r=>({currency:r.currency,amount:r.amount,source:'channel',complete:true,repeated:false})):
   sku.map(r=>({currency:r.currency,amount:r.adCost,source:'sku',complete:r.currency!=='UNKNOWN'&&!Number(r.costMissing)&&r.adCost!=null&&salesComplete,repeated:!!Number(r.repeated)}));
  const known=entries.filter(r=>r.amount!=null),status=!known.length?'missing':entries.some(r=>r.repeated)?'review':entries.some(r=>!r.complete)?'partial':'reported';
  days.push({date,salesComplete,provisional:date===filters.today,status,entries:entries.map(r=>({...r,amount:cents(r.amount)==null?null:cents(r.amount)/100}))});
 }
 const currencies=[...new Set(days.flatMap(d=>d.entries.map(e=>e.currency)))].sort();
 const totals=currencies.map(currency=>{
  const entries=days.flatMap(d=>d.entries.filter(e=>e.currency===currency).map(e=>({...e,date:d.date,provisional:d.provisional})));
  const known=entries.filter(e=>e.amount!=null),last=days.filter(d=>!d.provisional).at(-1),previous=last?days.find(d=>d.date===shiftDay(last.date,-1)):null;
  const current=last?.entries.find(e=>e.currency===currency),prior=previous?.entries.find(e=>e.currency===currency);
  const comparable=current?.complete&&prior?.complete&&!current.repeated&&!prior.repeated&&current.amount!=null&&prior.amount!=null;
  return {currency,amount:known.length?known.reduce((sum,e)=>sum+cents(e.amount),0)/100:null,knownDays:known.length,
   completeDays:entries.filter(e=>e.complete&&!e.repeated).length,reviewDays:entries.filter(e=>e.repeated).length,
   change:comparable?{date:last.date,previousDate:previous.date,amount:(cents(current.amount)-cents(prior.amount))/100,percent:prior.amount>0?(current.amount-prior.amount)/prior.amount:null}:null};
 });
 return {filters,days,currencies,totals,summary:{days:days.length,reportedDays:days.filter(d=>d.status==='reported').length,missingDays:days.filter(d=>d.status==='missing').length,partialDays:days.filter(d=>d.status==='partial').length,reviewDays:days.filter(d=>d.status==='review').length},generatedAt:new Date().toISOString()};
}
