CREATE TABLE marketing_sample_revenue_bases (
 id TEXT PRIMARY KEY, month TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0),
 through_date TEXT NOT NULL, data_json TEXT NOT NULL, actor_id TEXT NOT NULL REFERENCES users(id),
 created_at TEXT NOT NULL, UNIQUE(month,revision)
);
CREATE TRIGGER sample_revenue_maintenance_insert BEFORE INSERT ON marketing_sample_revenue_bases WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER sample_revenue_immutable_update BEFORE UPDATE ON marketing_sample_revenue_bases BEGIN SELECT RAISE(ABORT,'immutable sample allocation basis'); END;
CREATE TRIGGER sample_revenue_immutable_delete BEFORE DELETE ON marketing_sample_revenue_bases BEGIN SELECT RAISE(ABORT,'immutable sample allocation basis'); END;
CREATE TRIGGER sample_revenue_finance_clock AFTER INSERT ON marketing_sample_revenue_bases BEGIN INSERT INTO finance_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
CREATE TRIGGER sample_cost_finance_clock AFTER INSERT ON marketing_sample_costs BEGIN INSERT INTO finance_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
CREATE TRIGGER sample_ship_finance_clock AFTER INSERT ON marketing_sample_shipments BEGIN INSERT INTO finance_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
