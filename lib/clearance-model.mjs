import {localDay,shiftDay,validDay,zeroSalesSites} from './promotion-model.mjs';
import {round} from './business-action-model.mjs';
export {localDay,round};
export const clearanceSites=zeroSalesSites;
export const clearanceStates={draft:'准备中',finance_review:'待财务核定',admin_review:'待管理员批准',approved:'待平台执行',active:'执行与复盘',completed:'已结案',cancelled:'已取消'};
export const clearanceActions={price:'调价',creative:'素材优化',advertising:'投放调整',live:'直播／达人',bundle:'组合促销',listing:'链接优化',quality:'品质整改',followup:'跟进记录',support:'财务支持',stop:'停止优惠'};
export const canClearance=a=>['管理员','财务','运营主管','运营'].includes(a?.role);
export const clearanceScope=(a,r)=>canClearance(a)&&(a.role!=='运营'||a.site===r.site&&a.channel===r.channel);
export const fail=(message,status=400)=>{const e=new Error(message);e.status=status;throw e;};
export const text=(v,max=1000)=>String(v??'').trim().slice(0,max);
export function money(v,label='金额'){if(v==null||v===''||!/^\d+(\.\d{1,2})?$/.test(String(v))||Number(v)>1e10)fail(`${label}须为非负金额（最多两位小数）；未知请先核实`);return round(Number(v));}
export function monthEnd(month){if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))fail('月份无效');return new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5)),0)).toISOString().slice(0,10);}
export function dates(from,to){const out=[];if(!validDay(from)||!validDay(to))return out;for(let d=from;d<=to&&out.length<62;d=shiftDay(d,1))out.push(d);return out;}
export function periods(start,end){return dates(start,end).filter((_,i)=>i%7===0).map(from=>({from,to:shiftDay(from,6)<end?shiftDay(from,6):end}));}
// A discount allowance is a decision limit, never a write-down of the product's real cost.
export function clearanceScenario(unitCny,percent){if(unitCny==null)return {percent,allowanceCny:null,planningBasisCny:null};return {percent,allowanceCny:round(unitCny*percent/100),planningBasisCny:round(unitCny*(1-percent/100))};}
export function ownerOn(line,events,date){return events.filter(e=>e.action==='assign'&&e.business_date<=date).sort((a,b)=>b.business_date.localeCompare(a.business_date)||b.created_at.localeCompare(a.created_at))[0]?.detail.ownerId||line.data.initialOwnerId||line.owner_id;}
export function summarizeDays(days,rate){
 const known=days.filter(d=>d.revenue!=null),verified=days.filter(d=>d.status==='confirmed'),sum=(xs,fn)=>round(xs.reduce((s,x)=>s+fn(x),0));
 const costs=d=>Object.values(d.costs||{}).reduce((s,v)=>s+Number(v||0),0);
 const totalQty=days.reduce((s,d)=>s+d.qty,0),revenue=sum(known,d=>d.revenue),knownProfit=sum(verified,d=>d.revenue-costs(d));
 return {days:days.length,completeDays:known.length,financeDays:verified.length,qty:totalQty,revenue:days.length&&known.length===days.length?revenue:null,knownRevenue:revenue,
  profit:days.length&&verified.length===days.length?knownProfit:null,knownProfit,knownLoss:sum(verified,d=>Math.max(0,costs(d)-d.revenue)),
  // Net loss is different from gross losses on individual dates.
  netLoss:days.length&&verified.length===days.length?Math.max(0,-knownProfit):null,
  knownAds:sum(verified,d=>d.costs.ads),knownSupportSpend:sum(verified,d=>(d.costs.ads||0)+(d.costs.other||0)),
  profitCny:rate&&days.length&&verified.length===days.length?round(knownProfit*rate.rate):null,
  knownProfitCny:rate?round(knownProfit*rate.rate):null,
  missingSales:days.filter(d=>d.revenue==null).map(d=>d.date),pendingFinance:days.filter(d=>d.status!=='confirmed').map(d=>({date:d.date,status:d.status})),rateId:rate?.id||null};
}
