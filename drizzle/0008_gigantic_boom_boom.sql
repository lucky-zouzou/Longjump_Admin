CREATE TABLE `wholesale_finance_clock` (
	`id` text PRIMARY KEY NOT NULL,
	`version` integer DEFAULT 0 NOT NULL
);

--> statement-breakpoint
CREATE TRIGGER guard_closed_wholesale_orders BEFORE INSERT ON wholesale_orders
WHEN substr(NEW.business_date,1,7)<=COALESCE((SELECT MAX(month) FROM wholesale_finance_periods WHERE status='closed'),'')
BEGIN SELECT RAISE(ABORT,'closed finance period: use an open correction date or reopen the period'); END;
--> statement-breakpoint
CREATE TRIGGER tick_finance_wholesale_orders AFTER INSERT ON wholesale_orders
BEGIN INSERT INTO wholesale_finance_clock(id,version) VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;

--> statement-breakpoint
CREATE TRIGGER guard_closed_wholesale_shipments BEFORE INSERT ON wholesale_shipments
WHEN substr(NEW.business_date,1,7)<=COALESCE((SELECT MAX(month) FROM wholesale_finance_periods WHERE status='closed'),'')
BEGIN SELECT RAISE(ABORT,'closed finance period: use an open correction date or reopen the period'); END;
--> statement-breakpoint
CREATE TRIGGER tick_finance_wholesale_shipments AFTER INSERT ON wholesale_shipments
BEGIN INSERT INTO wholesale_finance_clock(id,version) VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;

--> statement-breakpoint
CREATE TRIGGER guard_closed_wholesale_returns BEFORE INSERT ON wholesale_returns
WHEN substr(NEW.business_date,1,7)<=COALESCE((SELECT MAX(month) FROM wholesale_finance_periods WHERE status='closed'),'')
BEGIN SELECT RAISE(ABORT,'closed finance period: use an open correction date or reopen the period'); END;
--> statement-breakpoint
CREATE TRIGGER tick_finance_wholesale_returns AFTER INSERT ON wholesale_returns
BEGIN INSERT INTO wholesale_finance_clock(id,version) VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;

--> statement-breakpoint
CREATE TRIGGER guard_closed_wholesale_finance_entries BEFORE INSERT ON wholesale_finance_entries
WHEN substr(NEW.business_date,1,7)<=COALESCE((SELECT MAX(month) FROM wholesale_finance_periods WHERE status='closed'),'')
BEGIN SELECT RAISE(ABORT,'closed finance period: use an open correction date or reopen the period'); END;
--> statement-breakpoint
CREATE TRIGGER tick_finance_wholesale_finance_entries AFTER INSERT ON wholesale_finance_entries
BEGIN INSERT INTO wholesale_finance_clock(id,version) VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;

--> statement-breakpoint
CREATE TRIGGER guard_closed_wholesale_bank_receipts BEFORE INSERT ON wholesale_bank_receipts
WHEN substr(NEW.business_date,1,7)<=COALESCE((SELECT MAX(month) FROM wholesale_finance_periods WHERE status='closed'),'')
BEGIN SELECT RAISE(ABORT,'closed finance period: use an open correction date or reopen the period'); END;
--> statement-breakpoint
CREATE TRIGGER tick_finance_wholesale_bank_receipts AFTER INSERT ON wholesale_bank_receipts
BEGIN INSERT INTO wholesale_finance_clock(id,version) VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;

--> statement-breakpoint
CREATE TRIGGER guard_closed_wholesale_bank_events BEFORE INSERT ON wholesale_bank_events
WHEN substr(NEW.business_date,1,7)<=COALESCE((SELECT MAX(month) FROM wholesale_finance_periods WHERE status='closed'),'')
BEGIN SELECT RAISE(ABORT,'closed finance period: use an open correction date or reopen the period'); END;
--> statement-breakpoint
CREATE TRIGGER tick_finance_wholesale_bank_events AFTER INSERT ON wholesale_bank_events
BEGIN INSERT INTO wholesale_finance_clock(id,version) VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;

--> statement-breakpoint
CREATE TRIGGER immutable_wholesale_finance_entries_update BEFORE UPDATE ON wholesale_finance_entries
BEGIN SELECT RAISE(ABORT,'immutable business record: use a referenced correction'); END;

--> statement-breakpoint
CREATE TRIGGER immutable_wholesale_finance_entries_delete BEFORE DELETE ON wholesale_finance_entries
BEGIN SELECT RAISE(ABORT,'immutable business record: use a referenced correction'); END;

--> statement-breakpoint
CREATE TRIGGER immutable_wholesale_returns_update BEFORE UPDATE ON wholesale_returns
BEGIN SELECT RAISE(ABORT,'immutable business record: use a referenced correction'); END;

--> statement-breakpoint
CREATE TRIGGER immutable_wholesale_returns_delete BEFORE DELETE ON wholesale_returns
BEGIN SELECT RAISE(ABORT,'immutable business record: use a referenced correction'); END;

--> statement-breakpoint
CREATE TRIGGER immutable_wholesale_shipments_update BEFORE UPDATE ON wholesale_shipments
BEGIN SELECT RAISE(ABORT,'immutable business record: use a referenced correction'); END;

--> statement-breakpoint
CREATE TRIGGER immutable_wholesale_shipments_delete BEFORE DELETE ON wholesale_shipments
BEGIN SELECT RAISE(ABORT,'immutable business record: use a referenced correction'); END;

--> statement-breakpoint
CREATE TRIGGER immutable_wholesale_bank_events_update BEFORE UPDATE ON wholesale_bank_events
BEGIN SELECT RAISE(ABORT,'immutable business record: use a referenced correction'); END;

--> statement-breakpoint
CREATE TRIGGER immutable_wholesale_bank_events_delete BEFORE DELETE ON wholesale_bank_events
BEGIN SELECT RAISE(ABORT,'immutable business record: use a referenced correction'); END;

--> statement-breakpoint
CREATE TRIGGER immutable_inventory_movements_update BEFORE UPDATE ON inventory_movements
BEGIN SELECT RAISE(ABORT,'immutable business record: use a referenced correction'); END;

--> statement-breakpoint
CREATE TRIGGER immutable_inventory_movements_delete BEFORE DELETE ON inventory_movements
BEGIN SELECT RAISE(ABORT,'immutable business record: use a referenced correction'); END;

--> statement-breakpoint
CREATE TRIGGER immutable_audit_logs_update BEFORE UPDATE ON audit_logs
BEGIN SELECT RAISE(ABORT,'immutable business record: use a referenced correction'); END;

--> statement-breakpoint
CREATE TRIGGER immutable_audit_logs_delete BEFORE DELETE ON audit_logs
BEGIN SELECT RAISE(ABORT,'immutable business record: use a referenced correction'); END;

--> statement-breakpoint
CREATE TRIGGER bank_receipt_cross_reference BEFORE INSERT ON wholesale_bank_receipts
WHEN EXISTS(SELECT 1 FROM wholesale_finance_entries WHERE kind='receipt' AND bank_receipt_id IS NULL AND reference=NEW.reference)
BEGIN SELECT RAISE(ABORT,'UNIQUE bank receipt reference'); END;
--> statement-breakpoint
CREATE TRIGGER direct_receipt_cross_reference BEFORE INSERT ON wholesale_finance_entries
WHEN NEW.kind='receipt' AND NEW.bank_receipt_id IS NULL AND EXISTS(SELECT 1 FROM wholesale_bank_receipts WHERE reference=NEW.reference)
BEGIN SELECT RAISE(ABORT,'UNIQUE bank receipt reference'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_approval_requests_insert BEFORE INSERT ON approval_requests
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_approval_requests_update BEFORE UPDATE ON approval_requests
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_approval_requests_delete BEFORE DELETE ON approval_requests
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_audit_logs_insert BEFORE INSERT ON audit_logs
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_audit_logs_update BEFORE UPDATE ON audit_logs
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_audit_logs_delete BEFORE DELETE ON audit_logs
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_inbound_allocations_insert BEFORE INSERT ON inbound_allocations
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_inbound_allocations_update BEFORE UPDATE ON inbound_allocations
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_inbound_allocations_delete BEFORE DELETE ON inbound_allocations
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_inbound_receipts_insert BEFORE INSERT ON inbound_receipts
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_inbound_receipts_update BEFORE UPDATE ON inbound_receipts
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_inbound_receipts_delete BEFORE DELETE ON inbound_receipts
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_inventory_balances_insert BEFORE INSERT ON inventory_balances
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_inventory_balances_update BEFORE UPDATE ON inventory_balances
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_inventory_balances_delete BEFORE DELETE ON inventory_balances
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_inventory_movements_insert BEFORE INSERT ON inventory_movements
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_inventory_movements_update BEFORE UPDATE ON inventory_movements
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_inventory_movements_delete BEFORE DELETE ON inventory_movements
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_monthly_submissions_insert BEFORE INSERT ON monthly_submissions
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_monthly_submissions_update BEFORE UPDATE ON monthly_submissions
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_monthly_submissions_delete BEFORE DELETE ON monthly_submissions
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_production_batches_insert BEFORE INSERT ON production_batches
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_production_batches_update BEFORE UPDATE ON production_batches
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_production_batches_delete BEFORE DELETE ON production_batches
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_sales_imports_insert BEFORE INSERT ON sales_imports
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_sales_imports_update BEFORE UPDATE ON sales_imports
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_sales_imports_delete BEFORE DELETE ON sales_imports
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_sales_records_insert BEFORE INSERT ON sales_records
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_sales_records_update BEFORE UPDATE ON sales_records
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_sales_records_delete BEFORE DELETE ON sales_records
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_sku_settings_insert BEFORE INSERT ON sku_settings
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_sku_settings_update BEFORE UPDATE ON sku_settings
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_sku_settings_delete BEFORE DELETE ON sku_settings
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_users_insert BEFORE INSERT ON users
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_users_update BEFORE UPDATE ON users
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_users_delete BEFORE DELETE ON users
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_new_product_projects_insert BEFORE INSERT ON new_product_projects
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_new_product_projects_update BEFORE UPDATE ON new_product_projects
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_new_product_projects_delete BEFORE DELETE ON new_product_projects
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_new_product_stage_records_insert BEFORE INSERT ON new_product_stage_records
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_new_product_stage_records_update BEFORE UPDATE ON new_product_stage_records
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_new_product_stage_records_delete BEFORE DELETE ON new_product_stage_records
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_series_production_order_items_insert BEFORE INSERT ON series_production_order_items
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_series_production_order_items_update BEFORE UPDATE ON series_production_order_items
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_series_production_order_items_delete BEFORE DELETE ON series_production_order_items
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_series_production_orders_insert BEFORE INSERT ON series_production_orders
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_series_production_orders_update BEFORE UPDATE ON series_production_orders
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_series_production_orders_delete BEFORE DELETE ON series_production_orders
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_series_purchase_order_items_insert BEFORE INSERT ON series_purchase_order_items
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_series_purchase_order_items_update BEFORE UPDATE ON series_purchase_order_items
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_series_purchase_order_items_delete BEFORE DELETE ON series_purchase_order_items
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_series_purchase_orders_insert BEFORE INSERT ON series_purchase_orders
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_series_purchase_orders_update BEFORE UPDATE ON series_purchase_orders
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_series_purchase_orders_delete BEFORE DELETE ON series_purchase_orders
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_shipment_batch_items_insert BEFORE INSERT ON shipment_batch_items
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_shipment_batch_items_update BEFORE UPDATE ON shipment_batch_items
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_shipment_batch_items_delete BEFORE DELETE ON shipment_batch_items
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_shipment_batches_insert BEFORE INSERT ON shipment_batches
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_shipment_batches_update BEFORE UPDATE ON shipment_batches
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_shipment_batches_delete BEFORE DELETE ON shipment_batches
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_shipment_receipt_items_insert BEFORE INSERT ON shipment_receipt_items
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_shipment_receipt_items_update BEFORE UPDATE ON shipment_receipt_items
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_shipment_receipt_items_delete BEFORE DELETE ON shipment_receipt_items
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_shipment_receipts_insert BEFORE INSERT ON shipment_receipts
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_shipment_receipts_update BEFORE UPDATE ON shipment_receipts
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_shipment_receipts_delete BEFORE DELETE ON shipment_receipts
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_shipment_shelf_confirmations_insert BEFORE INSERT ON shipment_shelf_confirmations
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_shipment_shelf_confirmations_update BEFORE UPDATE ON shipment_shelf_confirmations
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_shipment_shelf_confirmations_delete BEFORE DELETE ON shipment_shelf_confirmations
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_business_partners_insert BEFORE INSERT ON business_partners
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_business_partners_update BEFORE UPDATE ON business_partners
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_business_partners_delete BEFORE DELETE ON business_partners
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_inventory_count_requests_insert BEFORE INSERT ON inventory_count_requests
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_inventory_count_requests_update BEFORE UPDATE ON inventory_count_requests
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_inventory_count_requests_delete BEFORE DELETE ON inventory_count_requests
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_transport_batch_items_insert BEFORE INSERT ON transport_batch_items
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_transport_batch_items_update BEFORE UPDATE ON transport_batch_items
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_transport_batch_items_delete BEFORE DELETE ON transport_batch_items
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_transport_batches_insert BEFORE INSERT ON transport_batches
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_transport_batches_update BEFORE UPDATE ON transport_batches
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_transport_batches_delete BEFORE DELETE ON transport_batches
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_transport_leg_items_insert BEFORE INSERT ON transport_leg_items
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_transport_leg_items_update BEFORE UPDATE ON transport_leg_items
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_transport_leg_items_delete BEFORE DELETE ON transport_leg_items
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_transport_legs_insert BEFORE INSERT ON transport_legs
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_transport_legs_update BEFORE UPDATE ON transport_legs
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_transport_legs_delete BEFORE DELETE ON transport_legs
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_transport_receipt_items_insert BEFORE INSERT ON transport_receipt_items
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_transport_receipt_items_update BEFORE UPDATE ON transport_receipt_items
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_transport_receipt_items_delete BEFORE DELETE ON transport_receipt_items
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_transport_receipts_insert BEFORE INSERT ON transport_receipts
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_transport_receipts_update BEFORE UPDATE ON transport_receipts
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_transport_receipts_delete BEFORE DELETE ON transport_receipts
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_transport_shelf_confirmations_insert BEFORE INSERT ON transport_shelf_confirmations
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_transport_shelf_confirmations_update BEFORE UPDATE ON transport_shelf_confirmations
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_transport_shelf_confirmations_delete BEFORE DELETE ON transport_shelf_confirmations
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_warehouses_insert BEFORE INSERT ON warehouses
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_warehouses_update BEFORE UPDATE ON warehouses
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_warehouses_delete BEFORE DELETE ON warehouses
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_wholesale_allocations_insert BEFORE INSERT ON wholesale_allocations
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_wholesale_allocations_update BEFORE UPDATE ON wholesale_allocations
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_wholesale_allocations_delete BEFORE DELETE ON wholesale_allocations
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_wholesale_customers_insert BEFORE INSERT ON wholesale_customers
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_wholesale_customers_update BEFORE UPDATE ON wholesale_customers
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_wholesale_customers_delete BEFORE DELETE ON wholesale_customers
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_wholesale_files_insert BEFORE INSERT ON wholesale_files
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_wholesale_files_update BEFORE UPDATE ON wholesale_files
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_wholesale_files_delete BEFORE DELETE ON wholesale_files
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_wholesale_finance_entries_insert BEFORE INSERT ON wholesale_finance_entries
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_wholesale_finance_entries_update BEFORE UPDATE ON wholesale_finance_entries
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_wholesale_finance_entries_delete BEFORE DELETE ON wholesale_finance_entries
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_wholesale_order_items_insert BEFORE INSERT ON wholesale_order_items
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_wholesale_order_items_update BEFORE UPDATE ON wholesale_order_items
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_wholesale_order_items_delete BEFORE DELETE ON wholesale_order_items
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_wholesale_orders_insert BEFORE INSERT ON wholesale_orders
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_wholesale_orders_update BEFORE UPDATE ON wholesale_orders
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_wholesale_orders_delete BEFORE DELETE ON wholesale_orders
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_wholesale_returns_insert BEFORE INSERT ON wholesale_returns
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_wholesale_returns_update BEFORE UPDATE ON wholesale_returns
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_wholesale_returns_delete BEFORE DELETE ON wholesale_returns
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_wholesale_shipment_items_insert BEFORE INSERT ON wholesale_shipment_items
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_wholesale_shipment_items_update BEFORE UPDATE ON wholesale_shipment_items
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_wholesale_shipment_items_delete BEFORE DELETE ON wholesale_shipment_items
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_wholesale_shipments_insert BEFORE INSERT ON wholesale_shipments
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_wholesale_shipments_update BEFORE UPDATE ON wholesale_shipments
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_wholesale_shipments_delete BEFORE DELETE ON wholesale_shipments
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_wholesale_bank_events_insert BEFORE INSERT ON wholesale_bank_events
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_wholesale_bank_events_update BEFORE UPDATE ON wholesale_bank_events
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_wholesale_bank_events_delete BEFORE DELETE ON wholesale_bank_events
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_wholesale_bank_receipts_insert BEFORE INSERT ON wholesale_bank_receipts
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_wholesale_bank_receipts_update BEFORE UPDATE ON wholesale_bank_receipts
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_wholesale_bank_receipts_delete BEFORE DELETE ON wholesale_bank_receipts
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_wholesale_finance_periods_insert BEFORE INSERT ON wholesale_finance_periods
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_wholesale_finance_periods_update BEFORE UPDATE ON wholesale_finance_periods
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_wholesale_finance_periods_delete BEFORE DELETE ON wholesale_finance_periods
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_forecast_snapshots_insert BEFORE INSERT ON forecast_snapshots
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_forecast_snapshots_update BEFORE UPDATE ON forecast_snapshots
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_forecast_snapshots_delete BEFORE DELETE ON forecast_snapshots
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_plan_changes_insert BEFORE INSERT ON plan_changes
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_plan_changes_update BEFORE UPDATE ON plan_changes
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_plan_changes_delete BEFORE DELETE ON plan_changes
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_wholesale_return_resolutions_insert BEFORE INSERT ON wholesale_return_resolutions
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_wholesale_return_resolutions_update BEFORE UPDATE ON wholesale_return_resolutions
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_wholesale_return_resolutions_delete BEFORE DELETE ON wholesale_return_resolutions
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_sales_demand_corrections_insert BEFORE INSERT ON sales_demand_corrections
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_sales_demand_corrections_update BEFORE UPDATE ON sales_demand_corrections
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_sales_demand_corrections_delete BEFORE DELETE ON sales_demand_corrections
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_supply_policies_insert BEFORE INSERT ON supply_policies
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_supply_policies_update BEFORE UPDATE ON supply_policies
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_supply_policies_delete BEFORE DELETE ON supply_policies
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_wholesale_finance_clock_insert BEFORE INSERT ON wholesale_finance_clock
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_wholesale_finance_clock_update BEFORE UPDATE ON wholesale_finance_clock
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_wholesale_finance_clock_delete BEFORE DELETE ON wholesale_finance_clock
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;
