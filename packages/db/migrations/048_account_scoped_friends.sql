-- 048_account_scoped_friends.sql
-- Store the same LINE user as separate friend rows per LINE Official Account.
--
-- Before this migration, friends.line_user_id was globally UNIQUE, so adding the
-- same LINE user to both 採用プロ【公式】 and 採用プロ for Biz caused the single
-- friend row's line_account_id to be overwritten by the latest account.

PRAGMA foreign_keys = OFF;

CREATE TABLE IF NOT EXISTS friends_new (
  id                    TEXT PRIMARY KEY,
  line_user_id          TEXT NOT NULL,
  display_name          TEXT,
  picture_url           TEXT,
  status_message        TEXT,
  is_following          INTEGER NOT NULL DEFAULT 1,
  user_id               TEXT,
  ig_igsid              TEXT,
  score                 INTEGER NOT NULL DEFAULT 0,
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  ref_code              TEXT,
  metadata              TEXT NOT NULL DEFAULT '{}',
  line_account_id       TEXT REFERENCES line_accounts(id),
  first_tracked_link_id TEXT REFERENCES tracked_links(id) ON DELETE SET NULL
);

INSERT INTO friends_new (
  id, line_user_id, display_name, picture_url, status_message, is_following,
  user_id, ig_igsid, score, created_at, updated_at, ref_code, metadata,
  line_account_id, first_tracked_link_id
)
SELECT
  id, line_user_id, display_name, picture_url, status_message, is_following,
  user_id, ig_igsid, score, created_at, updated_at, ref_code, metadata,
  line_account_id, first_tracked_link_id
FROM friends;

DROP TABLE friends;
ALTER TABLE friends_new RENAME TO friends;

CREATE INDEX IF NOT EXISTS idx_friends_line_user_id ON friends (line_user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_friends_line_user_account
  ON friends (line_user_id, line_account_id)
  WHERE line_account_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_friends_line_user_null_account
  ON friends (line_user_id)
  WHERE line_account_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_friends_line_account_id ON friends (line_account_id);
CREATE INDEX IF NOT EXISTS idx_friends_user_id ON friends (user_id);
CREATE INDEX IF NOT EXISTS idx_friends_ig_igsid ON friends (ig_igsid);

PRAGMA foreign_keys = ON;
