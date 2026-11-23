-- Deletion is a new revision. Keep all earlier values for audit and never
-- fall back to an older revision when the latest revision is deleted.
ALTER TABLE content_platform_reports ADD COLUMN deleted_at TEXT;
ALTER TABLE content_platform_reports ADD COLUMN deleted_by TEXT REFERENCES users(id);
ALTER TABLE content_platform_reports ADD COLUMN delete_reason TEXT;
