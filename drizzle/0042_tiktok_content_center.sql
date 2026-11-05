CREATE TABLE content_scripts (
 id TEXT PRIMARY KEY, source TEXT NOT NULL CHECK(source IN ('studio','ai','creator')),
 site TEXT NOT NULL, sku TEXT NOT NULL REFERENCES sku_settings(sku), title TEXT NOT NULL,
 audience TEXT NOT NULL, selling_point TEXT NOT NULL, brief TEXT NOT NULL, scene TEXT NOT NULL,
 due TEXT NOT NULL, owner_id TEXT NOT NULL REFERENCES users(id), created_by TEXT NOT NULL REFERENCES users(id),
 source_content_id TEXT UNIQUE REFERENCES creator_contents(id),
 parent_version_id TEXT REFERENCES content_versions(id), joint_with TEXT REFERENCES content_scripts(id),
 status TEXT NOT NULL, shoot_date TEXT, delivery_date TEXT, version INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL
);
CREATE TABLE content_versions (
 id TEXT PRIMARY KEY, script_id TEXT NOT NULL REFERENCES content_scripts(id), label TEXT NOT NULL,
 storyboard TEXT NOT NULL, master_url TEXT NOT NULL, raw_url TEXT NOT NULL DEFAULT '', prompt TEXT NOT NULL DEFAULT '',
 product_ref TEXT NOT NULL DEFAULT '', created_by TEXT NOT NULL REFERENCES users(id),
 status TEXT NOT NULL, feedback TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
);
CREATE TABLE content_rights (
 script_id TEXT PRIMARY KEY REFERENCES content_scripts(id), mode TEXT NOT NULL, sites TEXT NOT NULL,
 end_date TEXT, evidence TEXT NOT NULL, actor_id TEXT NOT NULL REFERENCES users(id), source_version INTEGER NOT NULL
);
CREATE TABLE content_posts (
 id TEXT PRIMARY KEY, version_id TEXT NOT NULL REFERENCES content_versions(id), site TEXT NOT NULL, account TEXT NOT NULL,
 language TEXT NOT NULL, changes TEXT NOT NULL, local_url TEXT NOT NULL DEFAULT '', traffic TEXT NOT NULL, owner_id TEXT NOT NULL REFERENCES users(id),
 planned TEXT NOT NULL, url TEXT UNIQUE, video_key TEXT UNIQUE, published_at TEXT, original INTEGER NOT NULL DEFAULT 0,
 version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
);
CREATE TABLE content_metrics (
 id TEXT PRIMARY KEY, post_id TEXT NOT NULL REFERENCES content_posts(id), days INTEGER NOT NULL CHECK(days IN (1,7)),
 revision INTEGER NOT NULL, observed_at TEXT NOT NULL, views INTEGER, clicks INTEGER, orders INTEGER,
 retention REAL, evidence TEXT NOT NULL, note TEXT NOT NULL, actor_id TEXT NOT NULL REFERENCES users(id), UNIQUE(post_id,days,revision)
);
CREATE TABLE content_reviews (
 id TEXT PRIMARY KEY, post_id TEXT NOT NULL REFERENCES content_posts(id), decision TEXT NOT NULL, finding TEXT NOT NULL,
 hypothesis TEXT NOT NULL, change_note TEXT NOT NULL, site TEXT NOT NULL, owner_id TEXT NOT NULL REFERENCES users(id),
 due TEXT NOT NULL, next_script_id TEXT UNIQUE REFERENCES content_scripts(id), next_post_id TEXT UNIQUE REFERENCES content_posts(id),
 created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL
);
CREATE TABLE content_events (
 seq INTEGER PRIMARY KEY AUTOINCREMENT, operation_id TEXT NOT NULL UNIQUE, actor_id TEXT NOT NULL REFERENCES users(id),
 action TEXT NOT NULL, fingerprint TEXT NOT NULL, result_id TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX content_versions_script ON content_versions(script_id,created_at);
CREATE INDEX content_posts_version ON content_posts(version_id,planned);
CREATE INDEX content_reviews_post ON content_reviews(post_id);
