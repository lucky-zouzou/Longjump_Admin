-- Existing orders retain version 1. Every new application uses version 2.
ALTER TABLE wholesale_customers ADD COLUMN company_short_name TEXT NOT NULL DEFAULT '';
ALTER TABLE wholesale_orders ADD COLUMN workflow_version INTEGER NOT NULL DEFAULT 1 CHECK(workflow_version IN (1,2));
ALTER TABLE wholesale_orders ADD COLUMN logistics_user_id TEXT REFERENCES users(id);
ALTER TABLE wholesale_orders ADD COLUMN warehouse_user_id TEXT REFERENCES users(id);
CREATE TABLE wholesale_workflows (
 order_id TEXT PRIMARY KEY REFERENCES wholesale_orders(id),
 settlement_mode TEXT NOT NULL CHECK(settlement_mode IN ('prepaid','credit','consignment')),
 contract_reference TEXT NOT NULL DEFAULT '',
 reservation_expires_at TEXT,
 customer_confirmed_at TEXT, customer_confirmed_by TEXT, customer_confirmation_ref TEXT NOT NULL DEFAULT '',
 warehouse TEXT NOT NULL DEFAULT '', packed_at TEXT, packed_by TEXT, pack_proof_json TEXT NOT NULL DEFAULT '[]',
 returned_reason TEXT NOT NULL DEFAULT '', returned_at TEXT,
 original_order_id TEXT UNIQUE REFERENCES wholesale_orders(id), replacement_order_id TEXT UNIQUE REFERENCES wholesale_orders(id),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE wholesale_release_instructions (
 id TEXT PRIMARY KEY, order_id TEXT NOT NULL UNIQUE REFERENCES wholesale_orders(id),
 instruction_no TEXT NOT NULL UNIQUE, issued_at TEXT NOT NULL, issued_by TEXT NOT NULL,
 basis_json TEXT NOT NULL, items_json TEXT NOT NULL
);
CREATE INDEX wholesale_workflow_expiry ON wholesale_workflows(reservation_expires_at);
CREATE INDEX wholesale_orders_logistics ON wholesale_orders(logistics_user_id,status);
CREATE INDEX wholesale_orders_warehouse ON wholesale_orders(warehouse_user_id,status);
CREATE TRIGGER wholesale_release_immutable_update BEFORE UPDATE ON wholesale_release_instructions BEGIN SELECT RAISE(ABORT,'immutable wholesale release instruction'); END;
CREATE TRIGGER wholesale_release_immutable_delete BEFORE DELETE ON wholesale_release_instructions BEGIN SELECT RAISE(ABORT,'immutable wholesale release instruction'); END;

CREATE TRIGGER maintenance_wholesale_workflows_insert BEFORE INSERT ON wholesale_workflows WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;

CREATE TRIGGER maintenance_wholesale_workflows_update BEFORE UPDATE ON wholesale_workflows WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;

CREATE TRIGGER maintenance_wholesale_workflows_delete BEFORE DELETE ON wholesale_workflows WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER clock_wholesale_workflows_insert AFTER INSERT ON wholesale_workflows BEGIN INSERT INTO wholesale_finance_clock(id,version) VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;

CREATE TRIGGER maintenance_wholesale_release_instructions_insert BEFORE INSERT ON wholesale_release_instructions WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;

CREATE TRIGGER maintenance_wholesale_release_instructions_update BEFORE UPDATE ON wholesale_release_instructions WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;

CREATE TRIGGER maintenance_wholesale_release_instructions_delete BEFORE DELETE ON wholesale_release_instructions WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER clock_wholesale_release_instructions_insert AFTER INSERT ON wholesale_release_instructions BEGIN INSERT INTO wholesale_finance_clock(id,version) VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
CREATE TRIGGER clock_wholesale_workflows_update AFTER UPDATE ON wholesale_workflows BEGIN INSERT INTO wholesale_finance_clock(id,version) VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
