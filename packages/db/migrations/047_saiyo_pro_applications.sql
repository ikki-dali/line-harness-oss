-- 047_saiyo_pro_applications.sql
-- Saiyo Pro-specific applicant screening answers and status.

CREATE TABLE IF NOT EXISTS saiyo_pro_applications (
  id                  TEXT PRIMARY KEY,
  friend_id           TEXT NOT NULL UNIQUE,
  line_account_id     TEXT,
  age                 TEXT,
  gender              TEXT,
  location            TEXT,
  income              TEXT,
  eligibility_status  TEXT NOT NULL DEFAULT 'pending'
    CHECK (eligibility_status IN ('pending','eligible','ineligible')),
  interview_url       TEXT,
  source              TEXT NOT NULL DEFAULT 'line_questionnaire',
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  FOREIGN KEY (friend_id) REFERENCES friends(id),
  FOREIGN KEY (line_account_id) REFERENCES line_accounts(id)
);

CREATE INDEX IF NOT EXISTS idx_saiyo_pro_applications_status
  ON saiyo_pro_applications (eligibility_status, updated_at);

CREATE INDEX IF NOT EXISTS idx_saiyo_pro_applications_line_account
  ON saiyo_pro_applications (line_account_id, updated_at);
