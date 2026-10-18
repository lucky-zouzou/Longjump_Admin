export class SkuCatalogError extends Error {
  constructor(status,message){super(message);this.status=status;}
}
const text=value=>String(value??'').trim();
export const catalogSku=value=>text(value).toUpperCase();

// Keep spelling intact apart from the same trim/case normalization used by imports.
export function skuRegistration(input){
  const sku=catalogSku(input.sku),name=text(input.name),productSeries=text(input.productSeries),productType=text(input.productType);
  for(const [label,value,required] of [['SKU',sku,true],['商品名称',name,true],['产品系列',productSeries,false]]){
    if((required&&!value)||value.length>120||/[\u0000-\u001f\u007f]/u.test(value))throw new SkuCatalogError(400,`${label}须为1—120个字符，不能包含换行或控制字符`);
  }
  if(!['新品','老款'].includes(productType))throw new SkuCatalogError(400,'请选择商品类型：新品或老款');
  return {sku,name,productSeries:productSeries||'待归类',productType};
}

// One product may occur in several channel allocations. Conflicting source names
// are deliberately left blank for human confirmation instead of guessing.
export function missingSkuCandidates(rows,catalog){
  const known=new Set(catalog.map(r=>catalogSku(r.sku))),missing=new Map();
  for(const [i,row] of rows.entries()){
    const sku=catalogSku(row.sku);if(!sku||known.has(sku))continue;
    const item=missing.get(sku)||{sku,names:[],rows:[]};
    const name=text(row.name);if(name&&!item.names.includes(name))item.names.push(name);
    item.rows.push(row._row||i+2);missing.set(sku,item);
  }
  return [...missing.values()].map(r=>({...r,name:r.names.length===1?r.names[0]:''}));
}

