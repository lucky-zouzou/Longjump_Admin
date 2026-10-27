// Stored allocations use integer CNY cents. Original amounts and FX versions remain in every revision.
export class CostError extends Error { constructor(message,status=400){super(message);this.status=status;} }
export const fail=(message,status=400)=>{throw new CostError(message,status);};
export const STATES=['actual','estimated','pending','zero','not_applicable','missing'];
export const STATE_LABELS={actual:'实际',estimated:'暂估',pending:'待确认',zero:'明确零费用',not_applicable:'不适用',missing:'缺失'};
export const COST_LABELS={product:'商品',sea:'海运',tax:'计入存货税费',warehouse:'仓库履约',platform:'平台/达人',advertising:'广告',refund:'退款损耗'};
export function text(v,label,max=240,optional=false){const s=String(v??'').trim();if((!s&&!optional)||s.length>max)fail(`${label}必填且最多${max}字`);return s;}
export function number(v,label,{min=0,max=1e9,integer=false}={}){if(v==null||String(v).trim()===''||typeof v==='boolean'||!/^\d+(\.\d+)?$/.test(String(v)))fail(`${label}须明确填写非负数字，缺失不能填0`);const n=Number(v);if(!Number.isFinite(n)||n<min||n>max||(integer&&!Number.isSafeInteger(n)))fail(`${label}数值超出范围`);return n;}
export function date(v){const s=text(v,'日期',10);if(!/^\d{4}-\d{2}-\d{2}$/.test(s)||!Number.isFinite(Date.parse(s))||new Date(s).toISOString().slice(0,10)!==s)fail('日期须为有效 YYYY-MM-DD');return s;}
export const cents=n=>{const v=Math.round((n+Number.EPSILON)*100);if(!Number.isSafeInteger(v)||Math.abs(v)>1e13)fail('金额超出安全计算范围');return v;};
export function money(amount,state,source){if(!STATES.includes(state))fail('费用状态无效');const evidence=text(source,'凭据/缺失原因',1000);if(['missing','pending'].includes(state)){if(amount!==''&&amount!=null)fail('缺失/待确认金额须留空；已有预估金额请选择暂估');return {amount:null,state,source:evidence};}const n=number(amount,'金额');if(['zero','not_applicable'].includes(state)&&n!==0)fail('零费用/不适用必须明确填0');if(state==='actual'&&n===0)fail('零金额请选择明确零费用');return {amount:n,state,source:evidence};}
export function fx(p){const currency=text(p.currency,'币种',3).toUpperCase();if(!['CNY','USD','MYR','IDR','THB','VND','PHP'].includes(currency))fail('币种无效');const rate=number(p.fx,'兑CNY汇率',{min:0.00000001,max:10000});if(currency==='CNY'&&rate!==1)fail('CNY汇率必须为1');return {currency,fx:rate,fxVersion:text(p.fxVersion,'汇率版本/日期',100)};}
export function allocate(total,weights){
 if(!Number.isSafeInteger(total)||total<0||!weights.length||weights.some(w=>!Number.isFinite(w)||w<0||w>1e12))fail('分摊金额/依据无效');
 const units=weights.map(w=>BigInt(w.toFixed(8).replace('.',''))),sum=units.reduce((a,b)=>a+b,0n);if(sum===0n)fail('分摊依据须大于0（最多8位小数）');
 const numerators=units.map(w=>BigInt(total)*w),result=numerators.map(n=>Number(n/sum)),remainder=total-result.reduce((a,b)=>a+b,0);
 const order=numerators.map((n,i)=>({i,r:n%sum})).sort((a,b)=>a.r===b.r?b.i-a.i:a.r>b.r?-1:1);
 for(let i=0;i<remainder;i++)result[order[i%order.length].i]++;return result;
}
export function consumedCost(total,before,qty,lotQty){return Number(BigInt(total)*BigInt(before+qty)/BigInt(lotQty)-BigInt(total)*BigInt(before)/BigInt(lotQty));}

export function ticketCosts(ticket,treatment='inventory'){
 const weights=basis=>ticket.lines.map(l=>basis==='qty'?l.qty:l[basis]);
 const shares=Object.fromEntries(['sea','tax'].map(k=>{const f=ticket[k];return [k,f.amount==null?null:allocate(cents(f.amount*f.fx),weights(f.basis))];}));
 return ticket.lines.map((l,i)=>{const product=l.amount==null?null:cents(l.amount*l.fx*l.qty),sea=shares.sea?.[i]??null,tax=['period','recoverable','not_applicable'].includes(treatment)?0:shares.tax?.[i]??null;
 return {...l,costs:{product,sea,tax},total:product==null||sea==null||tax==null?null:product+sea+tax,estimated:[l,ticket.sea,ticket.tax].some(x=>x.state==='estimated'),missing:[['商品',l],['海运',ticket.sea],['税费',ticket.tax]].filter(([,v])=>v.amount==null).map(([k])=>k)};});
}
export function warehouseCost(p,qty){return cents(number(p.perOrder,'每单费用')+number(p.perParcel,'每包裹费用')*number(p.parcels,'包裹数',{integer:true,min:1})+number(p.perItem,'每件费用')*qty);}
export function contribution({revenue,basis,platform,product,sea,tax,warehouse,advertising,refund}){const costs={product,sea,tax,warehouse,platform,advertising,refund};const gross=revenue==null||basis==='net'&&platform==null?null:revenue+(basis==='net'?platform:0);return {gross,costs,contribution:gross==null||Object.values(costs).some(n=>n==null)?null:gross-Object.values(costs).reduce((a,b)=>a+b,0)};}
export function simulate(p,unitCost){const price=number(p.price,'售价'),discount=number(p.discount,'优惠金额',{max:price}),rate=number(p.commission,'佣金率',{max:1}),ad=number(p.advertising,'单件广告'),warehouse=number(p.warehouse,'单件履约');const revenue=cents(price-discount),platform=Math.round(revenue*rate),profit=unitCost==null?null:revenue-platform-unitCost-cents(ad+warehouse);return {price,discount,rate,advertising:ad,warehouse,unitCost,revenue,platform,contribution:profit,margin:revenue&&profit!=null?profit/revenue:null,breakEven:unitCost==null||rate===1?null:(unitCost+cents(ad+warehouse))/(1-rate)/100+discount};}
export function marketState(d,now=new Date()){return d.observedAt>now.toISOString().slice(0,10)?'待核实':+now-Date.parse(d.observedAt)>14*86400000?'过期':d.stock==='in_stock'?'公开价格证据':'库存待核实';}
