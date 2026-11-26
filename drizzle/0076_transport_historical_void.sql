-- Close obsolete destination legs that were recorded separately as historical
-- inbound. Never remove factory shipment commitments or alter inventory here.
CREATE TABLE transport_leg_voids (
 id TEXT PRIMARY KEY,
 leg_id TEXT NOT NULL UNIQUE REFERENCES transport_legs(id),
 kind TEXT NOT NULL CHECK(kind='historical_inbound'),
 reason TEXT NOT NULL,
 discrepancy_reason TEXT NOT NULL DEFAULT '',
 request_json TEXT NOT NULL,
 original_json TEXT NOT NULL,
 history_json TEXT NOT NULL,
 actor_id TEXT NOT NULL REFERENCES users(id),
 actor_name TEXT NOT NULL,
 created_at TEXT NOT NULL
);
CREATE TABLE transport_leg_void_sources (
 void_id TEXT NOT NULL REFERENCES transport_leg_voids(id),
 source_kind TEXT NOT NULL CHECK(source_kind IN ('document','legacy')),
 source_id TEXT NOT NULL,
 site TEXT NOT NULL,
 channel TEXT NOT NULL,
 sku TEXT NOT NULL,
 source_qty INTEGER NOT NULL CHECK(source_qty>0),
 receipt_no TEXT NOT NULL,
 proof_ref TEXT NOT NULL,
 source_json TEXT NOT NULL,
 PRIMARY KEY(source_kind,source_id,site,channel,sku)
);
CREATE INDEX transport_void_source_parent ON transport_leg_void_sources(void_id);
CREATE TRIGGER transport_void_immutable_update BEFORE UPDATE ON transport_leg_voids BEGIN SELECT RAISE(ABORT,'immutable transport void'); END;
CREATE TRIGGER transport_void_immutable_delete BEFORE DELETE ON transport_leg_voids BEGIN SELECT RAISE(ABORT,'immutable transport void'); END;
CREATE TRIGGER transport_void_source_immutable_update BEFORE UPDATE ON transport_leg_void_sources BEGIN SELECT RAISE(ABORT,'immutable transport void source'); END;
CREATE TRIGGER transport_void_source_immutable_delete BEFORE DELETE ON transport_leg_void_sources BEGIN SELECT RAISE(ABORT,'immutable transport void source'); END;
CREATE TRIGGER maintenance_transport_void_insert BEFORE INSERT ON transport_leg_voids WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER maintenance_transport_void_source_insert BEFORE INSERT ON transport_leg_void_sources WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;

-- All writers (including automatic carrier updates) must respect the terminal state.
CREATE TRIGGER guard_transport_void_terminal BEFORE UPDATE ON transport_legs
WHEN OLD.stage='voided' BEGIN SELECT RAISE(ABORT,'guard_transport_void_terminal'); END;
CREATE TRIGGER guard_transport_void_delete BEFORE DELETE ON transport_legs
WHEN OLD.stage='voided' BEGIN SELECT RAISE(ABORT,'immutable transport void leg'); END;
CREATE TRIGGER guard_transport_void_item_update BEFORE UPDATE ON transport_leg_items
WHEN EXISTS(SELECT 1 FROM transport_legs WHERE id=OLD.leg_id AND stage='voided') BEGIN SELECT RAISE(ABORT,'guard_transport_void_item'); END;
CREATE TRIGGER guard_transport_void_item_delete BEFORE DELETE ON transport_leg_items
WHEN EXISTS(SELECT 1 FROM transport_legs WHERE id=OLD.leg_id AND stage='voided') BEGIN SELECT RAISE(ABORT,'immutable transport void item'); END;
CREATE TRIGGER guard_transport_void_item_insert BEFORE INSERT ON transport_leg_items
WHEN EXISTS(SELECT 1 FROM transport_legs WHERE id=NEW.leg_id AND stage='voided') BEGIN SELECT RAISE(ABORT,'guard_transport_void_item'); END;
CREATE TRIGGER guard_transport_void_receipt_insert BEFORE INSERT ON transport_receipts
WHEN EXISTS(SELECT 1 FROM transport_legs WHERE id=NEW.leg_id AND stage='voided') BEGIN SELECT RAISE(ABORT,'guard_transport_void_receipt'); END;
CREATE TRIGGER guard_transport_void_shelf_insert BEFORE INSERT ON transport_shelf_confirmations
WHEN EXISTS(SELECT 1 FROM transport_leg_items i JOIN transport_legs l ON l.id=i.leg_id WHERE i.id=NEW.leg_item_id AND l.stage='voided') BEGIN SELECT RAISE(ABORT,'guard_transport_void_shelf'); END;
CREATE TRIGGER guard_transport_void_commitment_update BEFORE UPDATE ON transport_batch_items
WHEN EXISTS(SELECT 1 FROM transport_leg_items i JOIN transport_legs l ON l.id=i.leg_id WHERE i.batch_item_id=OLD.id AND l.stage='voided')
 AND (NEW.shipped_qty IS NOT OLD.shipped_qty OR NEW.production_order_item_id IS NOT OLD.production_order_item_id OR NEW.production_order_id IS NOT OLD.production_order_id OR NEW.sku IS NOT OLD.sku OR NEW.batch_id IS NOT OLD.batch_id)
BEGIN SELECT RAISE(ABORT,'guard_transport_void_commitment'); END;
CREATE TRIGGER guard_transport_void_commitment_delete BEFORE DELETE ON transport_batch_items
WHEN EXISTS(SELECT 1 FROM transport_leg_items i JOIN transport_legs l ON l.id=i.leg_id WHERE i.batch_item_id=OLD.id AND l.stage='voided') BEGIN SELECT RAISE(ABORT,'immutable transport void commitment'); END;
