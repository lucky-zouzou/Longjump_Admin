export class PromotionError extends Error {constructor(message,status=400){super(message);this.status=status;}}
export const fail=(m,s=400)=>{throw new PromotionError(m,s)};
export const text=(v,max=2000)=>String(v??'').trim().slice(0,max);
export const localDay=(at=new Date())=>new Date(+new Date(at)+7*3600000).toISOString().slice(0,10);
export const shiftDay=(d,n)=>new Date(Date.parse(d+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);
export const validDay=d=>/^20\d{2}-\d{2}-\d{2}$/.test(d)&&!isNaN(Date.parse(d))&&new Date(d).toISOString().slice(0,10)===d;
export const statuses={draft:'草稿',finance_review:'待财务核算',admin_review:'待管理员审批',approved:'已批准待执行',active:'优惠执行中',stop_required:'待停止／恢复价格',review_pending:'待复盘',completed:'已复盘',withdrawn:'已撤回',rejected:'已驳回',terminated:'未登记执行已终止'};
export const costFields={landed:'到岸采购成本／件',fulfillment:'履约成本／件',returns:'预计售后成本／件',ad:'预计广告费用／件'};
export function cents(v,label,optional=false){if(optional&&(v===''||v==null))return null;if(!/^\d+(\.\d{1,2})?$/.test(String(v??'')))fail(label+'请填写非负金额，最多两位小数');const n=Math.round(Number(v)*100);if(!Number.isSafeInteger(n)||n>1e12)fail(label+'超出范围');return n;}
const integer=(v,label)=>{const n=Number(v);if(!Number.isSafeInteger(n)||n<1||n>1000000)fail(label+'需为1至100万的整数');return n;};
export function normalizeProposal(p,now=new Date()){
 const start=text(p.start,10),end=text(p.end,10),reason=text(p.reason),goal=text(p.goal),url=text(p.url,600);
 if(!validDay(start)||!validDay(end)||start<localDay(now)||end<start||Date.parse(end)-Date.parse(start)>30*86400000)fail('优惠需从今天或未来开始，结束日不得早于开始日，最长31天');
 try{if(new URL(url).protocol!=='https:')throw Error();}catch{fail('请填写 HTTPS 商品或活动链接');}
 if(reason.length<4||goal.length<4||text(p.method).length<2)fail('请填写优惠方式、原因和量化目标');
 const original=cents(p.original,'当前成交价'),price=cents(p.price,'优惠最终成交价'),floor=cents(p.floor,'最低允许成交价'),qty=integer(p.qty,'优惠数量上限'),budget=cents(p.budget,'总预算'),lossCap=cents(p.lossCap??0,'总亏损上限');
 if(!price||price>=original||floor>price||!floor)fail('优惠价应为正数且低于原价，不得低于最低允许成交价');
 if(!Number.isSafeInteger(original*qty)||!Number.isSafeInteger(budget+lossCap))fail('金额与数量乘积超出安全范围');
 if((original-price)*qty>budget)fail('总预算至少覆盖全部优惠让利；财务核算还将计入预计广告费用');
 return {start,end,reason,goal,url,method:text(p.method,300),original,price,floor,qty,budget,lossCap,clearance:p.clearance===true,currency:'IDR'};
}
export function normalizeCosts(p,d){
 const costs={};for(const [k,l] of Object.entries(costFields))costs[k]=cents(p[k],l);
 const rate=Number(p.rate);if(p.rate===''||p.rate==null||!Number.isFinite(rate)||rate<0||rate>=100||Math.abs(Math.round(rate*100)-rate*100)>0.00001)fail('平台／支付／佣金合计费率需在0至100%之间，最多两位小数');
 const source=text(p.source),costDate=text(p.costDate,10);if(source.length<4||!validDay(costDate)||costDate>localDay())fail('请填写成本来源／版本和有效核算日期');
 const fees=Math.ceil(d.price*rate/100),unitCost=Object.values(costs).reduce((s,n)=>s+n,0)+fees,contribution=d.price-unitCost;
 if(!Number.isSafeInteger(unitCost*d.qty))fail('成本与数量乘积超出安全范围');
 if(d.budget<(d.original-d.price+costs.ad)*d.qty)fail('总预算不足以覆盖优惠让利和预计广告费用，请退回修改');
 if(contribution<0&&(!d.clearance||d.lossCap<-contribution*d.qty))fail('预计亏损：需申请专项清仓并设置足额总亏损上限');
 return {...costs,rate,source,costDate,fees,unitCost,contribution,estimatedLoss:Math.max(0,-contribution)*d.qty};
}
// Gross positive sales: returns and refunds never turn a selling SKU into a zero-sales SKU.
export function evaluateZeroSales({stock,sales,completeDates,availability,observations},now=new Date()){
 const cutoff=shiftDay(localDay(now),-1),days=Array.from({length:30},(_,i)=>shiftDay(cutoff,-i));
 const available=Math.max(0,stock.qty-stock.reserved_qty),complete=new Set(completeDates),missing=days.slice(0,7).filter(d=>!complete.has(d));
 const positive=sales.filter(s=>s.qty>0),recent=positive.filter(s=>s.business_date>=days[6]&&s.business_date<=cutoff).reduce((s,r)=>s+r.qty,0),lastSale=positive.filter(s=>s.business_date<=cutoff).map(s=>s.business_date).sort().at(-1)||null;
 const obs=new Map(observations.map(o=>[o.day,o]));
 // Compare timestamps numerically (offset strings must never be ordered lexically).
 const availableDay=d=>{const o=obs.get(d);if(o&&o.min_available<=0)return false;return Boolean(availability&&availability.listed_since<=d&&((availability.available_since<=d&&availability.verified_through>=d)||(o&&o.min_available>0&&Date.parse(o.first_at)<=Date.parse(d+'T00:05:00+07:00'))));};
 let zeroDays=0;for(const d of days){if(!complete.has(d)||!availableDay(d)||positive.some(s=>s.business_date===d))break;zeroDays++;}
 const reasons=[];if(missing.length)reasons.push(`缺少${missing.length}天完整日报`);if(!availability)reasons.push('尚未核实上架与连续可售日期');else if(days.slice(0,7).some(d=>!availableDay(d)))reasons.push('连续在售有货不足7天或历史待核实');
 const status=available<=0||recent>0?'closed':zeroDays>=7?'open':'observe';
 return {site:stock.site,channel:stock.channel,sku:stock.sku,name:stock.name,available,cutoff,start:days[6],recent,zeroDays,lastSale,coverage:7-missing.length,missing,reasons,status,level:zeroDays>=30?'专项去化':zeroDays>=14?'需处理':'关注',closedReason:available<=0?'当前无可售库存':recent>0?'近7天已有销售':'',verification:availability?{listedSince:availability.listed_since,availableSince:availability.available_since,through:availability.verified_through,reference:availability.reference,at:availability.updated_at}:null};
}
