-- Additive only: safe on the live database.

-- Hide a bad item (DELETE /api/items/:id). updated_at is when the row last changed
-- (written, or hidden), so the app picks up hides with its usual `since` cursor.
ALTER TABLE items ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;
ALTER TABLE items ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
UPDATE items SET updated_at = created_at;
CREATE INDEX items_updated ON items (updated_at);
CREATE INDEX items_kind ON items (kind, created_at);

-- Every attempt to write an item with Claude, so a failure can't repeat (and cost) all day.
CREATE TABLE attempts (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,      -- 'article' | 'clip' | 'scene' | 'cards'
  at INTEGER NOT NULL,     -- ms epoch
  ok INTEGER NOT NULL,     -- 1 written, 0 failed
  error TEXT
);
CREATE INDEX attempts_kind_at ON attempts (kind, at);
