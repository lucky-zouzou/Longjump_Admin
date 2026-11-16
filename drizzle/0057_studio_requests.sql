ALTER TABLE content_scripts ADD COLUMN original_count INTEGER NOT NULL DEFAULT 1 CHECK (original_count BETWEEN 1 AND 100);
ALTER TABLE content_scripts ADD COLUMN colors TEXT NOT NULL DEFAULT '';
ALTER TABLE content_scripts ADD COLUMN directions TEXT NOT NULL DEFAULT '';
ALTER TABLE content_scripts ADD COLUMN reference_url TEXT NOT NULL DEFAULT '';
ALTER TABLE content_versions ADD COLUMN original_no INTEGER NOT NULL DEFAULT 1 CHECK (original_no BETWEEN 1 AND 100);
