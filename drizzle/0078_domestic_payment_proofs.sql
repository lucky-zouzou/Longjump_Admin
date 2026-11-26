-- Customer-reported payments are evidence awaiting finance review, never cash entries.
CREATE TABLE domestic_payment_submissions (
 id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES domestic_orders(id),
 amount_minor INTEGER NOT NULL CHECK(amount_minor>0), claimed_date TEXT NOT NULL,
 customer_reference TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', digest TEXT NOT NULL,
 object_key TEXT NOT NULL UNIQUE, name TEXT NOT NULL, content_type TEXT NOT NULL,
 size INTEGER NOT NULL CHECK(size>0), actor_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL,
 UNIQUE(order_id,digest,amount_minor,claimed_date,customer_reference)
);
CREATE INDEX domestic_payment_submissions_order ON domestic_payment_submissions(order_id,created_at);
CREATE TABLE domestic_payment_reviews (
 id TEXT PRIMARY KEY, submission_id TEXT NOT NULL UNIQUE REFERENCES domestic_payment_submissions(id),
 outcome TEXT NOT NULL CHECK(outcome IN('confirmed','rejected')),
 entry_id TEXT UNIQUE REFERENCES domestic_finance_entries(id), reason TEXT NOT NULL,
 actor_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL,
 CHECK((outcome='confirmed' AND entry_id IS NOT NULL) OR (outcome='rejected' AND entry_id IS NULL))
);
CREATE TRIGGER domestic_payment_review_guard BEFORE INSERT ON domestic_payment_reviews BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.actor_id AND active=1 AND role='财务')
 OR EXISTS(SELECT 1 FROM domestic_payment_submissions WHERE id=NEW.submission_id AND actor_id=NEW.actor_id)
 THEN RAISE(ABORT,'payment review requires independent finance') END;
 SELECT CASE WHEN NEW.outcome='confirmed' AND NOT EXISTS(
 SELECT 1 FROM domestic_finance_entries e JOIN domestic_payment_submissions s ON s.order_id=e.order_id
 WHERE s.id=NEW.submission_id AND e.id=NEW.entry_id AND e.kind='receipt' AND e.actor_id=NEW.actor_id)
 THEN RAISE(ABORT,'payment review entry mismatch') END;
END;
CREATE TRIGGER domestic_payment_submissions_no_update BEFORE UPDATE ON domestic_payment_submissions BEGIN SELECT RAISE(ABORT,'immutable payment submission'); END;
CREATE TRIGGER domestic_payment_submissions_no_delete BEFORE DELETE ON domestic_payment_submissions BEGIN SELECT RAISE(ABORT,'immutable payment submission'); END;
CREATE TRIGGER domestic_payment_reviews_no_update BEFORE UPDATE ON domestic_payment_reviews BEGIN SELECT RAISE(ABORT,'immutable payment review'); END;
CREATE TRIGGER domestic_payment_reviews_no_delete BEFORE DELETE ON domestic_payment_reviews BEGIN SELECT RAISE(ABORT,'immutable payment review'); END;
