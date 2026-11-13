CREATE TABLE distributor_stores (
 customer_id TEXT PRIMARY KEY REFERENCES wholesale_customers(id),
 slug TEXT NOT NULL UNIQUE, username TEXT NOT NULL UNIQUE,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','active','suspended')),
 password_hash TEXT, password_salt TEXT,
 activation_hash TEXT UNIQUE, activation_expires_at TEXT,
 version INTEGER NOT NULL DEFAULT 1,
 created_by TEXT NOT NULL, reviewed_by TEXT, review_note TEXT NOT NULL DEFAULT '',
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE distributor_sessions (
 token_hash TEXT PRIMARY KEY, customer_id TEXT NOT NULL REFERENCES distributor_stores(customer_id),
 store_version INTEGER NOT NULL, expires_at TEXT NOT NULL
);
CREATE INDEX distributor_session_customer ON distributor_sessions(customer_id);
CREATE TABLE distributor_login_attempts (key TEXT PRIMARY KEY, attempts INTEGER NOT NULL, window_start INTEGER NOT NULL);
CREATE TABLE distributor_payments (
 id TEXT PRIMARY KEY, customer_id TEXT NOT NULL REFERENCES distributor_stores(customer_id),
 order_id TEXT NOT NULL REFERENCES wholesale_orders(id),
 request_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
 amount INTEGER NOT NULL CHECK(amount>0), reference TEXT NOT NULL, business_date TEXT NOT NULL,
 file_id TEXT NOT NULL REFERENCES wholesale_files(id),
 status TEXT NOT NULL DEFAULT 'submitted' CHECK(status IN ('submitted','rejected')),
 review_note TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL,
 UNIQUE(customer_id,request_id)
);
CREATE INDEX distributor_payments_order ON distributor_payments(order_id);
-- Existing approved distribution clients get an account identity, not a password.
-- Their old private links remain usable until the new account is activated.
INSERT INTO distributor_stores(customer_id,slug,username,status,created_by,created_at,updated_at)
 SELECT c.id,'toko-'||lower(hex(randomblob(8))),'lj-'||lower(hex(randomblob(6))),
 CASE WHEN c.active=1 THEN 'active' ELSE 'suspended' END,'migration',c.created_at,c.updated_at
 FROM wholesale_customers c WHERE EXISTS(SELECT 1 FROM distributor_links l WHERE l.customer_id=c.id)
 OR EXISTS(SELECT 1 FROM website_leads l WHERE l.customer_id=c.id AND l.source='distributor-application' AND l.status='converted');

CREATE TRIGGER maintenance_distributor_stores_insert BEFORE INSERT ON distributor_stores WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;

CREATE TRIGGER maintenance_distributor_stores_update BEFORE UPDATE ON distributor_stores WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;

CREATE TRIGGER maintenance_distributor_stores_delete BEFORE DELETE ON distributor_stores WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;

CREATE TRIGGER maintenance_distributor_payments_insert BEFORE INSERT ON distributor_payments WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;

CREATE TRIGGER maintenance_distributor_payments_update BEFORE UPDATE ON distributor_payments WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;

CREATE TRIGGER maintenance_distributor_payments_delete BEFORE DELETE ON distributor_payments WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
