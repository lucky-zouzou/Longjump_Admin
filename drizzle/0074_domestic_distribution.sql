-- Domestic factory-direct distribution is separate from Indonesia / overseas inventory.
CREATE TABLE domestic_customers (
 id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, company_name TEXT NOT NULL, company_short_name TEXT NOT NULL,
 contact TEXT NOT NULL, phone TEXT NOT NULL, address TEXT NOT NULL, supply_user_id TEXT NOT NULL REFERENCES users(id),
 country TEXT NOT NULL DEFAULT 'CN' CHECK(country='CN'), active INTEGER NOT NULL DEFAULT 1 CHECK(active IN(0,1)),
 version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE domestic_orders (
 id TEXT PRIMARY KEY, order_no TEXT NOT NULL UNIQUE, customer_id TEXT NOT NULL REFERENCES domestic_customers(id), customer_json TEXT NOT NULL,
 business_date TEXT NOT NULL, supply_user_id TEXT NOT NULL REFERENCES users(id), factory_user_id TEXT REFERENCES users(id), creator_id TEXT NOT NULL REFERENCES users(id),
 country TEXT NOT NULL DEFAULT 'CN' CHECK(country='CN'), currency TEXT NOT NULL DEFAULT 'CNY' CHECK(currency='CNY'),
 status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN('draft','quoted','contract_pending','approved','rejected','cancelled')),
 settlement_mode TEXT NOT NULL DEFAULT 'prepaid' CHECK(settlement_mode IN('prepaid','deposit','credit','consignment')),
 due_date TEXT, release_amount_minor INTEGER NOT NULL DEFAULT 0 CHECK(release_amount_minor>=0),
 total_qty INTEGER NOT NULL CHECK(total_qty>0), total_minor INTEGER NOT NULL CHECK(total_minor>0 AND total_minor<=1000000000000),
 quote_proof_id TEXT, contract_proof_id TEXT, contract_number TEXT, contract_terms TEXT NOT NULL DEFAULT '',
 reviewer_id TEXT REFERENCES users(id), reviewed_at TEXT, review_reason TEXT,
 release_by TEXT REFERENCES users(id), released_at TEXT, release_reason TEXT,
 note TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX domestic_orders_scope ON domestic_orders(supply_user_id,factory_user_id,status);
CREATE TABLE domestic_order_items (
 id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES domestic_orders(id), sku TEXT NOT NULL REFERENCES sku_settings(sku), name TEXT NOT NULL,
 qty INTEGER NOT NULL CHECK(qty>0), unit_minor INTEGER NOT NULL CHECK(unit_minor>0),
 packed_qty INTEGER NOT NULL DEFAULT 0, shipped_qty INTEGER NOT NULL DEFAULT 0, received_qty INTEGER NOT NULL DEFAULT 0, sold_qty INTEGER NOT NULL DEFAULT 0,
 CHECK(packed_qty BETWEEN 0 AND qty), CHECK(shipped_qty BETWEEN 0 AND packed_qty), CHECK(received_qty BETWEEN 0 AND shipped_qty), CHECK(sold_qty BETWEEN 0 AND received_qty), UNIQUE(order_id,sku)
);
CREATE TABLE domestic_order_versions (
 id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES domestic_orders(id), order_version INTEGER NOT NULL, snapshot_json TEXT NOT NULL,
 action TEXT NOT NULL, reason TEXT NOT NULL, actor_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL
);
CREATE TABLE domestic_files (
 id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES domestic_orders(id), purpose TEXT NOT NULL CHECK(purpose IN('quote','contract','source','packing','shipment','receipt','finance')),
 order_version INTEGER NOT NULL, object_key TEXT NOT NULL UNIQUE, name TEXT NOT NULL, content_type TEXT NOT NULL, size INTEGER NOT NULL CHECK(size>0), actor_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL
);
CREATE TABLE domestic_packs (
 id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES domestic_orders(id), source_no TEXT NOT NULL UNIQUE,
 source_kind TEXT NOT NULL DEFAULT 'domestic_factory_direct' CHECK(source_kind='domestic_factory_direct'),
 source_proof_id TEXT NOT NULL REFERENCES domestic_files(id), proof_id TEXT NOT NULL REFERENCES domestic_files(id), business_date TEXT NOT NULL,
 actor_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL
);
CREATE TABLE domestic_pack_lines (
 id TEXT PRIMARY KEY, pack_id TEXT NOT NULL REFERENCES domestic_packs(id), item_id TEXT NOT NULL REFERENCES domestic_order_items(id),
 qty INTEGER NOT NULL CHECK(qty>0), shipped_qty INTEGER NOT NULL DEFAULT 0 CHECK(shipped_qty>=0 AND shipped_qty<=qty), UNIQUE(pack_id,item_id)
);
CREATE TABLE domestic_shipments (
 id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES domestic_orders(id), shipment_no TEXT NOT NULL UNIQUE, business_date TEXT NOT NULL,
 carrier TEXT NOT NULL, tracking_no TEXT NOT NULL, proof_id TEXT NOT NULL REFERENCES domestic_files(id), release_by TEXT NOT NULL REFERENCES users(id),
 actor_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL
);
CREATE TABLE domestic_shipment_lines (
 id TEXT PRIMARY KEY, shipment_id TEXT NOT NULL REFERENCES domestic_shipments(id), pack_line_id TEXT NOT NULL REFERENCES domestic_pack_lines(id), item_id TEXT NOT NULL REFERENCES domestic_order_items(id),
 qty INTEGER NOT NULL CHECK(qty>0), received_qty INTEGER NOT NULL DEFAULT 0 CHECK(received_qty>=0 AND received_qty<=qty), UNIQUE(shipment_id,pack_line_id)
);
CREATE TABLE domestic_receipts (
 id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES domestic_orders(id), shipment_id TEXT NOT NULL REFERENCES domestic_shipments(id),
 business_date TEXT NOT NULL, receiver TEXT NOT NULL, proof_id TEXT NOT NULL REFERENCES domestic_files(id), actor_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL
);
CREATE TABLE domestic_receipt_lines (
 id TEXT PRIMARY KEY, receipt_id TEXT NOT NULL REFERENCES domestic_receipts(id), shipment_line_id TEXT NOT NULL REFERENCES domestic_shipment_lines(id), qty INTEGER NOT NULL CHECK(qty>0), UNIQUE(receipt_id,shipment_line_id)
);
CREATE TABLE domestic_consignment_sales (
 id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES domestic_orders(id), item_id TEXT NOT NULL REFERENCES domestic_order_items(id), qty INTEGER NOT NULL CHECK(qty>0), amount_minor INTEGER NOT NULL CHECK(amount_minor>0),
 business_date TEXT NOT NULL, proof_id TEXT NOT NULL REFERENCES domestic_files(id), actor_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL
);
CREATE TABLE domestic_finance_entries (
 id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES domestic_orders(id), kind TEXT NOT NULL CHECK(kind IN('receipt','receipt_reverse','refund','refund_reverse')),
 amount_minor INTEGER NOT NULL CHECK(amount_minor>0 AND amount_minor<=1000000000000), currency TEXT NOT NULL DEFAULT 'CNY' CHECK(currency='CNY'),
 business_date TEXT NOT NULL, bank_reference TEXT NOT NULL UNIQUE, bank_account TEXT NOT NULL, related_id TEXT REFERENCES domestic_finance_entries(id),
 proof_id TEXT NOT NULL REFERENCES domestic_files(id), reason TEXT NOT NULL, actor_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX domestic_finance_reversal_once ON domestic_finance_entries(related_id) WHERE related_id IS NOT NULL;
CREATE TABLE domestic_operations (
 id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, action TEXT NOT NULL, actor_id TEXT NOT NULL REFERENCES users(id), request_json TEXT NOT NULL,
 guard INTEGER NOT NULL CHECK(guard=1), created_at TEXT NOT NULL
);
CREATE TRIGGER guard_maintenance_domestic_customers_insert BEFORE INSERT ON domestic_customers WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER guard_maintenance_domestic_customers_update BEFORE UPDATE ON domestic_customers WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER guard_maintenance_domestic_customers_delete BEFORE DELETE ON domestic_customers WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER guard_maintenance_domestic_orders_insert BEFORE INSERT ON domestic_orders WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER guard_maintenance_domestic_orders_update BEFORE UPDATE ON domestic_orders WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER guard_maintenance_domestic_orders_delete BEFORE DELETE ON domestic_orders WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER guard_maintenance_domestic_order_items_insert BEFORE INSERT ON domestic_order_items WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER guard_maintenance_domestic_order_items_update BEFORE UPDATE ON domestic_order_items WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER guard_maintenance_domestic_order_items_delete BEFORE DELETE ON domestic_order_items WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER guard_maintenance_domestic_order_versions_insert BEFORE INSERT ON domestic_order_versions WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER guard_maintenance_domestic_order_versions_update BEFORE UPDATE ON domestic_order_versions WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER guard_maintenance_domestic_order_versions_delete BEFORE DELETE ON domestic_order_versions WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER guard_maintenance_domestic_files_insert BEFORE INSERT ON domestic_files WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER guard_maintenance_domestic_files_update BEFORE UPDATE ON domestic_files WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER guard_maintenance_domestic_files_delete BEFORE DELETE ON domestic_files WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER guard_maintenance_domestic_packs_insert BEFORE INSERT ON domestic_packs WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER guard_maintenance_domestic_packs_update BEFORE UPDATE ON domestic_packs WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER guard_maintenance_domestic_packs_delete BEFORE DELETE ON domestic_packs WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER guard_maintenance_domestic_pack_lines_insert BEFORE INSERT ON domestic_pack_lines WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER guard_maintenance_domestic_pack_lines_update BEFORE UPDATE ON domestic_pack_lines WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER guard_maintenance_domestic_pack_lines_delete BEFORE DELETE ON domestic_pack_lines WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER guard_maintenance_domestic_shipments_insert BEFORE INSERT ON domestic_shipments WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER guard_maintenance_domestic_shipments_update BEFORE UPDATE ON domestic_shipments WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER guard_maintenance_domestic_shipments_delete BEFORE DELETE ON domestic_shipments WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER guard_maintenance_domestic_shipment_lines_insert BEFORE INSERT ON domestic_shipment_lines WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER guard_maintenance_domestic_shipment_lines_update BEFORE UPDATE ON domestic_shipment_lines WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER guard_maintenance_domestic_shipment_lines_delete BEFORE DELETE ON domestic_shipment_lines WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER guard_maintenance_domestic_receipts_insert BEFORE INSERT ON domestic_receipts WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER guard_maintenance_domestic_receipts_update BEFORE UPDATE ON domestic_receipts WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER guard_maintenance_domestic_receipts_delete BEFORE DELETE ON domestic_receipts WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER guard_maintenance_domestic_receipt_lines_insert BEFORE INSERT ON domestic_receipt_lines WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER guard_maintenance_domestic_receipt_lines_update BEFORE UPDATE ON domestic_receipt_lines WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER guard_maintenance_domestic_receipt_lines_delete BEFORE DELETE ON domestic_receipt_lines WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER guard_maintenance_domestic_consignment_sales_insert BEFORE INSERT ON domestic_consignment_sales WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER guard_maintenance_domestic_consignment_sales_update BEFORE UPDATE ON domestic_consignment_sales WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER guard_maintenance_domestic_consignment_sales_delete BEFORE DELETE ON domestic_consignment_sales WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER guard_maintenance_domestic_finance_entries_insert BEFORE INSERT ON domestic_finance_entries WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER guard_maintenance_domestic_finance_entries_update BEFORE UPDATE ON domestic_finance_entries WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER guard_maintenance_domestic_finance_entries_delete BEFORE DELETE ON domestic_finance_entries WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER guard_maintenance_domestic_operations_insert BEFORE INSERT ON domestic_operations WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER guard_maintenance_domestic_operations_update BEFORE UPDATE ON domestic_operations WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER guard_maintenance_domestic_operations_delete BEFORE DELETE ON domestic_operations WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER immutable_domestic_order_versions_update BEFORE UPDATE ON domestic_order_versions BEGIN SELECT RAISE(ABORT,'immutable_domestic_fact'); END;
CREATE TRIGGER immutable_domestic_order_versions_delete BEFORE DELETE ON domestic_order_versions BEGIN SELECT RAISE(ABORT,'immutable_domestic_fact'); END;
CREATE TRIGGER immutable_domestic_packs_update BEFORE UPDATE ON domestic_packs BEGIN SELECT RAISE(ABORT,'immutable_domestic_fact'); END;
CREATE TRIGGER immutable_domestic_packs_delete BEFORE DELETE ON domestic_packs BEGIN SELECT RAISE(ABORT,'immutable_domestic_fact'); END;
CREATE TRIGGER immutable_domestic_shipments_update BEFORE UPDATE ON domestic_shipments BEGIN SELECT RAISE(ABORT,'immutable_domestic_fact'); END;
CREATE TRIGGER immutable_domestic_shipments_delete BEFORE DELETE ON domestic_shipments BEGIN SELECT RAISE(ABORT,'immutable_domestic_fact'); END;
CREATE TRIGGER immutable_domestic_receipts_update BEFORE UPDATE ON domestic_receipts BEGIN SELECT RAISE(ABORT,'immutable_domestic_fact'); END;
CREATE TRIGGER immutable_domestic_receipts_delete BEFORE DELETE ON domestic_receipts BEGIN SELECT RAISE(ABORT,'immutable_domestic_fact'); END;
CREATE TRIGGER immutable_domestic_receipt_lines_update BEFORE UPDATE ON domestic_receipt_lines BEGIN SELECT RAISE(ABORT,'immutable_domestic_fact'); END;
CREATE TRIGGER immutable_domestic_receipt_lines_delete BEFORE DELETE ON domestic_receipt_lines BEGIN SELECT RAISE(ABORT,'immutable_domestic_fact'); END;
CREATE TRIGGER immutable_domestic_consignment_sales_update BEFORE UPDATE ON domestic_consignment_sales BEGIN SELECT RAISE(ABORT,'immutable_domestic_fact'); END;
CREATE TRIGGER immutable_domestic_consignment_sales_delete BEFORE DELETE ON domestic_consignment_sales BEGIN SELECT RAISE(ABORT,'immutable_domestic_fact'); END;
CREATE TRIGGER immutable_domestic_finance_entries_update BEFORE UPDATE ON domestic_finance_entries BEGIN SELECT RAISE(ABORT,'immutable_domestic_fact'); END;
CREATE TRIGGER immutable_domestic_finance_entries_delete BEFORE DELETE ON domestic_finance_entries BEGIN SELECT RAISE(ABORT,'immutable_domestic_fact'); END;
CREATE TRIGGER immutable_domestic_operations_update BEFORE UPDATE ON domestic_operations BEGIN SELECT RAISE(ABORT,'immutable_domestic_fact'); END;
CREATE TRIGGER immutable_domestic_operations_delete BEFORE DELETE ON domestic_operations BEGIN SELECT RAISE(ABORT,'immutable_domestic_fact'); END;
CREATE TRIGGER immutable_domestic_files_update BEFORE UPDATE ON domestic_files BEGIN SELECT RAISE(ABORT,'immutable_domestic_fact'); END;
CREATE TRIGGER immutable_domestic_files_delete BEFORE DELETE ON domestic_files BEGIN SELECT RAISE(ABORT,'immutable_domestic_fact'); END;
CREATE INDEX domestic_versions_order ON domestic_order_versions(order_id,created_at);
CREATE INDEX domestic_files_order ON domestic_files(order_id,purpose);
CREATE INDEX domestic_packs_order ON domestic_packs(order_id);
CREATE INDEX domestic_shipments_order ON domestic_shipments(order_id);
CREATE INDEX domestic_receipts_order ON domestic_receipts(order_id,business_date);
CREATE INDEX domestic_sales_order ON domestic_consignment_sales(order_id,business_date);
CREATE INDEX domestic_finance_order ON domestic_finance_entries(order_id,business_date);
CREATE INDEX domestic_customers_owner ON domestic_customers(supply_user_id);

-- Central period close and snapshot clock cover the domestic subledger as well.
CREATE TRIGGER finance_domestic_orders_insert AFTER INSERT ON domestic_orders BEGIN INSERT INTO finance_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
CREATE TRIGGER finance_domestic_orders_update AFTER UPDATE ON domestic_orders BEGIN INSERT INTO finance_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
CREATE TRIGGER finance_domestic_orders_delete AFTER DELETE ON domestic_orders BEGIN INSERT INTO finance_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
CREATE TRIGGER finance_domestic_order_items_insert AFTER INSERT ON domestic_order_items BEGIN INSERT INTO finance_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
CREATE TRIGGER finance_domestic_order_items_update AFTER UPDATE ON domestic_order_items BEGIN INSERT INTO finance_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
CREATE TRIGGER finance_domestic_order_items_delete AFTER DELETE ON domestic_order_items BEGIN INSERT INTO finance_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
CREATE TRIGGER finance_domestic_order_versions_insert AFTER INSERT ON domestic_order_versions BEGIN INSERT INTO finance_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
CREATE TRIGGER finance_domestic_order_versions_update AFTER UPDATE ON domestic_order_versions BEGIN INSERT INTO finance_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
CREATE TRIGGER finance_domestic_order_versions_delete AFTER DELETE ON domestic_order_versions BEGIN INSERT INTO finance_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
CREATE TRIGGER finance_domestic_finance_entries_insert AFTER INSERT ON domestic_finance_entries BEGIN INSERT INTO finance_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
CREATE TRIGGER finance_domestic_finance_entries_update AFTER UPDATE ON domestic_finance_entries BEGIN INSERT INTO finance_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
CREATE TRIGGER finance_domestic_finance_entries_delete AFTER DELETE ON domestic_finance_entries BEGIN INSERT INTO finance_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
CREATE TRIGGER finance_domestic_shipments_insert AFTER INSERT ON domestic_shipments BEGIN INSERT INTO finance_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
CREATE TRIGGER finance_domestic_shipments_update AFTER UPDATE ON domestic_shipments BEGIN INSERT INTO finance_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
CREATE TRIGGER finance_domestic_shipments_delete AFTER DELETE ON domestic_shipments BEGIN INSERT INTO finance_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
CREATE TRIGGER finance_domestic_shipment_lines_insert AFTER INSERT ON domestic_shipment_lines BEGIN INSERT INTO finance_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
CREATE TRIGGER finance_domestic_shipment_lines_update AFTER UPDATE ON domestic_shipment_lines BEGIN INSERT INTO finance_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
CREATE TRIGGER finance_domestic_shipment_lines_delete AFTER DELETE ON domestic_shipment_lines BEGIN INSERT INTO finance_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
CREATE TRIGGER finance_domestic_consignment_sales_insert AFTER INSERT ON domestic_consignment_sales BEGIN INSERT INTO finance_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
CREATE TRIGGER finance_domestic_consignment_sales_update AFTER UPDATE ON domestic_consignment_sales BEGIN INSERT INTO finance_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
CREATE TRIGGER finance_domestic_consignment_sales_delete AFTER DELETE ON domestic_consignment_sales BEGIN INSERT INTO finance_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
CREATE TRIGGER period_domestic_finance_entries_insert BEFORE INSERT ON domestic_finance_entries WHEN EXISTS(SELECT 1 FROM finance_period_events p WHERE p.revision=(SELECT MAX(x.revision) FROM finance_period_events x WHERE x.month=p.month) AND p.status='closed' AND substr(NEW.business_date,1,7)<=p.month) BEGIN SELECT RAISE(ABORT,'closed finance period'); END;
CREATE TRIGGER period_domestic_shipments_insert BEFORE INSERT ON domestic_shipments WHEN EXISTS(SELECT 1 FROM finance_period_events p WHERE p.revision=(SELECT MAX(x.revision) FROM finance_period_events x WHERE x.month=p.month) AND p.status='closed' AND substr(NEW.business_date,1,7)<=p.month) BEGIN SELECT RAISE(ABORT,'closed finance period'); END;
CREATE TRIGGER period_domestic_consignment_sales_insert BEFORE INSERT ON domestic_consignment_sales WHEN EXISTS(SELECT 1 FROM finance_period_events p WHERE p.revision=(SELECT MAX(x.revision) FROM finance_period_events x WHERE x.month=p.month) AND p.status='closed' AND substr(NEW.business_date,1,7)<=p.month) BEGIN SELECT RAISE(ABORT,'closed finance period'); END;
