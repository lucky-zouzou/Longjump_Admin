ALTER TABLE wholesale_orders ADD COLUMN sale_type text NOT NULL DEFAULT 'legacy' CHECK (sale_type IN ('legacy','consignment','cash','clearance_cash'));
--> statement-breakpoint
ALTER TABLE wholesale_orders ADD COLUMN business_code text NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE wholesale_order_items ADD COLUMN product_color text NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE wholesale_order_items ADD COLUMN product_size text NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE wholesale_returns ADD COLUMN consignment_sold_qty integer NOT NULL DEFAULT 0 CHECK (consignment_sold_qty>=0 AND consignment_sold_qty<=qty);
--> statement-breakpoint
CREATE TABLE wholesale_consignment_sales (
 id text PRIMARY KEY NOT NULL,
 order_id text NOT NULL REFERENCES wholesale_orders(id),
 order_item_id text NOT NULL REFERENCES wholesale_order_items(id),
 qty integer NOT NULL CHECK (qty<>0),
 amount integer NOT NULL CHECK (amount<>0 AND ((amount>0 AND qty>0) OR (amount<0 AND qty<0))),
 business_date text NOT NULL,
 reference text NOT NULL,
 note text NOT NULL,
 actor_id text NOT NULL,
 actor_name text NOT NULL,
 created_at text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX idx_wh_consignment_reference ON wholesale_consignment_sales(reference,order_item_id);
--> statement-breakpoint
CREATE INDEX idx_wh_consignment_order ON wholesale_consignment_sales(order_id,business_date);
--> statement-breakpoint
CREATE TRIGGER guard_closed_wholesale_consignment_sales BEFORE INSERT ON wholesale_consignment_sales
WHEN substr(NEW.business_date,1,7)<=COALESCE((SELECT MAX(month) FROM wholesale_finance_periods WHERE status='closed'),'')
BEGIN SELECT RAISE(ABORT,'closed finance period'); END;
--> statement-breakpoint
CREATE TRIGGER tick_finance_wholesale_consignment_sales AFTER INSERT ON wholesale_consignment_sales
BEGIN INSERT INTO wholesale_finance_clock(id,version) VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
--> statement-breakpoint
CREATE TRIGGER immutable_wholesale_consignment_sales_update BEFORE UPDATE ON wholesale_consignment_sales
BEGIN SELECT RAISE(ABORT,'immutable consignment sale'); END;
--> statement-breakpoint
CREATE TRIGGER immutable_wholesale_consignment_sales_delete BEFORE DELETE ON wholesale_consignment_sales
BEGIN SELECT RAISE(ABORT,'immutable consignment sale'); END;
--> statement-breakpoint
CREATE TRIGGER maintenance_wholesale_consignment_sales_insert BEFORE INSERT ON wholesale_consignment_sales
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;
--> statement-breakpoint
CREATE TRIGGER baseline_date_wholesale_consignment_sales_insert BEFORE INSERT ON wholesale_consignment_sales
WHEN NEW.business_date < COALESCE((SELECT CASE WHEN action='inventoryBaselineApply' THEN json_extract(detail_json,'$.startDate') ELSE '' END FROM audit_logs WHERE action IN ('inventoryBaselineApply','inventoryBaselineUndo') ORDER BY rowid DESC LIMIT 1),'')
BEGIN SELECT RAISE(ABORT,'inventory_baseline_date'); END;
