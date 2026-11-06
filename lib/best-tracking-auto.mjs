import {isBestCarrier} from './best-carrier.mjs';
import {atomicBatch,guardStatement} from './atomic.mjs';
import {bestProgress,bestTimelineConflict} from './best-tracking-progress.mjs';
import {TrackingError} from './best-tracking-client.mjs';

const system = {id:'best-tracking-sync',name:'百世轨迹同步',role:'系统'};
export const bestCountries = {印尼:'ID',马来西亚:'MY',菲律宾:'PH',越南:'VN',泰国:'TH'};
const targetRows = `SELECT w.*,m.attempted_at,m.reason,m.suppressed FROM best_waybill_targets w
 LEFT JOIN best_tracking_matches m ON m.leg_id=w.leg_id AND m.waybill=w.waybill`;

export async function matchNotes(db,legId) {
  const {results} = await db.prepare(targetRows+` WHERE w.leg_id=? AND NOT EXISTS
    (SELECT 1 FROM best_transport_tracking t WHERE t.leg_id=w.leg_id AND t.waybill=w.waybill)`).bind(legId).all();
  return results.map(r=>({waybill:r.waybill,reason:r.suppressed?'已人工解除':r.issue||r.reason||'等待百世核验'}));
}

export async function discoverBestBindings(db,config,lookup) {
  const now=new Date().toISOString(), cutoff=new Date(Date.now()-3600000).toISOString();
  const {results}=await db.prepare(`SELECT w.*,l.site,b.carrier_name,m.attempted_at
    FROM best_waybill_targets w JOIN transport_legs l ON l.id=w.leg_id JOIN transport_batches b ON b.id=l.batch_id
    LEFT JOIN best_tracking_matches m ON m.leg_id=w.leg_id AND m.waybill=w.waybill
    WHERE w.issue='' AND l.stage NOT IN ('shelf_pending','on_shelf') AND coalesce(m.suppressed,0)=0
    AND coalesce(m.attempted_at,'')<? AND NOT EXISTS(SELECT 1 FROM best_transport_tracking t WHERE t.leg_id=w.leg_id AND t.waybill=w.waybill)
    ORDER BY coalesce(m.attempted_at,''),w.leg_id,w.waybill`).bind(cutoff).all();
  const cache=new Map();
  for (const row of results.filter(r=>isBestCarrier(r.carrier_name)).slice(0,20)) {
    const {leg_id,waybill,batch_id}=row;
    const claim=await db.prepare(`INSERT INTO best_tracking_matches(leg_id,waybill,attempted_at) VALUES(?,?,?)
      ON CONFLICT(leg_id,waybill) DO UPDATE SET attempted_at=excluded.attempted_at
      WHERE suppressed=0 AND attempted_at<?`).bind(leg_id,waybill,now,cutoff).run();
    if (!claim.meta.changes) continue;
    let snapshot;
    try {
      if (!cache.has(waybill)) cache.set(waybill,lookup(config,waybill));
      snapshot=await cache.get(waybill);
      if (!bestCountries[row.site] || snapshot.country!==bestCountries[row.site]) throw new TrackingError(409,'收货国家与分批不符，请核对运单');
    } catch(error) {
      await db.prepare('UPDATE best_tracking_matches SET reason=? WHERE leg_id=? AND waybill=? AND attempted_at=? AND suppressed=0')
        .bind(error instanceof TrackingError?error.message:'百世查询失败，稍后重试',leg_id,waybill,now).run();
      continue;
    }
    const id=crypto.randomUUID();
    // Recheck matching, operator suppression and order ownership after the network round trip.
    await atomicBatch(db,[
      db.prepare(`INSERT INTO best_transport_tracking(id,leg_id,waybill,snapshot_json,last_success_at,last_attempt_at,link_source)
        SELECT ?,w.leg_id,w.waybill,?,?,?,'auto' FROM best_waybill_targets w
        JOIN best_tracking_matches m ON m.leg_id=w.leg_id AND m.waybill=w.waybill
        JOIN transport_legs l ON l.id=w.leg_id JOIN transport_batches b ON b.id=l.batch_id
        WHERE w.leg_id=? AND w.waybill=? AND w.issue='' AND w.batch_id=? AND l.site=? AND b.carrier_name=?
        AND l.stage NOT IN ('shelf_pending','on_shelf') AND m.suppressed=0 AND m.attempted_at=?
        ON CONFLICT(leg_id,waybill) DO NOTHING`).bind(id,JSON.stringify(snapshot),now,now,leg_id,waybill,batch_id,row.site,row.carrier_name,now),
      db.prepare(`INSERT INTO audit_logs(id,action,entity_type,entity_id,detail_json,actor_id,actor_name,created_at)
        SELECT ?,'自动匹配百世运单','transport_leg',?,?,?,?,? WHERE EXISTS(SELECT 1 FROM best_transport_tracking WHERE id=?)`)
        .bind(crypto.randomUUID(),leg_id,JSON.stringify({waybill,source:row.source}),system.id,system.name,now,id),
    ]);
  }
}

// The transaction must observe precisely the evidence used to decide the new stage.
const bindingsVersion=`SELECT json_group_array(json_array(id,last_success_at,last_error)) FROM
 (SELECT id,last_success_at,last_error FROM best_transport_tracking WHERE leg_id=? ORDER BY id)`;
const matchingIssues=`SELECT 1 FROM best_waybill_targets w
 LEFT JOIN best_tracking_matches m ON m.leg_id=w.leg_id AND m.waybill=w.waybill
 LEFT JOIN best_transport_tracking t ON t.leg_id=w.leg_id AND t.waybill=w.waybill
 WHERE w.leg_id=? AND coalesce(m.suppressed,0)=0 AND
 ((t.id IS NULL AND w.issue<>'请以对应分批的运单为准') OR (t.id IS NOT NULL AND w.issue='单号出现在多个主批次，需核对'))`;
const disputedLink=`EXISTS(SELECT 1 FROM best_waybill_sources s WHERE s.waybill=t.waybill AND s.batch_id<>l.batch_id)
 OR (t.link_source='auto' AND NOT EXISTS(SELECT 1 FROM best_waybill_targets w WHERE w.leg_id=t.leg_id AND w.waybill=t.waybill AND w.issue=''))`;
const changedAutoReference=`SELECT 1 FROM best_transport_tracking t JOIN transport_legs l ON l.id=t.leg_id WHERE t.leg_id=? AND (${disputedLink})`;
export async function advanceBestLeg(db,legId) {
  const leg=await db.prepare(`SELECT l.*,b.carrier_name FROM transport_legs l JOIN transport_batches b ON b.id=l.batch_id WHERE l.id=?`).bind(legId).first();
  if(!leg||!isBestCarrier(leg.carrier_name)||!['sea_freight','port_arrived','customs_clearance','last_mile_delivery'].includes(leg.stage))return;
  const {results:bindings}=await db.prepare('SELECT * FROM best_transport_tracking WHERE leg_id=? ORDER BY id').bind(legId).all();
  const shipments=bindings.map(r=>({...r,snapshot:JSON.parse(r.snapshot_json)}));
  if(shipments.some(r=>!bestCountries[leg.site]||r.snapshot.country!==bestCountries[leg.site]))return;
  const next=bestProgress(leg,shipments);
  if(!next||await db.prepare(matchingIssues+' LIMIT 1').bind(legId).first()||await db.prepare(changedAutoReference+' LIMIT 1').bind(legId).first())return;
  const at=new Date().toISOString(),refs=[...new Set(next.evidence.map(e=>e.waybill))];
  const detail={source:'bestTracking',from:leg.stage,to:next.stage,nodes:next.evidence};
  const event={...detail,stage:leg.stage,reference:refs.join(' / '),note:'百世实际轨迹同步',at,by:system.name,role:system.role};
  const signature=JSON.stringify(bindings.map(r=>[r.id,r.last_success_at,r.last_error]));
  try {
    await atomicBatch(db,[
      guardStatement(db,system,'百世运输节点核对',`EXISTS(SELECT 1 FROM transport_legs l JOIN transport_batches b ON b.id=l.batch_id WHERE l.id=? AND l.version=? AND l.stage=? AND l.site=? AND b.carrier_name=?)
        AND (${bindingsVersion})=? AND NOT EXISTS(${matchingIssues}) AND NOT EXISTS(${changedAutoReference})`,
        [legId,leg.version,leg.stage,leg.site,leg.carrier_name,legId,signature,legId,legId]),
      db.prepare(`UPDATE transport_legs SET stage=?,stage_owner=?,ata=coalesce(nullif(ata,''),?),version=version+1,updated_at=?,
        evidence_json=json_insert(evidence_json,'$[#]',json(?)) WHERE id=?`).bind(next.stage,next.owner,next.ata,at,JSON.stringify(event),legId),
      db.prepare("UPDATE transport_batches SET status='active',updated_at=? WHERE id=?").bind(at,leg.batch_id),
      db.prepare(`INSERT INTO audit_logs(id,action,entity_type,entity_id,detail_json,actor_id,actor_name,created_at)
        VALUES(?,'自动推进百世运输节点','transport_leg',?,?,?,?,?)`).bind(crypto.randomUUID(),legId,JSON.stringify(detail),system.id,system.name,at),
    ]);
  } catch(error) { if(error.status!==409)throw error; } // Retry against fresh data on the next pass.
}

export async function waybillLocations(db, waybill, country) {
  const {results}=await db.prepare(`SELECT l.id,l.leg_no,l.site,l.channel,b.batch_no,b.carrier_name,
    t.id AS linked,w.issue, m.suppressed FROM transport_legs l JOIN transport_batches b ON b.id=l.batch_id
    LEFT JOIN best_transport_tracking t ON t.leg_id=l.id AND t.waybill=?
    LEFT JOIN best_waybill_targets w ON w.leg_id=l.id AND w.waybill=?
    LEFT JOIN best_tracking_matches m ON m.leg_id=l.id AND m.waybill=?
    WHERE t.id IS NOT NULL OR w.waybill IS NOT NULL ORDER BY b.batch_no,l.leg_no`).bind(waybill,waybill,waybill).all();
  return results.filter(r=>isBestCarrier(r.carrier_name)).map(r=>({id:r.id,leg:r.leg_no,batch:r.batch_no,site:r.site,channel:r.channel,
    status:r.linked?'已关联':r.suppressed?'已人工解除':r.issue|| (bestCountries[r.site]!==country?'目的地不符':'待自动匹配')}));
}

export async function cardSummaries(db,legIds) {
  const {results}=await db.prepare(`SELECT t.leg_id,l.stage,l.etd,t.waybill,t.snapshot_json,t.last_success_at,t.last_error,(${disputedLink}) disputed FROM best_transport_tracking t JOIN transport_legs l ON l.id=t.leg_id
    WHERE t.leg_id IN (SELECT value FROM json_each(?)) ORDER BY t.leg_id,t.waybill`).bind(JSON.stringify(legIds)).all();
  const summary=new Map();
  for(const row of results) {
    const snapshot=JSON.parse(row.snapshot_json);
    const event=snapshot.groups.flatMap(g=>g.events).filter(e=>e.kind==='actual'&&e.at&&Date.parse(e.at)<=Date.now()).sort((a,b)=>b.at.localeCompare(a.at))[0];
    const list=summary.get(row.leg_id)||[];
    list.push({waybill:row.waybill,timelineConflict:bestTimelineConflict(row,snapshot),status:snapshot.status,description:event?.description||event?.state||'',at:event?.at||null,updatedAt:row.last_success_at,error:row.disputed?'单号归属待核对，自动推进已暂停':row.last_error});
    summary.set(row.leg_id,list);
  }
  return summary;
}
