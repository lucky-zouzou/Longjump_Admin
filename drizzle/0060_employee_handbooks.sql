CREATE TABLE employee_handbooks (
  version INTEGER PRIMARY KEY,
  revision TEXT NOT NULL,
  payload TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
