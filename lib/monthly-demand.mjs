import {validateImportRows} from './tabular-import.mjs';

export function initialMonthlyDemand({actor,month,submissions,suggestions}) {
  const saved=submissions.find(row=>row.month===month&&row.site===actor.site&&row.channel===actor.channel);
  if(saved)return {drafts:(saved.items||[]).map(row=>({sku:row.sku,name:row.name||row.sku,qty:String(row.qty),reason:row.reason||''})),zeroDemand:Boolean(Number(saved.zero_demand)),zeroReason:saved.zero_reason||'',saved:true};
  return {drafts:suggestions.filter(row=>row.site===actor.site&&row.channel===actor.channel&&row.suggestedProduction>0).map(row=>({sku:row.sku,name:row.name||row.sku,qty:String(row.suggestedProduction),reason:row.alertLabel||'系统动态建议'})),zeroDemand:false,zeroReason:'',saved:false};
}

export function monthlyDemandItems(input) {
  const {rows,errors}=validateImportRows('monthlyPlan',input);
  if(errors.length)throw Error(errors.slice(0,5).map(error=>`第${error.row}行：${error.message}`).join('；'));
  return rows.map(({sku,name,qty,reason})=>({sku,name,qty,reason}));
}

export function applyMonthlyImport(input,current,knownSkus,mode='replace') {
  if(!['replace','merge'].includes(mode))throw Error('请选择有效的导入方式');
  const {rows,errors}=validateImportRows('monthlyPlan',input);
  if(errors.length)throw Error(errors.slice(0,5).map(error=>`第${error.row}行：${error.message}`).join('；'));
  const known=new Map(knownSkus.map(row=>[String(row.sku).trim().toUpperCase(),row]));
  const imported=rows.map(row=>{
    const product=known.get(row.sku);
    if(!product)throw Error(`第${row._row}行：SKU ${row.sku} 不存在，请先在主数据中维护该SKU`);
    return {sku:row.sku,name:product.name||row.name||row.sku,qty:String(row.qty),reason:row.reason||'运营批量导入'};
  });
  if(mode==='replace')return imported;
  const bySku=new Map(current.map(row=>[row.sku,row]));
  for(const row of imported)bySku.set(row.sku,row);
  if(bySku.size>1000)throw Error('合并后超过1000个SKU，请减少明细');
  return [...bySku.values()];
}
