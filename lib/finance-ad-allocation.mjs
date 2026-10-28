import {cents,fail} from './cost-profit-model.mjs';
const rows=async(db,sql,args=[])=>(await db.prepare(sql).bind(...args).all()).results||[];
export async function dailyAdAllocation(db,{site,channel,sku,date,currency}){
 const [shop,sales,days]=await Promise.all([
  rows(db,'SELECT * FROM sales_ad_spend WHERE site=? AND channel=? AND business_date=? AND currency=? AND deleted_at IS NULL',[site,channel,date,currency]),
  rows(db,'SELECT id,sku,ad_cost FROM sales_records WHERE site=? AND channel=? AND business_date=? AND currency=? AND reversed_at IS NULL',[site,channel,date,currency]),
  rows(db,`SELECT f.* FROM business_action_finance_days f WHERE site=? AND channel=? AND business_date=? AND currency=? AND revision=(SELECT MAX(x.revision) FROM business_action_finance_days x WHERE x.site=f.site AND x.channel=f.channel AND x.sku=f.sku AND x.business_date=f.business_date)`,[site,channel,date,currency])
 ]);
 return adAllocationRows({shop,sales,days,sku});
}
export function adAllocationRows({shop,sales,days,sku}){
 const own=sales.filter(r=>r.sku===sku),directKnown=own.length&&own.every(r=>r.ad_cost!=null);
 const total=shop.length?shop.reduce((n,r)=>n+cents(r.amount),0):directKnown?own.reduce((n,r)=>n+cents(r.ad_cost),0):null;
 const other=shop.length?days.filter(r=>r.sku!==sku).reduce((n,r)=>n+cents(JSON.parse(r.data_json).ads),0):0;
 return {mode:shop.length?'shop':directKnown?'direct':'unverified',sourceIds:shop.length?shop.map(r=>r.id):own.filter(r=>r.ad_cost!=null).map(r=>r.id),total:total==null?null:total/100,otherAllocated:other/100,available:total==null?null:Math.max(0,total-other)/100,overallocated:total!=null&&other>total};
}
export async function assertDailyAdAllocation(db,scope,amount){
 const a=await dailyAdAllocation(db,scope);
 if(a.total==null&&amount>0)fail('广告来源待核实：请先登记店铺当天总费用或可归属SKU的实际广告费，不能直接填入无来源金额');
 if(a.total!=null&&(cents(amount)+cents(a.otherAllocated)>cents(a.total)))fail(`广告分配超额：来源总额 ${a.total} ${scope.currency}，其他SKU已分配 ${a.otherAllocated}，本SKU最多 ${a.available}；请修订原分配，不要重复计费`,409);
 return a;
}
