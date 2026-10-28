import {localDay,shiftDay,validDay,zeroSalesSites,evaluateZeroSales} from './promotion-model.mjs';
export class ProductCostError extends Error {constructor(message,status=400){super(message);this.status=status;}}
export const fail=(message,status=400)=>{throw new ProductCostError(message,status);};
export const COST_SITES=zeroSalesSites;
export const COST_BASIS={unconfirmed:'费用范围待核实',purchase_freight:'采购＋海运（税费、入仓未核实）',landed:'已确认完整到仓成本'};
export const CLASS_LABELS={hero:'爆款',hot:'热卖款',steady:'平销款',slow:'滞销款'};
export const DEFAULT_RULES={heroDaily:10,hotDaily:3,heroRecentDaily:7,slowDaily:0.5,slowCover:90,minAge:28};
export function validateRules(input){
 const r={};for(const [k,base] of Object.entries(DEFAULT_RULES)){const n=Number(input[k]);if(input[k]===''||input[k]==null||!Number.isFinite(n)||n<=0||n>100000)fail('分类阈值必须为有效正数');r[k]=n;}
 if(!(r.heroDaily>r.hotDaily&&r.hotDaily>r.slowDaily)||r.heroRecentDaily>r.heroDaily||!Number.isInteger(r.slowCover)||!Number.isInteger(r.minAge)||r.minAge<28)fail('爆款日均须高于热卖、热卖须高于滞销；滞销观察期至少28天，天数须为整数');return r;
}
export const clean=(v,max=240)=>String(v??'').trim().slice(0,max);
export const skuCode=v=>clean(v,120).toUpperCase();
// Four decimal places preserve freight allocation; absent values are never zero.
export function units(v){if(v==null||typeof v==='string'&&!v.trim())return null;const n=Number(v);if(!['string','number'].includes(typeof v)||!Number.isFinite(n)||n<0||n>1e8)fail('成本须为非负数字，未知请留空');return Math.round(n*10000);}
export function normalizeCost(row,skus){
 const sku=skuCode(row.sku),matches=skus.filter(s=>skuCode(s.sku)===sku);if(matches.length!==1)fail(matches.length?'SKU大小写存在歧义，请核对主数据':`未匹配系统SKU：${sku}`);
 if(!COST_SITES.includes(row.site))fail('站点无效');
 const purchase=units(row.purchase),freight=units(row.freight),total=units(row.total);
 if([purchase,freight,total].every(v=>v==null))fail('该站点未提供成本');
 if(total!==null&&purchase!==null&&freight!==null&&Math.abs(purchase+freight-total)>110)fail('采购＋海运与综合成本不一致，请先核对原表');
 return {sku:matches[0].sku,site:row.site,purchase,freight,total};
}
// Header-based parsing: never guess the columns of a headerless supplementary sheet.
export function parseProductCostSheet(matrix,sheet){
 const at=matrix.findIndex(r=>r.some(c=>clean(c).replace(/^\*/, '')==='商品编码SKU'));
 if(at<0)fail('未找到商品编码SKU表头，请选择有完整表头的工作表');
 const headers=matrix[at].map(c=>clean(c).replace(/^\*/,'')),ix=k=>headers.indexOf(k),out=[];
 const prefixes={印尼:'印尼',马来西亚:'马来',菲律宾:'菲律宾',泰国:'泰国',越南:'越南'};
 for(let i=at+1;i<matrix.length;i++){const r=matrix[i],sku=skuCode(r[ix('商品编码SKU')]);if(!sku)continue;
  for(const site of COST_SITES){const p=prefixes[site],freight=r[ix(p+'海运费用')],total=r[ix(p+'综合成本')];
   // A procurement-only row does not establish which destination costs apply.
   if((freight==null||freight==='')&&(total==null||total===''))continue;
   out.push({sku,site,name:clean(r[ix('商品名称')]),purchase:r[ix('商品采购成本')]??null,freight:freight??null,total:total??null,source:{sheet,row:i+1},sourceLabel:clean(r[ix('状态')])});
  }
 }if(out.length>5000)fail('单次最多5000条站点成本，请拆分文件');if(!out.length)fail('工作表没有可识别的站点成本');return out;
}
export function mergeProductCostSheets(primary,fallback){
 const key=r=>r.site+'|'+skuCode(r.sku),merged=new Map();
 // Reject ambiguous source duplicates rather than choosing the last value.
 for(const source of [primary,fallback]){const seen=new Set();for(const r of source){if(seen.has(key(r)))fail('来源工作表存在重复的站点SKU，请先整理');seen.add(key(r));}}
 for(const r of primary)merged.set(key(r),{...r,source:{...r.source,fields:{purchase:r.source,freight:r.source,total:r.source}}});
 for(const r of fallback){const p=merged.get(key(r));if(!p){merged.set(key(r),r);continue;}
  const original={purchase:p.purchase,freight:p.freight,total:p.total},filled=[];
  for(const field of ['purchase','freight','total'])if((p[field]==null||p[field]==='')&&r[field]!=null&&r[field]!==''){p[field]=r[field];p.source.fields[field]=r.source;filled.push(field);}
  // An authoritative total cannot be invalidated by older auxiliary components.
  if(filled.length&&[p.purchase,p.freight,p.total].every(v=>v!=null&&v!==''&&Number.isFinite(Number(v)))&&Math.abs(units(p.purchase)+units(p.freight)-units(p.total))>110){
   for(const field of filled){p[field]=original[field];delete p.source.fields[field];}
   p.source.warning=`辅表 ${r.source.sheet} 第${r.source.row}行分项与主表不一致，未补入冲突分项，保留主表值`;
  }
 }
 return [...merged.values()];
}
export function classifyProduct({stock,sales,completeDates,availability,observations=[]},rules=DEFAULT_RULES,now=new Date()){
 const cutoff=shiftDay(localDay(now,stock.site),-1),start=shiftDay(cutoff,-27),days=Array.from({length:28},(_,i)=>shiftDay(start,i)),complete=new Set(completeDates),missing=days.filter(d=>!complete.has(d));
 const positive=sales.filter(s=>s.qty>0&&s.business_date>=start&&s.business_date<=cutoff),sum=(from,to)=>positive.filter(s=>s.business_date>=from&&s.business_date<=to).reduce((n,s)=>n+s.qty,0);
 const qty28=sum(start,cutoff),qty7=sum(shiftDay(cutoff,-6),cutoff),previous7=sum(shiftDay(cutoff,-13),shiftDay(cutoff,-7));
 const stockKnown=Number.isSafeInteger(stock.qty)&&Number.isSafeInteger(stock.reserved_qty??0)&&stock.qty>=0&&(stock.reserved_qty??0)>=0&&stock.qty>=(stock.reserved_qty??0);
 const available=stockKnown?stock.qty-(stock.reserved_qty??0):null,age=availability&&validDay(availability.listed_since)?Math.floor((Date.parse(cutoff)-Date.parse(availability.listed_since))/86400000)+1:null;
 const daily28=missing.length?null:qty28/28,daily7=days.slice(-7).every(d=>complete.has(d))?qty7/7:null;
 const cover=available!=null&&daily28>0?available/daily28:null;
 const zero=evaluateZeroSales({stock:{...stock,qty:stock.qty??0},sales,completeDates,availability,observations},now);
 const reasons=[];if(missing.length)reasons.push(`近28天缺${missing.length}天完整日报`);if(!stockKnown)reasons.push('库存数量或预留异常');
 if(age==null)reasons.push('上架时间未核实');else if(age<rules.minAge)reasons.push(`上架${age}天，观察期${rules.minAge}天`);
 let category=null;
 if(!reasons.length){
  if(qty7===0&&available>0&&zero.zeroDays<7)reasons.push('零销售期间连续有货未核实，不能判为滞销');
  else if(available>0&&(zero.zeroDays>=7||daily28<rules.slowDaily&&cover>=rules.slowCover&&zero.verification?.availableSince<=shiftDay(cutoff,-6)&&zero.verification?.through>=cutoff&&!observations.some(o=>o.day>=shiftDay(cutoff,-6)&&o.day<=cutoff&&o.min_available<=0)))category='slow';
  else if(daily28>=rules.heroDaily&&daily7>=rules.heroRecentDaily)category='hero';
  else if(daily28>=rules.hotDaily)category='hot';
  else if(available===0&&qty7===0)reasons.push('暂无可售库存，等待恢复后观察');
  else category='steady';
 }
 return {category,label:category?CLASS_LABELS[category]:'待核实／观察',cutoff,start,qty28,qty7,previous7,daily28,daily7,cover,available,age,missing,reasons,trend:previous7>0&&daily7!==null&&(days.slice(-14).every(d=>complete.has(d)))?(qty7-previous7)/previous7:null,zeroDays:zero.zeroDays};
}
