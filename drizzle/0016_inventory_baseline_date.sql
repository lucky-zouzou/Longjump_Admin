CREATE TRIGGER baseline_date_sales_imports_insert BEFORE INSERT ON sales_imports
WHEN NEW.business_date < COALESCE((SELECT CASE WHEN action='inventoryBaselineApply' THEN json_extract(detail_json,'$.startDate') ELSE '' END FROM audit_logs WHERE action IN ('inventoryBaselineApply','inventoryBaselineUndo') ORDER BY rowid DESC LIMIT 1),'')
BEGIN SELECT RAISE(ABORT,'inventory_baseline_date: historical business date precedes opening inventory'); END;
--> statement-breakpoint
CREATE TRIGGER baseline_date_sales_imports_update BEFORE UPDATE ON sales_imports
WHEN NEW.business_date < COALESCE((SELECT CASE WHEN action='inventoryBaselineApply' THEN json_extract(detail_json,'$.startDate') ELSE '' END FROM audit_logs WHERE action IN ('inventoryBaselineApply','inventoryBaselineUndo') ORDER BY rowid DESC LIMIT 1),'')
BEGIN SELECT RAISE(ABORT,'inventory_baseline_date: historical business date precedes opening inventory'); END;
--> statement-breakpoint
CREATE TRIGGER baseline_date_sales_records_insert BEFORE INSERT ON sales_records
WHEN NEW.business_date < COALESCE((SELECT CASE WHEN action='inventoryBaselineApply' THEN json_extract(detail_json,'$.startDate') ELSE '' END FROM audit_logs WHERE action IN ('inventoryBaselineApply','inventoryBaselineUndo') ORDER BY rowid DESC LIMIT 1),'')
BEGIN SELECT RAISE(ABORT,'inventory_baseline_date: historical business date precedes opening inventory'); END;
--> statement-breakpoint
CREATE TRIGGER baseline_date_sales_records_update BEFORE UPDATE ON sales_records
WHEN NEW.business_date < COALESCE((SELECT CASE WHEN action='inventoryBaselineApply' THEN json_extract(detail_json,'$.startDate') ELSE '' END FROM audit_logs WHERE action IN ('inventoryBaselineApply','inventoryBaselineUndo') ORDER BY rowid DESC LIMIT 1),'')
BEGIN SELECT RAISE(ABORT,'inventory_baseline_date: historical business date precedes opening inventory'); END;
--> statement-breakpoint
CREATE TRIGGER baseline_date_sales_ad_spend_insert BEFORE INSERT ON sales_ad_spend
WHEN NEW.business_date < COALESCE((SELECT CASE WHEN action='inventoryBaselineApply' THEN json_extract(detail_json,'$.startDate') ELSE '' END FROM audit_logs WHERE action IN ('inventoryBaselineApply','inventoryBaselineUndo') ORDER BY rowid DESC LIMIT 1),'')
BEGIN SELECT RAISE(ABORT,'inventory_baseline_date: historical business date precedes opening inventory'); END;
--> statement-breakpoint
CREATE TRIGGER baseline_date_sales_ad_spend_update BEFORE UPDATE ON sales_ad_spend
WHEN NEW.business_date < COALESCE((SELECT CASE WHEN action='inventoryBaselineApply' THEN json_extract(detail_json,'$.startDate') ELSE '' END FROM audit_logs WHERE action IN ('inventoryBaselineApply','inventoryBaselineUndo') ORDER BY rowid DESC LIMIT 1),'')
BEGIN SELECT RAISE(ABORT,'inventory_baseline_date: historical business date precedes opening inventory'); END;
--> statement-breakpoint
CREATE TRIGGER baseline_date_sales_demand_corrections_insert BEFORE INSERT ON sales_demand_corrections
WHEN NEW.business_date < COALESCE((SELECT CASE WHEN action='inventoryBaselineApply' THEN json_extract(detail_json,'$.startDate') ELSE '' END FROM audit_logs WHERE action IN ('inventoryBaselineApply','inventoryBaselineUndo') ORDER BY rowid DESC LIMIT 1),'')
BEGIN SELECT RAISE(ABORT,'inventory_baseline_date: historical business date precedes opening inventory'); END;
--> statement-breakpoint
CREATE TRIGGER baseline_date_sales_demand_corrections_update BEFORE UPDATE ON sales_demand_corrections
WHEN NEW.business_date < COALESCE((SELECT CASE WHEN action='inventoryBaselineApply' THEN json_extract(detail_json,'$.startDate') ELSE '' END FROM audit_logs WHERE action IN ('inventoryBaselineApply','inventoryBaselineUndo') ORDER BY rowid DESC LIMIT 1),'')
BEGIN SELECT RAISE(ABORT,'inventory_baseline_date: historical business date precedes opening inventory'); END;
--> statement-breakpoint
CREATE TRIGGER baseline_date_wholesale_orders_insert BEFORE INSERT ON wholesale_orders
WHEN NEW.business_date < COALESCE((SELECT CASE WHEN action='inventoryBaselineApply' THEN json_extract(detail_json,'$.startDate') ELSE '' END FROM audit_logs WHERE action IN ('inventoryBaselineApply','inventoryBaselineUndo') ORDER BY rowid DESC LIMIT 1),'')
BEGIN SELECT RAISE(ABORT,'inventory_baseline_date: historical business date precedes opening inventory'); END;
--> statement-breakpoint
CREATE TRIGGER baseline_date_wholesale_orders_update BEFORE UPDATE ON wholesale_orders
WHEN NEW.business_date < COALESCE((SELECT CASE WHEN action='inventoryBaselineApply' THEN json_extract(detail_json,'$.startDate') ELSE '' END FROM audit_logs WHERE action IN ('inventoryBaselineApply','inventoryBaselineUndo') ORDER BY rowid DESC LIMIT 1),'')
BEGIN SELECT RAISE(ABORT,'inventory_baseline_date: historical business date precedes opening inventory'); END;
--> statement-breakpoint
CREATE TRIGGER baseline_date_wholesale_shipments_insert BEFORE INSERT ON wholesale_shipments
WHEN NEW.business_date < COALESCE((SELECT CASE WHEN action='inventoryBaselineApply' THEN json_extract(detail_json,'$.startDate') ELSE '' END FROM audit_logs WHERE action IN ('inventoryBaselineApply','inventoryBaselineUndo') ORDER BY rowid DESC LIMIT 1),'')
BEGIN SELECT RAISE(ABORT,'inventory_baseline_date: historical business date precedes opening inventory'); END;
--> statement-breakpoint
CREATE TRIGGER baseline_date_wholesale_shipments_update BEFORE UPDATE ON wholesale_shipments
WHEN NEW.business_date < COALESCE((SELECT CASE WHEN action='inventoryBaselineApply' THEN json_extract(detail_json,'$.startDate') ELSE '' END FROM audit_logs WHERE action IN ('inventoryBaselineApply','inventoryBaselineUndo') ORDER BY rowid DESC LIMIT 1),'')
BEGIN SELECT RAISE(ABORT,'inventory_baseline_date: historical business date precedes opening inventory'); END;
--> statement-breakpoint
CREATE TRIGGER baseline_date_wholesale_finance_entries_insert BEFORE INSERT ON wholesale_finance_entries
WHEN NEW.business_date < COALESCE((SELECT CASE WHEN action='inventoryBaselineApply' THEN json_extract(detail_json,'$.startDate') ELSE '' END FROM audit_logs WHERE action IN ('inventoryBaselineApply','inventoryBaselineUndo') ORDER BY rowid DESC LIMIT 1),'')
BEGIN SELECT RAISE(ABORT,'inventory_baseline_date: historical business date precedes opening inventory'); END;
--> statement-breakpoint
CREATE TRIGGER baseline_date_wholesale_finance_entries_update BEFORE UPDATE ON wholesale_finance_entries
WHEN NEW.business_date < COALESCE((SELECT CASE WHEN action='inventoryBaselineApply' THEN json_extract(detail_json,'$.startDate') ELSE '' END FROM audit_logs WHERE action IN ('inventoryBaselineApply','inventoryBaselineUndo') ORDER BY rowid DESC LIMIT 1),'')
BEGIN SELECT RAISE(ABORT,'inventory_baseline_date: historical business date precedes opening inventory'); END;
--> statement-breakpoint
CREATE TRIGGER baseline_date_wholesale_returns_insert BEFORE INSERT ON wholesale_returns
WHEN NEW.business_date < COALESCE((SELECT CASE WHEN action='inventoryBaselineApply' THEN json_extract(detail_json,'$.startDate') ELSE '' END FROM audit_logs WHERE action IN ('inventoryBaselineApply','inventoryBaselineUndo') ORDER BY rowid DESC LIMIT 1),'')
BEGIN SELECT RAISE(ABORT,'inventory_baseline_date: historical business date precedes opening inventory'); END;
--> statement-breakpoint
CREATE TRIGGER baseline_date_wholesale_returns_update BEFORE UPDATE ON wholesale_returns
WHEN NEW.business_date < COALESCE((SELECT CASE WHEN action='inventoryBaselineApply' THEN json_extract(detail_json,'$.startDate') ELSE '' END FROM audit_logs WHERE action IN ('inventoryBaselineApply','inventoryBaselineUndo') ORDER BY rowid DESC LIMIT 1),'')
BEGIN SELECT RAISE(ABORT,'inventory_baseline_date: historical business date precedes opening inventory'); END;
--> statement-breakpoint
CREATE TRIGGER baseline_date_wholesale_bank_receipts_insert BEFORE INSERT ON wholesale_bank_receipts
WHEN NEW.business_date < COALESCE((SELECT CASE WHEN action='inventoryBaselineApply' THEN json_extract(detail_json,'$.startDate') ELSE '' END FROM audit_logs WHERE action IN ('inventoryBaselineApply','inventoryBaselineUndo') ORDER BY rowid DESC LIMIT 1),'')
BEGIN SELECT RAISE(ABORT,'inventory_baseline_date: historical business date precedes opening inventory'); END;
--> statement-breakpoint
CREATE TRIGGER baseline_date_wholesale_bank_receipts_update BEFORE UPDATE ON wholesale_bank_receipts
WHEN NEW.business_date < COALESCE((SELECT CASE WHEN action='inventoryBaselineApply' THEN json_extract(detail_json,'$.startDate') ELSE '' END FROM audit_logs WHERE action IN ('inventoryBaselineApply','inventoryBaselineUndo') ORDER BY rowid DESC LIMIT 1),'')
BEGIN SELECT RAISE(ABORT,'inventory_baseline_date: historical business date precedes opening inventory'); END;
--> statement-breakpoint
CREATE TRIGGER baseline_date_wholesale_bank_events_insert BEFORE INSERT ON wholesale_bank_events
WHEN NEW.business_date < COALESCE((SELECT CASE WHEN action='inventoryBaselineApply' THEN json_extract(detail_json,'$.startDate') ELSE '' END FROM audit_logs WHERE action IN ('inventoryBaselineApply','inventoryBaselineUndo') ORDER BY rowid DESC LIMIT 1),'')
BEGIN SELECT RAISE(ABORT,'inventory_baseline_date: historical business date precedes opening inventory'); END;
--> statement-breakpoint
CREATE TRIGGER baseline_date_wholesale_bank_events_update BEFORE UPDATE ON wholesale_bank_events
WHEN NEW.business_date < COALESCE((SELECT CASE WHEN action='inventoryBaselineApply' THEN json_extract(detail_json,'$.startDate') ELSE '' END FROM audit_logs WHERE action IN ('inventoryBaselineApply','inventoryBaselineUndo') ORDER BY rowid DESC LIMIT 1),'')
BEGIN SELECT RAISE(ABORT,'inventory_baseline_date: historical business date precedes opening inventory'); END;
