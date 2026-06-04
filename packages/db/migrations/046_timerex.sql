-- Migration 046: TimeRex → LINE 連携 (Phase L1-L2)
-- See: docs/timerex-integration/spec.md
--
-- Conventions follow schema.sql / migration 036:
--   - TEXT (UUID/nanoid) primary keys
--   - created_at / updated_at default in JST
--   - Time-of-event columns (starts_at / ends_at / scheduled_at / sent_at /
--     received_at / processed_at) are written by the Worker as UTC ISO8601
--     (Z-suffixed) and have NO default — callers must provide them.
--
-- TimeRex の認証は固定トークン (x-timerex-authorization) で HMAC 署名ではない
-- ため、既存 incoming_webhooks (HMAC body 検証) には乗らず専用テーブルを持つ。

-- ============================================================
-- timerex_events: 冪等台帳（リプレイ・重複配信を無害化）
--   PK = "<event_id>:<webhook_type>"。confirmed と cancelled は同一 event_id で
--   別配信されるため複合キーにする。INSERT OR IGNORE で初回のみ処理する。
--   PII (url_params の line_user_id 等) は保存しない（security: MEDIUM-6）。
-- ============================================================
CREATE TABLE IF NOT EXISTS timerex_events (
  idempotency_key  TEXT PRIMARY KEY,   -- "<event_id>:<webhook_type>"
  event_id         TEXT NOT NULL,
  webhook_type     TEXT NOT NULL,
  received_at      TEXT NOT NULL,      -- UTC ISO8601 (Worker 書込)
  processed_at     TEXT                -- UTC ISO8601、処理完了時に更新
);
CREATE INDEX IF NOT EXISTS idx_timerex_events_event ON timerex_events (event_id);

-- ============================================================
-- timerex_bookings: TimeRex 予約の写像（内製 bookings とは別系統）
--   line_account_id / friend_id は受信時に解決して保存（解決不可なら NULL +
--   ログ）。starts_at / ends_at は UTC ISO8601。
-- ============================================================
CREATE TABLE IF NOT EXISTS timerex_bookings (
  event_id           TEXT PRIMARY KEY,  -- TimeRex event.id
  calendar_url_path  TEXT,
  calendar_name      TEXT,
  line_account_id    TEXT,              -- 通知に使う active primary account
  friend_id          TEXT,              -- 紐付いた friend（不在なら NULL）
  line_user_id       TEXT,              -- url_params から回収（sig 検証済のみ）
  host_name          TEXT,              -- 担当（hosts[0].name）
  starts_at          TEXT,              -- UTC ISO8601
  ends_at            TEXT,              -- UTC ISO8601
  status             TEXT NOT NULL DEFAULT 'confirmed'
    CHECK (status IN ('confirmed','cancelled','rescheduled')),
  is_changed         INTEGER NOT NULL DEFAULT 0,
  old_event_id       TEXT,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  FOREIGN KEY (line_account_id) REFERENCES line_accounts(id),
  FOREIGN KEY (friend_id) REFERENCES friends(id)
);
CREATE INDEX IF NOT EXISTS idx_timerex_bookings_friend ON timerex_bookings (friend_id);
CREATE INDEX IF NOT EXISTS idx_timerex_bookings_starts ON timerex_bookings (status, starts_at);

-- ============================================================
-- timerex_reminders: TimeRex 予約のリマインド（既存 booking_reminders とは
--   分離。processDueReminders の JOIN を汚さないため独立スキャン）。
--   cron 5分 tick が status∈(pending,failed) ∧ scheduled_at<=now を送信。
-- ============================================================
CREATE TABLE IF NOT EXISTS timerex_reminders (
  id            TEXT PRIMARY KEY,
  event_id      TEXT NOT NULL,         -- timerex_bookings.event_id
  kind          TEXT NOT NULL CHECK (kind IN ('day_before','hours_before')),
  scheduled_at  TEXT NOT NULL,         -- UTC ISO8601 (Worker 書込)
  sent_at       TEXT,                  -- UTC ISO8601
  status        TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','sent','failed','failed_permanent','cancelled')),
  retry_count   INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  FOREIGN KEY (event_id) REFERENCES timerex_bookings(event_id),
  -- 同一予約・同一種別のリマインドの二重登録を防ぐ（handler の再試行/再配信対策）。
  UNIQUE (event_id, kind)
);
CREATE INDEX IF NOT EXISTS idx_timerex_reminders_due ON timerex_reminders (status, scheduled_at);
