import {financialRates,financeRows as rows,financeClock} from './finance-periods.mjs';
import {convertSalesSummary} from './sales-fx.mjs';
import {fail} from './cost-profit-model.mjs';
// Frozen periods replace current-source rows before conversion; only permitted
// scope rows leave this module. Never expose the rest of a financial snapshot.
export async function financialSalesSummary(db,actor,report){
 if(actor.role==='工厂')fail('当前岗位不可查看金额',403);const version=await financeClock(db),f=report.filters;
 const events=await rows(db,`SELECT p.* FROM finance_period_events p WHERE month BETWEEN ? AND ? AND revision=(SELECT MAX(x.revision) FROM finance_period_events x WHERE x.month=p.month)`,[f.from.slice(0,7),f.to.slice(0,7)]);
 const closed=new Map(events.filter(e=>e.status==='closed').map(e=>[e.month,JSON.parse(e.snapshot_json)]));
 let daily=(report.dayScopes||[]).filter(r=>!closed.has(r.date.slice(0,7)));
 for(const snapshot of closed.values())daily.push(...snapshot.salesDays.filter(r=>r.date>=f.from&&r.date<=f.to&&(!f.site||r.site===f.site)&&(!f.channel||r.channel===f.channel)));
 if(actor.role==='运营')daily=daily.filter(r=>r.site===actor.site&&r.channel===actor.channel);
 const months=[...new Set(daily.map(r=>r.date.slice(0,7)))],rateMap=new Map();for(const month of months)rateMap.set(month,closed.get(month)?.rates||await financialRates(db,month));
 const rateVersions=[],scopes=daily.map(r=>{const month=r.date.slice(0,7),rate=rateMap.get(month)?.[r.currency];if(rate&&!rateVersions.some(x=>x.id===rate.id&&x.month===month))rateVersions.push({month,currency:r.currency,rate:rate.rate,id:rate.id,revision:rate.revision,frozen:closed.has(month)});return {...r,cnyRate:rate?.rate??null,revenueCny:r.revenue==null||!rate?null:Math.round(r.revenue*rate.rate*100)/100,adCostCny:r.adCost==null||!rate?null:Math.round(r.adCost*rate.rate*100)/100,rateVersion:rate?.id||null,closed:closed.has(month)};});
 // Reuse the reference summary's grouping/coverage contract with already-CNY
 // rows, then restore original-currency evidence. No latest provider rates.
 const converted=convertSalesSummary({...report,scopes:scopes.map(r=>({...r,currency:'CNY',revenue:r.revenueCny,adCost:r.adCostCny,revenueMissing:r.revenueMissing+(r.revenueCny==null?1:0),costMissing:r.costMissing+(r.adCostCny==null?1:0)}))},{status:'financial',rates:{CNY:1}});
 const missing=scopes.filter(r=>r.cnyRate==null).length;converted.total.unconverted=missing;
 converted.scopes=scopes;converted.sites=converted.sites.map(s=>({...s,rows:scopes.filter(r=>r.site===s.site)}));
 if(await financeClock(db)!==version)fail('汇率或财务数据变化，请刷新',409);
 return {...converted,rateVersions,mode:'financial',closedMonths:[...closed.keys()],method:'按经营月份采用财务核定汇率；已关账月份使用封存销售及汇率版本。缺汇率不折算，已知部分不代表完整利润或到账。逐日逐站点渠道折算后合计。'};
}
