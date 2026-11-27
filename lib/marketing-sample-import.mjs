import {validateImportRows} from './tabular-import.mjs';

export function sampleImportItems(input,skus){
 const {rows,errors}=validateImportRows('marketingSample',input);
 if(errors.length)throw Error(`第${errors[0].row}行：${errors[0].message}`);
 const known=new Set(skus.map(s=>s.sku));
 for(const row of rows)if(!known.has(row.sku))throw Error(`第${row._row}行：SKU ${row.sku} 尚未建立商品档案`);
 return rows.map(row=>({sku:row.sku,sampleQty:row.qty}));
}
