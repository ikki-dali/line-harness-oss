import { jstNow } from './utils.js';

export type SaiyoProCompanyJobStatus = 'draft' | 'published' | 'closed';
export type SaiyoProJobApplicationStatus =
  | 'applied'
  | 'screening'
  | 'interview'
  | 'hired'
  | 'rejected'
  | 'withdrawn';

export interface SaiyoProCompanyJob {
  id: string;
  line_account_id: string;
  company_friend_id: string;
  company_name: string;
  title: string;
  employment_type: string | null;
  wage_label: string | null;
  work_location: string | null;
  work_hours: string | null;
  description: string | null;
  requirements: string | null;
  banner_url: string | null;
  status: SaiyoProCompanyJobStatus;
  published_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SaiyoProJobApplication {
  id: string;
  job_id: string;
  candidate_friend_id: string;
  candidate_line_account_id: string | null;
  company_friend_id: string;
  status: SaiyoProJobApplicationStatus;
  message: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateSaiyoProCompanyJobInput {
  lineAccountId: string;
  companyFriendId: string;
  companyName: string;
  title: string;
  employmentType?: string | null;
  wageLabel?: string | null;
  workLocation?: string | null;
  workHours?: string | null;
  description?: string | null;
  requirements?: string | null;
  bannerUrl?: string | null;
  status?: SaiyoProCompanyJobStatus;
}

export interface UpdateSaiyoProCompanyJobInput {
  companyName?: string;
  title?: string;
  employmentType?: string | null;
  wageLabel?: string | null;
  workLocation?: string | null;
  workHours?: string | null;
  description?: string | null;
  requirements?: string | null;
  bannerUrl?: string | null;
  status?: SaiyoProCompanyJobStatus;
}

export async function getSaiyoProCompanyJobs(
  db: D1Database,
  opts: {
    lineAccountId?: string | null;
    companyFriendId?: string | null;
    status?: SaiyoProCompanyJobStatus | 'all';
    limit?: number;
  } = {},
): Promise<SaiyoProCompanyJob[]> {
  const conditions: string[] = [];
  const binds: unknown[] = [];

  if (opts.lineAccountId) {
    conditions.push('line_account_id = ?');
    binds.push(opts.lineAccountId);
  }
  if (opts.companyFriendId) {
    conditions.push('company_friend_id = ?');
    binds.push(opts.companyFriendId);
  }
  if (opts.status && opts.status !== 'all') {
    conditions.push('status = ?');
    binds.push(opts.status);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = opts.limit ?? 50;
  const result = await db
    .prepare(
      `SELECT * FROM saiyo_pro_company_jobs
       ${where}
       ORDER BY
         CASE status WHEN 'published' THEN 0 WHEN 'draft' THEN 1 ELSE 2 END,
         updated_at DESC
       LIMIT ?`,
    )
    .bind(...binds, limit)
    .all<SaiyoProCompanyJob>();
  return result.results ?? [];
}

export async function getSaiyoProCompanyJobById(
  db: D1Database,
  id: string,
): Promise<SaiyoProCompanyJob | null> {
  return db
    .prepare('SELECT * FROM saiyo_pro_company_jobs WHERE id = ?')
    .bind(id)
    .first<SaiyoProCompanyJob>();
}

export async function createSaiyoProCompanyJob(
  db: D1Database,
  input: CreateSaiyoProCompanyJobInput,
): Promise<SaiyoProCompanyJob> {
  const id = crypto.randomUUID();
  const now = jstNow();
  const status = input.status ?? 'published';
  const publishedAt = status === 'published' ? now : null;

  await db
    .prepare(
      `INSERT INTO saiyo_pro_company_jobs (
         id, line_account_id, company_friend_id, company_name, title,
         employment_type, wage_label, work_location, work_hours, description,
         requirements, banner_url, status, published_at, created_at, updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.lineAccountId,
      input.companyFriendId,
      input.companyName,
      input.title,
      input.employmentType ?? null,
      input.wageLabel ?? null,
      input.workLocation ?? null,
      input.workHours ?? null,
      input.description ?? null,
      input.requirements ?? null,
      input.bannerUrl ?? null,
      status,
      publishedAt,
      now,
      now,
    )
    .run();

  return (await getSaiyoProCompanyJobById(db, id))!;
}

export async function updateSaiyoProCompanyJob(
  db: D1Database,
  id: string,
  input: UpdateSaiyoProCompanyJobInput,
): Promise<SaiyoProCompanyJob | null> {
  const existing = await getSaiyoProCompanyJobById(db, id);
  if (!existing) return null;

  const nextStatus = input.status ?? existing.status;
  const now = jstNow();
  const nextPublishedAt =
    nextStatus === 'published'
      ? existing.published_at ?? now
      : null;

  await db
    .prepare(
      `UPDATE saiyo_pro_company_jobs
       SET company_name = ?,
           title = ?,
           employment_type = ?,
           wage_label = ?,
           work_location = ?,
           work_hours = ?,
           description = ?,
           requirements = ?,
           banner_url = ?,
           status = ?,
           published_at = ?,
           updated_at = ?
       WHERE id = ?`,
    )
    .bind(
      input.companyName ?? existing.company_name,
      input.title ?? existing.title,
      'employmentType' in input ? (input.employmentType ?? null) : existing.employment_type,
      'wageLabel' in input ? (input.wageLabel ?? null) : existing.wage_label,
      'workLocation' in input ? (input.workLocation ?? null) : existing.work_location,
      'workHours' in input ? (input.workHours ?? null) : existing.work_hours,
      'description' in input ? (input.description ?? null) : existing.description,
      'requirements' in input ? (input.requirements ?? null) : existing.requirements,
      'bannerUrl' in input ? (input.bannerUrl ?? null) : existing.banner_url,
      nextStatus,
      nextPublishedAt,
      now,
      id,
    )
    .run();

  return getSaiyoProCompanyJobById(db, id);
}

export async function createSaiyoProJobApplication(
  db: D1Database,
  input: {
    jobId: string;
    candidateFriendId: string;
    candidateLineAccountId?: string | null;
    companyFriendId: string;
    message?: string | null;
  },
): Promise<SaiyoProJobApplication> {
  const existing = await db
    .prepare(
      `SELECT * FROM saiyo_pro_job_applications
       WHERE job_id = ? AND candidate_friend_id = ?`,
    )
    .bind(input.jobId, input.candidateFriendId)
    .first<SaiyoProJobApplication>();
  if (existing) return existing;

  const id = crypto.randomUUID();
  const now = jstNow();
  await db
    .prepare(
      `INSERT INTO saiyo_pro_job_applications (
         id, job_id, candidate_friend_id, candidate_line_account_id,
         company_friend_id, status, message, created_at, updated_at
       )
       VALUES (?, ?, ?, ?, ?, 'applied', ?, ?, ?)`,
    )
    .bind(
      id,
      input.jobId,
      input.candidateFriendId,
      input.candidateLineAccountId ?? null,
      input.companyFriendId,
      input.message ?? null,
      now,
      now,
    )
    .run();

  return (await db
    .prepare('SELECT * FROM saiyo_pro_job_applications WHERE id = ?')
    .bind(id)
    .first<SaiyoProJobApplication>())!;
}

export async function getSaiyoProJobApplicationsForCompany(
  db: D1Database,
  companyFriendId: string,
): Promise<Array<SaiyoProJobApplication & {
  job_title: string;
  candidate_name: string | null;
}>> {
  const result = await db
    .prepare(
      `SELECT a.*, j.title AS job_title, f.display_name AS candidate_name
       FROM saiyo_pro_job_applications a
       JOIN saiyo_pro_company_jobs j ON j.id = a.job_id
       LEFT JOIN friends f ON f.id = a.candidate_friend_id
       WHERE a.company_friend_id = ?
       ORDER BY a.created_at DESC`,
    )
    .bind(companyFriendId)
    .all<SaiyoProJobApplication & { job_title: string; candidate_name: string | null }>();
  return result.results ?? [];
}
