import { Hono } from 'hono';
import {
  createSaiyoProCompanyJob,
  createSaiyoProJobApplication,
  getFriendById,
  getSaiyoProCompanyJobById,
  getSaiyoProCompanyJobs,
  getSaiyoProJobApplicationsForCompany,
  updateSaiyoProCompanyJob,
} from '@line-crm/db';
import type { SaiyoProCompanyJob } from '@line-crm/db';
import type { Env } from '../index.js';

const saiyoProJobs = new Hono<Env>();

type ParsedFormValue = string | File | null | undefined;

function textValue(value: ParsedFormValue, max = 240): string {
  return String(value ?? '').trim().slice(0, max);
}

function nullableText(value: ParsedFormValue, max = 240): string | null {
  const text = textValue(value, max);
  return text ? text : null;
}

function serializeJob(row: SaiyoProCompanyJob) {
  return {
    id: row.id,
    lineAccountId: row.line_account_id,
    companyFriendId: row.company_friend_id,
    companyName: row.company_name,
    title: row.title,
    employmentType: row.employment_type,
    wageLabel: row.wage_label,
    workLocation: row.work_location,
    workHours: row.work_hours,
    description: row.description,
    requirements: row.requirements,
    bannerUrl: row.banner_url,
    status: row.status,
    publishedAt: row.published_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function escapeHtml(value: string | null | undefined): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function buildJobManagementUrl(workerUrl: string, accountId: string, friendId: string): string {
  return `${workerUrl}/company/jobs?accountId=${encodeURIComponent(accountId)}&friendId=${encodeURIComponent(friendId)}`;
}

function buildCandidateJobsUrl(workerUrl: string, accountId: string, friendId: string): string {
  return `${workerUrl}/candidate/jobs?accountId=${encodeURIComponent(accountId)}&friendId=${encodeURIComponent(friendId)}`;
}

saiyoProJobs.get('/api/saiyo-pro/jobs', async (c) => {
  try {
    const lineAccountId = c.req.query('lineAccountId') ?? null;
    const companyFriendId = c.req.query('companyFriendId') ?? null;
    const status = (c.req.query('status') ?? 'all') as 'all' | 'draft' | 'published' | 'closed';
    const jobs = await getSaiyoProCompanyJobs(c.env.DB, {
      lineAccountId,
      companyFriendId,
      status,
      limit: 100,
    });
    return c.json({ success: true, data: jobs.map(serializeJob) });
  } catch (err) {
    console.error('GET /api/saiyo-pro/jobs error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

saiyoProJobs.get('/company/jobs', async (c) => {
  const accountId = c.req.query('accountId') ?? '';
  const friendId = c.req.query('friendId') ?? '';
  const saved = c.req.query('saved') === '1';

  const friend = friendId ? await getFriendById(c.env.DB, friendId) : null;
  if (!friend || friend.line_account_id !== accountId) {
    return c.html(renderErrorPage('求人管理を開けません', 'for Biz のLINEから「求人管理」を開き直してください。'), 403);
  }

  const [jobs, applications] = await Promise.all([
    getSaiyoProCompanyJobs(c.env.DB, { lineAccountId: accountId, companyFriendId: friendId, status: 'all', limit: 20 }),
    getSaiyoProJobApplicationsForCompany(c.env.DB, friendId),
  ]);
  const latest = jobs[0] ?? null;
  const companyName = latest?.company_name || friend.display_name || '会社名未設定';
  return c.html(renderCompanyJobsPage({
    accountId,
    friendId,
    companyName,
    jobs,
    applications,
    saved,
  }));
});

saiyoProJobs.post('/company/jobs', async (c) => {
  const body = await c.req.parseBody();
  const accountId = textValue(body.accountId);
  const friendId = textValue(body.friendId);
  const friend = friendId ? await getFriendById(c.env.DB, friendId) : null;
  if (!friend || friend.line_account_id !== accountId) {
    return c.html(renderErrorPage('求人を保存できません', 'for Biz のLINEから「求人管理」を開き直してください。'), 403);
  }

  const jobId = nullableText(body.jobId, 80);
  const payload = {
    companyName: textValue(body.companyName, 80) || friend.display_name || '会社名未設定',
    title: textValue(body.title, 100),
    employmentType: nullableText(body.employmentType, 40),
    wageLabel: nullableText(body.wageLabel, 80),
    workLocation: nullableText(body.workLocation, 120),
    workHours: nullableText(body.workHours, 120),
    description: nullableText(body.description, 500),
    requirements: nullableText(body.requirements, 500),
    bannerUrl: nullableText(body.bannerUrl, 500),
    status: textValue(body.status, 20) === 'draft' ? 'draft' as const : 'published' as const,
  };
  if (!payload.title) {
    return c.html(renderErrorPage('求人名が必要です', '求人名を入力して保存してください。'), 400);
  }

  if (jobId) {
    const existing = await getSaiyoProCompanyJobById(c.env.DB, jobId);
    if (!existing || existing.company_friend_id !== friendId) {
      return c.html(renderErrorPage('求人を更新できません', 'この求人は現在の企業アカウントに紐づいていません。'), 403);
    }
    await updateSaiyoProCompanyJob(c.env.DB, jobId, payload);
  } else {
    await createSaiyoProCompanyJob(c.env.DB, {
      lineAccountId: accountId,
      companyFriendId: friendId,
      ...payload,
    });
  }

  return c.redirect(buildJobManagementUrl(c.env.WORKER_URL || new URL(c.req.url).origin, accountId, friendId) + '&saved=1', 303);
});

saiyoProJobs.get('/candidate/jobs', async (c) => {
  const accountId = c.req.query('accountId') ?? '';
  const friendId = c.req.query('friendId') ?? '';
  const applied = c.req.query('applied') === '1';
  const friend = friendId ? await getFriendById(c.env.DB, friendId) : null;
  if (!friend || friend.line_account_id !== accountId) {
    return c.html(renderErrorPage('求人一覧を開けません', '求職者向けLINEから「求人を見る」を開き直してください。'), 403);
  }

  const jobs = await getSaiyoProCompanyJobs(c.env.DB, { status: 'published', limit: 50 });
  return c.html(renderCandidateJobsPage({ accountId, friendId, jobs, applied }));
});

saiyoProJobs.post('/candidate/jobs/apply', async (c) => {
  const body = await c.req.parseBody();
  const accountId = textValue(body.accountId);
  const friendId = textValue(body.friendId);
  const jobId = textValue(body.jobId);
  const [friend, job] = await Promise.all([
    friendId ? getFriendById(c.env.DB, friendId) : Promise.resolve(null),
    jobId ? getSaiyoProCompanyJobById(c.env.DB, jobId) : Promise.resolve(null),
  ]);
  if (!friend || friend.line_account_id !== accountId || !job || job.status !== 'published') {
    return c.html(renderErrorPage('応募できません', '求人一覧からもう一度応募してください。'), 400);
  }

  await createSaiyoProJobApplication(c.env.DB, {
    jobId: job.id,
    candidateFriendId: friend.id,
    candidateLineAccountId: friend.line_account_id,
    companyFriendId: job.company_friend_id,
    message: nullableText(body.message, 300),
  });

  const workerUrl = c.env.WORKER_URL || new URL(c.req.url).origin;
  return c.redirect(buildCandidateJobsUrl(workerUrl, accountId, friendId) + '&applied=1', 303);
});

function renderCompanyJobsPage(input: {
  accountId: string;
  friendId: string;
  companyName: string;
  jobs: SaiyoProCompanyJob[];
  applications: Array<{ id: string; job_title: string; candidate_name: string | null; status: string; created_at: string }>;
  saved: boolean;
}): string {
  const latest = input.jobs[0] ?? null;
  const jobsHtml = input.jobs.length
    ? input.jobs.map((job) => `
      <article class="card">
        ${job.banner_url ? `<img class="banner" src="${escapeHtml(job.banner_url)}" alt="">` : ''}
        <div class="status ${job.status}">${job.status === 'published' ? '公開中' : job.status === 'draft' ? '下書き' : '停止中'}</div>
        <h2>${escapeHtml(job.title)}</h2>
        <p>${escapeHtml(job.wage_label || '給与未設定')} / ${escapeHtml(job.work_hours || '勤務時間未設定')}</p>
      </article>
    `).join('')
    : '<section class="card"><h2>掲載中の求人はまだありません</h2><p>下のフォームから最初の求人を作成できます。</p></section>';
  const applicationsHtml = input.applications.length
    ? input.applications.map((app) => `
      <div class="row"><strong>${escapeHtml(app.candidate_name || '名前未取得')}</strong><span>${escapeHtml(app.job_title)}</span></div>
    `).join('')
    : '<p class="muted">まだ応募者はいません。</p>';

  return pageShell('採用PRO 求人管理', `
    <header><div class="eyebrow">採用PRO for Biz</div><h1>求人管理</h1><p>${escapeHtml(input.companyName)} の求人を作成・公開できます。</p></header>
    <main>
      ${input.saved ? '<div class="notice">求人を保存しました。</div>' : ''}
      ${jobsHtml}
      <section class="card">
        <h2>${latest ? '求人を編集' : '求人を作成'}</h2>
        <form method="post" action="/company/jobs">
          <input type="hidden" name="accountId" value="${escapeHtml(input.accountId)}">
          <input type="hidden" name="friendId" value="${escapeHtml(input.friendId)}">
          <input type="hidden" name="jobId" value="${escapeHtml(latest?.id ?? '')}">
          <label>企業名<input name="companyName" value="${escapeHtml(latest?.company_name ?? input.companyName)}" required></label>
          <label>求人名<input name="title" value="${escapeHtml(latest?.title ?? '')}" placeholder="例: 未経験歓迎 カスタマーサポート" required></label>
          <label>雇用形態<input name="employmentType" value="${escapeHtml(latest?.employment_type ?? '')}" placeholder="例: 正社員 / アルバイト"></label>
          <label>給与<input name="wageLabel" value="${escapeHtml(latest?.wage_label ?? '')}" placeholder="例: 月給25万円〜 / 時給1,300円〜"></label>
          <label>勤務地<input name="workLocation" value="${escapeHtml(latest?.work_location ?? '')}" placeholder="例: 東京都渋谷区"></label>
          <label>勤務時間<input name="workHours" value="${escapeHtml(latest?.work_hours ?? '')}" placeholder="例: 10:00〜19:00 / 週3日〜"></label>
          <label>仕事内容<textarea name="description" placeholder="仕事内容、魅力、働き方など">${escapeHtml(latest?.description ?? '')}</textarea></label>
          <label>応募条件<textarea name="requirements" placeholder="必須条件・歓迎条件など">${escapeHtml(latest?.requirements ?? '')}</textarea></label>
          <label>バナー画像URL<input name="bannerUrl" value="${escapeHtml(latest?.banner_url ?? '')}" placeholder="https://..."></label>
          <label>公開状態<select name="status"><option value="published"${latest?.status !== 'draft' ? ' selected' : ''}>公開する</option><option value="draft"${latest?.status === 'draft' ? ' selected' : ''}>下書き</option></select></label>
          <button type="submit">求人を保存する</button>
        </form>
      </section>
      <section class="card"><h2>応募者</h2>${applicationsHtml}</section>
    </main>
  `);
}

function renderCandidateJobsPage(input: {
  accountId: string;
  friendId: string;
  jobs: SaiyoProCompanyJob[];
  applied: boolean;
}): string {
  const jobsHtml = input.jobs.length
    ? input.jobs.map((job) => `
      <article class="card job">
        ${job.banner_url ? `<img class="banner" src="${escapeHtml(job.banner_url)}" alt="">` : ''}
        <div class="eyebrow">${escapeHtml(job.company_name)}</div>
        <h2>${escapeHtml(job.title)}</h2>
        <p>${escapeHtml(job.employment_type || '雇用形態未設定')} / ${escapeHtml(job.wage_label || '給与未設定')}</p>
        <p>${escapeHtml(job.work_location || '勤務地未設定')}</p>
        <p>${escapeHtml(job.work_hours || '勤務時間未設定')}</p>
        ${job.description ? `<p>${escapeHtml(job.description)}</p>` : ''}
        <form method="post" action="/candidate/jobs/apply">
          <input type="hidden" name="accountId" value="${escapeHtml(input.accountId)}">
          <input type="hidden" name="friendId" value="${escapeHtml(input.friendId)}">
          <input type="hidden" name="jobId" value="${escapeHtml(job.id)}">
          <button type="submit">この求人に応募する</button>
        </form>
      </article>
    `).join('')
    : '<section class="card"><h2>公開中の求人はまだありません</h2><p>求人が公開されるとここに表示されます。</p></section>';

  return pageShell('採用PRO 求人を見る', `
    <header><div class="eyebrow">採用PRO</div><h1>求人を見る</h1><p>公開中の求人を確認できます。</p></header>
    <main>
      ${input.applied ? '<div class="notice">応募を受け付けました。担当者からの連絡をお待ちください。</div>' : ''}
      ${jobsHtml}
    </main>
  `);
}

function renderErrorPage(title: string, description: string): string {
  return pageShell(title, `<main><section class="card"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(description)}</p></section></main>`);
}

function pageShell(title: string, body: string): string {
  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>${escapeHtml(title)}</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Hiragino Sans", "Yu Gothic", system-ui, sans-serif; background: #f3f8f7; color: #071526; }
    header { padding: 22px 18px 12px; background: #fff; border-bottom: 1px solid #dbe7e5; }
    header h1 { margin: 4px 0 6px; font-size: 25px; line-height: 1.25; }
    header p, .muted { color: #5d6b7a; line-height: 1.7; }
    main { padding: 14px 14px calc(28px + env(safe-area-inset-bottom)); display: grid; gap: 12px; }
    .card { background: #fff; border: 1px solid #dbe7e5; border-radius: 16px; padding: 14px; box-shadow: 0 1px 2px rgba(15,23,42,.04); }
    .card h2 { margin: 0 0 10px; font-size: 18px; line-height: 1.35; }
    .card p { margin: 7px 0; line-height: 1.7; }
    .eyebrow { font-size: 12px; font-weight: 900; color: #0fb7b3; letter-spacing: .02em; }
    .notice { border-radius: 14px; padding: 12px 14px; background: #dcfce7; color: #166534; font-weight: 900; }
    .status { display: inline-flex; margin-bottom: 10px; padding: 4px 9px; border-radius: 999px; font-size: 12px; font-weight: 900; background: #e0f2fe; color: #075985; }
    .status.draft { background: #fef3c7; color: #92400e; }
    .status.closed { background: #e5e7eb; color: #4b5563; }
    .banner { width: 100%; aspect-ratio: 20 / 10; object-fit: cover; border-radius: 12px; margin-bottom: 12px; background: #e5e7eb; }
    form { display: grid; gap: 11px; }
    label { display: grid; gap: 6px; color: #344256; font-size: 12px; font-weight: 900; }
    input, textarea, select { width: 100%; border: 1px solid #cfd9df; border-radius: 12px; padding: 12px; font: inherit; font-size: 16px; background: #fff; }
    textarea { min-height: 96px; resize: vertical; line-height: 1.6; }
    button { min-height: 48px; border: 0; border-radius: 14px; background: linear-gradient(135deg, #08b9c8, #7bd323); color: #fff; font-size: 16px; font-weight: 900; }
    .row { display: grid; grid-template-columns: 1fr; gap: 2px; padding: 10px 0; border-top: 1px solid #edf2f4; }
    .row:first-child { border-top: 0; }
    .row span { color: #5d6b7a; font-size: 13px; }
  </style>
</head>
<body>${body}</body>
</html>`;
}

export {
  saiyoProJobs,
  buildJobManagementUrl,
  buildCandidateJobsUrl,
};
