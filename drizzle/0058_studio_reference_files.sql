CREATE TABLE content_reference_files (
 id TEXT PRIMARY KEY REFERENCES content_scripts(id),
 object_key TEXT NOT NULL UNIQUE,
 original_name TEXT NOT NULL,
 size INTEGER NOT NULL CHECK(size>0),
 content_type TEXT NOT NULL,
 sha256 TEXT NOT NULL
);
