import {atomicBatch,guardStatement,assertWritable} from './atomic.mjs';
import {rows,parse,text,fail} from './purchase-documents.mjs';
const id=p=>`${p}_${crypto.randomUUID()}`;
const scope=a=>`${a.site}|${a.channel}`;
const integer=(v,label,min=0)=>{if(v===''||v==null||typeof v==='boolean')fail(400,`${label}请填写整数`);const n=Number(v);if(!Number.isSafeInteger(n)||n<min||n>1e9)fail(400,`${label}须为${min===0?'非负':'正'}整数`);return n;};
const canRead=a=>{if(!['供应链','管理员'].includes(a.role))fail(403,'仅供应链和管理员可调整工厂下单数量');};
const audit=(db,a,action,entity,detail,at)=>db.prepare('INSERT INTO audit_logs(id,action,entity_type,entity_id,detail_json,actor_id,actor_name,created_at) VALUES(?,?,?,?,?,?,?,?)').bind(id('audit'),action,'purchase_quantity_change',entity,JSON.stringify(detail),a.id,a.name,at);
const commitmentsSQL="SELECT c.item_id,c.site,c.channel,SUM(c.qty) qty FROM production_scope_commitments c JOIN series_production_order_items i ON i.id=c.item_id WHERE i.production_order_id=? GROUP BY c.item_id,c.site,c.channel ORDER BY c.item_id,c.site,c.channel";
export async function purchaseQuantitySource(db,actor,orderId){
 canRead(actor);
 const order=await db.prepare('SELECT * FROM series_purchase_orders WHERE id=?').bind(text(orderId,120)).first();
 if(!order||order.status==='cancelled')fail(404,'采购订单不存在或已取消');
 if(actor.role==='供应链'&&order.assigned_supply_user_id!==actor.id)fail(403,'请由该采购单供应链负责人调整');
 const production=await db.prepare('SELECT * FROM series_production_orders WHERE purchase_order_id=?').bind(order.id).first();
 if(!production||production.status==='cancelled')fail(409,'生产订单不可调整');
 const items=await rows(db,'SELECT i.*,p.ordered_qty,p.allocations_json FROM series_production_order_items i JOIN series_purchase_order_items p ON p.id=i.purchase_order_item_id WHERE i.production_order_id=? ORDER BY i.id',[production.id]);
 const commitments=await rows(db,commitmentsSQL,[production.id]);
 const profiles=await rows(db,'SELECT sku,data_json FROM product_profiles WHERE sku IN (SELECT sku FROM series_production_order_items WHERE production_order_id=?)',[production.id]);
 const document=parse(order.quantity_document_json||order.document_json,{});
 const firstChange=await db.prepare("SELECT before_json FROM purchase_quantity_changes WHERE purchase_order_id=? ORDER BY created_at,id LIMIT 1").bind(order.id).first();
 const originalItems=parse(firstChange?.before_json,{}).items||[];
 const snapshot={order,production,items,commitments};
 return {orderId:order.id,productionId:production.id,month:order.month,reference:order.order_ref||order.id,sourceKey:JSON.stringify(snapshot),document,
  items:items.map(i=>{const d=document.items?.find(x=>x.sku===i.sku)||{};return {itemId:i.id,sku:i.sku,name:i.name,total:i.planned_qty,producedQty:i.produced_qty,demandTotal:d.demandTotal??parse(order.document_json,{}).items?.find(x=>x.sku===i.sku)?.total??originalItems.find(x=>x.itemId===i.id)?.demandTotal??i.ordered_qty,cartonQty:d.cartonQty??parse(profiles.find(p=>p.sku===i.sku)?.data_json,{}).cartonQty??'',allocations:parse(i.dispatch_allocations_json||i.allocations_json).map(a=>({...a,committedQty:commitments.find(c=>c.item_id===i.id&&scope(c)===scope(a))?.qty||0}))};})};
}
export async function readPurchaseQuantityChanges(db,actor){
 canRead(actor);const args=actor.role==='供应链'?[actor.id]:[],where=actor.role==='供应链'?' AND p.assigned_supply_user_id=?':'';
 const orders=await rows(db,`SELECT p.id,p.month,p.order_ref,p.series_name,p.factory_name,p.total_qty FROM series_purchase_orders p WHERE p.status<>'cancelled'${where} ORDER BY p.month DESC,p.created_at DESC`,args);
 const changes=await rows(db,`SELECT q.*,p.order_ref,p.series_name,p.month,u.name creator_name FROM purchase_quantity_changes q JOIN series_purchase_orders p ON p.id=q.purchase_order_id LEFT JOIN users u ON u.id=q.creator_id WHERE 1=1${where} ORDER BY q.created_at DESC`,args);
 return {orders,changes:changes.map(({before_json,after_json,...c})=>({...c,before:parse(before_json,{}).items,after:parse(after_json,{}).items}))};
}
function guards(db,actor,snapshot){
 const {order,production,items,commitments}=snapshot;
 return [guardStatement(db,actor,'purchaseQuantityVersion','EXISTS(SELECT 1 FROM series_purchase_orders WHERE id=? AND updated_at=? AND total_qty=? AND assigned_supply_user_id=?) AND EXISTS(SELECT 1 FROM series_production_orders WHERE id=? AND updated_at=? AND status=? AND total_produced_qty=?)',[order.id,order.updated_at,order.total_qty,order.assigned_supply_user_id,production.id,production.updated_at,production.status,production.total_produced_qty]),
 ...items.map(i=>guardStatement(db,actor,'purchaseQuantityItem','EXISTS(SELECT 1 FROM series_production_order_items WHERE id=? AND updated_at=? AND planned_qty=? AND produced_qty=? AND COALESCE(dispatch_allocations_json,\'\')=?)',[i.id,i.updated_at,i.planned_qty,i.produced_qty,i.dispatch_allocations_json||''])),
 guardStatement(db,actor,'purchaseQuantityCommitments',`COALESCE((SELECT json_group_array(json_object('item_id',item_id,'site',site,'channel',channel,'qty',qty)) FROM (${commitmentsSQL})),'[]')=?`,[production.id,JSON.stringify(commitments)])];
}
function normalize(source,raw){
 if(!Array.isArray(raw)||raw.length!==source.items.length||new Set(raw.map(i=>i.itemId)).size!==raw.length)fail(400,'请完整填写当前订单的SKU，不能新增或移除SKU');
 return source.items.map(i=>{
  const r=raw.find(x=>x.itemId===i.itemId);if(!r||!Array.isArray(r.allocations)||r.allocations.length!==i.allocations.length)fail(400,'站点渠道明细不匹配');
  if(new Set(r.allocations.map(scope)).size!==i.allocations.length)fail(400,'站点渠道重复');
  const allocations=i.allocations.map(a=>{const changed=r.allocations.find(x=>scope(x)===scope(a));if(!changed)fail(400,'不能替换原站点渠道');const qty=integer(changed.qty,'实际下单数量');if(qty<a.committedQty)fail(409,`${i.sku} ${a.site} ${a.channel}已有 ${a.committedQty} 件发货占用，不能减少到该数量以下`);return {site:a.site,channel:a.channel,qty};});
  const total=allocations.reduce((n,a)=>n+a.qty,0);if(!Number.isSafeInteger(total)||total<1||total>1e9)fail(400,'每个SKU实际下单合计须为有效正整数');
  if(total<i.producedQty)fail(409,`${i.sku}已登记完工 ${i.producedQty} 件，不能通过下单调整抹掉生产事实`);
  const cartonQty=r.cartonQty===''||r.cartonQty==null?null:integer(r.cartonQty,'本单装箱数',1);
  return {itemId:i.itemId,sku:i.sku,name:i.name,demandTotal:i.demandTotal,total,cartonQty,allocations};
 });
}
const reopensProduction=(source,items)=>['completed','completed_with_variance'].includes(parse(source.sourceKey,{}).production.status)&&items.some(i=>i.total>source.items.find(x=>x.itemId===i.itemId).producedQty);
const unhandedPacking="production_order_id=? AND transport_batch_id IS NULL AND (status IN ('packing_submitted','confirmed') OR (status='issued' AND json_extract(packing_json,'$.submittedAt') IS NOT NULL))";
async function reopenGuards(db,actor,source,items){
 if(!reopensProduction(source,items))return [];
 // Quality approval is currently held at order level. Do not reset it while
 // any SKU on that order has physically shipped cargo awaiting sea handoff.
 const pending=await rows(db,`SELECT notice_no FROM factory_dispatch_notices WHERE ${unhandedPacking}`,[source.productionId]);
 if(pending.length)fail(409,`原订单仍有已发货装箱单 ${pending.map(n=>n.notice_no).join('、')} 待复核或转海运。请先复核原货并创建海运批次，再调整需要补产的数量，避免影响原货继续运输`);
 return [guardStatement(db,actor,'quantityReopenPacking',`NOT EXISTS(SELECT 1 FROM factory_dispatch_notices WHERE ${unhandedPacking})`,[source.productionId])];
}
export async function mutatePurchaseQuantity(db,actor,p){
 canRead(actor);await assertWritable(db);const reason=text(p.reason,1000),at=new Date().toISOString();
 if(reason.length<4)fail(400,'请填写至少4个字的调整或审批原因');
 if(p.action==='quantityChangeSubmit'){
  if(actor.role!=='供应链')fail(403,'供应链调整实际下单数量，管理员负责审批');
  const source=await purchaseQuantitySource(db,actor,p.orderId);if(source.sourceKey!==p.sourceKey)fail(409,'订单或发货记录已变化，请重新读取后调整');
  const snapshot=parse(source.sourceKey,{}),items=normalize(source,p.items);
  if(items.every(i=>{const old=source.items.find(x=>x.itemId===i.itemId);return JSON.stringify(i.allocations)===JSON.stringify(old.allocations.map(({committedQty,...a})=>a))&&String(i.cartonQty??'')===String(old.cartonQty??'');}))fail(400,'数量与装箱数没有变化');
  const changeId=id('qtychange');
  await atomicBatch(db,[...guards(db,actor,snapshot),...await reopenGuards(db,actor,source,items),guardStatement(db,actor,'quantityChangePending',"NOT EXISTS(SELECT 1 FROM purchase_quantity_changes WHERE purchase_order_id=? AND status='pending')",[source.orderId]),db.prepare('INSERT INTO purchase_quantity_changes(id,purchase_order_id,production_order_id,creator_id,reason,before_json,after_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').bind(changeId,source.orderId,source.productionId,actor.id,reason,JSON.stringify({...snapshot,items:source.items,sourceKey:source.sourceKey}),JSON.stringify({items}),at,at),audit(db,actor,'提交工厂下单数量调整',changeId,{orderId:source.orderId,reason,before:source.items,after:items},at)]);
  return {ok:true,id:changeId};
 }
 const change=await db.prepare('SELECT * FROM purchase_quantity_changes WHERE id=?').bind(text(p.changeId,120)).first();
 if(!change||change.status!=='pending'||Number(p.version)!==change.version)fail(409,'数量变更已处理，请刷新');
 const withdraw=p.action==='quantityChangeWithdraw';
 if(withdraw?actor.id!==change.creator_id:actor.role!=='管理员'||actor.id===change.creator_id)fail(403,withdraw?'仅申请人可以撤回':'请由另一位管理员审核');
 if(!withdraw&&p.action!=='quantityChangeDecide')fail(400,'操作无效');
 if(!withdraw&&!['approve','reject'].includes(p.decision))fail(400,'审批结果无效');
 const status=withdraw?'withdrawn':p.decision==='approve'?'approved':'rejected';
 const statements=[guardStatement(db,actor,'quantityChangeReview',"EXISTS(SELECT 1 FROM purchase_quantity_changes WHERE id=? AND version=? AND status='pending')",[change.id,change.version])];
 if(status==='approved'){
  const source=await purchaseQuantitySource(db,actor,change.purchase_order_id),before=parse(change.before_json,{}),next=parse(change.after_json,{});
  if(source.sourceKey!==before.sourceKey)fail(409,'送审后订单、生产或发货已有变化，请供应链撤回并重新核对提交');
  const snapshot=parse(source.sourceKey,{}),items=normalize(source,next.items),total=items.reduce((n,i)=>n+i.total,0),{order,production}=snapshot;
  statements.push(...guards(db,actor,snapshot),...await reopenGuards(db,actor,source,items));
  const oldDocument=source.document;
  const document=oldDocument.items?.length?{...oldDocument,quantityChangeId:change.id,quantityReason:change.reason,quantityApprovedBy:actor.name,quantityApprovedAt:at,items:oldDocument.items.map(d=>{const item=items.find(i=>i.sku===d.sku);if(!item)fail(409,'采购模板SKU与生产明细不一致');const lineAmount=d.purchasePrice==null?null:Math.round(d.purchasePrice*100)*item.total/100;return {...d,...item,demandAllocations:d.demandAllocations??d.allocations,quantityReason:change.reason,lineAmount};}),totalQty:total}:null;
  if(document){document.totalAmount=document.items.some(i=>i.lineAmount==null)?null:document.items.reduce((n,i)=>n+Math.round(i.lineAmount*100),0)/100;if(document.totalAmount!=null&&!Number.isSafeInteger(Math.round(document.totalAmount*100)))fail(400,'调整金额超出系统范围');}
  const reopen=reopensProduction(source,items);
  const evidence=parse(production.evidence_json);evidence.push({stage:'order_quantity_changed',at,by:actor.name,role:actor.role,note:change.reason,reference:change.id,fromQty:order.total_qty,toQty:total});
  for(const i of items){const stored=snapshot.items.find(x=>x.id===i.itemId);statements.push(db.prepare('UPDATE series_purchase_order_items SET ordered_qty=?,allocations_json=?,updated_at=? WHERE id=?').bind(i.total,JSON.stringify(i.allocations),at,stored.purchase_order_item_id),db.prepare('UPDATE series_production_order_items SET planned_qty=?,dispatch_allocations_json=?,updated_at=? WHERE id=?').bind(i.total,JSON.stringify(i.allocations),at,i.itemId));}
  statements.push(db.prepare('UPDATE series_purchase_orders SET total_qty=?,quantity_document_json=?,status=?,updated_at=? WHERE id=?').bind(total,document?JSON.stringify(document):order.quantity_document_json,reopen?'in_production':order.status,at,order.id),db.prepare('UPDATE series_production_orders SET total_planned_qty=?,status=?,qc_status=?,progress_pct=?,evidence_json=?,updated_at=? WHERE id=?').bind(total,reopen?'in_production':production.status,reopen?'pending':production.qc_status,reopen?Math.min(99,Math.floor(production.total_produced_qty/total*100)):production.progress_pct,JSON.stringify(evidence),at,production.id));
 }
 statements.push(db.prepare('UPDATE purchase_quantity_changes SET status=?,version=version+1,reviewer_id=?,review_reason=?,updated_at=? WHERE id=?').bind(status,withdraw?null:actor.id,reason,at,change.id),audit(db,actor,status==='approved'?'批准工厂下单数量调整':withdraw?'撤回工厂下单数量调整':'驳回工厂下单数量调整',change.id,{reason,status},at));
 await atomicBatch(db,statements);return {ok:true,status};
}
