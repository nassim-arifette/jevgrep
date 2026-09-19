CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  payload TEXT NOT NULL
);

CREATE INDEX audit_events_created_at ON audit_events(created_at);
