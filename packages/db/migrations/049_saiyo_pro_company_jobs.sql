-- 049_saiyo_pro_company_jobs.sql
-- Production job posting tables for 採用PRO for Biz.

CREATE TABLE IF NOT EXISTS saiyo_pro_company_jobs (
  id                 TEXT PRIMARY KEY,
  line_account_id    TEXT NOT NULL,
  company_friend_id  TEXT NOT NULL,
  company_name       TEXT NOT NULL,
  title              TEXT NOT NULL,
  employment_type    TEXT,
  wage_label         TEXT,
  work_location      TEXT,
  work_hours         TEXT,
  description        TEXT,
  requirements       TEXT,
  banner_url         TEXT,
  status             TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','published','closed')),
  published_at       TEXT,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  FOREIGN KEY (line_account_id) REFERENCES line_accounts(id),
  FOREIGN KEY (company_friend_id) REFERENCES friends(id)
);

CREATE INDEX IF NOT EXISTS idx_saiyo_pro_company_jobs_account_status
  ON saiyo_pro_company_jobs (line_account_id, status, updated_at);

CREATE INDEX IF NOT EXISTS idx_saiyo_pro_company_jobs_company_friend
  ON saiyo_pro_company_jobs (company_friend_id, updated_at);

CREATE TABLE IF NOT EXISTS saiyo_pro_job_applications (
  id                         TEXT PRIMARY KEY,
  job_id                     TEXT NOT NULL,
  candidate_friend_id        TEXT NOT NULL,
  candidate_line_account_id  TEXT,
  company_friend_id          TEXT NOT NULL,
  status                     TEXT NOT NULL DEFAULT 'applied'
    CHECK (status IN ('applied','screening','interview','hired','rejected','withdrawn')),
  message                    TEXT,
  created_at                 TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at                 TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  FOREIGN KEY (job_id) REFERENCES saiyo_pro_company_jobs(id) ON DELETE CASCADE,
  FOREIGN KEY (candidate_friend_id) REFERENCES friends(id),
  FOREIGN KEY (candidate_line_account_id) REFERENCES line_accounts(id),
  FOREIGN KEY (company_friend_id) REFERENCES friends(id),
  UNIQUE (job_id, candidate_friend_id)
);

CREATE INDEX IF NOT EXISTS idx_saiyo_pro_job_applications_candidate
  ON saiyo_pro_job_applications (candidate_friend_id, created_at);

CREATE INDEX IF NOT EXISTS idx_saiyo_pro_job_applications_company_friend
  ON saiyo_pro_job_applications (company_friend_id, status, created_at);
