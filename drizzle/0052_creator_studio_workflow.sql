CREATE TABLE creator_evidence_files (
 id TEXT PRIMARY KEY,
 creator_id TEXT NOT NULL REFERENCES creator_profiles(id),
 round_id TEXT NOT NULL REFERENCES creator_rounds(id),
 filename TEXT NOT NULL,
 mime TEXT NOT NULL,
 payload TEXT NOT NULL,
 actor_id TEXT NOT NULL REFERENCES users(id),
 created_at TEXT NOT NULL
);
CREATE INDEX creator_evidence_round ON creator_evidence_files(round_id);
ALTER TABLE content_materials ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE content_materials ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE content_materials ADD COLUMN replaces_id TEXT REFERENCES content_materials(id);
CREATE INDEX content_material_replacement ON content_materials(replaces_id) WHERE replaces_id IS NOT NULL;
CREATE TABLE content_material_options (
 id TEXT PRIMARY KEY CHECK(id='global'),
 version INTEGER NOT NULL DEFAULT 1,
 data_json TEXT NOT NULL,
 updated_at TEXT NOT NULL
);

ALTER TABLE content_metrics ADD COLUMN cart_adds INTEGER CHECK(cart_adds IS NULL OR cart_adds>=0);
