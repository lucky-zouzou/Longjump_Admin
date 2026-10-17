// Raw persistence columns never cross the API boundary. Parsed, permission-scoped
// fields are assembled by the domain code before this final serialization pass.
const factoryPrivate=new Set(['amount','unit_price','unitPrice','reported_amount','ad_cost','adCost','adSpend','revenue','salesAmount','sales_amount','averagePrice','roas','roi','sellingPrice','salePrice','plannedPrice','planned_price','total_amount','ad_spend','revenueMissing','costMissing']);
export function publicSystemSnapshot(value,role=''){
  if(Array.isArray(value))return value.map(item=>publicSystemSnapshot(item,role));
  if(!value||typeof value!=='object')return value;
  return Object.fromEntries(Object.entries(value).filter(([key])=>!key.endsWith('_json')&&(role!=='工厂'||!factoryPrivate.has(key))).map(([key,item])=>[key,publicSystemSnapshot(item,role)]));
}
