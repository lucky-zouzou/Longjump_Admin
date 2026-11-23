-- Keep the originally approved purchase document immutable. Effective quantity
-- revisions are separate, approved records on the same physical production order.
ALTER TABLE series_purchase_orders ADD quantity_document_json TEXT;
CREATE TABLE purchase_quantity_changes (
 id TEXT PRIMARY KEY NOT NULL,
 purchase_order_id TEXT NOT NULL REFERENCES series_purchase_orders(id),
 production_order_id TEXT NOT NULL REFERENCES series_production_orders(id),
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','withdrawn')),
 creator_id TEXT NOT NULL REFERENCES users(id),
 reason TEXT NOT NULL,
 before_json TEXT NOT NULL,
 after_json TEXT NOT NULL,
 version INTEGER NOT NULL DEFAULT 1,
 reviewer_id TEXT REFERENCES users(id),
 review_reason TEXT NOT NULL DEFAULT '',
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX one_pending_purchase_quantity ON purchase_quantity_changes(purchase_order_id) WHERE status='pending';
CREATE INDEX purchase_quantity_status ON purchase_quantity_changes(status,created_at);
CREATE TRIGGER immutable_purchase_quantity_change BEFORE UPDATE ON purchase_quantity_changes
WHEN OLD.status<>'pending' OR NEW.before_json<>OLD.before_json OR NEW.after_json<>OLD.after_json
 OR NEW.creator_id<>OLD.creator_id OR NEW.purchase_order_id<>OLD.purchase_order_id
 OR NEW.production_order_id<>OLD.production_order_id OR NEW.reason<>OLD.reason
 OR (NEW.status IN ('approved','rejected') AND (NEW.reviewer_id IS NULL OR NEW.reviewer_id=OLD.creator_id))
BEGIN SELECT RAISE(ABORT,'immutable_purchase_quantity_change'); END;
CREATE TRIGGER immutable_purchase_quantity_delete BEFORE DELETE ON purchase_quantity_changes
BEGIN SELECT RAISE(ABORT,'immutable_purchase_quantity_change'); END;
