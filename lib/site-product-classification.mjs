import {COST_SITES,CLASS_LABELS,DEFAULT_RULES,classifyProduct,fail} from './product-cost-model.mjs';
import {completeSalesDates} from './sales-completeness.mjs';
import {localDay,shiftDay,validDay,siteOffset} from './promotion-model.mjs';

// Trial parameters approved for country-level, combined TikTok + Shopee sales.
// They are fixed defaults, not daily percentile recalculations.
export const SITE_RULE_DEFAULTS=Object.fromEntries(Object.entries({印尼:[18,3],泰国:[7,2],马来西亚:[4,1.5],菲律宾:[5,1.5],越南:[3,2]}).map(([site,[hero,hot]])=>[site,{...DEFAULT_RULES,heroDaily:hero,heroRecentDaily:hero,hotDaily:hot,hotRecentDaily:hot}]));
export const SITE_CHANNELS=['TikTok','Shopee'];
export const siteSkuKey=r=>JSON.stringify([r.site,r.sku]);
const channelKey=r=>JSON.stringify([r.site,r.channel]);
const stockKey=r=>JSON.stringify([r.site,r.channel,r.sku]);
const group=(rows,key)=>{const m=new Map();for(const r of rows){const k=key(r);if(!m.has(k))m.set(k,[]);m.get(k).push(r);}return m;};

export function validateSiteRules(input){
 const result={};for(const k of Object.keys(SITE_RULE_DEFAULTS.印尼)){const v=input?.[k],n=Number(v);if(v==null||v===''||!['number','string'].includes(typeof v)||!Number.isFinite(n)||n<=0||n>100000)fail('分类阈值必须为有效正数');result[k]=n;}
 if(result.heroDaily<=result.hotDaily||result.heroRecentDaily<=result.hotRecentDaily||result.hotDaily<=result.slowDaily||!Number.isInteger(result.slowCover)||!Number.isInteger(result.minAge)||result.minAge<28)fail('各周期爆款阈值须高于热卖，28天热卖须高于滞销；观察期至少28天，天数须为整数');
 return result;
}
export function siteRuleSet(stored){
 // Legacy global rules remain in the immutable audit table. They must not silently
 // overwrite the newly approved country defaults or be treated as site overrides.
 return Object.fromEntries(COST_SITES.map(site=>[site,stored?.scope==='site'&&stored.sites?.[site]?validateSiteRules(stored.sites[site]):{...SITE_RULE_DEFAULTS[site]}]));
}
function salesTier(quantity,days,missing,hero,hot){
 const observedDaily=quantity/days,level=observedDaily>=hero?'hero':observedDaily>=hot?'hot':'steady',complete=missing.length===0;
 return {category:complete?level:null,label:complete?(level==='steady'?(quantity===0?'零销量':'未达热卖'):CLASS_LABELS[level]):'待核实',candidate:!complete&&level!=='steady'?level:null,quantity,daily:complete?observedDaily:null,complete,missing};
}
const safeStock=s=>s&&Number.isSafeInteger(s.qty)&&Number.isSafeInteger(s.reserved_qty??0)&&s.qty>=0&&(s.reserved_qty??0)>=0&&s.qty>=(s.reserved_qty??0);
function availableOnDay(a,observations,day,site){
 if(!a||!validDay(a.listed_since)||a.listed_since>day)return false;
 const o=observations.find(o=>o.day===day);
 if(o&&o.min_available<=0)return false;
 return Boolean(validDay(a.available_since)&&validDay(a.verified_through)&&a.available_since<=day&&a.verified_through>=day||o?.min_available>0&&Date.parse(o.first_at)<=Date.parse(day+`T00:05:00+0${siteOffset(site)}:00`));
}
export function classifySiteProducts({stocks,sales,imports,availability=[],observations=[]},rulesBySite=siteRuleSet(),now=new Date()){
 const salesByChannel=group(sales,channelKey),importsByChannel=group(imports,channelKey),complete=new Map();
 for(const [key,rows] of importsByChannel)complete.set(key,new Set(completeSalesDates(rows,salesByChannel.get(key)||[])));
 const stockMap=new Map(stocks.map(s=>[stockKey(s),s])),salesMap=group(sales,siteSkuKey),availabilityMap=new Map(availability.map(a=>[stockKey(a),a])),observationsMap=group(observations,stockKey);
 const scopes=new Map([...stocks,...sales].filter(r=>COST_SITES.includes(r.site)&&SITE_CHANNELS.includes(r.channel)).map(r=>[siteSkuKey(r),{site:r.site,sku:r.sku}]));
 return [...scopes.values()].map(scope=>{
  const rules=rulesBySite[scope.site],cutoff=shiftDay(localDay(now,scope.site),-1),days=Array.from({length:28},(_,i)=>shiftDay(cutoff,i-27));
  const members=SITE_CHANNELS.map(channel=>({...scope,channel})),byChannel=members.map(m=>({channel:m.channel,missing:days.filter(d=>!complete.get(channelKey(m))?.has(d))}));
  // A complete date means both platform reports are complete, not merely one.
  const completeDates=days.filter(d=>byChannel.every(c=>!c.missing.includes(d)));
  const balances=members.map(m=>stockMap.get(stockKey(m))),stockKnown=balances.every(safeStock),qty=stockKnown?balances.reduce((n,s)=>n+s.qty,0):null,reserved=stockKnown?balances.reduce((n,s)=>n+(s.reserved_qty??0),0):null;
  const dates=members.map(m=>availabilityMap.get(stockKey(m))?.listed_since).filter(d=>validDay(d)&&d<=cutoff).sort();
  // One evidenced channel with positive stock proves site availability that day.
  // Two unknown channels never become a synthetic in-stock day.
  let since=null;for(const day of [...days].reverse()){if(!members.some(m=>availableOnDay(availabilityMap.get(stockKey(m)),observationsMap.get(stockKey(m))||[],day,scope.site)))break;since=day;}
  const combinedAvailability=dates.length?{listed_since:dates[0],available_since:since,verified_through:since?cutoff:null}:null;
  const performance=classifyProduct({stock:{...scope,qty:Number.isSafeInteger(qty)?qty:null,reserved_qty:reserved},sales:salesMap.get(siteSkuKey(scope))||[],completeDates,availability:combinedAvailability},rules,now);
  const missing7=performance.missing.filter(d=>d>=shiftDay(cutoff,-6));
  const period28=salesTier(performance.qty28,28,performance.missing,rules.heroDaily,rules.hotDaily),period7=salesTier(performance.qty7,7,missing7,rules.heroRecentDaily,rules.hotRecentDaily);
  // Health still requires stock, age and report evidence. The 28-day sales tier
  // no longer depends on passing the independent 7-day threshold.
  if(!performance.reasons.length&&performance.category!=='slow'){performance.category=period28.category;performance.label=CLASS_LABELS[performance.category];}
  const momentum=period28.complete&&period7.complete?(period28.category==='hero'&&period7.category==='hero'?'持续爆款':period7.category==='hero'&&period28.category!=='hero'?'近期起量':period28.category==='hero'&&period7.category!=='hero'?'近期放缓':''):'';
  return {...scope,channels:SITE_CHANNELS,performance:{...performance,period28,period7,momentum,missingByChannel:byChannel,ruleSite:scope.site}};
 });
}
