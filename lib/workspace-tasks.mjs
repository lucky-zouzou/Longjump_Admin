import {wholesaleTasks} from './wholesale.mjs';
import {reviewTasks} from './business-reviews.mjs';
import {afterTasks} from './after-sales.mjs';
export async function workspaceTasks(db,actor){
  const tasks=[...await wholesaleTasks(db,actor),...await reviewTasks(db,actor),...await afterTasks(db,actor)];
  const today=new Date(Date.now()+8*3600000).toISOString().slice(0,10),month=today.slice(0,7),yesterday=new Date(Date.parse(today)-86400000).toISOString().slice(0,10);
  const rows=async(sql,...args)=>(await db.prepare(sql).bind(...args).all()).results||[];
  const add=(tab,entity,title,detail,level='amber',more={})=>tasks.push({tab,entity,title,detail,level,...more});
  if(actor.role==='运营'){
    if(!await db.prepare("SELECT id FROM sales_imports WHERE site=? AND channel=? AND business_date=? AND report_kind IN ('complete','zero') AND reversed_at IS NULL LIMIT 1").bind(actor.site,actor.channel,yesterday).first())add('sales','','导入昨日销售',`${actor.site} · ${actor.channel} · ${yesterday} 日报待完成`,'red');
    if(!await db.prepare('SELECT id FROM monthly_submissions WHERE site=? AND channel=? AND month=?').bind(actor.site,actor.channel,month).first())add('suggestions','','提交月度需求',`${month} 需求尚未提交`);
    for(const leg of await rows("SELECT l.id,l.leg_no,SUM(i.pending_shelf_qty) qty FROM transport_legs l JOIN transport_leg_items i ON i.leg_id=l.id WHERE l.site=? AND l.channel=? AND l.stage='shelf_pending' GROUP BY l.id HAVING SUM(i.pending_shelf_qty)>0",actor.site,actor.channel))add('batches',leg.id,'确认上架',`${leg.leg_no} · ${leg.qty}件待转可售`);
  }
  if(['管理员','供应链'].includes(actor.role)){
    for(const row of await rows("SELECT id,site,channel,sku FROM inventory_count_requests WHERE status='pending'"))add('inventory',row.id,'复核盘点差异',`${row.site} · ${row.channel} · ${row.sku}`);
    for(const row of await rows("SELECT id,series_name,total_qty FROM series_purchase_orders WHERE status IN ('draft','ordered') AND COALESCE(supplier_confirmed_at,'')=''"+(actor.role==='供应链'?' AND assigned_supply_user_id=?':''),...(actor.role==='供应链'?[actor.id]:[])))add('fulfillment',row.id,'确认供应商接单',`${row.series_name} · ${row.total_qty}件`);
    for(const row of await rows("SELECT id,series_name FROM series_production_orders WHERE status IN ('completed','completed_with_variance') AND qc_status<>'passed'"))add('fulfillment',row.id,'确认生产质检',`${row.series_name} 已完工待质检`,'red');
    for(const row of await rows("SELECT id,leg_no,stage,site,channel FROM transport_legs WHERE stage IN ('booking','awaiting_receipt')"))add('batches',row.id,row.stage==='booking'?'完成订舱交接':'登记目的地到仓',`${row.leg_no} · ${row.site} · ${row.channel}`);
    for(const row of await rows("SELECT id,month,status,creator_id FROM approval_requests WHERE type='monthly_plan' AND status IN ('pending','withdrawn','rejected')")){
      if(actor.role==='管理员'&&row.status==='pending')add('approval',row.id,row.creator_id===actor.id?'撤回本人送审计划':'审批月度备货',`${row.month} 计划待审批`,'red',{month:row.month});
      if(actor.role==='供应链'&&['withdrawn','rejected'].includes(row.status))add('approval',row.id,'重新送审月度计划',`${row.month} 请核对需求后重新送审`,'red',{month:row.month});
    }
  }
  if(actor.role==='工厂')for(const row of await rows("SELECT id,series_name,total_planned_qty,status,promised_completion_date FROM series_production_orders WHERE assigned_user_id=? AND status IN ('awaiting_factory','in_production','pending')",actor.id))add('fulfillment',row.id,row.status==='in_production'?'更新生产进度':'确认生产接单',`${row.series_name} · ${row.total_planned_qty}件`,row.promised_completion_date&&row.promised_completion_date<today?'red':'amber');
  if(actor.role==='海运')for(const row of await rows("SELECT id,leg_no,site,channel,eta FROM transport_legs WHERE assigned_user_id=? AND stage_owner='海运' AND stage<>'on_shelf'",actor.id))add('batches',row.id,'更新运输节点',`${row.leg_no} · ${row.site} · ${row.channel}`,row.eta&&row.eta<today?'red':'amber');
  return tasks;
}
