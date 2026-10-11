const parse=value=>{try{const parsed=JSON.parse(value||'[]');return Array.isArray(parsed)?parsed:[];}catch{return [];}};
export const PRODUCTION_STAGES = Object.freeze({awaiting_order:'待采购确认',awaiting_factory:'待导出确认',in_production:'生产中',pending:'历史待生产',awaiting_qc:'待质检',qc_rejected:'质检不通过',ready_to_ship:'质检通过 · 待发货'});
export function productionStage(order){
  if(['completed','completed_with_variance'].includes(order.status))return order.qc_status==='passed'?'ready_to_ship':order.qc_status==='rejected'?'qc_rejected':'awaiting_qc';
  return order.status;
}
export const productionStageLabel=order=>PRODUCTION_STAGES[productionStage(order)]||order.status;
const stages={factory_accepted:'确认接单并开始生产',production_progress:'更新生产进度',production_completed:'登记生产完成，转待质检',qc_passed:'质检通过',qc_rejected:'质检不通过'};
// This explicit projection is shared by all signed-in roles. Internal references,
// free-text notes, prices, contact details and unscoped persistence rows stay private.
export function productionTracking(orders,items,purchases,exports=[]){
  const purchaseMap=new Map(purchases.map(row=>[row.id,row]));
  const grouped=new Map();for(const item of items){const rows=grouped.get(item.production_order_id)||[];rows.push(item);grouped.set(item.production_order_id,rows);}
  const exported=new Map();for(const entry of exports){const rows=exported.get(entry.entity_id)||[];rows.push({label:'生成工厂订单导出',at:entry.created_at,by:entry.actor_name});exported.set(entry.entity_id,rows);}
  return orders.map(order=>{
    const purchase=purchaseMap.get(order.purchase_order_id)||{},lines=grouped.get(order.id)||[],evidence=parse(order.evidence_json);
    const events=[{label:'生成生产订单',at:order.created_at,by:''},...(purchase.supplier_confirmed_at?[{label:'采购确认，订单送达工厂',at:purchase.supplier_confirmed_at,by:''}]:[]),...(exported.get(order.id)||[]),...evidence.filter(e=>stages[e.stage]).map(e=>({label:stages[e.stage],at:e.at,by:e.by||'',...(e.progressPct!==undefined?{progressPct:Number(e.progressPct)}:{})}))];
    if(order.started_at&&!evidence.some(e=>e.stage==='factory_accepted'))events.push({label:'历史记录：开始生产',at:order.started_at,by:''});
    if(order.completed_at&&!evidence.some(e=>e.stage==='production_completed'))events.push({label:'历史记录：生产完成',at:order.completed_at,by:''});
    if(order.qc_at&&!evidence.some(e=>['qc_passed','qc_rejected'].includes(e.stage)))events.push({label:order.qc_status==='passed'?'历史记录：质检通过':'历史记录：质检不通过',at:order.qc_at,by:''});
    return {id:order.id,month:order.month,seriesName:order.series_name,factoryName:order.factory_name,stage:productionStage(order),stageLabel:productionStageLabel(order),plannedQty:Number(order.total_planned_qty),producedQty:Number(order.total_produced_qty),progressPct:Number(order.progress_pct||0),promisedDate:order.promised_completion_date||purchase.expected_completion_date||'',updatedAt:order.updated_at,items:lines.map(i=>({sku:i.sku,name:i.name,plannedQty:Number(i.planned_qty),producedQty:Number(i.produced_qty)})),events:events.filter(e=>e.at).sort((a,b)=>a.at.localeCompare(b.at))};
  }).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));
}
export function productionDocument(order,items,purchase={}){
  return {id:order.id,purchaseId:order.purchase_order_id,month:order.month,seriesName:order.series_name,factoryName:order.factory_name,orderRef:purchase.order_ref||'',promisedDate:order.promised_completion_date||purchase.expected_completion_date||'',plannedQty:Number(order.total_planned_qty),status:productionStageLabel(order),items:[...items].sort((a,b)=>a.sku.localeCompare(b.sku)).map(i=>({id:i.id,sku:String(i.sku),name:i.name||'',plannedQty:Number(i.planned_qty),producedQty:Number(i.produced_qty)}))};
}
export async function productionFingerprint(order,items,purchase){
  const text=JSON.stringify({document:productionDocument(order,items,purchase),assigned:order.assigned_user_id||'',version:order.updated_at});
  const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text));return Array.from(new Uint8Array(bytes),n=>n.toString(16).padStart(2,'0')).join('');
}
export function productionWorkbook(XLSX,document){
  if(!document.items?.length||document.items.reduce((n,i)=>n+i.plannedQty,0)!==document.plannedQty)throw Error('生产订单明细与总数不一致，请刷新后导出');
  const book=XLSX.utils.book_new();
  const sheets=[['订单确认', [['项目','内容'],['生产单号',document.id],['采购单号',document.purchaseId],['供应商订单号',document.orderRef],['月份',document.month],['产品系列',document.seriesName],['工厂',document.factoryName],['当前状态',document.status],['承诺／预计完工日',document.promisedDate],['SKU数',document.items.length],['计划生产总数量',document.plannedQty],['核对要求','请核对SKU、生产数量及交期；下载后回系统确认接单。导出不会自动接单。']]],['SKU生产明细',[['SKU','商品名称','计划生产数量','已登记完工数量'],...document.items.map(i=>[i.sku,i.name,i.plannedQty,i.producedQty])]]];
  for(const [name,rows] of sheets){const ws=XLSX.utils.aoa_to_sheet(rows);ws['!cols']=name==='订单确认'?[{wch:24},{wch:78}]:[{wch:36},{wch:48},{wch:20},{wch:20}];if(name==='SKU生产明细')ws['!autofilter']={ref:ws['!ref']};for(const [k,v]of Object.entries(ws))if(!k.startsWith('!')&&v.t==='n')v.z='#,##0';XLSX.utils.book_append_sheet(book,ws,name);}
  return book;
}
