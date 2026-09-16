import {planIntegrityGuards} from "./plan-integrity.mjs";
import {guardStatement,atomicBatch,ConflictError} from './atomic.mjs';
const json=(v,f)=>{try{return JSON.parse(v)}catch{return f}};
const all=async(db,sql,args=[]) => (await db.prepare(sql).bind(...args).all()).results||[];
const id=p=>`${p}_${crypto.randomUUID()}`;
const fail=m=>{throw new ConflictError(m)};
export const PLAN_ACTIONS=new Set(['planChangeSubmit','planChangeDecide','purchaseReassign']);
export function normalizeChangedPlan(rows){
 if(!Array.isArray(rows)||rows.length>1000)fail('变更明细最多1000行');const map=new Map();
 for(const r of rows){const sku=String(r.sku||'').trim().toUpperCase(),qty=Number(r.qty),site=String(r.site),channel=String(r.channel);if(!sku||!Number.isSafeInteger(qty)||qty<0||!['印尼','马来西亚','泰国','越南','菲律宾'].includes(site)||!['TikTok','Shopee'].includes(channel))fail('变更明细的SKU、站点、渠道或数量无效');if(!qty)continue;const item=map.get(sku)||{sku,name:String(r.name||''),total:0,allocations:[]};if(item.allocations.some(a=>a.site===site&&a.channel===channel))fail('变更明细存在重复SKU站点渠道');item.total+=qty;item.allocations.push({site,channel,qty});map.set(sku,item);}
 return [...map.values()];
}
function scopeMap(items){const map=new Map();for(const r of items)for(const a of r.allocations||[])map.set(`${r.sku}|${a.site}|${a.channel}`,(map.get(`${r.sku}|${a.site}|${a.channel}`)||0)+Number(a.qty));return map;}
export async function managePlan(db,actor,payload,{buildSeriesOrders}){
 const action=payload.action,stamp=new Date().toISOString(),reason=String(payload.reason||'').trim().slice(0,1000);if(reason.length<4)fail('请填写不少于4字的变更或指派原因');
 if(action==='purchaseReassign'){
  if(actor.role!=='管理员')fail('仅管理员可重新指派采购单');const po=await db.prepare('SELECT * FROM series_purchase_orders WHERE id=?').bind(payload.purchaseOrderId).first();if(!po||['cancelled','completed'].includes(po.status))fail('采购单不存在或已结束');
  const supply=await db.prepare("SELECT id FROM users WHERE id=? AND role='供应链' AND active=1").bind(payload.supplyUserId).first();if(!supply)fail('请选择启用中的供应链负责人');
  if(payload.updatedAt!==po.updated_at)fail('采购单已更新，请刷新');
  await atomicBatch(db,[guardStatement(db,actor,action,'EXISTS (SELECT 1 FROM series_purchase_orders WHERE id=? AND updated_at=? AND status=?)',[po.id,po.updated_at,po.status]),db.prepare('UPDATE series_purchase_orders SET assigned_supply_user_id=?,updated_at=? WHERE id=?').bind(supply.id,stamp,po.id),audit(db,actor,action,po.id,{from:po.assigned_supply_user_id,to:supply.id,reason},stamp)]);return {ok:true};
 }
 if(!['管理员','供应链'].includes(actor.role))fail('当前岗位无权发起计划变更');
 if(action==='planChangeSubmit'){
  const base=await db.prepare("SELECT * FROM approval_requests WHERE id=? AND type='monthly_plan' AND status='approved'").bind(payload.approvalId).first();if(!base||Number(payload.version)!==base.version)fail('已批准计划版本变化，请刷新');
  const items=normalizeChangedPlan(payload.rows),seriesOrders=buildSeriesOrders(items,await all(db,'SELECT * FROM sku_settings'));const changeId=id('change');
  await atomicBatch(db,[guardStatement(db,actor,action,"EXISTS (SELECT 1 FROM approval_requests WHERE id=? AND version=? AND status='approved') AND NOT EXISTS (SELECT 1 FROM plan_changes WHERE approval_id=? AND status='pending')",[base.id,base.version,base.id]),db.prepare("INSERT INTO plan_changes (id,approval_id,base_version,month,old_json,new_json,reason,creator_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)").bind(changeId,base.id,base.version,base.month,base.payload_json,JSON.stringify({items,seriesOrders}),reason,actor.id,stamp,stamp),audit(db,actor,action,changeId,{reason,baseVersion:base.version},stamp)]);return {ok:true,id:changeId};
 }
 if(actor.role!=='管理员')fail('仅管理员可审批计划变更');
 const change=await db.prepare("SELECT * FROM plan_changes WHERE id=? AND status='pending'").bind(payload.changeId).first();if(!change||change.creator_id===actor.id)fail('变更不存在或申请人不能自行审批');if(Number(payload.version)!==change.version)fail('变更版本已更新');
 const base=await db.prepare("SELECT * FROM approval_requests WHERE id=? AND status='approved'").bind(change.approval_id).first();if(!base||base.version!==change.base_version)fail('原计划已变化，请重新发起变更');
 if(!['approve','reject'].includes(payload.decision))fail('审批结果无效');
 const stmts=[guardStatement(db,actor,action,"EXISTS (SELECT 1 FROM plan_changes WHERE id=? AND status='pending' AND version=?) AND EXISTS (SELECT 1 FROM approval_requests WHERE id=? AND version=? AND status='approved')",[change.id,change.version,base.id,base.version])];
 if(payload.decision==='approve'){
  const supply=await db.prepare("SELECT id FROM users WHERE id=? AND role='供应链' AND active=1").bind(payload.supplyUserId).first();if(!supply)fail('请选择启用中的供应链负责人');
  const next=json(change.new_json,{items:[]}),desired=scopeMap(next.items);
  stmts.push(...planIntegrityGuards(db,actor,next.items));
  const orders=await all(db,"SELECT * FROM series_purchase_orders WHERE (approval_id=? OR approval_id IN (SELECT id FROM plan_changes WHERE approval_id=? AND status='approved')) AND status!='cancelled'",[base.id,base.id]);
  const committed=new Map();
  for(const po of orders){
   const mos=await all(db,'SELECT * FROM series_production_orders WHERE purchase_order_id=?',[po.id]);
   const replaceable=po.status==='draft'&&!po.supplier_confirmed_at&&mos.every(m=>m.status==='awaiting_order'&&m.total_produced_qty===0);
   stmts.push(guardStatement(db,actor,action,'EXISTS (SELECT 1 FROM series_purchase_orders WHERE id=? AND status=? AND updated_at=?)',[po.id,po.status,po.updated_at]));
   for(const mo of mos)stmts.push(guardStatement(db,actor,action,'EXISTS (SELECT 1 FROM series_production_orders WHERE id=? AND status=? AND updated_at=?)',[mo.id,mo.status,mo.updated_at]));
   if(replaceable){stmts.push(db.prepare("UPDATE series_purchase_orders SET status='cancelled',updated_at=? WHERE id=?").bind(stamp,po.id),db.prepare("UPDATE series_production_orders SET status='cancelled',updated_at=? WHERE purchase_order_id=?").bind(stamp,po.id));}
   else{const lines=await all(db,'SELECT * FROM series_purchase_order_items WHERE purchase_order_id=?',[po.id]);for(const line of lines)for(const a of json(line.allocations_json,[])){const key=`${line.sku}|${a.site}|${a.channel}`;committed.set(key,(committed.get(key)||0)+Number(a.qty));}}
  }
  for(const [key,qty] of committed)if((desired.get(key)||0)<qty)fail(`${key} 已执行${qty}件，不能通过计划变更减少；请先处理执行订单`);
  const remaining=next.items.map(r=>({...r,allocations:r.allocations.map(a=>({...a,qty:a.qty-(committed.get(`${r.sku}|${a.site}|${a.channel}`)||0)})).filter(a=>a.qty>0)})).map(r=>({...r,total:r.allocations.reduce((s,a)=>s+a.qty,0)})).filter(r=>r.total>0);
  const groups=buildSeriesOrders(remaining,await all(db,'SELECT * FROM sku_settings'));
  for(const g of groups){
   const supplier=await db.prepare("SELECT id FROM business_partners WHERE type='supplier' AND name=? AND active=1").bind(g.supplierName).first();
   const factory=await db.prepare("SELECT b.assigned_user_id FROM business_partners b JOIN users u ON u.id=b.assigned_user_id WHERE b.type='factory' AND b.name=? AND b.active=1 AND u.active=1 AND u.role='工厂'").bind(g.factoryName).first();if(!supplier||!factory)fail('供应商或工厂负责人未完整启用');
   const po=id('change_po'),mo=id('change_mo');
   stmts.push(db.prepare("INSERT INTO series_purchase_orders (id,month,series_name,supplier_name,factory_name,status,total_qty,sku_count,approval_id,creator_id,assigned_supply_user_id,created_at,updated_at) VALUES (?,?,?,?,?,'draft',?,?,?,?,?,?,?)").bind(po,base.month,g.seriesName,g.supplierName,g.factoryName,g.totalQty,g.items.length,change.id,change.creator_id,supply.id,stamp,stamp),db.prepare("INSERT INTO series_production_orders (id,purchase_order_id,month,series_name,factory_name,status,total_planned_qty,total_produced_qty,evidence_json,creator_id,assigned_user_id,progress_pct,qc_status,created_at,updated_at) VALUES (?,?,?,?,?,'awaiting_order',?,0,'[]',?,?,0,'pending',?,?)").bind(mo,po,base.month,g.seriesName,g.factoryName,g.totalQty,change.creator_id,factory.assigned_user_id,stamp,stamp));
   for(const r of g.items){const item=id('po_item');stmts.push(db.prepare('INSERT INTO series_purchase_order_items (id,purchase_order_id,sku,name,ordered_qty,allocations_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').bind(item,po,r.sku,r.name,r.total,JSON.stringify(r.allocations),stamp,stamp),db.prepare('INSERT INTO series_production_order_items (id,production_order_id,purchase_order_item_id,sku,name,planned_qty,produced_qty,created_at,updated_at) VALUES (?,?,?,?,?,?,0,?,?)').bind(id('mo_item'),mo,item,r.sku,r.name,r.total,stamp,stamp));}
  }
  stmts.push(db.prepare('UPDATE approval_requests SET payload_json=?,version=version+1,updated_at=? WHERE id=?').bind(change.new_json,stamp,base.id));
  stmts.push(db.prepare('UPDATE forecast_snapshots SET approved_qty=0,approval_id=? WHERE month=?').bind(base.id,base.month));for(const r of next.items)for(const a of r.allocations)stmts.push(db.prepare('UPDATE forecast_snapshots SET approved_qty=?,approval_id=? WHERE month=? AND sku=? AND site=? AND channel=?').bind(a.qty,base.id,base.month,r.sku,a.site,a.channel));
 }
 stmts.push(db.prepare('UPDATE plan_changes SET status=?,version=version+1,decided_by=?,decision_note=?,updated_at=? WHERE id=?').bind(payload.decision==='approve'?'approved':'rejected',actor.id,reason,stamp,change.id),audit(db,actor,action,change.id,{decision:payload.decision,reason},stamp));await atomicBatch(db,stmts);return {ok:true};
}
function audit(db,a,action,entity,detail,stamp){return db.prepare('INSERT INTO audit_logs (id,action,entity_type,entity_id,detail_json,actor_id,actor_name,created_at) VALUES (?,?,?,?,?,?,?,?)').bind(id('audit'),action,'plan_change',entity,JSON.stringify(detail),a.id,a.name,stamp)}
