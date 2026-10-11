import {hasPermission} from './permissions.mjs';

const quantities=[['qty','可售库存'],['seaInTransit','海运在途'],['productionInProgress','生产中'],['suggestedReplenishment','建议海运补货'],['suggestedProduction','建议启动生产']];
const number=(value,optional=false)=>{
  if(value===null||value===undefined||value===''){
    if(optional)return '';
    throw Error('备货数据不完整，请刷新页面后重新导出');
  }
  const result=Number(value);
  if(!Number.isFinite(result))throw Error('备货数据包含无效数量，请刷新页面后重新导出');
  return result;
};
const text=value=>String(value??'');
const chinaTime=value=>{
  const date=new Date(value);
  if(!Number.isFinite(date.valueOf()))throw Error('缺少数据时间，请刷新页面后重新导出');
  return new Date(date.valueOf()+8*3600000).toISOString().slice(0,19).replace('T',' ');
};
const sums=rows=>quantities.map(([key])=>rows.reduce((total,row)=>total+number(row[key]),0));
const group=(rows,key)=>{
  const result=new Map();
  for(const row of rows){const id=key(row);if(!result.has(id))result.set(id,[]);result.get(id).push(row);}
  return [...result.values()];
};

// Export the already-authorized page snapshot. No second fetch/recalculation can
// change the quantities between the visible dashboard and this workbook.
export function replenishmentExportSheets(snapshot,{exportedAt=new Date().toISOString()}={}){
  if(!hasPermission(snapshot.actor?.role,'planning.export'))throw Error('仅管理员和供应链可导出全站备货明细');
  if(!Array.isArray(snapshot.suggestions)||!Array.isArray(snapshot.skuSettings))throw Error('备货数据不完整，请刷新页面后重新导出');
  const readAt=chinaTime(snapshot.generatedAt),downloadAt=chinaTime(exportedAt);
  const settings=new Map(snapshot.skuSettings.map(row=>[row.sku,row]));
  const rows=snapshot.suggestions.map(row=>{
    if(!row.site||!row.channel||!row.sku)throw Error('备货明细缺少站点、渠道或SKU，请刷新后重试');
    const setting=settings.get(row.sku)||{};
    return {...row,name:row.name||setting.name||'',series:setting.product_series||'未归类'};
  });
  if(new Set(rows.map(row=>JSON.stringify([row.site,row.channel,row.sku]))).size!==rows.length)throw Error('备货明细包含重复记录，请刷新后重试');
  const totals=sums(rows),metricKeys=['inventoryQty','seaTransitQty','productionInProgressQty',null,'suggestedProductionQty'];
  for(let i=0;i<metricKeys.length;i++){
    const key=metricKeys[i];
    if(key&&Math.abs(number(snapshot.metrics?.[key])-totals[i])>0.000001)throw Error('页面总数与备货明细不一致，请刷新页面后重新导出');
  }
  const skuGroups=group(rows,row=>row.sku).sort((a,b)=>a[0].sku.localeCompare(b[0].sku,'en'));
  const scopes=group(rows,row=>JSON.stringify([row.site,row.channel]));
  return [
    {name:'备货总览',headers:['项目','数值 / 内容','说明'],rows:[
      ['数据时间（北京时间）',readAt,'与点击导出时的驾驶舱数据一致；系统同步后数据可能变化'],
      ['导出时间（北京时间）',downloadAt,'本文件生成时间'],
      ['数据来源','补货与生产驾驶舱 · 当前页面快照','包含全部站点及渠道明细，未截取图表前几名'],
      ['统计口径','动态备货建议','不是月度提交量、已批准计划量，也不代表新增采购订单'],
      ['SKU种类数',skuGroups.length,'跨站点、渠道去重'],
      ['站点渠道数',scopes.length,'明细中实际存在的组合'],
      ['站点渠道SKU明细行数',rows.length,'同一SKU可以出现在不同站点、渠道'],
      ...quantities.map(([,label],i)=>[label,totals[i],['账面库存扣除预留，负数原样保留','已进入海运、尚未到仓数量','尚未进入海运的生产数量','解决运输周期缺口；不要与建议启动生产相加','覆盖生产及运输周期的动态缺口；已考虑库存、在途及生产中'][i]]),
      ['需新增生产的SKU数',skuGroups.filter(items=>items.some(row=>number(row.suggestedProduction)>0)).length,'按SKU去重'],
      ['空白字段','表示未知或未提供','不把未知可售天数、到仓日期等填成0'],
      ['使用提示','复核销量完整性、库存差异、交期及风险原因后安排备货','本次导出不会送审、下单、锁库存或修改业务数据'],
    ]},
    {name:'SKU备货汇总',headers:['SKU','商品名称','产品系列','站点渠道数',...quantities.map(([,label])=>label)],rows:skuGroups.map(items=>[text(items[0].sku),text(items[0].name),text(items[0].series),items.length,...sums(items)])},
    {name:'站点渠道汇总',headers:['站点','渠道','SKU种类数',...quantities.map(([,label])=>label)],rows:scopes.map(items=>[text(items[0].site),text(items[0].channel),items.length,...sums(items)])},
    {name:'站点SKU明细',headers:['站点','渠道','SKU','商品名称','产品系列',...quantities.map(([,label])=>label),'预留库存','待上架','目标库存位','预测日均','7日日均','21日日均','56日日均','安全库存','库存可售天数','预计到仓日期','有效销售天数','数据可信度','风险状态','判断依据','约束说明'],rows:rows.map(row=>[
      text(row.site),text(row.channel),text(row.sku),text(row.name),text(row.series),...quantities.map(([key])=>number(row[key])),
      number(row.reserved_qty??0),number(row.pendingShelfQty??0),...['targetQty','forecastDaily','avg7','avg21','avg56','safetyStock','stockCoverDays'].map(key=>number(row[key],true)),
      text(row.nextSeaEta),number(row.dataDays,true),text(row.confidence),text(row.alertLabel),text(row.alertReason),(row.limits||[]).join('、'),
    ])},
  ];
}

export function toReplenishmentWorkbook(XLSX,sheets){
  const book=XLSX.utils.book_new();
  book.Props={Title:'LOONG JUMP 备货明细',Subject:'驾驶舱动态备货快照',Author:'LOONG JUMP'};
  for(const sheet of sheets){
    const ws=XLSX.utils.aoa_to_sheet([sheet.headers,...sheet.rows]);
    ws['!cols']=sheet.headers.map(header=>({wch:/数值|说明|依据/.test(header)?64:/名称|系列/.test(header)?32:header==='SKU'?32:18}));
    if(sheet.name!=='备货总览')ws['!autofilter']={ref:ws['!ref']};
    for(const [address,cell] of Object.entries(ws)){
      if(address.startsWith('!')||cell.t!=='n')continue;
      const header=sheet.headers[XLSX.utils.decode_cell(address).c];
      cell.z=/日均|可售天数/.test(header)?'0.00;[Red]-0.00':'#,##0;[Red]-#,##0';
    }
    XLSX.utils.book_append_sheet(book,ws,sheet.name);
  }
  return book;
}

export function replenishmentDownloadName(generatedAt){
  return `备货明细-${chinaTime(generatedAt).replaceAll(':','').replace(' ','-')}.xlsx`;
}
