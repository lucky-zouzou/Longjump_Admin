CREATE TABLE wholesale_customer_receipts (
 id text PRIMARY KEY NOT NULL,
 order_id text NOT NULL REFERENCES wholesale_orders(id),
 shipment_id text NOT NULL REFERENCES wholesale_shipments(id),
 business_date text NOT NULL,
 receiver text NOT NULL,
 proof_ref text NOT NULL,
 note text NOT NULL DEFAULT '',
 actor_id text NOT NULL,
 actor_name text NOT NULL,
 created_at text NOT NULL,
 revoked_at text,
 revoked_by text,
 revoked_by_name text,
 revoke_reason text,
 CHECK (length(receiver)>0 AND length(proof_ref)>=4),
 CHECK ((revoked_at IS NULL AND revoked_by IS NULL AND revoked_by_name IS NULL AND revoke_reason IS NULL)
 OR (revoked_at IS NOT NULL AND revoked_by IS NOT NULL AND revoked_by_name IS NOT NULL AND revoke_reason IS NOT NULL AND length(revoke_reason)>=4))
);
--> statement-breakpoint
CREATE UNIQUE INDEX idx_wh_receipt_active ON wholesale_customer_receipts(shipment_id) WHERE revoked_at IS NULL;
--> statement-breakpoint
CREATE INDEX idx_wh_receipt_order ON wholesale_customer_receipts(order_id,created_at);
--> statement-breakpoint
CREATE TRIGGER guard_wh_receipt_insert BEFORE INSERT ON wholesale_customer_receipts
WHEN NOT EXISTS (SELECT 1 FROM wholesale_shipments s WHERE s.id=NEW.shipment_id AND s.order_id=NEW.order_id AND s.business_date<=NEW.business_date)
BEGIN SELECT RAISE(ABORT,'guard_wh_receipt_shipment'); END;
--> statement-breakpoint
CREATE TRIGGER immutable_wh_receipt BEFORE UPDATE ON wholesale_customer_receipts
WHEN OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL OR NEW.id<>OLD.id OR NEW.order_id<>OLD.order_id
 OR NEW.shipment_id<>OLD.shipment_id OR NEW.business_date<>OLD.business_date OR NEW.receiver<>OLD.receiver
 OR NEW.proof_ref<>OLD.proof_ref OR NEW.note<>OLD.note OR NEW.actor_id<>OLD.actor_id OR NEW.actor_name<>OLD.actor_name OR NEW.created_at<>OLD.created_at
BEGIN SELECT RAISE(ABORT,'immutable customer receipt'); END;
