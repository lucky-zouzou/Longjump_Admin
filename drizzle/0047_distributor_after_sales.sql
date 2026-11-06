-- Each claim is one row in the common after-sales register.
CREATE UNIQUE INDEX idx_dist_case_request ON after_sales(json_extract(data_json,'$.dist.customer'),json_extract(data_json,'$.dist.request'))
WHERE channel='线下分销';
CREATE INDEX idx_dist_case_item ON after_sales(json_extract(data_json,'$.dist.item')) WHERE channel='线下分销';
CREATE TABLE distributor_refund_allocations (
 case_id TEXT NOT NULL REFERENCES after_sales(id),
 source_id TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('return','refund')),
 amount INTEGER NOT NULL CHECK(amount>0),
 PRIMARY KEY(case_id,kind,source_id)
);
CREATE INDEX idx_dist_refund_source ON distributor_refund_allocations(kind,source_id);
CREATE TRIGGER distributor_linked_refund_reverse BEFORE INSERT ON wholesale_finance_entries
WHEN NEW.kind='refund_void' AND EXISTS(SELECT 1 FROM distributor_refund_allocations WHERE kind='refund' AND source_id=NEW.reverses_id)
BEGIN SELECT RAISE(ABORT,'guard_unlink_distributor_refund_first'); END;
-- Units already exchanged retain their original recognized sale.
CREATE TRIGGER distributor_exchange_return_cap BEFORE INSERT ON wholesale_returns
WHEN NEW.qty + COALESCE((SELECT SUM(json_extract(data_json,'$.qty')) FROM after_sales
 WHERE channel='线下分销' AND json_extract(data_json,'$.dist.item')=NEW.order_item_id
 AND json_extract(data_json,'$.dist.kind')='exchange' AND json_extract(data_json,'$.dist.state') IN ('submitted','approved','completed')),0)
 > (SELECT shipped_qty-returned_qty FROM wholesale_order_items WHERE id=NEW.order_item_id)
BEGIN SELECT RAISE(ABORT,'guard_units_already_exchanged'); END;

CREATE TRIGGER maintenance_dist_allocations_insert BEFORE INSERT ON distributor_refund_allocations
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

CREATE TRIGGER maintenance_dist_allocations_update BEFORE UPDATE ON distributor_refund_allocations
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

CREATE TRIGGER maintenance_dist_allocations_delete BEFORE DELETE ON distributor_refund_allocations
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;
