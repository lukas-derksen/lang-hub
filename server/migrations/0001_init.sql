-- Generated content: one row per article, clip, scene or batch of cards.
CREATE TABLE items (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,          -- 'article' | 'clip' | 'scene' | 'cards'
  created_at INTEGER NOT NULL, -- ms epoch
  data TEXT NOT NULL           -- JSON, same shape as content/<lang>/*.json entries
);
CREATE INDEX items_created ON items (created_at);

-- Small key/value state: the learner profile synced from the app.
CREATE TABLE state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Usage counters per month: 'tts_chars', 'claude_input', 'claude_output'.
CREATE TABLE usage (
  month TEXT NOT NULL,
  kind TEXT NOT NULL,
  amount INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (month, kind)
);
