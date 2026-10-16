ALTER TABLE wholesale_files ADD COLUMN purpose text NOT NULL DEFAULT 'shipment' CHECK (purpose IN ('shipment','finance'));
--> statement-breakpoint
ALTER TABLE wholesale_files ADD COLUMN finance_entry_id text REFERENCES wholesale_finance_entries(id);
--> statement-breakpoint
ALTER TABLE wholesale_files ADD COLUMN actor_name text NOT NULL DEFAULT '';
--> statement-breakpoint
CREATE INDEX idx_wh_files_finance_entry ON wholesale_files(finance_entry_id);
--> statement-breakpoint
CREATE TRIGGER guard_finance_file_insert BEFORE INSERT ON wholesale_files
WHEN NEW.finance_entry_id IS NOT NULL AND (
 NEW.purpose<>'finance' OR NOT EXISTS (SELECT 1 FROM wholesale_finance_entries e WHERE e.id=NEW.finance_entry_id AND e.order_id=NEW.order_id)
 OR (SELECT COUNT(*) FROM wholesale_files WHERE finance_entry_id=NEW.finance_entry_id)>=10)
BEGIN SELECT RAISE(ABORT,'guard_finance_file'); END;
--> statement-breakpoint
CREATE TRIGGER guard_finance_file_update BEFORE UPDATE ON wholesale_files
WHEN NEW.finance_entry_id IS NOT NULL AND (
 NEW.purpose<>'finance' OR NOT EXISTS (SELECT 1 FROM wholesale_finance_entries e WHERE e.id=NEW.finance_entry_id AND e.order_id=NEW.order_id)
 OR (SELECT COUNT(*) FROM wholesale_files WHERE finance_entry_id=NEW.finance_entry_id AND id<>NEW.id)>=10)
BEGIN SELECT RAISE(ABORT,'guard_finance_file'); END;
--> statement-breakpoint
CREATE TRIGGER immutable_bound_finance_file BEFORE UPDATE ON wholesale_files
WHEN OLD.finance_entry_id IS NOT NULL AND (NEW.finance_entry_id IS NOT OLD.finance_entry_id OR NEW.order_id<>OLD.order_id OR NEW.purpose<>OLD.purpose OR NEW.object_key<>OLD.object_key OR NEW.name<>OLD.name OR NEW.content_type<>OLD.content_type OR NEW.size<>OLD.size OR NEW.actor_id<>OLD.actor_id OR NEW.actor_name<>OLD.actor_name OR NEW.created_at<>OLD.created_at)
BEGIN SELECT RAISE(ABORT,'immutable finance proof'); END;
