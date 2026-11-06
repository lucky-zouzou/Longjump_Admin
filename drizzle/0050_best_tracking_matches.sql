ALTER TABLE best_transport_tracking ADD COLUMN link_source TEXT NOT NULL DEFAULT 'manual' CHECK(link_source IN ('manual','auto'));
CREATE TABLE best_tracking_matches (
 leg_id TEXT NOT NULL REFERENCES transport_legs(id) ON DELETE CASCADE,
 waybill TEXT NOT NULL,
 attempted_at TEXT NOT NULL DEFAULT '',
 reason TEXT NOT NULL DEFAULT '',
 suppressed INTEGER NOT NULL DEFAULT 0 CHECK(suppressed IN (0,1)),
 PRIMARY KEY(leg_id,waybill)
);
CREATE INDEX idx_best_waybill ON best_transport_tracking(waybill);
-- Only shipping references entered by staff are evidence of a carrier booking.
CREATE VIEW best_waybill_sources AS
 SELECT l.id leg_id,l.batch_id,upper(trim(b.bill_no)) waybill,'bill' source
 FROM transport_legs l JOIN transport_batches b ON b.id=l.batch_id
 WHERE upper(trim(b.bill_no)) GLOB 'BS*'
 UNION
 SELECT l.id,l.batch_id,upper(trim(json_extract(e.value,'$.reference'))),'leg'
 FROM transport_legs l,json_each(l.evidence_json) e
 WHERE json_valid(e.value) AND coalesce(json_extract(e.value,'$.source'),'')<>'bestTracking'
 AND upper(trim(json_extract(e.value,'$.reference'))) GLOB 'BS*';
INSERT INTO best_tracking_matches(leg_id,waybill,suppressed,reason)
 SELECT DISTINCT l.id,json_extract(a.detail_json,'$.waybill'),1,'已人工解除'
 FROM audit_logs a JOIN transport_legs l ON l.id=a.entity_id
 WHERE a.entity_type='transport_leg' AND a.action='解除百世运单关联' AND json_valid(a.detail_json)
 AND json_type(a.detail_json,'$.waybill')='text' AND NOT EXISTS (
 SELECT 1 FROM best_transport_tracking t WHERE t.leg_id=l.id AND t.waybill=json_extract(a.detail_json,'$.waybill'));
CREATE TRIGGER maintenance_best_matches_insert BEFORE INSERT ON best_tracking_matches
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER maintenance_best_matches_update BEFORE UPDATE ON best_tracking_matches
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER maintenance_best_matches_delete BEFORE DELETE ON best_tracking_matches
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE VIEW best_waybill_targets AS
 SELECT s.leg_id,s.batch_id,s.waybill,max(s.source) AS source,
 CASE
 WHEN EXISTS(SELECT 1 FROM best_waybill_sources other WHERE other.waybill=s.waybill AND other.batch_id<>s.batch_id)
   OR EXISTS(SELECT 1 FROM best_transport_tracking t JOIN transport_legs p ON p.id=t.leg_id WHERE t.waybill=s.waybill AND p.batch_id<>s.batch_id) THEN '单号出现在多个主批次，需核对'
 WHEN max(s.source)='leg' THEN ''
 WHEN EXISTS(SELECT 1 FROM best_waybill_sources direct WHERE direct.source='leg' AND direct.batch_id=s.batch_id AND (direct.leg_id=s.leg_id OR direct.waybill=s.waybill)) THEN '请以对应分批的运单为准'
 WHEN (SELECT count(*) FROM transport_legs sibling WHERE sibling.batch_id=s.batch_id AND sibling.site=l.site)>1 THEN '同站点有多个分批，请分别登记运单'
 ELSE '' END AS issue
 FROM best_waybill_sources s JOIN transport_legs l ON l.id=s.leg_id
 WHERE length(s.waybill) BETWEEN 7 AND 50 AND s.waybill NOT GLOB '*[^0-9A-Z-]*'
 GROUP BY s.leg_id,s.batch_id,s.waybill;
