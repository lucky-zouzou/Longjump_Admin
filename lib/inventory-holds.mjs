import {guardStatement,atomicBatch,ConflictError} from './atomic.mjs';
const all=async(db,sql,args=[])=>{const r=await db.prepare(sql).bind(...args).all();if(!r.success)throw Error('隔离明细读取失败');return r.results||[];};
export async function resolveInventoryHoldSources(db,actor,payload){
  const {site,channel,sku,resolution}=payload,qty=Number(payload.qty),reason=String(payload.reason||'').trim();
  if(!Number.isSafeInteger(qty)||qty<=0||!['release','writeoff'].includes(resolution)||reason.length<4)throw new ConflictError('请填写有效数量、处理方式和原因');
  const stock=await db.prepare('SELECT * FROM inventory_balances WHERE site=? AND channel=? AND sku=?').bind(site,channel,sku).first();
  if(!stock||stock.quarantine_qty<qty)throw new ConflictError('隔离库存不足，请刷新核对');
  const transport=await all(db,'SELECT li.id,li.leg_id,li.quarantine_qty qty,li.updated_at created_at,l.batch_id FROM transport_leg_items li JOIN transport_legs l ON l.id=li.leg_id WHERE l.site=? AND l.channel=? AND li.sku=? AND li.quarantine_qty>0',[site,channel,sku]);
  const returned=site==='印尼'?await all(db,`SELECT r.id,r.created_at,CAST(j.value->>'qty' AS INTEGER)-COALESCE((SELECT SUM(x.qty) FROM wholesale_return_resolutions x WHERE x.return_id=r.id AND x.channel=?),0) qty
    FROM wholesale_returns r JOIN wholesale_order_items i ON i.id=r.order_item_id JOIN json_each(r.allocations_json) j WHERE r.resellable=0 AND i.sku=? AND j.value->>'channel'=?`,[channel,sku,channel]):[];
  const sources=[...transport.map(r=>({...r,kind:'transport'})),...returned.map(r=>({...r,kind:'return'}))].filter(r=>r.qty>0).sort((a,b)=>a.created_at.localeCompare(b.created_at)||a.id.localeCompare(b.id));
  if(sources.reduce((s,r)=>s+r.qty,0)<qty)throw new ConflictError('隔离库存来源不足，请先核对历史来源明细');
  const now=new Date().toISOString(),ref='hold_'+crypto.randomUUID(),statements=[guardStatement(db,actor,'resolveInventoryHold','EXISTS (SELECT 1 FROM inventory_balances WHERE site=? AND channel=? AND sku=? AND quarantine_qty=?)',[site,channel,sku,stock.quarantine_qty])];
  let left=qty,returnReleased=0,transportReleased=0;const legs=new Set(),batches=new Set(),details=[];
  for(const row of sources){if(!left)break;const n=Math.min(left,row.qty);left-=n;details.push({source:row.kind,id:row.id,qty:n});
    if(row.kind==='return'){
      statements.push(db.prepare('INSERT INTO wholesale_return_resolutions (id,return_id,channel,qty,resolution,reason,actor_id,created_at) VALUES (?,?,?,?,?,?,?,?)').bind('holdret_'+crypto.randomUUID(),row.id,channel,n,resolution,reason,actor.id,now));
      if(resolution==='release')returnReleased+=n;
    }else{
      legs.add(row.leg_id);batches.add(row.batch_id);
      statements.push(db.prepare('UPDATE transport_leg_items SET quarantine_qty=quarantine_qty-?,pending_shelf_qty=pending_shelf_qty+?,updated_at=? WHERE id=?').bind(n,resolution==='release'?n:0,now,row.id));
      if(resolution==='release')transportReleased+=n;
    }
  }
  statements.push(db.prepare('UPDATE inventory_balances SET quarantine_qty=quarantine_qty-?,qty=qty+?,pending_shelf_qty=pending_shelf_qty+?,updated_at=? WHERE site=? AND channel=? AND sku=?').bind(qty,returnReleased,transportReleased,now,site,channel,sku),
    db.prepare("INSERT INTO inventory_movements(id,site,channel,sku,name,movement_type,qty_delta,balance_after,reference_type,reference_id,note,actor_id,created_at) SELECT ?,site,channel,sku,name,?,?,qty,'隔离来源处理',?,?,?,? FROM inventory_balances WHERE site=? AND channel=? AND sku=?").bind('move_'+crypto.randomUUID(),resolution==='release'?'隔离质检放行':'破损报损',returnReleased,ref,JSON.stringify({reason,qty,returnReleased,transportReleased,details}),actor.id,now,site,channel,sku));
  for(const leg of legs)statements.push(...transportCompletionStatements(db,leg,now));
  for(const batch of batches)statements.push(db.prepare("UPDATE transport_batches SET status=CASE WHEN EXISTS(SELECT 1 FROM transport_legs WHERE batch_id=? AND stage<>'on_shelf') THEN 'active' ELSE 'completed' END,updated_at=? WHERE id=?").bind(batch,now,batch));
  statements.push(db.prepare('INSERT INTO audit_logs(id,action,entity_type,entity_id,detail_json,actor_id,actor_name,created_at) VALUES(?,?,?,?,?,?,?,?)').bind('audit_'+crypto.randomUUID(),'隔离库存来源处理','inventory',ref,JSON.stringify({site,channel,sku,qty,resolution,reason,details}),actor.id,actor.name,now));
  await atomicBatch(db,statements);return {ok:true,qty,resolution,returnReleased,transportReleased};
}
export function transportCompletionStatements(db,legId,now){
  const stage=`CASE WHEN (SELECT COALESCE(SUM(qty-received_qty),0) FROM transport_leg_items WHERE leg_id=?)>0 THEN 'awaiting_receipt' WHEN (SELECT COALESCE(SUM(pending_shelf_qty+quarantine_qty),0) FROM transport_leg_items WHERE leg_id=?)>0 THEN 'shelf_pending' ELSE 'on_shelf' END`;
  return [db.prepare(`UPDATE transport_legs SET stage=${stage},version=version+1,updated_at=? WHERE id=?`).bind(legId,legId,now,legId),db.prepare("UPDATE transport_legs SET stage_owner=CASE stage WHEN 'on_shelf' THEN '完成' WHEN 'shelf_pending' THEN '运营' ELSE '供应链' END WHERE id=?").bind(legId)];
}
