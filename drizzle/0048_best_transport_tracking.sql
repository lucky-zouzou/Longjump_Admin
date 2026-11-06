CREATE TABLE best_transport_tracking (
  id TEXT PRIMARY KEY NOT NULL,
  leg_id TEXT NOT NULL REFERENCES transport_legs(id) ON DELETE CASCADE,
  waybill TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  last_success_at TEXT NOT NULL,
  last_attempt_at TEXT NOT NULL,
  last_error TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX idx_best_leg_waybill ON best_transport_tracking(leg_id, waybill);
CREATE INDEX idx_best_tracking_due ON best_transport_tracking(last_attempt_at);

CREATE TRIGGER maintenance_best_tracking_insert BEFORE INSERT ON best_transport_tracking
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

CREATE TRIGGER maintenance_best_tracking_update BEFORE UPDATE ON best_transport_tracking
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

CREATE TRIGGER maintenance_best_tracking_delete BEFORE DELETE ON best_transport_tracking
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;
