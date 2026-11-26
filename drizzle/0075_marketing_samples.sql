-- Marketing sample fulfillment posts inventory and actual costs, never sales/receivables.
CREATE TABLE marketing_sample_orders (
 id TEXT PRIMARY KEY, order_no TEXT NOT NULL UNIQUE, round_id TEXT NOT NULL REFERENCES creator_rounds(id),
 creator_id TEXT NOT NULL REFERENCES creator_profiles(id), scope_id TEXT NOT NULL REFERENCES creator_scopes(id),
 site TEXT NOT NULL DEFAULT '印尼' CHECK(site='印尼'), channel TEXT NOT NULL DEFAULT 'TikTok' CHECK(channel='TikTok'),
 applicant_id TEXT NOT NULL REFERENCES users(id), status TEXT NOT NULL CHECK(status IN ('pending','approved','assigned','partial','shipped','received','rejected','cancelled','closed')),
 agreement_ref TEXT NOT NULL, signed_on TEXT NOT NULL, recipient_json TEXT NOT NULL, terms_json TEXT NOT NULL,
 reviewer_id TEXT REFERENCES users(id), logistics_user_id TEXT REFERENCES users(id), warehouse_user_id TEXT REFERENCES users(id), warehouse_id TEXT REFERENCES warehouses(id),
 approved_at TEXT, assigned_at TEXT, version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX marketing_sample_active_round ON marketing_sample_orders(round_id) WHERE status NOT IN ('rejected','cancelled');
CREATE TABLE marketing_sample_items (
 id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES marketing_sample_orders(id), sku TEXT NOT NULL REFERENCES sku_settings(sku),
 qty INTEGER NOT NULL CHECK(qty>0), shipped_qty INTEGER NOT NULL DEFAULT 0 CHECK(shipped_qty>=0), released_qty INTEGER NOT NULL DEFAULT 0 CHECK(released_qty>=0),
 UNIQUE(order_id,sku), CHECK(shipped_qty+released_qty<=qty)
);
CREATE TABLE marketing_sample_shipments (
 id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES marketing_sample_orders(id), shipment_no TEXT NOT NULL UNIQUE,
 business_date TEXT NOT NULL, shipped_at TEXT NOT NULL, carrier TEXT NOT NULL, tracking_no TEXT NOT NULL,
 warehouse_id TEXT NOT NULL REFERENCES warehouses(id), warehouse_name TEXT NOT NULL, actor_id TEXT NOT NULL REFERENCES users(id),
 items_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE marketing_sample_receipts (
 id TEXT PRIMARY KEY, shipment_id TEXT NOT NULL UNIQUE REFERENCES marketing_sample_shipments(id), order_id TEXT NOT NULL REFERENCES marketing_sample_orders(id),
 received_at TEXT NOT NULL, receiver TEXT NOT NULL, proof_ref TEXT NOT NULL, actor_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL
);
CREATE TABLE marketing_sample_costs (
 id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES marketing_sample_orders(id), shipment_id TEXT NOT NULL REFERENCES marketing_sample_shipments(id),
 kind TEXT NOT NULL CHECK(kind IN ('sample','freight')), revision INTEGER NOT NULL CHECK(revision>0), business_date TEXT NOT NULL,
 currency TEXT NOT NULL, amount_minor INTEGER NOT NULL CHECK(amount_minor>=0), source_ref TEXT NOT NULL, evidence TEXT NOT NULL,
 data_json TEXT NOT NULL, actor_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL,
 UNIQUE(shipment_id,kind,revision)
);
CREATE TABLE marketing_sample_cost_sources (
 source_ref TEXT PRIMARY KEY, shipment_id TEXT NOT NULL REFERENCES marketing_sample_shipments(id), kind TEXT NOT NULL CHECK(kind IN ('sample','freight'))
);
CREATE TABLE marketing_sample_files (
 id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES marketing_sample_orders(id), shipment_id TEXT NOT NULL REFERENCES marketing_sample_shipments(id),
 filename TEXT NOT NULL, mime TEXT NOT NULL, payload TEXT NOT NULL, actor_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL
);
CREATE TABLE marketing_sample_events (
 id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES marketing_sample_orders(id), action TEXT NOT NULL, detail_json TEXT NOT NULL,
 actor_id TEXT NOT NULL REFERENCES users(id), actor_name TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX marketing_sample_ship_date ON marketing_sample_shipments(business_date,order_id);
CREATE INDEX marketing_sample_cost_date ON marketing_sample_costs(business_date,shipment_id);
CREATE TRIGGER maintenance_marketing_sample_orders_insert BEFORE INSERT ON marketing_sample_orders WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER maintenance_marketing_sample_orders_update BEFORE UPDATE ON marketing_sample_orders WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER maintenance_marketing_sample_orders_delete BEFORE DELETE ON marketing_sample_orders WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER clock_marketing_sample_orders_insert AFTER INSERT ON marketing_sample_orders BEGIN INSERT INTO creator_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
CREATE TRIGGER clock_marketing_sample_orders_update AFTER UPDATE ON marketing_sample_orders BEGIN INSERT INTO creator_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
CREATE TRIGGER clock_marketing_sample_orders_delete AFTER DELETE ON marketing_sample_orders BEGIN INSERT INTO creator_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
CREATE TRIGGER maintenance_marketing_sample_items_insert BEFORE INSERT ON marketing_sample_items WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER maintenance_marketing_sample_items_update BEFORE UPDATE ON marketing_sample_items WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER maintenance_marketing_sample_items_delete BEFORE DELETE ON marketing_sample_items WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER clock_marketing_sample_items_insert AFTER INSERT ON marketing_sample_items BEGIN INSERT INTO creator_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
CREATE TRIGGER clock_marketing_sample_items_update AFTER UPDATE ON marketing_sample_items BEGIN INSERT INTO creator_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
CREATE TRIGGER clock_marketing_sample_items_delete AFTER DELETE ON marketing_sample_items BEGIN INSERT INTO creator_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
CREATE TRIGGER maintenance_marketing_sample_shipments_insert BEFORE INSERT ON marketing_sample_shipments WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER maintenance_marketing_sample_shipments_update BEFORE UPDATE ON marketing_sample_shipments WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER maintenance_marketing_sample_shipments_delete BEFORE DELETE ON marketing_sample_shipments WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER immutable_marketing_sample_shipments_update BEFORE UPDATE ON marketing_sample_shipments BEGIN SELECT RAISE(ABORT,'immutable marketing sample history'); END;
CREATE TRIGGER immutable_marketing_sample_shipments_delete BEFORE DELETE ON marketing_sample_shipments BEGIN SELECT RAISE(ABORT,'immutable marketing sample history'); END;
CREATE TRIGGER clock_marketing_sample_shipments_insert AFTER INSERT ON marketing_sample_shipments BEGIN INSERT INTO creator_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
CREATE TRIGGER clock_marketing_sample_shipments_update AFTER UPDATE ON marketing_sample_shipments BEGIN INSERT INTO creator_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
CREATE TRIGGER clock_marketing_sample_shipments_delete AFTER DELETE ON marketing_sample_shipments BEGIN INSERT INTO creator_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
CREATE TRIGGER maintenance_marketing_sample_receipts_insert BEFORE INSERT ON marketing_sample_receipts WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER maintenance_marketing_sample_receipts_update BEFORE UPDATE ON marketing_sample_receipts WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER maintenance_marketing_sample_receipts_delete BEFORE DELETE ON marketing_sample_receipts WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER immutable_marketing_sample_receipts_update BEFORE UPDATE ON marketing_sample_receipts BEGIN SELECT RAISE(ABORT,'immutable marketing sample history'); END;
CREATE TRIGGER immutable_marketing_sample_receipts_delete BEFORE DELETE ON marketing_sample_receipts BEGIN SELECT RAISE(ABORT,'immutable marketing sample history'); END;
CREATE TRIGGER clock_marketing_sample_receipts_insert AFTER INSERT ON marketing_sample_receipts BEGIN INSERT INTO creator_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
CREATE TRIGGER clock_marketing_sample_receipts_update AFTER UPDATE ON marketing_sample_receipts BEGIN INSERT INTO creator_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
CREATE TRIGGER clock_marketing_sample_receipts_delete AFTER DELETE ON marketing_sample_receipts BEGIN INSERT INTO creator_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
CREATE TRIGGER maintenance_marketing_sample_costs_insert BEFORE INSERT ON marketing_sample_costs WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER maintenance_marketing_sample_costs_update BEFORE UPDATE ON marketing_sample_costs WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER maintenance_marketing_sample_costs_delete BEFORE DELETE ON marketing_sample_costs WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER immutable_marketing_sample_costs_update BEFORE UPDATE ON marketing_sample_costs BEGIN SELECT RAISE(ABORT,'immutable marketing sample history'); END;
CREATE TRIGGER immutable_marketing_sample_costs_delete BEFORE DELETE ON marketing_sample_costs BEGIN SELECT RAISE(ABORT,'immutable marketing sample history'); END;
CREATE TRIGGER clock_marketing_sample_costs_insert AFTER INSERT ON marketing_sample_costs BEGIN INSERT INTO creator_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
CREATE TRIGGER clock_marketing_sample_costs_update AFTER UPDATE ON marketing_sample_costs BEGIN INSERT INTO creator_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
CREATE TRIGGER clock_marketing_sample_costs_delete AFTER DELETE ON marketing_sample_costs BEGIN INSERT INTO creator_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
CREATE TRIGGER maintenance_marketing_sample_cost_sources_insert BEFORE INSERT ON marketing_sample_cost_sources WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER maintenance_marketing_sample_cost_sources_update BEFORE UPDATE ON marketing_sample_cost_sources WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER maintenance_marketing_sample_cost_sources_delete BEFORE DELETE ON marketing_sample_cost_sources WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER immutable_marketing_sample_cost_sources_update BEFORE UPDATE ON marketing_sample_cost_sources BEGIN SELECT RAISE(ABORT,'immutable marketing sample history'); END;
CREATE TRIGGER immutable_marketing_sample_cost_sources_delete BEFORE DELETE ON marketing_sample_cost_sources BEGIN SELECT RAISE(ABORT,'immutable marketing sample history'); END;
CREATE TRIGGER clock_marketing_sample_cost_sources_insert AFTER INSERT ON marketing_sample_cost_sources BEGIN INSERT INTO creator_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
CREATE TRIGGER clock_marketing_sample_cost_sources_update AFTER UPDATE ON marketing_sample_cost_sources BEGIN INSERT INTO creator_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
CREATE TRIGGER clock_marketing_sample_cost_sources_delete AFTER DELETE ON marketing_sample_cost_sources BEGIN INSERT INTO creator_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
CREATE TRIGGER maintenance_marketing_sample_files_insert BEFORE INSERT ON marketing_sample_files WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER maintenance_marketing_sample_files_update BEFORE UPDATE ON marketing_sample_files WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER maintenance_marketing_sample_files_delete BEFORE DELETE ON marketing_sample_files WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER immutable_marketing_sample_files_update BEFORE UPDATE ON marketing_sample_files BEGIN SELECT RAISE(ABORT,'immutable marketing sample history'); END;
CREATE TRIGGER immutable_marketing_sample_files_delete BEFORE DELETE ON marketing_sample_files BEGIN SELECT RAISE(ABORT,'immutable marketing sample history'); END;
CREATE TRIGGER clock_marketing_sample_files_insert AFTER INSERT ON marketing_sample_files BEGIN INSERT INTO creator_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
CREATE TRIGGER clock_marketing_sample_files_update AFTER UPDATE ON marketing_sample_files BEGIN INSERT INTO creator_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
CREATE TRIGGER clock_marketing_sample_files_delete AFTER DELETE ON marketing_sample_files BEGIN INSERT INTO creator_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
CREATE TRIGGER maintenance_marketing_sample_events_insert BEFORE INSERT ON marketing_sample_events WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER maintenance_marketing_sample_events_update BEFORE UPDATE ON marketing_sample_events WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER maintenance_marketing_sample_events_delete BEFORE DELETE ON marketing_sample_events WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER immutable_marketing_sample_events_update BEFORE UPDATE ON marketing_sample_events BEGIN SELECT RAISE(ABORT,'immutable marketing sample history'); END;
CREATE TRIGGER immutable_marketing_sample_events_delete BEFORE DELETE ON marketing_sample_events BEGIN SELECT RAISE(ABORT,'immutable marketing sample history'); END;
CREATE TRIGGER clock_marketing_sample_events_insert AFTER INSERT ON marketing_sample_events BEGIN INSERT INTO creator_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
CREATE TRIGGER clock_marketing_sample_events_update AFTER UPDATE ON marketing_sample_events BEGIN INSERT INTO creator_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
CREATE TRIGGER clock_marketing_sample_events_delete AFTER DELETE ON marketing_sample_events BEGIN INSERT INTO creator_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
CREATE TRIGGER finance_marketing_sample_shipments_insert AFTER INSERT ON marketing_sample_shipments BEGIN INSERT INTO finance_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
CREATE TRIGGER period_marketing_sample_shipments_insert BEFORE INSERT ON marketing_sample_shipments WHEN EXISTS(SELECT 1 FROM finance_period_events p WHERE p.revision=(SELECT MAX(x.revision) FROM finance_period_events x WHERE x.month=p.month) AND p.status='closed' AND substr(NEW.business_date,1,7)<=p.month) BEGIN SELECT RAISE(ABORT,'closed finance period'); END;
CREATE TRIGGER finance_marketing_sample_costs_insert AFTER INSERT ON marketing_sample_costs BEGIN INSERT INTO finance_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
CREATE TRIGGER period_marketing_sample_costs_insert BEFORE INSERT ON marketing_sample_costs WHEN EXISTS(SELECT 1 FROM finance_period_events p WHERE p.revision=(SELECT MAX(x.revision) FROM finance_period_events x WHERE x.month=p.month) AND p.status='closed' AND substr(NEW.business_date,1,7)<=p.month) BEGIN SELECT RAISE(ABORT,'closed finance period'); END;
CREATE INDEX marketing_sample_ship_order ON marketing_sample_shipments(order_id);
CREATE INDEX marketing_sample_receipt_order ON marketing_sample_receipts(order_id);
CREATE INDEX marketing_sample_cost_order ON marketing_sample_costs(order_id);
CREATE INDEX marketing_sample_event_order ON marketing_sample_events(order_id,created_at);
CREATE INDEX marketing_sample_file_order ON marketing_sample_files(order_id,shipment_id);
