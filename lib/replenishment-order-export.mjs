import {hasPermission} from './permissions.mjs';
import {toReplenishmentWorkbook} from './replenishment-export.mjs';

export const planStatusLabels={approved:'已批准',pending:'待审批',withdrawn:'已撤回',rejected:'已驳回'};
const purchaseLabels={draft:'待供应商确认',supplier_confirmed:'供应商已确认',in_production:'生产中',awaiting_qc:'待质检',ready_to_ship:'质检通过待发货',qc_rejected:'质检不通过',shipping:'发运中',completed:'已完成'};
const text=value=>String(value??'');
const qty=value=>{
  if(value===null||value===undefined||value===''||!Number.isSafeInteger(Number(value))||Number(value)<0)throw Error('备货订单数量无效，请刷新核对');
  return Number(value);
};
const time=value=>{
  const date=new Date(value);
  if(!Number.isFinite(date.valueOf()))throw Error('订单数据时间缺失，请刷新后重试');
  return new Date(date.valueOf()+8*3600000).toISOString().slice(0,19).replace('T',' ');
};
export function replenishmentPlans(snapshot){
  return (snapshot.approvals||[]).filter(row=>row.type==='monthly_plan').slice().sort((a,b)=>String(b.month).localeCompare(String(a.month))||Number(b.version)-Number(a.version));
}

// Only the saved approval snapshot and its execution orders are used here.
// Live inventory, forecasting and later unsubmitted requests cannot replace it.
export function replenishmentOrderSheets(snapshot,approvalId){
  if(!hasPermission(snapshot.actor?.role,'planning.export'))throw Error('仅管理员和供应链可导出备货订单');
  const plan=replenishmentPlans(snapshot).find(row=>row.id===approvalId);
  if(!plan)throw Error('请选择已送审的备货计划；尚未送审的需求请先由供应链核对送审');
  if(!Array.isArray(plan.payload?.items)||!Array.isArray(plan.payload?.seriesOrders))throw Error('计划快照不完整，请刷新核对');
  const version=qty(plan.version),status=planStatusLabels[plan.status]||text(plan.status),items=plan.payload.items;
  const groups=new Map();
  for(const group of plan.payload.seriesOrders){
    for(const item of group.items||[]){
      if(groups.has(item.sku))throw Error('计划系列存在重复SKU，请核对');
      groups.set(item.sku,group);
    }
  }
  const seen=new Set(),allocations=[],details=[];
  for(const item of items){
    if(!item.sku||seen.has(item.sku))throw Error('计划SKU缺失或重复，请核对');
    seen.add(item.sku);
    const group=groups.get(item.sku);
    if(!group||!Array.isArray(item.allocations))throw Error('计划系列或站点分配缺失，请核对');
    const scopeSeen=new Set();let total=0;
    for(const a of item.allocations){
      const key=JSON.stringify([a.site,a.channel]);
      if(!a.site||!a.channel||scopeSeen.has(key))throw Error('计划站点渠道缺失或重复，请核对');
      scopeSeen.add(key);total+=qty(a.qty);
      allocations.push([plan.month,plan.id,version,status,text(item.sku),text(item.name),text(group.seriesName),text(a.site),text(a.channel),qty(a.qty)]);
    }
    if(total!==qty(item.total))throw Error(`${item.sku}站点分配与备货总数不一致，请核对`);
    details.push([plan.month,plan.id,version,status,text(item.sku),text(item.name),text(group.seriesName),text(group.supplierName),text(group.factoryName),total]);
  }
  if(groups.size!==seen.size)throw Error('计划系列与SKU明细不一致，请核对');
  const relatedIds=new Set([plan.id,...(snapshot.planChanges||[]).filter(c=>c.approval_id===plan.id&&c.status==='approved').map(c=>c.id)]);
  const orders=(snapshot.purchaseOrders||[]).filter(o=>relatedIds.has(o.approval_id)&&o.status!=='cancelled');
  const execution=orders.flatMap(o=>(o.items||[]).map(item=>[text(o.month),text(o.id),text(o.approval_id),text(o.order_ref),text(o.series_name),text(o.supplier_name),text(o.factory_name),text(item.sku),text(item.name),qty(item.ordered_qty),purchaseLabels[o.status]||text(o.status),text(o.expected_completion_date)]));
  const total=items.reduce((sum,item)=>sum+qty(item.total),0);
  if(plan.status==='approved'){
    const executionTotals=new Map();
    for(const row of execution)executionTotals.set(row[7],(executionTotals.get(row[7])||0)+row[9]);
    if(executionTotals.size!==items.length||items.some(item=>executionTotals.get(item.sku)!==qty(item.total)))throw Error('已批准计划与采购执行单数量不一致，请刷新并核对计划变更');
  }
  return [
    {name:'备货订单总览',headers:['项目','内容','说明'],rows:[
      ['备货月份',text(plan.month),'按所选月度计划导出'],['计划编号',text(plan.id),'用于追溯审批与执行单'],['计划版本',version,'当前已保存版本'],['计划状态',status,plan.status==='approved'?'已批准数量；包含已批准的后续计划变更':'未批准计划，仅供核对，不能作为已下单数量'],
      ['备货总数量',total,'与本版计划的SKU明细及站点渠道分配一致'],['SKU种类数',items.length,'同一SKU跨站点合并'],['有效采购单数',orders.length,'关联本计划和已批准变更，排除已取消的旧单'],
      ['数据时间（北京时间）',time(snapshot.generatedAt),'导出时页面读取的数据'],['计划最近更新时间（北京时间）',time(plan.updated_at),'本版计划更新时间'],['数据来源','月度备货计划审批快照＋对应采购执行单','不使用仓库库存、断货风险或动态补货测算'],
    ]},
    {name:'SKU备货订单明细',headers:['月份','计划编号','版本','计划状态','SKU','商品名称','产品系列','供应商','工厂','备货数量'],rows:details},
    {name:'站点渠道分配',headers:['月份','计划编号','版本','计划状态','SKU','商品名称','产品系列','站点','渠道','备货数量'],rows:allocations},
    {name:'采购执行明细',headers:['月份','采购单编号','来源计划或变更编号','采购订单号','产品系列','供应商','工厂','SKU','商品名称','下单数量','采购执行状态','约定交期'],rows:execution},
  ];
}
export function replenishmentOrderWorkbook(XLSX,sheets){
  const book=toReplenishmentWorkbook(XLSX,sheets);
  book.Props={Title:'LOONG JUMP 备货订单明细',Subject:'月度计划及对应采购执行单',Author:'LOONG JUMP'};
  delete book.Sheets['备货订单总览']['!autofilter'];
  return book;
}
export function replenishmentOrderName(plan){
  return `备货订单明细-${text(plan.month)}-V${qty(plan.version)}-${planStatusLabels[plan.status]||'待核对'}.xlsx`;
}
