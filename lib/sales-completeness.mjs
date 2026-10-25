// A SKU/day summary has no order-line identity. A second summary for the same
// scope may overlap even when every number, filename and batch reference differs.
export const overlapMessage='同日同站点渠道已有该 SKU 销量，无法证明报表不重叠；本批未写入、未扣库。请在导入历史修订原批次（填写累计正确数量），不要换文件或批次追加。';
export function completeSalesDates(imports,sales=[]){
 const batches=new Map(),overlaps=new Set();
 for(const r of sales){if(!(r.qty>0)||r.reversed_at)continue;const key=JSON.stringify([r.business_date,r.sku]);const set=batches.get(key)||new Set();set.add(r.import_id);batches.set(key,set);if(set.size>1)overlaps.add(r.business_date);}
 return [...new Set(imports.filter(r=>!r.reversed_at&&['complete','zero'].includes(r.report_kind)&&!overlaps.has(r.business_date)).map(r=>r.business_date))];
}
