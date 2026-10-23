CREATE TABLE business_actions (
 id TEXT PRIMARY KEY NOT NULL, site TEXT NOT NULL, channel TEXT NOT NULL, sku TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('loss','stockout','weakening')),
 status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','in_progress','review_pending','resolved')),
 owner_id TEXT, collaborators_json TEXT NOT NULL DEFAULT '[]', diagnosis_json TEXT NOT NULL DEFAULT '{}',
 snapshot_json TEXT NOT NULL, due_at TEXT NOT NULL, review_at TEXT NOT NULL,
 executed_at TEXT, executed_cutoff TEXT, resolved_at TEXT, reopen_count INTEGER NOT NULL DEFAULT 0, ever_active INTEGER NOT NULL DEFAULT 0,
 opened_at TEXT NOT NULL, updated_at TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1
);
--> statement-breakpoint
CREATE UNIQUE INDEX idx_business_actions_scope ON business_actions(site,channel,sku,kind);
--> statement-breakpoint
CREATE INDEX idx_business_actions_owner ON business_actions(owner_id,status,due_at);
--> statement-breakpoint
CREATE TABLE business_action_finance (
 id TEXT PRIMARY KEY NOT NULL, site TEXT NOT NULL, channel TEXT NOT NULL, sku TEXT NOT NULL,
 start_date TEXT NOT NULL, end_date TEXT NOT NULL, basis_hash TEXT NOT NULL, data_json TEXT NOT NULL,
 source TEXT NOT NULL, actor_id TEXT NOT NULL, created_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX idx_business_action_finance_scope ON business_action_finance(site,channel,sku,start_date,end_date);
--> statement-breakpoint
CREATE TABLE business_action_events (
 id TEXT PRIMARY KEY NOT NULL, action_id TEXT NOT NULL REFERENCES business_actions(id),
 event TEXT NOT NULL, actor_id TEXT NOT NULL, actor_name TEXT NOT NULL, detail_json TEXT NOT NULL, created_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX idx_business_action_events ON business_action_events(action_id,created_at);
--> statement-breakpoint
CREATE TABLE business_action_source_clock (id TEXT PRIMARY KEY NOT NULL CHECK(id='global'),version INTEGER NOT NULL DEFAULT 1);
--> statement-breakpoint
CREATE TRIGGER maintenance_business_actions_insert BEFORE INSERT ON business_actions
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
--> statement-breakpoint
CREATE TRIGGER maintenance_business_actions_update BEFORE UPDATE ON business_actions
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
--> statement-breakpoint
CREATE TRIGGER maintenance_business_actions_delete BEFORE DELETE ON business_actions
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
--> statement-breakpoint
CREATE TRIGGER maintenance_business_action_finance_insert BEFORE INSERT ON business_action_finance
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
--> statement-breakpoint
CREATE TRIGGER maintenance_business_action_finance_update BEFORE UPDATE ON business_action_finance
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
--> statement-breakpoint
CREATE TRIGGER maintenance_business_action_finance_delete BEFORE DELETE ON business_action_finance
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
--> statement-breakpoint
CREATE TRIGGER maintenance_business_action_events_insert BEFORE INSERT ON business_action_events
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
--> statement-breakpoint
CREATE TRIGGER maintenance_business_action_events_update BEFORE UPDATE ON business_action_events
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
--> statement-breakpoint
CREATE TRIGGER maintenance_business_action_events_delete BEFORE DELETE ON business_action_events
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
--> statement-breakpoint
CREATE TRIGGER action_clock_sales_records_insert AFTER INSERT ON sales_records
BEGIN INSERT INTO business_action_source_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
--> statement-breakpoint
CREATE TRIGGER action_clock_sales_records_update AFTER UPDATE ON sales_records
BEGIN INSERT INTO business_action_source_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
--> statement-breakpoint
CREATE TRIGGER action_clock_sales_records_delete AFTER DELETE ON sales_records
BEGIN INSERT INTO business_action_source_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
--> statement-breakpoint
CREATE TRIGGER action_clock_sales_imports_insert AFTER INSERT ON sales_imports
BEGIN INSERT INTO business_action_source_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
--> statement-breakpoint
CREATE TRIGGER action_clock_sales_imports_update AFTER UPDATE ON sales_imports
BEGIN INSERT INTO business_action_source_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
--> statement-breakpoint
CREATE TRIGGER action_clock_sales_imports_delete AFTER DELETE ON sales_imports
BEGIN INSERT INTO business_action_source_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
--> statement-breakpoint
CREATE TRIGGER action_clock_sales_ad_spend_insert AFTER INSERT ON sales_ad_spend
BEGIN INSERT INTO business_action_source_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
--> statement-breakpoint
CREATE TRIGGER action_clock_sales_ad_spend_update AFTER UPDATE ON sales_ad_spend
BEGIN INSERT INTO business_action_source_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
--> statement-breakpoint
CREATE TRIGGER action_clock_sales_ad_spend_delete AFTER DELETE ON sales_ad_spend
BEGIN INSERT INTO business_action_source_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
--> statement-breakpoint
CREATE TRIGGER action_clock_inventory_balances_insert AFTER INSERT ON inventory_balances
BEGIN INSERT INTO business_action_source_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
--> statement-breakpoint
CREATE TRIGGER action_clock_inventory_balances_update AFTER UPDATE ON inventory_balances
BEGIN INSERT INTO business_action_source_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
--> statement-breakpoint
CREATE TRIGGER action_clock_inventory_balances_delete AFTER DELETE ON inventory_balances
BEGIN INSERT INTO business_action_source_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
--> statement-breakpoint
CREATE TRIGGER action_clock_sku_settings_insert AFTER INSERT ON sku_settings
BEGIN INSERT INTO business_action_source_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
--> statement-breakpoint
CREATE TRIGGER action_clock_sku_settings_update AFTER UPDATE ON sku_settings
BEGIN INSERT INTO business_action_source_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
--> statement-breakpoint
CREATE TRIGGER action_clock_sku_settings_delete AFTER DELETE ON sku_settings
BEGIN INSERT INTO business_action_source_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
--> statement-breakpoint
CREATE TRIGGER action_clock_supply_policies_insert AFTER INSERT ON supply_policies
BEGIN INSERT INTO business_action_source_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
--> statement-breakpoint
CREATE TRIGGER action_clock_supply_policies_update AFTER UPDATE ON supply_policies
BEGIN INSERT INTO business_action_source_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
--> statement-breakpoint
CREATE TRIGGER action_clock_supply_policies_delete AFTER DELETE ON supply_policies
BEGIN INSERT INTO business_action_source_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
--> statement-breakpoint
CREATE TRIGGER action_clock_sales_demand_corrections_insert AFTER INSERT ON sales_demand_corrections
BEGIN INSERT INTO business_action_source_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
--> statement-breakpoint
CREATE TRIGGER action_clock_sales_demand_corrections_update AFTER UPDATE ON sales_demand_corrections
BEGIN INSERT INTO business_action_source_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
--> statement-breakpoint
CREATE TRIGGER action_clock_sales_demand_corrections_delete AFTER DELETE ON sales_demand_corrections
BEGIN INSERT INTO business_action_source_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
--> statement-breakpoint
CREATE TRIGGER action_clock_promotion_availability_insert AFTER INSERT ON promotion_availability
BEGIN INSERT INTO business_action_source_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
--> statement-breakpoint
CREATE TRIGGER action_clock_promotion_availability_update AFTER UPDATE ON promotion_availability
BEGIN INSERT INTO business_action_source_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
--> statement-breakpoint
CREATE TRIGGER action_clock_promotion_availability_delete AFTER DELETE ON promotion_availability
BEGIN INSERT INTO business_action_source_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
--> statement-breakpoint
CREATE TRIGGER action_clock_promotion_stock_days_insert AFTER INSERT ON promotion_stock_days
BEGIN INSERT INTO business_action_source_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
--> statement-breakpoint
CREATE TRIGGER action_clock_promotion_stock_days_update AFTER UPDATE ON promotion_stock_days
BEGIN INSERT INTO business_action_source_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
--> statement-breakpoint
CREATE TRIGGER action_clock_promotion_stock_days_delete AFTER DELETE ON promotion_stock_days
BEGIN INSERT INTO business_action_source_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
--> statement-breakpoint
CREATE TRIGGER action_clock_production_batches_insert AFTER INSERT ON production_batches
BEGIN INSERT INTO business_action_source_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
--> statement-breakpoint
CREATE TRIGGER action_clock_production_batches_update AFTER UPDATE ON production_batches
BEGIN INSERT INTO business_action_source_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
--> statement-breakpoint
CREATE TRIGGER action_clock_production_batches_delete AFTER DELETE ON production_batches
BEGIN INSERT INTO business_action_source_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
--> statement-breakpoint
CREATE TRIGGER action_clock_series_production_orders_insert AFTER INSERT ON series_production_orders
BEGIN INSERT INTO business_action_source_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
--> statement-breakpoint
CREATE TRIGGER action_clock_series_production_orders_update AFTER UPDATE ON series_production_orders
BEGIN INSERT INTO business_action_source_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
--> statement-breakpoint
CREATE TRIGGER action_clock_series_production_orders_delete AFTER DELETE ON series_production_orders
BEGIN INSERT INTO business_action_source_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
--> statement-breakpoint
CREATE TRIGGER action_clock_series_production_order_items_insert AFTER INSERT ON series_production_order_items
BEGIN INSERT INTO business_action_source_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
--> statement-breakpoint
CREATE TRIGGER action_clock_series_production_order_items_update AFTER UPDATE ON series_production_order_items
BEGIN INSERT INTO business_action_source_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
--> statement-breakpoint
CREATE TRIGGER action_clock_series_production_order_items_delete AFTER DELETE ON series_production_order_items
BEGIN INSERT INTO business_action_source_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
--> statement-breakpoint
CREATE TRIGGER action_clock_series_purchase_order_items_insert AFTER INSERT ON series_purchase_order_items
BEGIN INSERT INTO business_action_source_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
--> statement-breakpoint
CREATE TRIGGER action_clock_series_purchase_order_items_update AFTER UPDATE ON series_purchase_order_items
BEGIN INSERT INTO business_action_source_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
--> statement-breakpoint
CREATE TRIGGER action_clock_series_purchase_order_items_delete AFTER DELETE ON series_purchase_order_items
BEGIN INSERT INTO business_action_source_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
--> statement-breakpoint
CREATE TRIGGER action_clock_shipment_batches_insert AFTER INSERT ON shipment_batches
BEGIN INSERT INTO business_action_source_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
--> statement-breakpoint
CREATE TRIGGER action_clock_shipment_batches_update AFTER UPDATE ON shipment_batches
BEGIN INSERT INTO business_action_source_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
--> statement-breakpoint
CREATE TRIGGER action_clock_shipment_batches_delete AFTER DELETE ON shipment_batches
BEGIN INSERT INTO business_action_source_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
--> statement-breakpoint
CREATE TRIGGER action_clock_shipment_batch_items_insert AFTER INSERT ON shipment_batch_items
BEGIN INSERT INTO business_action_source_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
--> statement-breakpoint
CREATE TRIGGER action_clock_shipment_batch_items_update AFTER UPDATE ON shipment_batch_items
BEGIN INSERT INTO business_action_source_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
--> statement-breakpoint
CREATE TRIGGER action_clock_shipment_batch_items_delete AFTER DELETE ON shipment_batch_items
BEGIN INSERT INTO business_action_source_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
--> statement-breakpoint
CREATE TRIGGER action_clock_transport_legs_insert AFTER INSERT ON transport_legs
BEGIN INSERT INTO business_action_source_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
--> statement-breakpoint
CREATE TRIGGER action_clock_transport_legs_update AFTER UPDATE ON transport_legs
BEGIN INSERT INTO business_action_source_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
--> statement-breakpoint
CREATE TRIGGER action_clock_transport_legs_delete AFTER DELETE ON transport_legs
BEGIN INSERT INTO business_action_source_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
--> statement-breakpoint
CREATE TRIGGER action_clock_transport_batch_items_insert AFTER INSERT ON transport_batch_items
BEGIN INSERT INTO business_action_source_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
--> statement-breakpoint
CREATE TRIGGER action_clock_transport_batch_items_update AFTER UPDATE ON transport_batch_items
BEGIN INSERT INTO business_action_source_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
--> statement-breakpoint
CREATE TRIGGER action_clock_transport_batch_items_delete AFTER DELETE ON transport_batch_items
BEGIN INSERT INTO business_action_source_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
--> statement-breakpoint
CREATE TRIGGER action_clock_transport_leg_items_insert AFTER INSERT ON transport_leg_items
BEGIN INSERT INTO business_action_source_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
--> statement-breakpoint
CREATE TRIGGER action_clock_transport_leg_items_update AFTER UPDATE ON transport_leg_items
BEGIN INSERT INTO business_action_source_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
--> statement-breakpoint
CREATE TRIGGER action_clock_transport_leg_items_delete AFTER DELETE ON transport_leg_items
BEGIN INSERT INTO business_action_source_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
--> statement-breakpoint
CREATE TRIGGER action_clock_after_sales_insert AFTER INSERT ON after_sales
BEGIN INSERT INTO business_action_source_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
--> statement-breakpoint
CREATE TRIGGER action_clock_after_sales_update AFTER UPDATE ON after_sales
BEGIN INSERT INTO business_action_source_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
--> statement-breakpoint
CREATE TRIGGER action_clock_after_sales_delete AFTER DELETE ON after_sales
BEGIN INSERT INTO business_action_source_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
--> statement-breakpoint
CREATE TRIGGER action_clock_sales_fx_snapshots_insert AFTER INSERT ON sales_fx_snapshots
BEGIN INSERT INTO business_action_source_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
--> statement-breakpoint
CREATE TRIGGER action_clock_sales_fx_snapshots_update AFTER UPDATE ON sales_fx_snapshots
BEGIN INSERT INTO business_action_source_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
--> statement-breakpoint
CREATE TRIGGER action_clock_sales_fx_snapshots_delete AFTER DELETE ON sales_fx_snapshots
BEGIN INSERT INTO business_action_source_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
--> statement-breakpoint
CREATE TRIGGER action_clock_business_action_finance_insert AFTER INSERT ON business_action_finance
BEGIN INSERT INTO business_action_source_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
--> statement-breakpoint
CREATE TRIGGER action_clock_business_action_finance_update AFTER UPDATE ON business_action_finance
BEGIN INSERT INTO business_action_source_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
--> statement-breakpoint
CREATE TRIGGER action_clock_business_action_finance_delete AFTER DELETE ON business_action_finance
BEGIN INSERT INTO business_action_source_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
--> statement-breakpoint
CREATE TRIGGER action_clock_wholesale_shipments_insert AFTER INSERT ON wholesale_shipments
BEGIN INSERT INTO business_action_source_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
--> statement-breakpoint
CREATE TRIGGER action_clock_wholesale_shipments_update AFTER UPDATE ON wholesale_shipments
BEGIN INSERT INTO business_action_source_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
--> statement-breakpoint
CREATE TRIGGER action_clock_wholesale_shipments_delete AFTER DELETE ON wholesale_shipments
BEGIN INSERT INTO business_action_source_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
--> statement-breakpoint
CREATE TRIGGER action_clock_wholesale_shipment_items_insert AFTER INSERT ON wholesale_shipment_items
BEGIN INSERT INTO business_action_source_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
--> statement-breakpoint
CREATE TRIGGER action_clock_wholesale_shipment_items_update AFTER UPDATE ON wholesale_shipment_items
BEGIN INSERT INTO business_action_source_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
--> statement-breakpoint
CREATE TRIGGER action_clock_wholesale_shipment_items_delete AFTER DELETE ON wholesale_shipment_items
BEGIN INSERT INTO business_action_source_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
--> statement-breakpoint
CREATE TRIGGER action_clock_wholesale_returns_insert AFTER INSERT ON wholesale_returns
BEGIN INSERT INTO business_action_source_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
--> statement-breakpoint
CREATE TRIGGER action_clock_wholesale_returns_update AFTER UPDATE ON wholesale_returns
BEGIN INSERT INTO business_action_source_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
--> statement-breakpoint
CREATE TRIGGER action_clock_wholesale_returns_delete AFTER DELETE ON wholesale_returns
BEGIN INSERT INTO business_action_source_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
