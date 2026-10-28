CREATE TABLE wholesale_prices (
 id TEXT PRIMARY KEY NOT NULL,
 sku TEXT NOT NULL REFERENCES sku_settings(sku),
 version INTEGER NOT NULL CHECK(version > 0),
 status TEXT NOT NULL CHECK(status IN ('published','withdrawn')),
 purchase_minor INTEGER NOT NULL CHECK(purchase_minor >= 0),
 freight_minor INTEGER NOT NULL CHECK(freight_minor >= 0),
 tax_minor INTEGER NOT NULL CHECK(tax_minor >= 0),
 inbound_minor INTEGER NOT NULL CHECK(inbound_minor >= 0),
 standard_markup_bp INTEGER NOT NULL CHECK(standard_markup_bp >= 0),
 minimum_markup_bp INTEGER NOT NULL CHECK(minimum_markup_bp >= 0),
 rounding INTEGER NOT NULL CHECK(rounding IN (1,100,500,1000)),
 standard_price INTEGER NOT NULL CHECK(standard_price > 0),
 minimum_price INTEGER NOT NULL CHECK(minimum_price > 0 AND minimum_price <= standard_price),
 valid_until TEXT NOT NULL,
 cost_reference TEXT NOT NULL,
 reason TEXT NOT NULL,
 actor_id TEXT NOT NULL,
 actor_name TEXT NOT NULL,
 created_at TEXT NOT NULL,
 UNIQUE(sku,version)
);
CREATE TRIGGER wholesale_prices_no_update BEFORE UPDATE ON wholesale_prices BEGIN SELECT RAISE(ABORT,'immutable wholesale price'); END;
CREATE TRIGGER wholesale_prices_no_delete BEFORE DELETE ON wholesale_prices BEGIN SELECT RAISE(ABORT,'immutable wholesale price'); END;
ALTER TABLE wholesale_orders ADD COLUMN pricing_policy_version INTEGER NOT NULL DEFAULT 0;
CREATE TABLE wholesale_price_snapshots (
 id TEXT PRIMARY KEY NOT NULL,
 order_id TEXT NOT NULL REFERENCES wholesale_orders(id),
 item_id TEXT NOT NULL REFERENCES wholesale_order_items(id),
 phase TEXT NOT NULL CHECK(phase IN ('request','approval')),
 sku TEXT NOT NULL,
 price_version INTEGER NOT NULL,
 standard_price INTEGER,
 minimum_price INTEGER,
 unit_price INTEGER NOT NULL,
 status TEXT NOT NULL,
 reason TEXT NOT NULL DEFAULT '',
 actor_id TEXT NOT NULL,
 created_at TEXT NOT NULL,
 UNIQUE(item_id,phase)
);
CREATE TRIGGER wholesale_price_snapshots_no_update BEFORE UPDATE ON wholesale_price_snapshots BEGIN SELECT RAISE(ABORT,'immutable price snapshot'); END;
CREATE TRIGGER immutable_wholesale_price_snapshots_delete BEFORE DELETE ON wholesale_price_snapshots BEGIN SELECT RAISE(ABORT,'immutable price snapshot'); END;
CREATE TABLE wholesale_price_requests (
 id TEXT PRIMARY KEY NOT NULL,
 customer_id TEXT NOT NULL REFERENCES wholesale_customers(id),
 sales_user_id TEXT NOT NULL,
 sku TEXT NOT NULL REFERENCES sku_settings(sku),
 qty INTEGER NOT NULL CHECK(qty > 0),
 requested_price INTEGER NOT NULL CHECK(requested_price > 0),
 requested_reason TEXT NOT NULL,
 source_version INTEGER NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
 approved_price INTEGER,
 valid_until TEXT,
 decision_reason TEXT,
 decided_by TEXT,
 decided_at TEXT,
 used_order_id TEXT REFERENCES wholesale_orders(id),
 version INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL
);
CREATE INDEX idx_wholesale_price_requests_owner ON wholesale_price_requests(sales_user_id,status);
ALTER TABLE wholesale_order_items ADD COLUMN price_request_id TEXT REFERENCES wholesale_price_requests(id);

CREATE TRIGGER maintenance_wholesale_prices_insert BEFORE INSERT ON wholesale_prices
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;

CREATE TRIGGER maintenance_wholesale_prices_update BEFORE UPDATE ON wholesale_prices
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;

CREATE TRIGGER maintenance_wholesale_prices_delete BEFORE DELETE ON wholesale_prices
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;

CREATE TRIGGER maintenance_wholesale_price_snapshots_insert BEFORE INSERT ON wholesale_price_snapshots
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;

CREATE TRIGGER maintenance_wholesale_price_snapshots_update BEFORE UPDATE ON wholesale_price_snapshots
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;

CREATE TRIGGER maintenance_wholesale_price_snapshots_delete BEFORE DELETE ON wholesale_price_snapshots
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;

CREATE TRIGGER maintenance_wholesale_price_requests_insert BEFORE INSERT ON wholesale_price_requests
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;

CREATE TRIGGER maintenance_wholesale_price_requests_update BEFORE UPDATE ON wholesale_price_requests
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;

CREATE TRIGGER maintenance_wholesale_price_requests_delete BEFORE DELETE ON wholesale_price_requests
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
