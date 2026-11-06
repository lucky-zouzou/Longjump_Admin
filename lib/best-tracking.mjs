import {assertWritable, atomicBatch, guardStatement} from './atomic.mjs';
import {canReadDomain, navigationForRole} from './permissions.mjs';
import {isBestCarrier} from './best-carrier.mjs';
import {normalizeWaybill, queryBestTracking, TrackingError} from './best-tracking-client.mjs';

const countries = {印尼:'ID',马来西亚:'MY',菲律宾:'PH',越南:'VN',泰国:'TH'};
const legSql = 'SELECT l.*, b.carrier_name FROM transport_legs l JOIN transport_batches b ON b.id=l.batch_id';

async function readLeg(db, actor, legId, write = false) {
  if (!canReadDomain(actor.role, 'transport') || !navigationForRole(actor.role).includes('batches'))
    throw new TrackingError(403, '当前账号无权查看海运批次');
  const leg = await db.prepare(legSql + ' WHERE l.id=?').bind(String(legId ?? '')).first();
  if (!leg || (actor.role === '海运' && actor.id !== leg.assigned_user_id) ||
      (actor.role === '运营' && (actor.site !== leg.site || actor.channel !== leg.channel)))
    throw new TrackingError(404, '未找到可访问的目的地分批');
  if (!isBestCarrier(leg.carrier_name)) throw new TrackingError(400, '该批次承运商未登记为百世');
  if (write && !['供应链','管理员','海运'].includes(actor.role))
    throw new TrackingError(403, '仅管理员、供应链或本批次的海运负责人可以管理运单');
  return leg;
}

// Company-account lookup without recording the waybill or changing a shipment.
export async function previewBestTracking(config,actor,waybill,lookup=queryBestTracking){
  if(!['管理员','供应链'].includes(actor.role))throw new TrackingError(403,'仅管理员和供应链可独立核验运单');
  const no=normalizeWaybill(waybill);
  return {waybill:no,snapshot:await lookup(config,no)};
}

export async function readBestTracking(db, actor, legId) {
  const leg = await readLeg(db, actor, legId);
  const {results} = await db.prepare('SELECT * FROM best_transport_tracking WHERE leg_id=? ORDER BY waybill').bind(leg.id).all();
  return {canManage:['供应链','管理员','海运'].includes(actor.role), rows:results.map(row => ({
    id:row.id, waybill:row.waybill, snapshot:JSON.parse(row.snapshot_json),
    updatedAt:row.last_success_at, error:row.last_error,
  }))};
}

function verifyDestination(snapshot, site) {
  if (!countries[site] || snapshot.country !== countries[site])
    throw new TrackingError(409, '百世收货国家与该分批站点无法匹配，请核对运单和分批');
}

function audit(db, actor, leg, waybill, action, at) {
  return db.prepare(`INSERT INTO audit_logs (id,action,entity_type,entity_id,detail_json,actor_id,actor_name,created_at)
    VALUES (?,?, 'transport_leg',?,?,?,?,?)`).bind(crypto.randomUUID(),action,leg.id,JSON.stringify({waybill}),actor.id,actor.name,at);
}

function legGuard(db, actor, leg) {
  return guardStatement(db, actor, '百世运输轨迹', `EXISTS(SELECT 1 FROM transport_legs l
    JOIN transport_batches b ON b.id=l.batch_id WHERE l.id=? AND l.batch_id=? AND l.site=? AND b.carrier_name=?
    AND (? <> '海运' OR l.assigned_user_id=?))`, [leg.id,leg.batch_id,leg.site,leg.carrier_name,actor.role,actor.id]);
}

export async function manageBestTracking(db, config, actor, input, lookup = queryBestTracking) {
  const leg = await readLeg(db, actor, input.legId, true);
  await assertWritable(db);
  const at = new Date().toISOString();
  if (input.action === 'link') {
    const no = normalizeWaybill(input.waybill);
    const existing = await db.prepare('SELECT id FROM best_transport_tracking WHERE leg_id=? AND waybill=?').bind(leg.id,no).first();
    if (!existing) {
      const snapshot = await lookup(config, no);
      verifyDestination(snapshot, leg.site);
      // One shipment may be split between channels of the same master batch.
      // Never let a second master batch claim the same waybill.
      const guard = guardStatement(db, actor, '关联百世运单', `NOT EXISTS(SELECT 1 FROM best_transport_tracking t
        JOIN transport_legs l ON l.id=t.leg_id WHERE t.waybill=? AND l.batch_id<>?)`, [no,leg.batch_id]);
      const newId = crypto.randomUUID();
      await atomicBatch(db, [legGuard(db, actor, leg), guard,
        db.prepare(`INSERT INTO best_transport_tracking (id,leg_id,waybill,snapshot_json,last_success_at,last_attempt_at)
          VALUES (?,?,?,?,?,?) ON CONFLICT(leg_id,waybill) DO NOTHING`).bind(newId,leg.id,no,JSON.stringify(snapshot),at,at),
        db.prepare(`INSERT INTO audit_logs (id,action,entity_type,entity_id,detail_json,actor_id,actor_name,created_at)
          SELECT ?,'关联百世运单','transport_leg',?,?,?,?,? WHERE EXISTS(SELECT 1 FROM best_transport_tracking WHERE id=?)`)
          .bind(crypto.randomUUID(),leg.id,JSON.stringify({waybill:no}),actor.id,actor.name,at,newId),
      ]);
    }
  } else {
    const row = await db.prepare('SELECT * FROM best_transport_tracking WHERE leg_id=? AND id=?').bind(leg.id,String(input.id ?? '')).first();
    if (!row) throw new TrackingError(404, '运单关联已变化，请重新打开轨迹');
    if (input.action === 'unlink') {
      await atomicBatch(db, [legGuard(db, actor, leg),guardStatement(db, actor, '解除百世运单',
        'EXISTS(SELECT 1 FROM best_transport_tracking WHERE id=? AND leg_id=?)',[row.id,leg.id]),
        db.prepare('DELETE FROM best_transport_tracking WHERE id=? AND leg_id=?').bind(row.id,leg.id),
        audit(db,actor,leg,row.waybill,'解除百世运单关联',at)]);
    } else if (input.action === 'refresh') {
      await refreshBinding(db, config, row, leg.site, lookup);
    } else throw new TrackingError(400, '不支持的运单操作');
  }
  return readBestTracking(db, actor, leg.id);
}

async function refreshBinding(db, config, row, site, lookup) {
  const now = new Date(), attempt = now.toISOString();
  // Compare and swap prevents concurrent requests and older responses from overwriting newer tracks.
  const claimed = await db.prepare(`UPDATE best_transport_tracking SET last_attempt_at=?
    WHERE id=? AND last_attempt_at=? AND last_attempt_at<?`)
    .bind(attempt,row.id,row.last_attempt_at,new Date(+now - 60000).toISOString()).run();
  if (!claimed.meta.changes) return;
  let snapshot;
  try {
    snapshot = await lookup(config, row.waybill);
    verifyDestination(snapshot, site);
  } catch (error) {
    const message = error instanceof TrackingError ? error.message : '百世查询失败，请稍后重试';
    await db.prepare('UPDATE best_transport_tracking SET last_error=? WHERE id=? AND last_attempt_at=?').bind(message,row.id,attempt).run();
    return;
  }
  await db.prepare(`UPDATE best_transport_tracking SET snapshot_json=?,last_success_at=?,last_error=''
    WHERE id=? AND last_attempt_at=? AND EXISTS(SELECT 1 FROM transport_legs l WHERE l.id=leg_id AND l.site=?)`)
    .bind(JSON.stringify(snapshot),new Date().toISOString(),row.id,attempt,site).run();
}

export async function pollBestTracking(db, config, lookup = queryBestTracking) {
  if (!config.BEST_PARTNER_ID || !config.BEST_API_SECRET) return;
  await assertWritable(db);
  const {results} = await db.prepare(`SELECT t.*,l.site,b.carrier_name FROM best_transport_tracking t
    JOIN transport_legs l ON l.id=t.leg_id JOIN transport_batches b ON b.id=l.batch_id
    WHERE l.stage<>'on_shelf' AND t.last_attempt_at<? ORDER BY t.last_attempt_at LIMIT 20`)
    .bind(new Date(Date.now()-3600000).toISOString()).all();
  for (const row of results) {
    if (isBestCarrier(row.carrier_name)) await refreshBinding(db,config,row,row.site,lookup);
  }
}
