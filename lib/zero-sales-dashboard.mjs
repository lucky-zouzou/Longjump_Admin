// Counts are site + channel + SKU positions. Unique SKUs are separately deduplicated.
export const zeroSalesFilters={all:'全部有库存商品',reported_zero:'日报确认零销量',open:'已确认连续在售预警',availability:'零销量 · 在售待核实',missing:'日报待补齐',selling:'近7天有销量'};
export function matchesZeroSales(row,filter='all'){
 if(row.available<=0)return false;
 if(filter==='reported_zero')return row.coverage===7&&row.recent===0;
 if(filter==='open')return row.status==='open';
 if(filter==='availability')return row.coverage===7&&row.recent===0&&row.status!=='open';
 if(filter==='missing')return row.coverage<7;
 if(filter==='selling')return row.recent>0;
 return true;
}
function totals(rows){
 const stocked=rows.filter(r=>r.available>0),zero=stocked.filter(r=>matchesZeroSales(r,'reported_zero')),confirmed=zero.filter(r=>r.status==='open');
 const assessed=stocked.filter(r=>r.coverage===7).length;
 return {stocked:stocked.length,stockUnits:stocked.reduce((n,r)=>n+r.available,0),assessed,zero:zero.length,uniqueSkus:new Set(zero.map(r=>r.sku)).size,zeroUnits:zero.reduce((n,r)=>n+r.available,0),confirmed:confirmed.length,availability:zero.length-confirmed.length,missing:stocked.filter(r=>r.coverage<7).length,selling:stocked.filter(r=>r.recent>0).length,zeroRate:assessed?zero.length/assessed:null,
 tiers:[{label:'7–13天',min:7,max:13},{label:'14–29天',min:14,max:29},{label:'30天及以上',min:30,max:Infinity}].map(t=>({label:t.label,count:confirmed.filter(r=>r.zeroDays>=t.min&&r.zeroDays<=t.max).length}))};
}
export function summarizeZeroSales(alerts,scopes){
 // Scopes come from the authenticated server query, never from arbitrary client filters.
 const scopeKeys=new Set(scopes.map(r=>r.site+'|'+r.channel)),scoped=alerts.filter(r=>scopeKeys.has(r.site+'|'+r.channel));
 const channels=scopes.map(scope=>({...scope,...totals(scoped.filter(r=>r.site===scope.site&&r.channel===scope.channel)),missingDates:scope.missing}));
 const sites=[...new Set(scopes.map(r=>r.site))].map(site=>({site,...totals(scoped.filter(r=>r.site===site)),channels:channels.filter(r=>r.site===site)}));
 return {total:totals(scoped),sites,channels,top:scoped.filter(r=>matchesZeroSales(r,'reported_zero')).sort((a,b)=>b.available-a.available||b.zeroDays-a.zeroDays||a.sku.localeCompare(b.sku)).slice(0,10)};
}
