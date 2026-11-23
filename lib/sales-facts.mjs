// Shared source for monthly targets and daily briefings. Call inside one db.batch
// so revenue, store-level advertising and completeness use the same snapshot.
export function salesFactStatements(db, from, to, scope={sql:'',args:[]}) {
 const f=scope,args=[from,to,...f.args];
 return [
  db.prepare(`SELECT * FROM (WITH r AS (SELECT * FROM sales_records WHERE reversed_at IS NULL AND business_date BETWEEN ? AND ? AND channel IN ('TikTok','Shopee')${f.sql}), repeated_values AS (
   SELECT business_date,site,channel,COALESCE(currency,'UNKNOWN') currency,ad_cost FROM r WHERE ad_cost>0 GROUP BY business_date,site,channel,COALESCE(currency,'UNKNOWN'),ad_cost HAVING COUNT(DISTINCT sku)>=3
  ), repeated AS (SELECT DISTINCT business_date,site,channel,currency FROM repeated_values), grouped AS (
   SELECT business_date date,site,channel,COALESCE(currency,'UNKNOWN') currency,SUM(qty) qty,SUM(reported_amount) revenue,SUM(ad_cost) adCost,
   SUM(CASE WHEN reported_amount IS NULL THEN 1 ELSE 0 END) revenueMissing,SUM(CASE WHEN ad_cost IS NULL THEN 1 ELSE 0 END) costMissing
   FROM r GROUP BY business_date,site,channel,COALESCE(currency,'UNKNOWN')
  ) SELECT g.*,CASE WHEN x.business_date IS NULL THEN 0 ELSE 1 END repeated FROM grouped g
   LEFT JOIN repeated x ON x.business_date=g.date AND x.site=g.site AND x.channel=g.channel AND x.currency=g.currency)`).bind(...args),
  db.prepare(`SELECT business_date date,site,channel,currency,amount FROM sales_ad_spend WHERE deleted_at IS NULL AND business_date BETWEEN ? AND ? AND channel IN ('TikTok','Shopee')${f.sql}`).bind(...args),
  db.prepare(`SELECT DISTINCT business_date date,site,channel FROM sales_imports WHERE reversed_at IS NULL AND report_kind IN ('complete','zero') AND business_date BETWEEN ? AND ? AND channel IN ('TikTok','Shopee')${f.sql}`).bind(...args),
 ];
}
