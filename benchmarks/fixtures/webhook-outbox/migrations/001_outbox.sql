CREATE TABLE outbox (
  id TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at INTEGER,
  delivered_at TEXT
);
CREATE INDEX due_outbox ON outbox(next_at) WHERE delivered_at IS NULL;
