import {atomicBatch,guardStatement,assertWritable} from './atomic.mjs';
import {rows,parse,text,fail,dateValid,today} from './purchase-documents.mjs';
const id=p=>p+'_'+crypto.randomUUID();
const audit=(db,a,action,n,detail,stamp)=>db.prepare('INSERT INTO audit_logs(id,action,entity_type,entity_id,detail_json,actor_id,actor_name,created_at) VALUES(?,?,?,?,?,?,?,?)').bind(id('audit'),action,'factory_document',n,JSON.stringify(detail),a.id,a.name,stamp);
const allowed=a=>['管理员','供应链','工厂'].includes(a.role);
export function canReadNotice(a,n){return a.role==='管理员'||a.role==='供应链'||a.role==='工厂'&&n.factory_user_id===a.id;}
const supply=(a,n)=>{if(a.role!=='管理员'&&(a.role!=='供应链'||n&&n.supply_user_id!==a.id))fail(403,'请由该单供应链负责人处理');};
const factory=(a,n)=>{if(a.role!=='工厂'||a.id!==n.factory_user_id)fail(403,'仅对应工厂账号可提交发货装箱清单');};
const positive=(v,label,max=1e9)=>{const n=Number(v);if(!Number.isSafeInteger(n)||n<1||n>max)fail(400,`${label}须为有效正整数`);return n;};
function eventStatement(db,actor,order,stage,stamp){
 const events=parse(order.evidence_json);events.push({stage,at:stamp,by:actor.name});
 return [guardStatement(db,actor,stage,'EXISTS(SELECT 1 FROM series_production_orders WHERE id=? AND updated_at=?)',[order.id,order.updated_at]),db.prepare('UPDATE series_production_orders SET evidence_json=?,updated_at=? WHERE id=?').bind(JSON.stringify(events),stamp,order.id)];
}
export async function dispatchAvailability(db,orderId){
 const list=await rows(db,'SELECT i.*,p.allocations_json FROM series_production_order_items i JOIN series_purchase_order_items p ON p.id=i.purchase_order_item_id WHERE i.production_order_id=?',[orderId]);
 const active=await rows(db,"SELECT * FROM factory_dispatch_notices WHERE production_order_id=? AND status IN ('issued','packing_submitted','confirmed')",[orderId]);
 const shipped=await rows(db,'SELECT production_order_item_id itemId,shipped_qty qty,allocations_json FROM shipment_batch_items WHERE production_order_item_id IN (SELECT id FROM series_production_order_items WHERE production_order_id=?)',[orderId]);
 const transported=await rows(db,'SELECT bi.production_order_item_id itemId,l.site,l.channel,li.qty FROM transport_leg_items li JOIN transport_batch_items bi ON bi.id=li.batch_item_id JOIN transport_legs l ON l.id=li.leg_id WHERE bi.production_order_id=?',[orderId]);
 return list.map(i=>{
  const scopes=parse(i.allocations_json).map(a=>({...a}));let used=0;
  const debit=(site,channel,qty)=>{used+=qty;const s=scopes.find(a=>a.site===site&&a.channel===channel);if(s)s.qty-=qty;};
  for(const n of active)for(const line of parse(n.items_json))if(line.itemId===i.id)debit(n.site,n.channel,Number(line.qty));
  for(const s of shipped)if(s.itemId===i.id)for(const a of parse(s.allocations_json))debit(a.site,a.channel,Number(a.qty));
  for(const s of transported)if(s.itemId===i.id)debit(s.site,s.channel,Number(s.qty));
  return {itemId:i.id,sku:i.sku,name:i.name,available:Math.max(0,Math.min(i.planned_qty,i.produced_qty)-used),allocations:scopes.map(a=>({...a,qty:Math.max(0,a.qty)}))};
 });
}
export async function readFactoryDocuments(db,actor){
 if(!allowed(actor))fail(403,'当前岗位不能查看工厂单据');
 const orders=await rows(db,`SELECT p.*,o.id productionId,o.assigned_user_id,o.qc_status,o.status productionStatus FROM series_purchase_orders p JOIN series_production_orders o ON o.purchase_order_id=p.id ${actor.role==='工厂'?'WHERE o.assigned_user_id=?':''} ORDER BY p.updated_at DESC`,actor.role==='工厂'?[actor.id]:[]);
 const notices=await rows(db,`SELECT n.*,p.factory_name,p.series_name,p.order_ref FROM factory_dispatch_notices n JOIN series_purchase_orders p ON p.id=n.purchase_order_id ${actor.role==='工厂'?'WHERE n.factory_user_id=?':''} ORDER BY n.created_at DESC`,actor.role==='工厂'?[actor.id]:[]);
 const documents=[];
 for(const o of orders){documents.push({id:o.id,productionId:o.productionId,seriesName:o.series_name,factoryName:o.factory_name,orderRef:o.order_ref,month:o.month,status:o.status,productionStatus:o.productionStatus,qcStatus:o.qc_status,workflowVersion:o.workflow_version,supplyUserId:o.assigned_supply_user_id,document:parse(o.document_json,{}),available:o.qc_status==='passed'?await dispatchAvailability(db,o.productionId):[]});}
 const result=[];
 for(const n of notices){
  const files=await rows(db,'SELECT id,name,content_type,size,actor_name,created_at FROM factory_document_files WHERE notice_id=? ORDER BY created_at',[n.id]);
  const history=await rows(db,"SELECT action,actor_name,created_at,detail_json FROM audit_logs WHERE entity_type='factory_document' AND entity_id=? ORDER BY created_at",[n.id]);
  result.push({...Object.fromEntries(Object.entries(n).filter(([k])=>!k.endsWith('_json'))),items:parse(n.items_json),packing:parse(n.packing_json,{}),files,history:history.map(h=>({action:h.action,actor:h.actor_name,at:h.created_at,reason:parse(h.detail_json,{}).reason||''}))});
 }
 return {orders:documents,notices:result,warehouses:actor.role==='工厂'?[]:await rows(db,'SELECT id,site,channel,name FROM warehouses WHERE active=1'),carriers:actor.role==='工厂'?[]:await rows(db,"SELECT name FROM business_partners WHERE type='carrier' AND active=1 AND assigned_user_id IS NOT NULL")};
}
export async function issueDispatchNotice(db,actor,p){
 supply(actor);await assertWritable(db);
 const order=await db.prepare('SELECT o.*,p.assigned_supply_user_id,p.document_json FROM series_production_orders o JOIN series_purchase_orders p ON p.id=o.purchase_order_id WHERE o.id=?').bind(text(p.productionOrderId,120)).first();
 if(!order||order.qc_status!=='passed')fail(409,'生产单尚未质检通过');if(!await db.prepare("SELECT id FROM users WHERE id=? AND role='工厂' AND active=1").bind(order.assigned_user_id).first())fail(409,'工厂账号未启用，请先核对负责人');supply(actor,{supply_user_id:order.assigned_supply_user_id});
 const warehouse=await db.prepare('SELECT * FROM warehouses WHERE id=? AND active=1').bind(text(p.warehouseId,120)).first();if(!warehouse)fail(400,'请选择启用中的目的仓');
 const noticeNo=text(p.noticeNo,100),shippingDate=text(p.shippingDate,10),receiver=text(p.receiver,120),phone=text(p.phone,80),address=text(p.address,600),instructions=text(p.instructions,2000);
 if(!noticeNo||!dateValid(shippingDate)||shippingDate<today()||!receiver||!phone||!address)fail(400,'请填写通知单号、计划发货日、收件人、电话及收货地址');
 if(await db.prepare('SELECT id FROM factory_dispatch_notices WHERE notice_no=?').bind(noticeNo).first())fail(409,'发货通知单号已存在');
 if(!Array.isArray(p.items)||!p.items.length||p.items.length>1000)fail(400,'请选择发货SKU');
 const availability=await dispatchAvailability(db,order.id),seen=new Set(),document=parse(order.document_json,{});
 const items=p.items.map(raw=>{
  const source=availability.find(i=>i.itemId===raw.itemId);if(!source||seen.has(source.itemId))fail(400,'发货SKU无效或重复');seen.add(source.itemId);
  const qty=positive(raw.qty,'发货数量'),allocation=source.allocations.find(a=>a.site===warehouse.site&&a.channel===warehouse.channel);
  if(qty>source.available||qty>Number(allocation?.qty||0))fail(409,`${source.sku}超过可发数量或该站点渠道剩余需求`);
  const detail=document.items?.find(i=>i.sku===source.sku)||{};
  return {itemId:source.itemId,sku:source.sku,name:source.name,qty,color:text(raw.color||detail.color,100),specification:text(raw.specification||detail.specification,100),cartonSpec:text(raw.cartonSpec,100),cartons:raw.cartons===''||raw.cartons==null?null:positive(raw.cartons,'计划箱数',1000000),qrCode:text(raw.qrCode,200),remark:text(raw.remark)};
 });
 const noticeId=id('dispatch'),stamp=new Date().toISOString();
 const allNoticeVersion=JSON.stringify(await rows(db,'SELECT id,version FROM factory_dispatch_notices WHERE production_order_id=? ORDER BY id',[order.id]));
 const guardSql="COALESCE((SELECT json_group_array(json_object('id',id,'version',version)) FROM (SELECT id,version FROM factory_dispatch_notices WHERE production_order_id=? ORDER BY id)),'[]')=?";
 await atomicBatch(db,[guardStatement(db,actor,'issueDispatchNotice',guardSql,[order.id,allNoticeVersion]),
  ...eventStatement(db,actor,order,'dispatch_issued',stamp),
  db.prepare("INSERT INTO factory_dispatch_notices(id,notice_no,production_order_id,purchase_order_id,factory_user_id,supply_user_id,site,channel,warehouse_id,warehouse_name,shipping_date,receiver,receiver_phone,receiver_address,instructions,items_json,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(noticeId,noticeNo,order.id,order.purchase_order_id,order.assigned_user_id,order.assigned_supply_user_id,warehouse.site,warehouse.channel,warehouse.id,warehouse.name,shippingDate,receiver,phone,address,instructions,JSON.stringify(items),actor.id,stamp,stamp),
  audit(db,actor,'下发工厂发货通知',noticeId,{noticeNo,items,site:warehouse.site,channel:warehouse.channel},stamp)]);
 return {ok:true,id:noticeId};
}
export function normalizePacking(notice,p){
 const number=text(p.number,100),shippedDate=text(p.shippedDate,10),shipper=text(p.shipper,120),inspector=text(p.inspector,120),trackingNo=text(p.trackingNo,160),reason=text(p.reason,1000);
 const issuedDate=new Date(Date.parse(notice.created_at)+8*3600000).toISOString().slice(0,10);
 if(!number||!dateValid(shippedDate)||shippedDate>today()||shippedDate<issuedDate||!shipper||!inspector||!trackingNo||p.shippedConfirmed!==true)fail(400,'请填写实际发货日期、装箱单号、物流凭证、发货及检验责任人，并确认已实际发货');
 if(!Array.isArray(p.rows)||!p.rows.length||p.rows.length>2000)fail(400,'请填写装箱明细');
 const requested=parse(notice.items_json),totalByItem=new Map(),usedBoxes=new Set();
 const lines=p.rows.map(r=>{
  const source=requested.find(i=>i.itemId===r.itemId);if(!source)fail(400,'装箱SKU不属于发货通知');
  const pcs=positive(r.pcsPerCarton,'单箱数量'),cartons=positive(r.cartons,'箱数',100000),start=positive(r.cartonStart,'起始箱号',1000000),qty=pcs*cartons;
  const dimensions=['length','width','height'].map(k=>{const v=Number(r[k]);if(!Number.isFinite(v)||v<0.01||v>1000)fail(400,'箱长宽高须为0—1000厘米之间的有效数字');return Math.round(v*100)/100;});
  for(let box=start;box<start+cartons;box++){if(usedBoxes.has(box))fail(400,'箱号范围重复，请分开登记每种SKU和尾箱');usedBoxes.add(box);}
  const total=(totalByItem.get(source.itemId)||0)+qty;if(total>source.qty)fail(409,`${source.sku}累计装箱数量超过通知单`);totalByItem.set(source.itemId,total);
  return {itemId:source.itemId,sku:source.sku,name:source.name,color:source.color,specification:source.specification,pcsPerCarton:pcs,cartons,qty,cartonStart:start,cartonEnd:start+cartons-1,length:dimensions[0],width:dimensions[1],height:dimensions[2],volumePerCarton:Math.round(dimensions.reduce((a,b)=>a*b,1))/1e6,remark:text(r.remark)};
 });
 const qty=lines.reduce((s,r)=>s+r.qty,0),requestedQty=requested.reduce((s,r)=>s+r.qty,0);
 if(qty<requestedQty&&reason.length<4)fail(400,'实际发货少于通知数量，请说明短发原因');
 const proofIds=[...new Set(Array.isArray(p.proofIds)?p.proofIds:[])];if(!proofIds.length||proofIds.length>10)fail(400,'请关联至少1份签字扫描件，最多10份');
 return {number,shippedDate,shipper,inspector,trackingNo,reason,rows:lines,proofIds,totalQty:qty,totalCartons:lines.reduce((s,r)=>s+r.cartons,0),totalVolume:Math.round(lines.reduce((s,r)=>s+r.volumePerCarton*r.cartons,0)*1e6)/1e6};
}
export async function changeDispatch(db,actor,p){
 await assertWritable(db);const n=await db.prepare('SELECT * FROM factory_dispatch_notices WHERE id=?').bind(text(p.noticeId,120)).first();
 if(!n||!canReadNotice(actor,n))fail(403,'无权处理该发货通知');if(Number(p.version)!==n.version)fail(409,'单据已更新，请刷新核对');
 const order=await db.prepare('SELECT * FROM series_production_orders WHERE id=?').bind(n.production_order_id).first();
 let status=n.status,packing=parse(n.packing_json,{}),packingNo=n.packing_no,event='',action='',reason=text(p.reason,1000);const stamp=new Date().toISOString();
 if(p.action==='submitPacking'){
  factory(actor,n);if(n.status!=='issued')fail(409,'仅待工厂发货的通知可以提交装箱清单');
  packing=normalizePacking(n,p);packingNo=packing.number;
  if(await db.prepare('SELECT id FROM factory_dispatch_notices WHERE packing_no=? AND id<>?').bind(packingNo,n.id).first())fail(409,'装箱单号已使用');
  const files=await rows(db,'SELECT id,content_type FROM factory_document_files WHERE notice_id=?',[n.id]);
  if(packing.proofIds.some(id=>!files.some(f=>f.id===id)))fail(400,'签字附件不属于本通知单');
  if(!files.some(f=>packing.proofIds.includes(f.id)&&['application/pdf','image/jpeg','image/png','image/webp'].includes(f.content_type)))fail(400,'请上传并关联签字图片或PDF');
  packing.submittedBy=actor.name;packing.submittedAt=stamp;status='packing_submitted';action='工厂提交发货装箱清单';event='packing_submitted';
 }else{
  supply(actor,n);if(reason.length<4)fail(400,'请填写至少4字的处理意见');
  if(p.action==='cancelNotice'){if(n.status!=='issued'||packing.submittedAt)fail(409,'已提交发货的通知不可直接取消');status='cancelled';action='取消发货通知';event='dispatch_cancelled';}
  else if(p.action==='reviewPacking'){
   if(n.status!=='packing_submitted'||!['confirm','return'].includes(p.decision))fail(409,'请选择待复核装箱清单的处理结果');
   if(p.decision==='confirm'){status='confirmed';packing.reviewedBy=actor.name;packing.reviewedAt=stamp;packing.reviewNote=reason;action='复核装箱清单通过';event='packing_confirmed';}
   else{status='issued';packing={...packing,returnReason:reason};action='退回装箱清单补正';event='packing_returned';}
  }else fail(400,'不支持的单据操作');
 }
 await atomicBatch(db,[guardStatement(db,actor,p.action,'EXISTS(SELECT 1 FROM factory_dispatch_notices WHERE id=? AND version=? AND status=?)',[n.id,n.version,n.status]),...eventStatement(db,actor,order,event,stamp),
 db.prepare('UPDATE factory_dispatch_notices SET status=?,packing_json=?,packing_no=?,version=version+1,updated_at=? WHERE id=?').bind(status,JSON.stringify(packing),packingNo,stamp,n.id),audit(db,actor,action,n.id,{reason,packing:packing.submittedAt?packing:undefined},stamp)]);
 return {ok:true,status};
}
export async function packingTransportContext(db,actor,p){
 if(!p.noticeId){
  for(const item of Array.isArray(p.items)?p.items:[]){const row=await db.prepare('SELECT p.workflow_version FROM series_production_order_items i JOIN series_production_orders o ON o.id=i.production_order_id JOIN series_purchase_orders p ON p.id=o.purchase_order_id WHERE i.id=?').bind(text(item.productionOrderItemId||item.id,120)).first();if(row?.workflow_version===1)fail(409,'新版采购订单请先下发发货通知、由工厂提交装箱清单，复核后从单据创建海运批次');}
  return null;
 }
 const n=await db.prepare('SELECT * FROM factory_dispatch_notices WHERE id=?').bind(text(p.noticeId,120)).first();if(!n)fail(404,'发货通知不存在');supply(actor,n);
 if(n.status!=='confirmed'||Number(p.noticeVersion)!==n.version||n.transport_batch_id)fail(409,'装箱清单尚未复核、已转海运或版本已更新');
 const packing=parse(n.packing_json,{}),totals=new Map();for(const r of packing.rows||[])totals.set(r.itemId,(totals.get(r.itemId)||0)+r.qty);
 if(!totals.size)fail(409,'没有有效的装箱数据');
 const order=await db.prepare('SELECT * FROM series_production_orders WHERE id=?').bind(n.production_order_id).first();
 return {items:[...totals].map(([itemId,qty])=>({productionOrderItemId:itemId,shippedQty:qty,allocations:[{site:n.site,channel:n.channel,warehouseId:n.warehouse_id,qty}]})),statements:(batchId,stamp)=>[
 guardStatement(db,actor,'packingToTransport',"EXISTS(SELECT 1 FROM factory_dispatch_notices WHERE id=? AND version=? AND status='confirmed' AND transport_batch_id IS NULL)",[n.id,n.version]),
 db.prepare("UPDATE factory_dispatch_notices SET status='linked',transport_batch_id=?,version=version+1,updated_at=? WHERE id=?").bind(batchId,stamp,n.id),
 ...eventStatement(db,actor,order,'transport_linked',stamp),audit(db,actor,'装箱清单转海运批次',n.id,{batchId,packingNo:n.packing_no},stamp)]};
}
