CREATE TABLE product_profiles (
  sku TEXT PRIMARY KEY REFERENCES sku_settings(sku),
  version INTEGER NOT NULL CHECK(version > 0),
  data_json TEXT NOT NULL,
  source_json TEXT NOT NULL,
  cost_references_json TEXT NOT NULL DEFAULT '[]',
  actor_id TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE product_profile_history (
  id TEXT PRIMARY KEY,
  sku TEXT NOT NULL REFERENCES sku_settings(sku),
  version INTEGER NOT NULL,
  data_json TEXT NOT NULL,
  source_json TEXT NOT NULL,
  cost_references_json TEXT NOT NULL,
  reason TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(sku, version)
);
CREATE TRIGGER product_profile_history_immutable_update BEFORE UPDATE ON product_profile_history
BEGIN SELECT RAISE(ABORT, 'immutable product profile history'); END;
CREATE TRIGGER product_profile_history_immutable_delete BEFORE DELETE ON product_profile_history
BEGIN SELECT RAISE(ABORT, 'immutable product profile history'); END;
CREATE TABLE product_profile_files (
  id TEXT PRIMARY KEY,
  sku TEXT NOT NULL REFERENCES sku_settings(sku),
  object_key TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL,
  name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  actor_id TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(sku, sha256)
);
CREATE INDEX product_profile_files_sku ON product_profile_files(sku, created_at);
