import {CLASS_LABELS} from './product-cost-model.mjs';
export const HEALTH_LABELS={...CLASS_LABELS,observe:'待核实／观察'};
export const healthKey=r=>JSON.stringify([r.site,r.channel,r.sku]);
export function healthSummary(items){
 const groups=Object.fromEntries(Object.keys(HEALTH_LABELS).map(k=>[k,{count:0,available:0,unknownStock:0,value:0,unknownCost:0}]));
 for(const r of items){const g=groups[r.performance.category||'observe'];g.count++;if(r.performance.available==null)g.unknownStock++;else g.available+=r.performance.available;if(r.stockCost==null||r.cost?.basis!=='landed')g.unknownCost++;else g.value+=r.stockCost;}
 return {groups,uniqueSkus:new Set(items.map(r=>r.sku)).size,scopes:items.length};
}
export function healthPriority(a,b){
 // Only confirmed slow movers enter liquidation priority. Unknown costs do not become zero.
 const lane=r=>r.performance.category==='slow'?0:r.performance.category==null?2:1;
 return lane(a)-lane(b)||(a.stockCost==null)-(b.stockCost==null)||(b.stockCost??0)-(a.stockCost??0)||(b.performance.available??0)-(a.performance.available??0)||healthKey(a).localeCompare(healthKey(b));
}
export function healthAdvice(r){const p=r.performance;
 if(!p.category)return '先补齐日报、上架及连续有货证据，再判断动销；不直接降价。';
 if(p.category==='slow')return '运营核查流量、转化、价格及质量；财务核对成本与最低售价，再申请促销或调拨并复查。';
 if(p.category==='hero'||p.category==='hot')return '运营核查贡献利润，供应链结合有效到货与补货周期防断货；销量高不等于盈利。';
 return '保持常规销售，跟踪7天趋势和库存覆盖，出现下滑再诊断。';}
