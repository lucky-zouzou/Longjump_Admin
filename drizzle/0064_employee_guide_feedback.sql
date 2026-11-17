CREATE TABLE employee_guide_feedback (
  actor_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL,
  page TEXT NOT NULL,
  question_key TEXT NOT NULL,
  guide_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (actor_id, role, page, question_key)
);
CREATE INDEX employee_guide_feedback_lookup ON employee_guide_feedback(role,page,question_key,guide_id);
