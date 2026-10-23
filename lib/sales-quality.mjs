import {salesFinancials} from './sales-data.mjs';
// Warnings need human verification: equal costs and zero-value gifts can be legitimate.
export function salesImportWarnings(rows,defaultCurrency=''){
 const warnings=[],groups=new Map(),foreign=new Map(),zero=[];
 rows.forEach((r,i)=>{try{
  const f=salesFinancials(r,defaultCurrency),line=r._row||i+2;
  if(defaultCurrency&&f.currency!==defaultCurrency)foreign.set(f.currency,(foreign.get(f.currency)||0)+1);
  if(Number(r.qty)>0&&f.amount===0)zero.push(line);
  if(f.adCost>0){const key=`${f.currency}|${f.adCost}`,g=groups.get(key)||{currency:f.currency,cost:f.adCost,lines:[],skus:new Set()};g.lines.push(line);g.skus.add(r.sku);groups.set(key,g);}
 }catch{/* Field validation presents malformed rows separately. */}});
 for(const g of groups.values())if(g.skus.size>=3)warnings.push({code:`repeated-cost-${g.currency}-${g.cost}`,message:`${g.lines.length} 行填写了相同的广告费 ${g.cost.toLocaleString('zh-CN')} ${g.currency}，合计 ${(g.cost*g.lines.length).toLocaleString('zh-CN')}。请确认是各 SKU 的真实费用；店铺总费用只在“渠道广告总费用”登记一次。没有 SKU 费用明细时请留空，不要均摊或重复填写。`});
 for(const [currency,count] of foreign)warnings.push({code:`foreign-${currency}`,message:`${count} 行使用 ${currency}，当前站点本币为 ${defaultCurrency}。请确认金额已经按该币种填写；仅修改币种标签不会换算金额。`});
 if(zero.length)warnings.push({code:'zero-revenue',message:`第 ${zero.slice(0,12).join('、')}${zero.length>12?' 等':''} 行有销量但销售额为 0。请确认是赠品或真实零金额；未知金额应留空。`});
 return warnings;
}
