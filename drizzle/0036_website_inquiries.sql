CREATE TABLE website_leads (
 id TEXT PRIMARY KEY, source TEXT NOT NULL, external_id TEXT NOT NULL,
 source_revision INTEGER NOT NULL CHECK(source_revision>0), source_hash TEXT NOT NULL, source_json TEXT NOT NULL,
 source_owner_id TEXT NOT NULL DEFAULT '', source_owner_email TEXT NOT NULL DEFAULT '',
 owner_id TEXT REFERENCES users(id), assignment_state TEXT NOT NULL DEFAULT 'pending',
 country TEXT NOT NULL DEFAULT '', business_kind TEXT NOT NULL DEFAULT 'unclassified',
 qualification_note TEXT NOT NULL DEFAULT '', profile_json TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','following','quoted','closed','converted')),
 next_follow_up TEXT, customer_id TEXT REFERENCES wholesale_customers(id),
 version INTEGER NOT NULL DEFAULT 1, source_created_at TEXT NOT NULL, source_updated_at TEXT NOT NULL,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 UNIQUE(source,external_id)
);
CREATE INDEX website_leads_owner ON website_leads(owner_id,status,updated_at);
CREATE INDEX website_leads_customer ON website_leads(customer_id);
CREATE TABLE website_sales_mappings (
 source TEXT NOT NULL, external_user_id TEXT NOT NULL, admin_user_id TEXT NOT NULL REFERENCES users(id),
 actor_id TEXT NOT NULL REFERENCES users(id), updated_at TEXT NOT NULL,
 PRIMARY KEY(source,external_user_id)
);
CREATE TABLE website_lead_events (
 id TEXT PRIMARY KEY, lead_id TEXT NOT NULL REFERENCES website_leads(id), action TEXT NOT NULL,
 actor_id TEXT, actor_name TEXT NOT NULL, detail_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX website_lead_events_lead ON website_lead_events(lead_id,created_at);
CREATE TABLE website_lead_operations (
 id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, request_hash TEXT NOT NULL, lead_id TEXT NOT NULL, result_json TEXT NOT NULL, created_at TEXT NOT NULL
);
ALTER TABLE wholesale_orders ADD COLUMN website_lead_id TEXT REFERENCES website_leads(id);
CREATE INDEX wholesale_orders_website_lead ON wholesale_orders(website_lead_id);
CREATE TRIGGER immutable_website_lead_events_update BEFORE UPDATE ON website_lead_events BEGIN SELECT RAISE(ABORT,'immutable history'); END;
CREATE TRIGGER immutable_website_lead_events_delete BEFORE DELETE ON website_lead_events BEGIN SELECT RAISE(ABORT,'immutable history'); END;
CREATE TRIGGER maintenance_website_leads_insert BEFORE INSERT ON website_leads WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER maintenance_website_leads_update BEFORE UPDATE ON website_leads WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER maintenance_website_leads_delete BEFORE DELETE ON website_leads WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER maintenance_website_sales_mappings_insert BEFORE INSERT ON website_sales_mappings WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER maintenance_website_sales_mappings_update BEFORE UPDATE ON website_sales_mappings WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER maintenance_website_sales_mappings_delete BEFORE DELETE ON website_sales_mappings WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER maintenance_website_lead_events_insert BEFORE INSERT ON website_lead_events WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER maintenance_website_lead_events_update BEFORE UPDATE ON website_lead_events WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER maintenance_website_lead_events_delete BEFORE DELETE ON website_lead_events WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER maintenance_website_lead_operations_insert BEFORE INSERT ON website_lead_operations WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER maintenance_website_lead_operations_update BEFORE UPDATE ON website_lead_operations WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER maintenance_website_lead_operations_delete BEFORE DELETE ON website_lead_operations WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
