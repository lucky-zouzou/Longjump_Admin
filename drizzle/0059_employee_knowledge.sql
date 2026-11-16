CREATE TABLE employee_knowledge (
  role TEXT NOT NULL,
  scope TEXT NOT NULL CHECK(scope IN ('internal','public')),
  question_key TEXT NOT NULL,
  title TEXT NOT NULL,
  guide_id TEXT NOT NULL DEFAULT '',
  revision TEXT NOT NULL,
  answer_json TEXT NOT NULL,
  verified_at TEXT NOT NULL,
  expires_at TEXT,
  PRIMARY KEY(role,scope,question_key)
);
CREATE INDEX employee_knowledge_recent ON employee_knowledge(role,verified_at DESC);
