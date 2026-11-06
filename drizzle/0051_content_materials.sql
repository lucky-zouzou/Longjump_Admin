CREATE TABLE content_materials (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  script_id TEXT REFERENCES content_scripts(id),
  original_name TEXT NOT NULL,
  title TEXT NOT NULL,
  sku TEXT NOT NULL,
  note TEXT NOT NULL,
  shoot_from TEXT NOT NULL,
  shoot_to TEXT NOT NULL,
  actor_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  size INTEGER NOT NULL CHECK(size>0),
  content_type TEXT NOT NULL,
  upload_key TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'uploading' CHECK(state IN ('uploading','ready','archived'))
);
CREATE INDEX content_materials_recent ON content_materials(state,created_at DESC);
CREATE TABLE content_material_parts (
  id TEXT PRIMARY KEY,
  material_id TEXT NOT NULL REFERENCES content_materials(id),
  part_no INTEGER NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  size INTEGER NOT NULL,
  content_type TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  UNIQUE(material_id,part_no)
);
CREATE TABLE content_material_sites (
  material_id TEXT NOT NULL REFERENCES content_materials(id),
  site TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','downloaded','failed')),
  handled_by TEXT REFERENCES users(id),
  handled_at TEXT,
  PRIMARY KEY(material_id,site)
);
CREATE INDEX content_materials_by_site ON content_material_sites(site,status,material_id);
