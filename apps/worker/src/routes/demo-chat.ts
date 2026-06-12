import { Hono } from 'hono';
import { LineClient } from '@line-crm/line-sdk';
import { jstNow } from '@line-crm/db';
import type { Env } from '../index.js';
import {
  DEFAULT_COMPANY_JOB,
  DEFAULT_COMPANY_SETTINGS,
  DEMO_CANDIDATE_COMPANIES,
  DEMO_CANDIDATE_LINE_ACCOUNT_ID,
  DEMO_CANDIDATES,
  DEMO_CHAT_VERSION,
  DEMO_COMPANY_LINE_ACCOUNT_ID,
  DEMO_COMPANY_NAME,
  DEMO_SERVICE_NAME,
  DEMO_WORKER_URL,
  type DemoBannerPosition,
  type DemoCandidate,
  type DemoCandidateCompany,
  type DemoCandidateProfile,
  type DemoCandidateStatus,
  type DemoCompanyJob,
  type DemoCompanySettings,
} from './saiyo-pro-demo-data.js';
const demoChat = new Hono<Env>();

demoChat.use('*', async (c, next) => {
  await next();
  c.header('Cache-Control', 'no-store, max-age=0');
});

demoChat.get('/demo-chat', async (c) => {
  const candidates = await getDemoCandidates(c.env.DB);
  const candidate = resolveCandidateFromList(candidates, c.req.query('candidate'));
  if (!candidate) return c.html(renderDemoChatEmptyHtml());
  return c.html(renderDemoChatHtml(candidate, candidates));
});

demoChat.get('/demo-candidate-chat', async (c) => {
  const candidateId = c.req.query('candidate') ?? 'yamada';
  const candidate = DEMO_CANDIDATES[candidateId] ?? DEMO_CANDIDATES.yamada;
  if (c.req.query('status') === '1') {
    const status = await getDemoCandidateStatus(c.env.DB, candidate);
    return c.html(renderDemoCandidateStatusHtml(candidate, status));
  }
  const isMatched = c.req.query('matched') === '1';
  if (!isMatched) return c.html(renderDemoCandidateChatGateHtml(candidate));
  return c.html(renderDemoCandidateChatHtml(candidate));
});

demoChat.get('/demo-candidate-jobs', async (c) => {
  const candidateId = c.req.query('candidate') ?? 'yamada';
  const candidate = DEMO_CANDIDATES[candidateId] ?? DEMO_CANDIDATES.yamada;
  const companyId = c.req.query('company');
  const linkedCompanyName = sanitizeProfileField(c.req.query('companyName'), 60);
  if (!companyId && !linkedCompanyName) {
    const jobs = await getDemoCompanyJobs(c.env.DB);
    return c.html(renderDemoCandidateJobCardsHtml(candidate, jobs));
  }
  const job = await getDemoCompanyJob(c.env.DB, linkedCompanyName || undefined);
  const company = linkedCompanyName
    ? {
        id: `linked-${linkedCompanyName}`,
        name: linkedCompanyName,
        reason: '企業向けLINEから登録された会社の求人です。条件に合いそうな求人を確認できます。',
        color: '#2563EB',
        jobs: job ? [{ ...job, companyName: linkedCompanyName }] : [],
      }
    : DEMO_CANDIDATE_COMPANIES[companyId ?? 'default'] ?? DEMO_CANDIDATE_COMPANIES.default;
  const displayCompany = !linkedCompanyName && company.id === 'default' && job
    ? { ...company, jobs: [{ ...job, companyName: company.name }, ...company.jobs.slice(1)] }
    : company;
  return c.html(renderDemoCandidateJobsHtml(candidate, displayCompany));
});

demoChat.get('/demo-company-jobs', async (c) => {
  const companyName = sanitizeProfileField(c.req.query('companyName'), 60) || DEMO_COMPANY_NAME;
  const job = await getDemoCompanyJob(c.env.DB, companyName);
  return c.html(renderDemoCompanyJobsHtml(job, companyName));
});

demoChat.post('/demo-company-jobs/publish', async (c) => {
  const body = await c.req.json().catch(() => null) as Partial<DemoCompanyJob> | null;
  const job = normalizeDemoCompanyJob(body);
  const friendId = await getDemoLogFriendId(c.env.DB);
  if (!friendId) return c.json({ success: false, error: 'demo_friend_not_ready' }, 503);

  await c.env.DB
    .prepare(
      `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, delivery_type, source, line_account_id, created_at)
       VALUES (?, ?, 'outgoing', 'text', ?, NULL, NULL, 'push', ?, ?, ?)`,
    )
    .bind(crypto.randomUUID(), friendId, JSON.stringify(job), 'demo_company_job', DEMO_COMPANY_LINE_ACCOUNT_ID, jstNow())
    .run();

  const notified = await notifyCandidateNewJob(c.env.DB, job).catch((err) => {
    console.error('Failed to notify demo candidate job', err);
    return false;
  });
  const notificationCount = notified ? 1 : 0;

  return c.json({ success: true, data: { job, notified, notificationCount } });
});

demoChat.post('/demo-company-jobs/banner', async (c) => {
  try {
    if (!c.env.IMAGES) return c.json({ success: false, error: 'image_storage_not_ready' }, 503);
    const contentType = (c.req.header('Content-Type') || 'image/png').split(';')[0].toLowerCase();
    const normalizedType = contentType === 'image/jpg' || contentType === 'image/pjpeg' ? 'image/jpeg' : contentType;
    const allowedTypes = ['image/png', 'image/jpeg', 'image/webp'];
    if (!allowedTypes.includes(normalizedType)) {
      return c.json({ success: false, error: 'PNG/JPEG/WebPの画像を選んでください。' }, 400);
    }

    const data = await c.req.arrayBuffer();
    if (data.byteLength === 0) return c.json({ success: false, error: '画像ファイルが空です。' }, 400);
    if (data.byteLength > 10 * 1024 * 1024) {
      return c.json({ success: false, error: '画像は10MB以内にしてください。' }, 400);
    }

    const ext = normalizedType === 'image/jpeg' ? 'jpg' : normalizedType.split('/')[1];
    const key = `demo-job-banners/${crypto.randomUUID()}.${ext}`;
    await c.env.IMAGES.put(key, data, {
      httpMetadata: { contentType: normalizedType },
      customMetadata: { source: 'demo-company-jobs' },
    });

    const workerUrl = c.env.WORKER_URL || new URL(c.req.url).origin;
    return c.json({ success: true, data: { key, url: `${workerUrl}/images/${key}`, mimeType: normalizedType, size: data.byteLength } }, 201);
  } catch (err) {
    console.error('POST /demo-company-jobs/banner error:', err);
    return c.json({ success: false, error: '画像をアップロードできませんでした。' }, 500);
  }
});

demoChat.get('/demo-company-settings', (c) => {
  return c.html(renderDemoCompanySettingsHtml());
});

demoChat.get('/demo-chat/profile', async (c) => {
  const candidate = await resolveDemoCandidate(c.env.DB, c.req.query('candidate'));
  if (!candidate) return c.json({ success: false, error: 'candidate_not_found' }, 404);
  const profile = await getDemoCandidateProfile(c.env.DB, candidate);
  return c.json({ success: true, data: { candidate, profile } });
});

demoChat.post('/demo-chat/profile', async (c) => {
  const body = await c.req.json().catch(() => null) as Partial<DemoCandidateProfile> & { candidate?: string } | null;
  const candidate = DEMO_CANDIDATES[body?.candidate ?? body?.candidateId ?? ''] ?? DEMO_CANDIDATES.yamada;
  const profile = normalizeDemoCandidateProfile(candidate, body);
  if (!profile.fullName) return c.json({ success: false, error: 'full_name_required' }, 400);

  const friendId = await getDemoLogFriendId(c.env.DB);
  if (!friendId) return c.json({ success: false, error: 'demo_friend_not_ready' }, 503);

  await c.env.DB
    .prepare(
      `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, delivery_type, source, line_account_id, created_at)
       VALUES (?, ?, 'incoming', 'text', ?, NULL, NULL, NULL, 'demo_candidate_profile', ?, ?)`,
    )
    .bind(crypto.randomUUID(), friendId, JSON.stringify(profile), DEMO_CANDIDATE_LINE_ACCOUNT_ID, jstNow())
    .run();

  return c.json({ success: true, data: { candidate, profile } });
});

demoChat.get('/demo-chat/settings', async (c) => {
  const settings = await getDemoCompanySettings(c.env.DB);
  return c.json({ success: true, data: { settings } });
});

demoChat.post('/demo-chat/settings', async (c) => {
  const body = await c.req.json().catch(() => null) as Partial<DemoCompanySettings> | null;
  const settings = normalizeDemoCompanySettings(body);
  const friendId = await getDemoLogFriendId(c.env.DB);
  if (!friendId) return c.json({ success: false, error: 'demo_friend_not_ready' }, 503);

  await c.env.DB
    .prepare(
      `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, delivery_type, source, line_account_id, created_at)
       VALUES (?, ?, 'incoming', 'text', ?, NULL, NULL, NULL, 'demo_company_settings', ?, ?)`,
    )
    .bind(crypto.randomUUID(), friendId, JSON.stringify(settings), DEMO_COMPANY_LINE_ACCOUNT_ID, jstNow())
    .run();

  return c.json({ success: true, data: { settings } });
});

demoChat.post('/demo-chat/status', async (c) => {
  const body = await c.req.json().catch(() => null) as { candidate?: string; status?: string } | null;
  const candidate = await resolveDemoCandidate(c.env.DB, body?.candidate);
  if (!candidate) return c.json({ success: false, error: 'candidate_not_found' }, 404);
  const status = normalizeDemoCandidateStatus(candidate, body?.status);
  const friendId = await getDemoLogFriendId(c.env.DB);
  if (!friendId) return c.json({ success: false, error: 'demo_friend_not_ready' }, 503);

  await c.env.DB
    .prepare(
      `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, delivery_type, source, line_account_id, created_at)
       VALUES (?, ?, 'incoming', 'text', ?, NULL, NULL, NULL, 'demo_candidate_status', ?, ?)`,
    )
    .bind(crypto.randomUUID(), friendId, JSON.stringify(status), DEMO_COMPANY_LINE_ACCOUNT_ID, jstNow())
    .run();

  if (isTerminalDemoCandidateStatus(status)) {
    await notifyCandidateStatusChange(c.env.DB, candidate, status).catch((err) => {
      console.error('Failed to notify demo candidate status change', err);
    });
  }

  return c.json({ success: true, data: { candidate, status } });
});

demoChat.get('/demo-chat/status', async (c) => {
  const candidate = await resolveDemoCandidate(c.env.DB, c.req.query('candidate'));
  if (!candidate) return c.json({ success: false, error: 'candidate_not_found' }, 404);
  const status = await getDemoCandidateStatus(c.env.DB, candidate);
  return c.json({ success: true, data: { candidate, status } });
});

demoChat.post('/demo-chat/interview', async (c) => {
  const body = await c.req.json().catch(() => null) as { candidate?: string } | null;
  const candidate = await resolveDemoCandidate(c.env.DB, body?.candidate);
  if (!candidate) return c.json({ success: false, error: 'candidate_not_found' }, 404);
  const settings = await getDemoCompanySettings(c.env.DB);
  const text = `${settings.interviewMessage}\n${settings.interviewUrl}`;

  const lineAccount = await c.env.DB
    .prepare('SELECT channel_access_token FROM line_accounts WHERE id = ? AND is_active = 1')
    .bind(DEMO_CANDIDATE_LINE_ACCOUNT_ID)
    .first<{ channel_access_token: string }>();
  const candidateLineUserId = candidate.lineUserId ?? await getRememberedCandidateLineUserId(c.env.DB);
  if (!lineAccount?.channel_access_token || !candidateLineUserId) {
    return c.json({ success: false, error: 'candidate_line_not_ready' }, 503);
  }

  const client = new LineClient(lineAccount.channel_access_token);
  await client.pushMessage(candidateLineUserId, [{
    type: 'flex',
    altText: `${settings.companyName}から面接日程のご案内`,
    contents: buildCandidateThreadOpenFlex(candidate, text),
  }]);

  const friendId = await getDemoLogFriendId(c.env.DB);
  if (friendId) {
    const status = normalizeDemoCandidateStatus(candidate, 'interview');
    await c.env.DB.batch([
      c.env.DB
        .prepare(
          `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, delivery_type, source, line_account_id, created_at)
           VALUES (?, ?, 'outgoing', 'text', ?, NULL, NULL, 'push', 'demo_candidate_thread', ?, ?)`,
        )
        .bind(crypto.randomUUID(), friendId, `${candidate.name}: ${text}`, DEMO_CANDIDATE_LINE_ACCOUNT_ID, jstNow()),
      c.env.DB
        .prepare(
          `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, delivery_type, source, line_account_id, created_at)
           VALUES (?, ?, 'incoming', 'text', ?, NULL, NULL, NULL, 'demo_candidate_status', ?, ?)`,
        )
        .bind(crypto.randomUUID(), friendId, JSON.stringify(status), DEMO_COMPANY_LINE_ACCOUNT_ID, jstNow()),
    ]);
  }

  return c.json({ success: true, data: { candidate, sent: true } });
});

demoChat.get('/demo-chat/messages', async (c) => {
  const candidate = await resolveDemoCandidate(c.env.DB, c.req.query('candidate'));
  if (!candidate) return c.json({ success: false, error: 'candidate_not_found' }, 404);
  const result = await c.env.DB
    .prepare(
      `SELECT direction, source, message_type, content, created_at
         FROM messages_log
        WHERE content LIKE ?
          AND source IN ('demo_candidate_thread','demo_candidate_thread_reply','demo_candidate_preset','demo_candidate_forward','demo_candidate_reply_notification')
        ORDER BY created_at DESC
        LIMIT 30`,
    )
    .bind(`%${candidate.name}%`)
    .all<{ direction: string; source: string; message_type: string; content: string; created_at: string }>();

  const items = (result.results ?? [])
    .reverse()
    .map((row) => ({
      direction: row.direction,
      source: row.source,
      text: extractReadableText(row.content, candidate.name),
      createdAt: row.created_at,
    }))
    .filter((row) => row.text);

  return c.json({ success: true, data: { candidate, items } });
});

demoChat.post('/demo-chat/send', async (c) => {
  const body = await c.req.json().catch(() => null) as { candidate?: string; text?: string } | null;
  const candidate = await resolveDemoCandidate(c.env.DB, body?.candidate);
  if (!candidate) return c.json({ success: false, error: 'candidate_not_found' }, 404);
  const text = body?.text?.trim();
  if (!text) return c.json({ success: false, error: 'message_required' }, 400);
  const status = await getDemoCandidateStatus(c.env.DB, candidate);
  if (isTerminalDemoCandidateStatus(status)) {
    return c.json({ success: false, error: 'candidate_closed', data: { status } }, 409);
  }

  const lineAccount = await c.env.DB
    .prepare('SELECT channel_access_token FROM line_accounts WHERE id = ? AND is_active = 1')
    .bind(DEMO_CANDIDATE_LINE_ACCOUNT_ID)
    .first<{ channel_access_token: string }>();
  const candidateLineUserId = candidate.lineUserId ?? await getRememberedCandidateLineUserId(c.env.DB);
  if (!lineAccount?.channel_access_token || !candidateLineUserId) {
    return c.json({ success: false, error: 'candidate_line_not_ready' }, 503);
  }

  const client = new LineClient(lineAccount.channel_access_token);
  await client.pushMessage(candidateLineUserId, [{
    type: 'flex',
    altText: `${DEMO_COMPANY_NAME}からメッセージ`,
    contents: buildCandidateThreadOpenFlex(candidate, text),
  }]);

  const friendId = await getDemoLogFriendId(c.env.DB);
  if (friendId) {
    await c.env.DB
      .prepare(
        `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, delivery_type, source, line_account_id, created_at)
         VALUES (?, ?, 'outgoing', 'text', ?, NULL, NULL, 'push', 'demo_candidate_thread', ?, ?)`,
      )
      .bind(crypto.randomUUID(), friendId, `${candidate.name}: ${text}`, DEMO_CANDIDATE_LINE_ACCOUNT_ID, jstNow())
      .run();
  }

  return c.json({ success: true, data: { sent: true } });
});

demoChat.post('/demo-candidate-chat/send', async (c) => {
  const body = await c.req.json().catch(() => null) as { candidate?: string; text?: string } | null;
  const candidate = DEMO_CANDIDATES[body?.candidate ?? ''] ?? DEMO_CANDIDATES.yamada;
  const text = body?.text?.trim();
  if (!text) return c.json({ success: false, error: 'message_required' }, 400);
  const status = await getDemoCandidateStatus(c.env.DB, candidate);
  if (isTerminalDemoCandidateStatus(status)) {
    return c.json({ success: false, error: 'candidate_closed', data: { status } }, 409);
  }

  const lineAccount = await c.env.DB
    .prepare('SELECT channel_access_token FROM line_accounts WHERE id = ? AND is_active = 1')
    .bind(DEMO_COMPANY_LINE_ACCOUNT_ID)
    .first<{ channel_access_token: string }>();
  const companyLineUserId = await getRememberedCompanyLineUserId(c.env.DB);
  if (!lineAccount?.channel_access_token || !companyLineUserId) {
    return c.json({ success: false, error: 'company_line_not_ready' }, 503);
  }

  const client = new LineClient(lineAccount.channel_access_token);
  await client.pushMessage(companyLineUserId, [{
    type: 'flex',
    altText: `${candidate.name}から返信`,
    contents: buildCompanyThreadNotificationFlex(candidate, text),
  }]);

  const friendId = await getDemoLogFriendId(c.env.DB);
  if (friendId) {
    await c.env.DB
      .prepare(
        `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, delivery_type, source, line_account_id, created_at)
         VALUES (?, ?, 'incoming', 'text', ?, NULL, NULL, NULL, 'demo_candidate_thread_reply', ?, ?)`,
      )
      .bind(crypto.randomUUID(), friendId, `${candidate.name}: ${text}`, DEMO_CANDIDATE_LINE_ACCOUNT_ID, jstNow())
      .run();
  }

  return c.json({ success: true, data: { sent: true } });
});

async function getRememberedCandidateLineUserId(db: D1Database): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT line_user_id
         FROM friends
        WHERE line_account_id = ?
        ORDER BY updated_at DESC
        LIMIT 1`,
    )
    .bind(DEMO_CANDIDATE_LINE_ACCOUNT_ID)
    .first<{ line_user_id: string }>();
  return row?.line_user_id ?? null;
}

async function getPrimaryDemoCandidateLineUserId(db: D1Database): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT line_user_id
         FROM friends
        WHERE line_account_id = ?
          AND is_following = 1
        ORDER BY
          CASE
            WHEN LOWER(COALESCE(display_name, '')) LIKE '%ikki%' THEN 0
            WHEN COALESCE(display_name, '') LIKE '%いっき%' THEN 0
            WHEN COALESCE(display_name, '') LIKE '%山本%' THEN 0
            ELSE 1
          END,
          created_at ASC
        LIMIT 1`,
    )
    .bind(DEMO_CANDIDATE_LINE_ACCOUNT_ID)
    .first<{ line_user_id: string }>();
  return row?.line_user_id ?? null;
}

async function getRememberedCompanyLineUserId(db: D1Database): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT line_user_id, metadata
         FROM friends
        WHERE metadata LIKE '%demo_company_line_user_id%'
        ORDER BY updated_at DESC
        LIMIT 1`,
    )
    .first<{ line_user_id: string; metadata: string | null }>();
  if (row?.metadata) {
    try {
      const parsed = JSON.parse(row.metadata) as Record<string, unknown>;
      const remembered = parsed.demo_company_line_user_id;
      if (typeof remembered === 'string' && remembered) return remembered;
    } catch {
      // Fall back to the latest line_user_id on the same row.
    }
  }
  return row?.line_user_id ?? null;
}

async function getDemoLogFriendId(db: D1Database): Promise<string | null> {
  const row = await db
    .prepare(`SELECT id FROM friends ORDER BY updated_at DESC LIMIT 1`)
    .first<{ id: string }>();
  return row?.id ?? null;
}

async function getDemoCandidateProfile(db: D1Database, candidate: DemoCandidate): Promise<DemoCandidateProfile | null> {
  const row = await db
    .prepare(
      `SELECT content
         FROM messages_log
        WHERE source = 'demo_candidate_profile'
          AND content LIKE ?
        ORDER BY created_at DESC
        LIMIT 1`,
    )
    .bind(`%"candidateId":"${candidate.id}"%`)
    .first<{ content: string }>();
  if (!row?.content) return null;
  try {
    return normalizeDemoCandidateProfile(candidate, JSON.parse(row.content) as Partial<DemoCandidateProfile>);
  } catch {
    return null;
  }
}

async function getDemoCompanySettings(db: D1Database): Promise<DemoCompanySettings> {
  const row = await db
    .prepare(
      `SELECT content
         FROM messages_log
        WHERE source = 'demo_company_settings'
        ORDER BY created_at DESC
        LIMIT 1`,
    )
    .first<{ content: string }>();
  if (!row?.content) return DEFAULT_COMPANY_SETTINGS;
  try {
    return normalizeDemoCompanySettings(JSON.parse(row.content) as Partial<DemoCompanySettings>);
  } catch {
    return DEFAULT_COMPANY_SETTINGS;
  }
}

async function getDemoCompanyJob(db: D1Database, companyName?: string): Promise<DemoCompanyJob | null> {
  const rows = await db
    .prepare(
      `SELECT content
         FROM messages_log
        WHERE source = 'demo_company_job'
        ORDER BY created_at DESC
        LIMIT 50`,
    )
    .all<{ content: string }>();
  const normalizedCompanyName = sanitizeProfileField(companyName, 60);
  for (const row of rows.results ?? []) {
    if (!row?.content) continue;
    try {
      const job = normalizeDemoCompanyJob(JSON.parse(row.content) as Partial<DemoCompanyJob>);
      if (!normalizedCompanyName || job.companyName === normalizedCompanyName) return job;
    } catch {
      // Ignore broken demo rows and continue to older entries.
    }
  }
  return null;
}

async function getDemoCompanyJobs(db: D1Database): Promise<DemoCompanyJob[]> {
  const rows = await db
    .prepare(
      `SELECT content
         FROM messages_log
        WHERE source = 'demo_company_job'
        ORDER BY created_at DESC
        LIMIT 50`,
    )
    .all<{ content: string }>();
  const seenCompanyNames = new Set<string>();
  const jobs: DemoCompanyJob[] = [];
  for (const row of rows.results ?? []) {
    if (!row?.content) continue;
    try {
      const job = normalizeDemoCompanyJob(JSON.parse(row.content) as Partial<DemoCompanyJob>);
      if (seenCompanyNames.has(job.companyName)) continue;
      seenCompanyNames.add(job.companyName);
      jobs.push(job);
    } catch {
      // Ignore broken demo rows and continue to older entries.
    }
  }
  return jobs;
}

async function getDemoCandidateStatus(db: D1Database, candidate: DemoCandidate): Promise<DemoCandidateStatus> {
  const row = await db
    .prepare(
      `SELECT content
         FROM messages_log
        WHERE source = 'demo_candidate_status'
          AND content LIKE ?
        ORDER BY created_at DESC
        LIMIT 1`,
    )
    .bind(`%"candidateId":"${candidate.id}"%`)
    .first<{ content: string }>();
  if (!row?.content) return normalizeDemoCandidateStatus(candidate, 'active');
  try {
    const parsed = JSON.parse(row.content) as Partial<DemoCandidateStatus>;
    return normalizeDemoCandidateStatus(candidate, parsed.status);
  } catch {
    return normalizeDemoCandidateStatus(candidate, 'active');
  }
}

function normalizeDemoCompanySettings(body: Partial<DemoCompanySettings> | null): DemoCompanySettings {
  return {
    companyName: sanitizeProfileField(body?.companyName, 60) || DEFAULT_COMPANY_SETTINGS.companyName,
    staffName: sanitizeProfileField(body?.staffName, 40) || DEFAULT_COMPANY_SETTINGS.staffName,
    interviewUrl: sanitizeProfileField(body?.interviewUrl, 200) || DEFAULT_COMPANY_SETTINGS.interviewUrl,
    interviewMessage: sanitizeProfileField(body?.interviewMessage, 180) || DEFAULT_COMPANY_SETTINGS.interviewMessage,
  };
}

function normalizeDemoCompanyJob(body: Partial<DemoCompanyJob> | null): DemoCompanyJob {
  return {
    companyName: sanitizeProfileField(body?.companyName, 60) || DEFAULT_COMPANY_JOB.companyName,
    title: sanitizeProfileField(body?.title, 80) || DEFAULT_COMPANY_JOB.title,
    hourlyWage: sanitizeProfileField(body?.hourlyWage, 80) || DEFAULT_COMPANY_JOB.hourlyWage,
    shift: sanitizeProfileField(body?.shift, 100) || DEFAULT_COMPANY_JOB.shift,
    description: sanitizeProfileField(body?.description, 220) || DEFAULT_COMPANY_JOB.description,
    bannerUrl: sanitizeDemoImageUrl(body?.bannerUrl) || DEFAULT_COMPANY_JOB.bannerUrl,
    bannerPosition: normalizeDemoBannerPosition(body?.bannerPosition),
    bannerOffsetX: normalizeDemoBannerOffset(body?.bannerOffsetX),
    bannerOffsetY: normalizeDemoBannerOffset(body?.bannerOffsetY),
    bannerZoom: normalizeDemoBannerZoom(body?.bannerZoom),
  };
}

function normalizeDemoBannerPosition(value: unknown): DemoBannerPosition {
  return value === 'top' || value === 'bottom' || value === 'left' || value === 'right' || value === 'center'
    ? value
    : DEFAULT_COMPANY_JOB.bannerPosition;
}

function normalizeDemoBannerZoom(value: unknown): number {
  const raw = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(raw)) return DEFAULT_COMPANY_JOB.bannerZoom;
  return Math.min(1.8, Math.max(1, Math.round(raw * 100) / 100));
}

function normalizeDemoBannerOffset(value: unknown): number {
  const raw = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(raw)) return 0;
  return Math.min(45, Math.max(-45, Math.round(raw * 10) / 10));
}

function demoBannerObjectPosition(position: DemoBannerPosition): string {
  const positions: Record<DemoBannerPosition, string> = {
    center: 'center center',
    top: 'center top',
    bottom: 'center bottom',
    left: 'left center',
    right: 'right center',
  };
  return positions[position];
}

function demoBannerFlexGravity(position: DemoBannerPosition): 'top' | 'bottom' | 'center' {
  if (position === 'top') return 'top';
  if (position === 'bottom') return 'bottom';
  return 'center';
}

function demoBannerStyle(job: DemoCompanyJob): string {
  return `object-position: ${demoBannerObjectPosition(job.bannerPosition)}; transform: translate(${job.bannerOffsetX}%, ${job.bannerOffsetY}%) scale(${job.bannerZoom});`;
}

function sanitizeDemoImageUrl(value: unknown): string | null {
  const url = sanitizeProfileField(value, 300);
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function normalizeDemoCandidateStatus(candidate: DemoCandidate, value: unknown): DemoCandidateStatus {
  const status = value === 'interview' || value === 'rejected' || value === 'archived' ? value : 'active';
  const labels: Record<DemoCandidateStatus['status'], string> = {
    active: 'やり取り中',
    interview: '面接',
    rejected: '不合格',
    archived: '削除済み',
  };
  return {
    candidateId: candidate.id,
    status,
    label: labels[status],
  };
}

function isTerminalDemoCandidateStatus(status: DemoCandidateStatus): boolean {
  return status.status === 'rejected' || status.status === 'archived';
}

function normalizeDemoCandidateProfile(candidate: DemoCandidate, body: Partial<DemoCandidateProfile> | null): DemoCandidateProfile {
  return {
    candidateId: candidate.id,
    fullName: sanitizeProfileField(body?.fullName, 40),
    kana: sanitizeProfileField(body?.kana, 60),
    phone: sanitizeProfileField(body?.phone, 30),
    availability: sanitizeProfileField(body?.availability, 80),
    memo: sanitizeProfileField(body?.memo, 180),
  };
}

function sanitizeProfileField(value: unknown, maxLength: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function buildCandidateThreadOpenFlex(candidate: DemoCandidate, text: string): Record<string, unknown> {
  return {
    type: 'bubble',
    size: 'mega',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: '#111827',
      paddingAll: '16px',
      contents: [
        { type: 'text', text: '企業からメッセージ', size: 'xs', color: '#FFFFFF', weight: 'bold' },
        { type: 'text', text: DEMO_COMPANY_NAME, size: 'lg', color: '#FFFFFF', weight: 'bold', margin: 'sm', wrap: true },
      ],
    },
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'md',
      paddingAll: '16px',
      contents: [
        { type: 'text', text, size: 'sm', color: '#111827', wrap: true },
        { type: 'separator', margin: 'md' },
        { type: 'text', text: '返信は専用チャット画面でできます。LINE本体のトークを汚さずに履歴を見返せます。', size: 'xs', color: '#6B7280', wrap: true },
      ],
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '12px',
      contents: [
        { type: 'button', style: 'primary', color: candidate.color, height: 'sm', action: { type: 'uri', label: '返信する', uri: `${DEMO_WORKER_URL}/demo-candidate-chat?candidate=${encodeURIComponent(candidate.id)}&matched=1&v=${DEMO_CHAT_VERSION}` } },
      ],
    },
  };
}

function buildCompanyThreadNotificationFlex(candidate: DemoCandidate, text: string): Record<string, unknown> {
  return {
    type: 'bubble',
    size: 'mega',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: candidate.color,
      paddingAll: '16px',
      contents: [
        { type: 'text', text: '新着メッセージ', size: 'xs', color: '#FFFFFF', weight: 'bold' },
        { type: 'text', text: candidate.name, size: 'xl', color: '#FFFFFF', weight: 'bold', margin: 'sm', wrap: true },
      ],
    },
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'md',
      paddingAll: '16px',
      contents: [
        { type: 'text', text, size: 'sm', color: '#111827', wrap: true },
        { type: 'separator', margin: 'md' },
        { type: 'text', text: '専用チャット画面から返信できます。', size: 'xs', color: '#6B7280', wrap: true },
      ],
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '12px',
      contents: [
        { type: 'button', style: 'primary', color: candidate.color, height: 'sm', action: { type: 'uri', label: '返信する', uri: `${DEMO_WORKER_URL}/demo-chat?candidate=${encodeURIComponent(candidate.id)}` } },
      ],
    },
  };
}

async function notifyCandidateStatusChange(db: D1Database, candidate: DemoCandidate, status: DemoCandidateStatus): Promise<void> {
  const lineAccount = await db
    .prepare('SELECT channel_access_token FROM line_accounts WHERE id = ? AND is_active = 1')
    .bind(DEMO_CANDIDATE_LINE_ACCOUNT_ID)
    .first<{ channel_access_token: string }>();
  const candidateLineUserId = candidate.lineUserId ?? await getRememberedCandidateLineUserId(db);
  if (!lineAccount?.channel_access_token || !candidateLineUserId) return;

  const client = new LineClient(lineAccount.channel_access_token);
  await client.pushMessage(candidateLineUserId, [{
    type: 'flex',
    altText: status.status === 'rejected' ? '選考結果のご連絡' : 'やり取り終了のお知らせ',
    contents: buildCandidateStatusNotificationFlex(candidate, status),
  }]);
}

async function notifyCandidateNewJob(db: D1Database, job: DemoCompanyJob): Promise<boolean> {
  const [lineAccount, candidateLineUserId] = await Promise.all([
    db
      .prepare('SELECT channel_access_token FROM line_accounts WHERE id = ? AND is_active = 1')
      .bind(DEMO_CANDIDATE_LINE_ACCOUNT_ID)
      .first<{ channel_access_token: string }>(),
    getPrimaryDemoCandidateLineUserId(db).then((lineUserId) => lineUserId ?? getRememberedCandidateLineUserId(db)),
  ]);
  if (!lineAccount?.channel_access_token || !candidateLineUserId) return false;

  const client = new LineClient(lineAccount.channel_access_token);
  await client.pushMessage(candidateLineUserId, [{
    type: 'flex',
    altText: 'あなたにあった求人が届きました！！',
    contents: buildCandidateJobNotificationFlex(job),
  }]);
  return true;
}

function buildCandidateJobNotificationFlex(job: DemoCompanyJob): Record<string, unknown> {
  return {
    type: 'bubble',
    size: 'mega',
    hero: {
      type: 'image',
      url: job.bannerUrl,
      size: 'full',
      aspectRatio: '20:10',
      aspectMode: 'cover',
      gravity: demoBannerFlexGravity(job.bannerPosition),
    },
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: '#2563EB',
      paddingAll: '16px',
      contents: [
        { type: 'text', text: 'あなたにあった求人が届きました！！', size: 'xs', color: '#FFFFFF', weight: 'bold', wrap: true },
        { type: 'text', text: job.companyName, size: 'lg', color: '#FFFFFF', weight: 'bold', margin: 'sm', wrap: true },
      ],
    },
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'md',
      paddingAll: '16px',
      contents: [
        { type: 'text', text: job.title, size: 'md', color: '#111827', weight: 'bold', wrap: true },
        { type: 'text', text: 'プロフィールと会話内容から、条件が近そうな求人として表示しています。', size: 'xs', color: '#6B7280', wrap: true },
        { type: 'text', text: job.hourlyWage, size: 'sm', color: '#374151', wrap: true },
        { type: 'text', text: job.shift, size: 'sm', color: '#374151', wrap: true },
      ],
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '12px',
      contents: [
        { type: 'button', style: 'primary', color: '#2563EB', height: 'sm', action: { type: 'uri', label: '会社を見る', uri: `${DEMO_WORKER_URL}/demo-candidate-jobs?candidate=yamada&companyName=${encodeURIComponent(job.companyName)}` } },
      ],
    },
  };
}

function buildCandidateStatusNotificationFlex(candidate: DemoCandidate, status: DemoCandidateStatus): Record<string, unknown> {
  const isRejected = status.status === 'rejected';
  const title = isRejected ? '選考結果のご連絡' : 'やり取り終了のお知らせ';
  const body = isRejected
    ? '今回は選考結果として不合格が通知されました。ご応募ありがとうございました。'
    : 'この応募について、企業側でやり取りが終了されました。以降このチャットでは返信できません。';
  return {
    type: 'bubble',
    size: 'mega',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: isRejected ? '#6B7280' : '#111827',
      paddingAll: '16px',
      contents: [
        { type: 'text', text: title, size: 'xs', color: '#FFFFFF', weight: 'bold' },
        { type: 'text', text: DEMO_COMPANY_NAME, size: 'lg', color: '#FFFFFF', weight: 'bold', margin: 'sm', wrap: true },
      ],
    },
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'md',
      paddingAll: '16px',
      contents: [
        { type: 'text', text: body, size: 'sm', color: '#111827', wrap: true },
        { type: 'separator', margin: 'md' },
        { type: 'text', text: `${candidate.name}さんの対応チャットは停止されています。`, size: 'xs', color: '#6B7280', wrap: true },
      ],
    },
  };
}

function extractReadableText(content: string, candidateName: string): string {
  if (content.startsWith('{')) {
    try {
      const textValues: string[] = [];
      collectTextValues(JSON.parse(content), textValues);
      const compact = textValues
        .filter((value) => value && !['送信しました', '送信しました（デモ）', '企業からメッセージ'].includes(value))
        .join(' / ');
      return compact.slice(0, 180);
    } catch {
      return '';
    }
  }
  return content.replace(/^候補者へ転送（デモ）:\s*/, '').replace(`${candidateName} / `, '').replace(`${candidateName}: `, '');
}

function collectTextValues(value: unknown, out: string[]): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) collectTextValues(item, out);
    return;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.text === 'string') out.push(record.text);
  for (const item of Object.values(record)) collectTextValues(item, out);
}

async function getDemoCandidates(db: D1Database): Promise<DemoCandidate[]> {
  const result = await db
    .prepare(
      `SELECT id, line_user_id, display_name, created_at, updated_at
         FROM friends
        WHERE line_account_id = ?
          AND is_following = 1
        ORDER BY updated_at DESC
        LIMIT 50`,
    )
    .bind(DEMO_CANDIDATE_LINE_ACCOUNT_ID)
    .all<{
      id: string;
      line_user_id: string;
      display_name: string | null;
      created_at: string;
      updated_at: string;
    }>();

  return (result.results ?? []).map((row, index) => ({
    id: row.id,
    name: sanitizeProfileField(row.display_name, 40) || `応募者 ${index + 1}`,
    job: '採用PRO 求人案内対象者',
    color: demoCandidateColor(row.id),
    status: '応募受付',
    lastMessage: '応募ありがとうございます。詳細を確認中です。',
    lineUserId: row.line_user_id,
    airworkProfile: {
      fullName: sanitizeProfileField(row.display_name, 40) || `応募者 ${index + 1}`,
      kana: '',
      phone: '',
      availability: '',
      memo: `LINE登録: ${row.created_at.slice(0, 10)}`,
    },
  }));
}

async function resolveDemoCandidate(db: D1Database, candidateId: string | null | undefined): Promise<DemoCandidate | null> {
  const candidates = await getDemoCandidates(db);
  return resolveCandidateFromList(candidates, candidateId);
}

function resolveCandidateFromList(candidates: DemoCandidate[], candidateId: string | null | undefined): DemoCandidate | null {
  if (candidates.length === 0) return null;
  if (!candidateId) return candidates[0] ?? null;
  return candidates.find((candidate) => candidate.id === candidateId || candidate.lineUserId === candidateId) ?? candidates[0] ?? null;
}

function demoCandidateColor(seed: string): string {
  const colors = ['#16A34A', '#0EA5E9', '#2563EB', '#EA580C', '#7C3AED', '#0F766E'];
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return colors[hash % colors.length] ?? colors[0];
}

function renderDemoCandidateSwitcher(activeCandidateId: string, candidates: DemoCandidate[]): string {
  return `<nav class="candidate-switcher" aria-label="応募者切替">
      <div class="candidate-switcher-title">候補者リスト</div>
      <div class="candidate-tabs">
        ${candidates.map((item) => `<a class="candidate-tab${item.id === activeCandidateId ? ' active' : ''}" href="${DEMO_WORKER_URL}/demo-chat?candidate=${encodeURIComponent(item.id)}">
          <span class="candidate-tab-name">${escapeHtml(item.name)}</span>
          <span class="candidate-tab-meta">対応チャット</span>
        </a>`).join('')}
      </div>
    </nav>`;
}

function renderDemoChatEmptyHtml(): string {
  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>採用PRO 応募者対応</title>
  <style>
    body { margin: 0; min-height: 100dvh; display: grid; place-items: center; font-family: -apple-system, BlinkMacSystemFont, "Hiragino Sans", "Yu Gothic", system-ui, sans-serif; background: #eef2f7; color: #111827; }
    .empty { width: min(92vw, 420px); padding: 24px; border-radius: 18px; background: #fff; box-shadow: 0 10px 30px rgba(15,23,42,.08); }
    h1 { margin: 0 0 8px; font-size: 20px; }
    p { margin: 0; color: #4b5563; line-height: 1.7; font-size: 14px; }
  </style>
</head>
<body>
  <section class="empty">
    <h1>応募者はまだいません</h1>
    <p>採用PROで条件確認が完了した人が、ここに自動で表示されます。デモ固定ユーザーは表示しません。</p>
  </section>
</body>
</html>`;
}

function renderDemoChatHtml(candidate: DemoCandidate, candidates: DemoCandidate[]): string {
  const safeCandidateJson = JSON.stringify(candidate).replace(/</g, '\\u003c');
  const candidateSwitcherHtml = renderDemoCandidateSwitcher(candidate.id, candidates);
  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>${escapeHtml(candidate.name)} - 採用PRO対応</title>
  <style>
    * { box-sizing: border-box; }
    html { height: 100%; overflow: hidden; }
    body { height: 100dvh; overflow: hidden; margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Hiragino Sans", "Yu Gothic", system-ui, sans-serif; background: #eef2f7; color: #111827; }
    .app { min-height: 100dvh; overflow: hidden; }
    header { position: fixed; left: 0; right: 0; top: var(--viewport-top, 0px); z-index: 10; display: flex; align-items: center; gap: 12px; padding: 14px 16px; background: #fff; border-bottom: 1px solid #e5e7eb; }
    .avatar { width: 42px; height: 42px; border-radius: 50%; background: ${candidate.color}; color: #fff; display: grid; place-items: center; font-weight: 700; }
    .title { min-width: 0; flex: 1; }
    .name { font-weight: 800; font-size: 16px; }
    .job { font-size: 12px; color: #6b7280; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .status-pill { display: inline-block; margin-top: 4px; padding: 2px 7px; border-radius: 999px; background: #eef2ff; color: #3730a3; font-size: 10px; font-weight: 900; }
    .header-settings { flex: 0 0 auto; border: 1px solid #d1d5db; border-radius: 999px; padding: 8px 10px; background: #fff; color: #374151; font-size: 12px; font-weight: 900; }
    .profile-card { margin: 12px 14px 0; padding: 12px; background: #fff; border: 1px solid #e5e7eb; border-radius: 14px; box-shadow: 0 1px 2px rgba(15,23,42,.05); }
    .profile-title { font-size: 12px; font-weight: 800; color: #374151; margin-bottom: 8px; }
    .profile-grid { display: grid; grid-template-columns: 78px 1fr; gap: 6px 10px; font-size: 12px; line-height: 1.5; }
    .profile-key { color: #6b7280; }
    .profile-value { color: #111827; font-weight: 700; overflow-wrap: anywhere; }
    .candidate-switcher { position: fixed; left: 0; right: 0; top: calc(var(--viewport-top, 0px) + var(--header-height, 78px)); z-index: 9; padding: 8px 14px 7px; background: rgba(238,242,247,.98); border-bottom: 1px solid #e5e7eb; }
    .candidate-switcher-title { margin-bottom: 6px; font-size: 10px; font-weight: 900; color: #6b7280; letter-spacing: .08em; }
    .candidate-tabs { display: flex; gap: 8px; overflow-x: auto; -webkit-overflow-scrolling: touch; scrollbar-width: none; }
    .candidate-tabs::-webkit-scrollbar { display: none; }
    .candidate-tab { flex: 0 0 auto; display: grid; gap: 2px; min-width: 132px; padding: 9px 10px; border: 1px solid #d1d5db; border-radius: 14px; background: #fff; color: #374151; text-decoration: none; box-shadow: 0 1px 2px rgba(15,23,42,.04); }
    .candidate-tab.active { border-color: ${candidate.color}; background: #f8fafc; box-shadow: inset 0 0 0 1px ${candidate.color}; }
    .candidate-tab-name { font-size: 13px; font-weight: 900; color: #111827; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .candidate-tab-meta { font-size: 10px; font-weight: 800; color: #6b7280; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .action-bar { position: fixed; left: 0; right: 0; top: calc(var(--viewport-top, 0px) + var(--header-height, 78px) + var(--switcher-height, 76px)); z-index: 9; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; padding: 10px 14px 8px; background: rgba(238,242,247,.98); border-bottom: 1px solid #e5e7eb; transition: transform .18s ease, opacity .18s ease; }
    .action-bar button { min-height: 42px; border: 1px solid #d1d5db; border-radius: 12px; background: #fff; color: #374151; font-size: 12px; font-weight: 900; }
    .action-bar .primary { border-color: ${candidate.color}; background: ${candidate.color}; color: #fff; }
    .action-bar .danger { color: #b91c1c; border-color: #fecaca; background: #fff5f5; }
    .keyboard-open .action-bar { transform: translateY(-64px); opacity: 0; pointer-events: none; }
    .keyboard-open .candidate-switcher { transform: translateY(-64px); opacity: 0; pointer-events: none; }
    .settings-sheet { position: fixed; inset: 0; z-index: 5; display: grid; align-items: end; background: rgba(15,23,42,.36); animation: fadeIn .16s ease-out; }
    .settings-sheet[hidden] { display: none; }
    .settings-panel { max-height: 86vh; overflow: auto; background: #fff; border-radius: 20px 20px 0 0; padding: 18px 16px calc(16px + env(safe-area-inset-bottom)); box-shadow: 0 -16px 48px rgba(15,23,42,.24); animation: sheetUp .18s ease-out; }
    .settings-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
    .settings-head h1 { margin: 0; font-size: 18px; line-height: 1.35; }
    .settings-close { width: 36px; height: 36px; border: 0; border-radius: 50%; background: #f3f4f6; color: #374151; font-size: 20px; line-height: 1; }
    .settings-fields { display: grid; gap: 10px; }
    .settings-fields label { display: grid; gap: 5px; font-size: 12px; font-weight: 800; color: #374151; }
    .settings-fields input, .settings-fields textarea { width: 100%; border: 1px solid #d1d5db; border-radius: 12px; padding: 11px 12px; font: inherit; font-size: 16px; outline: none; background: #fff; }
    .settings-fields textarea { min-height: 78px; resize: vertical; }
    .settings-submit { width: 100%; margin-top: 12px; min-height: 46px; border: 0; border-radius: 14px; background: ${candidate.color}; color: #fff; font-weight: 900; font-size: 15px; }
    .settings-error { min-height: 18px; margin-top: 8px; color: #dc2626; font-size: 12px; font-weight: 700; }
    .confirm-sheet { position: fixed; inset: 0; z-index: 20; display: grid; place-items: end center; padding: 16px; background: rgba(15,23,42,.42); animation: fadeIn .16s ease-out; }
    .confirm-sheet[hidden] { display: none; }
    .confirm-panel { width: min(100%, 390px); border-radius: 18px; background: #fff; padding: 18px 16px calc(16px + env(safe-area-inset-bottom)); box-shadow: 0 -16px 44px rgba(15,23,42,.26); animation: sheetUp .18s ease-out; }
    .confirm-panel h2 { margin: 0 0 8px; font-size: 18px; line-height: 1.35; }
    .confirm-panel p { margin: 0; color: #4b5563; font-size: 14px; line-height: 1.65; }
    .confirm-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 16px; }
    .confirm-actions button { min-height: 46px; border-radius: 14px; font-weight: 900; font-size: 14px; }
    .confirm-cancel { border: 1px solid #d1d5db; background: #fff; color: #374151; }
    .confirm-submit { border: 0; background: #dc2626; color: #fff; }
    .composer.closed textarea { color: #6b7280; background: #f3f4f6; }
    .composer.closed button { background: #9ca3af; }
    .messages { position: fixed; left: 0; right: 0; top: calc(var(--viewport-top, 0px) + var(--top-chrome-height, 132px)); bottom: var(--composer-height, 74px); overflow-y: auto; -webkit-overflow-scrolling: touch; overscroll-behavior: contain; padding: 16px 14px; display: flex; flex-direction: column; gap: 10px; }
    .keyboard-open .messages { top: calc(var(--viewport-top, 0px) + var(--header-height, 78px)); }
    .bubble { max-width: 82%; padding: 10px 12px; border-radius: 16px; line-height: 1.55; white-space: pre-wrap; font-size: 15px; box-shadow: 0 1px 2px rgba(15,23,42,.08); }
    .in { align-self: flex-start; background: #fff; border-top-left-radius: 4px; }
    .out { align-self: flex-end; background: #d9f99d; border-top-right-radius: 4px; }
    .meta { font-size: 10px; color: #9ca3af; margin-top: 3px; }
    .empty { margin: 36px auto; color: #6b7280; text-align: center; font-size: 14px; }
    .composer { position: fixed; left: 0; right: 0; bottom: 0; z-index: 3; display: flex; gap: 8px; padding: 10px 12px calc(10px + env(safe-area-inset-bottom)); background: rgba(255,255,255,.96); border-top: 1px solid #e5e7eb; }
    .composer textarea { flex: 1; resize: none; min-height: 44px; max-height: 120px; border: 1px solid #d1d5db; border-radius: 18px; padding: 11px 13px; font: inherit; outline: none; background: #fff; }
    .composer button { width: 64px; border: 0; border-radius: 18px; background: ${candidate.color}; color: #fff; font-weight: 800; }
    @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
    @keyframes sheetUp { from { transform: translateY(18px); } to { transform: translateY(0); } }
  </style>
</head>
<body>
  <div class="app">
    <header>
      <div class="avatar">${escapeHtml(candidate.name.slice(0, 1))}</div>
      <div class="title">
        <div class="name">${escapeHtml(candidate.name)}</div>
        <div class="job">${escapeHtml(candidate.job)}</div>
        <span id="statusLabel" class="status-pill">やり取り中</span>
      </div>
      <button id="settingsButton" class="header-settings" type="button">対応設定</button>
    </header>
    ${candidateSwitcherHtml}
    <div class="action-bar">
      <button id="sendInterview" class="primary" type="button">面接を送る</button>
      <button id="rejectCandidate" class="danger" type="button">不合格</button>
      <button id="archiveCandidate" class="danger" type="button">削除</button>
    </div>
    <section id="profileCard" class="profile-card" hidden>
      <div class="profile-title">応募者情報</div>
      <div class="profile-grid">
        <div class="profile-key">氏名</div><div id="profileName" class="profile-value"></div>
        <div class="profile-key">ふりがな</div><div id="profileKana" class="profile-value"></div>
        <div class="profile-key">電話番号</div><div id="profilePhone" class="profile-value"></div>
        <div class="profile-key">希望</div><div id="profileAvailability" class="profile-value"></div>
        <div class="profile-key">メモ</div><div id="profileMemo" class="profile-value"></div>
      </div>
    </section>
    <main id="messages" class="messages"><div class="empty">読み込み中...</div></main>
    <form id="form" class="composer">
      <textarea id="text" rows="1" placeholder="${escapeHtml(candidate.name)}へ送信"></textarea>
      <button type="submit">送信</button>
    </form>
    <section id="confirmSheet" class="confirm-sheet" hidden>
      <div class="confirm-panel" role="dialog" aria-modal="true" aria-labelledby="confirmTitle">
        <h2 id="confirmTitle">この求職者とのやり取りを停止しますか？</h2>
        <p id="confirmMessage">もうこの求職者とはやり取りができません。それでも大丈夫ですか？</p>
        <div class="confirm-actions">
          <button id="confirmCancel" class="confirm-cancel" type="button">キャンセル</button>
          <button id="confirmSubmit" class="confirm-submit" type="button">停止する</button>
        </div>
      </div>
    </section>
    <section id="settingsSheet" class="settings-sheet" hidden>
      <div class="settings-panel">
        <div class="settings-head">
          <h1>対応設定</h1>
          <button id="settingsClose" class="settings-close" type="button" aria-label="閉じる">x</button>
        </div>
        <form id="settingsForm" class="settings-fields">
          <label>求人企業名<input id="companyName" name="companyName" value="${escapeHtml(DEMO_COMPANY_NAME)}" /></label>
          <label>担当者名<input id="staffName" name="staffName" value="対応担当" /></label>
          <label>面談URL<input id="interviewUrl" name="interviewUrl" inputmode="url" value="https://timerex.net/s/demo" /></label>
          <label>面接案内文<textarea id="interviewMessage" name="interviewMessage">${escapeHtml(DEFAULT_COMPANY_SETTINGS.interviewMessage)}</textarea></label>
          <button class="settings-submit" type="submit">保存</button>
          <div id="settingsError" class="settings-error"></div>
        </form>
      </div>
    </section>
  </div>
  <script>
    const candidate = ${safeCandidateJson};
    const messagesEl = document.getElementById('messages');
    const textEl = document.getElementById('text');
    const profileCard = document.getElementById('profileCard');
    const statusLabel = document.getElementById('statusLabel');
    const settingsSheet = document.getElementById('settingsSheet');
    const settingsError = document.getElementById('settingsError');
    const formEl = document.getElementById('form');
    const sendButton = formEl.querySelector('button[type="submit"]');
    const confirmSheet = document.getElementById('confirmSheet');
    const confirmTitle = document.getElementById('confirmTitle');
    const confirmMessage = document.getElementById('confirmMessage');
    const confirmSubmit = document.getElementById('confirmSubmit');
    const headerEl = document.querySelector('header');
    const candidateSwitcherEl = document.querySelector('.candidate-switcher');
    const actionBarEl = document.querySelector('.action-bar');
    const composerEl = document.querySelector('.composer');
    const openSettingsOnLoad = new URLSearchParams(window.location.search).get('settings') === '1';
    let pendingTerminalStatus = null;
    function syncViewportTop() {
      const viewport = window.visualViewport;
      const top = viewport ? viewport.offsetTop : 0;
      document.documentElement.style.setProperty('--viewport-top', top + 'px');
      const headerHeight = headerEl ? Math.ceil(headerEl.getBoundingClientRect().height) : 78;
      const switcherHeight = candidateSwitcherEl ? Math.ceil(candidateSwitcherEl.getBoundingClientRect().height) : 76;
      const actionBarHeight = actionBarEl ? Math.ceil(actionBarEl.getBoundingClientRect().height) : 54;
      const composerHeight = composerEl ? Math.ceil(composerEl.getBoundingClientRect().height) : 74;
      document.documentElement.style.setProperty('--header-height', headerHeight + 'px');
      document.documentElement.style.setProperty('--switcher-height', switcherHeight + 'px');
      document.documentElement.style.setProperty('--top-chrome-height', (headerHeight + switcherHeight + actionBarHeight) + 'px');
      document.documentElement.style.setProperty('--composer-height', composerHeight + 'px');
    }
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', syncViewportTop);
      window.visualViewport.addEventListener('scroll', syncViewportTop);
    }
    async function loadProfile() {
      const res = await fetch('/demo-chat/profile?candidate=' + encodeURIComponent(candidate.id));
      const json = await res.json();
      const profile = json.data.profile;
      if (!profile) return;
      document.getElementById('profileName').textContent = profile.fullName || candidate.name;
      document.getElementById('profileKana').textContent = profile.kana || '-';
      document.getElementById('profilePhone').textContent = profile.phone || '-';
      document.getElementById('profileAvailability').textContent = profile.availability || '-';
      document.getElementById('profileMemo').textContent = profile.memo || '-';
      document.querySelector('.name').textContent = profile.fullName || candidate.name;
      document.querySelector('.job').textContent = profile.availability ? candidate.job + ' / ' + profile.availability : candidate.job;
      profileCard.hidden = false;
    }
    async function loadSettings() {
      const res = await fetch('/demo-chat/settings');
      const json = await res.json();
      const settings = json.data.settings;
      document.getElementById('companyName').value = settings.companyName || '';
      document.getElementById('staffName').value = settings.staffName || '';
      document.getElementById('interviewUrl').value = settings.interviewUrl || '';
      document.getElementById('interviewMessage').value = settings.interviewMessage || '';
    }
    async function loadStatus() {
      const res = await fetch('/demo-chat/status?candidate=' + encodeURIComponent(candidate.id));
      const json = await res.json();
      if (json.data.status) applyStatus(json.data.status);
    }
    function showStatus(label) {
      statusLabel.textContent = label;
    }
    function applyStatus(status) {
      showStatus(status.label);
      const closed = status.status === 'rejected' || status.status === 'archived';
      textEl.disabled = closed;
      sendButton.disabled = closed;
      formEl.classList.toggle('closed', closed);
      textEl.placeholder = closed ? 'この求職者とのやり取りは停止されています' : candidate.name + 'へ送信';
      if (closed) textEl.value = '';
    }
    async function updateStatus(status) {
      const res = await fetch('/demo-chat/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ candidate: candidate.id, status }),
      });
      const json = await res.json();
      if (json.success) applyStatus(json.data.status);
    }
    function openTerminalConfirm(status) {
      pendingTerminalStatus = status;
      const isArchive = status === 'archived';
      confirmTitle.textContent = isArchive ? 'この求職者を削除しますか？' : 'この求職者を不合格にしますか？';
      confirmMessage.textContent = 'もうこの求職者とはやり取りができません。それでも大丈夫ですか？';
      confirmSubmit.textContent = isArchive ? '削除する' : '不合格にする';
      confirmSheet.hidden = false;
      textEl.blur();
    }
    function closeTerminalConfirm() {
      pendingTerminalStatus = null;
      confirmSheet.hidden = true;
    }
    async function loadMessages() {
      const res = await fetch('/demo-chat/messages?candidate=' + encodeURIComponent(candidate.id));
      const json = await res.json();
      const items = json.data.items || [];
      messagesEl.innerHTML = items.length ? '' : '<div class="empty">まだ履歴がありません</div>';
      for (const item of items) addBubble(item.text, item.direction === 'outgoing' ? 'out' : 'in', item.createdAt);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
    function addBubble(text, cls, createdAt) {
      const wrap = document.createElement('div');
      wrap.className = 'bubble ' + cls;
      wrap.textContent = text;
      if (createdAt) {
        const meta = document.createElement('div');
        meta.className = 'meta';
        meta.textContent = createdAt.slice(5, 16).replace('T', ' ');
        wrap.appendChild(meta);
      }
      messagesEl.appendChild(wrap);
    }
    let keepKeyboardFromMessages = false;
    function keepKeyboardOpenFromMessages() {
      if (document.activeElement === textEl) keepKeyboardFromMessages = true;
    }
    messagesEl.addEventListener('touchstart', keepKeyboardOpenFromMessages, { passive: true });
    messagesEl.addEventListener('mousedown', (event) => {
      if (document.activeElement === textEl) {
        keepKeyboardFromMessages = true;
        event.preventDefault();
      }
    });
    textEl.addEventListener('focus', () => {
      document.body.classList.add('keyboard-open');
      requestAnimationFrame(syncViewportTop);
    });
    textEl.addEventListener('blur', () => {
      if (keepKeyboardFromMessages) {
        keepKeyboardFromMessages = false;
        setTimeout(() => textEl.focus({ preventScroll: true }), 0);
        return;
      }
      document.body.classList.remove('keyboard-open');
      requestAnimationFrame(syncViewportTop);
    });
    document.getElementById('sendInterview').addEventListener('click', async () => {
      showStatus('面接');
      await fetch('/demo-chat/interview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ candidate: candidate.id }),
      });
      await loadMessages();
    });
    document.getElementById('rejectCandidate').addEventListener('click', () => openTerminalConfirm('rejected'));
    document.getElementById('archiveCandidate').addEventListener('click', () => openTerminalConfirm('archived'));
    document.getElementById('confirmCancel').addEventListener('click', closeTerminalConfirm);
    confirmSheet.addEventListener('click', (event) => {
      if (event.target === confirmSheet) closeTerminalConfirm();
    });
    confirmSubmit.addEventListener('click', async () => {
      if (!pendingTerminalStatus) return;
      const status = pendingTerminalStatus;
      closeTerminalConfirm();
      await updateStatus(status);
    });
    document.getElementById('settingsButton').addEventListener('click', () => {
      settingsSheet.hidden = false;
    });
    document.getElementById('settingsClose').addEventListener('click', () => {
      settingsSheet.hidden = true;
    });
    settingsSheet.addEventListener('click', (event) => {
      if (event.target === settingsSheet) settingsSheet.hidden = true;
    });
    document.getElementById('settingsForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      settingsError.textContent = '';
      const payload = {
        companyName: document.getElementById('companyName').value.trim(),
        staffName: document.getElementById('staffName').value.trim(),
        interviewUrl: document.getElementById('interviewUrl').value.trim(),
        interviewMessage: document.getElementById('interviewMessage').value.trim(),
      };
      const res = await fetch('/demo-chat/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        settingsError.textContent = '保存できませんでした。もう一度お試しください';
        return;
      }
      settingsSheet.hidden = true;
    });
    document.getElementById('form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const text = textEl.value.trim();
      if (!text) return;
      textEl.value = '';
      addBubble(text, 'out', '');
      await fetch('/demo-chat/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ candidate: candidate.id, text }),
      });
      await loadMessages();
    });
    loadProfile();
    loadSettings().then(() => {
      if (openSettingsOnLoad) settingsSheet.hidden = false;
    });
    loadStatus();
    loadMessages();
    syncViewportTop();
  </script>
</body>
</html>`;
}

function renderDemoCandidateChatHtml(candidate: DemoCandidate): string {
  const safeCandidateJson = JSON.stringify(candidate).replace(/</g, '\\u003c');
  const draft = candidate.airworkProfile ?? {
    fullName: candidate.name,
    kana: '',
    phone: '',
    availability: '',
    memo: '',
  };
  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>応募チャット</title>
  <style>
    * { box-sizing: border-box; }
    html { height: 100%; overflow: hidden; }
    body { height: 100dvh; overflow: hidden; margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Hiragino Sans", "Yu Gothic", system-ui, sans-serif; background: #eef2f7; color: #111827; }
    .app { min-height: 100dvh; overflow: hidden; }
    header { position: fixed; left: 0; right: 0; top: var(--viewport-top, 0px); z-index: 10; display: flex; align-items: center; gap: 12px; padding: 12px 12px 12px 16px; background: #fff; border-bottom: 1px solid #e5e7eb; }
    .avatar { width: 42px; height: 42px; border-radius: 50%; background: #111827; color: #fff; display: grid; place-items: center; font-weight: 700; }
    .title { min-width: 0; flex: 1; }
    .name { font-weight: 800; font-size: 16px; }
    .job { font-size: 12px; color: #6b7280; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .profile-button { flex: 0 0 auto; border: 1px solid #d1d5db; border-radius: 999px; padding: 8px 10px; background: #fff; color: #374151; font-size: 12px; font-weight: 900; }
    .profile-notice { margin: 10px 14px 0; padding: 10px 12px; border: 1px solid #bbf7d0; border-radius: 12px; background: #f0fdf4; color: #166534; font-size: 13px; line-height: 1.5; }
    .profile-notice strong { display: block; margin-bottom: 2px; color: #14532d; }
    .profile-sheet { position: fixed; inset: 0; z-index: 5; display: grid; align-items: end; background: rgba(15,23,42,.36); animation: fadeIn .16s ease-out; }
    .profile-sheet[hidden], .profile-notice[hidden] { display: none; }
    .profile-panel { max-height: 86vh; overflow: auto; background: #fff; border-radius: 20px 20px 0 0; padding: 18px 16px calc(16px + env(safe-area-inset-bottom)); box-shadow: 0 -16px 48px rgba(15,23,42,.24); animation: sheetUp .18s ease-out; }
    .profile-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 8px; }
    .profile-panel h1 { margin: 0; font-size: 18px; line-height: 1.35; letter-spacing: 0; }
    .profile-close { width: 36px; height: 36px; border: 0; border-radius: 50%; background: #f3f4f6; color: #374151; font-size: 20px; line-height: 1; }
    .profile-panel p { margin: 6px 0 14px; color: #6b7280; font-size: 13px; line-height: 1.6; }
    .profile-fields { display: grid; gap: 10px; }
    .profile-fields label { display: grid; gap: 5px; font-size: 12px; font-weight: 800; color: #374151; }
    .profile-fields input, .profile-fields textarea { width: 100%; border: 1px solid #d1d5db; border-radius: 12px; padding: 11px 12px; font: inherit; font-size: 16px; outline: none; background: #fff; }
    .profile-fields textarea { min-height: 70px; resize: vertical; }
    .profile-submit { width: 100%; margin-top: 12px; min-height: 46px; border: 0; border-radius: 14px; background: ${candidate.color}; color: #fff; font-weight: 900; font-size: 15px; }
    .profile-error { min-height: 18px; margin-top: 8px; color: #dc2626; font-size: 12px; font-weight: 700; }
    .profile-chip { padding: 3px 7px; border-radius: 999px; background: #dcfce7; color: #166534; font-size: 10px; font-weight: 900; }
    .messages { position: fixed; left: 0; right: 0; top: calc(var(--viewport-top, 0px) + var(--header-height, 67px)); bottom: var(--composer-height, 74px); overflow-y: auto; -webkit-overflow-scrolling: touch; overscroll-behavior: contain; padding: 16px 14px; display: flex; flex-direction: column; gap: 10px; }
    .bubble { max-width: 82%; padding: 10px 12px; border-radius: 16px; line-height: 1.55; white-space: pre-wrap; font-size: 15px; box-shadow: 0 1px 2px rgba(15,23,42,.08); }
    .in { align-self: flex-start; background: #fff; border-top-left-radius: 4px; }
    .out { align-self: flex-end; background: #d9f99d; border-top-right-radius: 4px; }
    .meta { font-size: 10px; color: #9ca3af; margin-top: 3px; }
    .empty { margin: 36px auto; color: #6b7280; text-align: center; font-size: 14px; }
    .composer { position: fixed; left: 0; right: 0; bottom: 0; z-index: 3; display: flex; gap: 8px; padding: 10px 12px calc(10px + env(safe-area-inset-bottom)); background: rgba(255,255,255,.96); border-top: 1px solid #e5e7eb; }
    .composer textarea { flex: 1; resize: none; min-height: 44px; max-height: 120px; border: 1px solid #d1d5db; border-radius: 18px; padding: 11px 13px; font: inherit; outline: none; background: #fff; }
    .composer button { width: 64px; border: 0; border-radius: 18px; background: ${candidate.color}; color: #fff; font-weight: 800; }
    @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
    @keyframes sheetUp { from { transform: translateY(18px); } to { transform: translateY(0); } }
  </style>
</head>
<body>
  <div class="app">
    <header>
      <div class="avatar">企</div>
      <div class="title">
        <div class="name">${escapeHtml(DEMO_SERVICE_NAME)} 応募チャット</div>
        <div class="job">${escapeHtml(candidate.name)}さんの対応チャット</div>
      </div>
      <button id="profileButton" class="profile-button" type="button">プロフィール</button>
    </header>
    <section id="profileNotice" class="profile-notice" hidden>
      <strong>プロフィールを設定してください</strong>
      AirWorkの応募情報から下書きしています。右上のプロフィールから確認・編集できます。
    </section>
    <main id="messages" class="messages"><div class="empty">読み込み中...</div></main>
    <form id="form" class="composer">
      <textarea id="text" rows="1" placeholder="メッセージを入力"></textarea>
      <button type="submit">送信</button>
    </form>
    <section id="profileSheet" class="profile-sheet" hidden>
      <div class="profile-panel">
        <div class="profile-head">
          <h1>プロフィール編集</h1>
          <button id="profileClose" class="profile-close" type="button" aria-label="閉じる">x</button>
        </div>
        <p><span class="profile-chip">AirWork下書き</span> LINE名とは別に、企業へ見せる採用上のプロフィールを登録します。</p>
        <form id="profileForm" class="profile-fields">
          <label>採用上のお名前<input id="profileFullName" name="fullName" autocomplete="name" value="${escapeHtml(draft.fullName)}" required /></label>
          <label>ふりがな<input id="profileKana" name="kana" autocomplete="off" value="${escapeHtml(draft.kana)}" placeholder="やまもと いっき" /></label>
          <label>電話番号<input id="profilePhone" name="phone" inputmode="tel" autocomplete="tel" value="${escapeHtml(draft.phone)}" placeholder="090-1234-5678" /></label>
          <label>希望勤務時間<input id="profileAvailability" name="availability" value="${escapeHtml(draft.availability)}" placeholder="週3日 / 平日夜 / 土日など" /></label>
          <label>メモ・自己PR<textarea id="profileMemo" name="memo" placeholder="接客経験、希望、連絡しやすい時間など">${escapeHtml(draft.memo)}</textarea></label>
          <button class="profile-submit" type="submit">保存してチャットへ</button>
          <div id="profileError" class="profile-error"></div>
        </form>
      </div>
    </section>
  </div>
  <script>
    const candidate = ${safeCandidateJson};
    const messagesEl = document.getElementById('messages');
    const textEl = document.getElementById('text');
    const profileSheet = document.getElementById('profileSheet');
    const profileNotice = document.getElementById('profileNotice');
    const profileError = document.getElementById('profileError');
    const headerEl = document.querySelector('header');
    const composerEl = document.querySelector('.composer');
    const openProfileOnLoad = new URLSearchParams(window.location.search).get('profile') === '1';
    function syncViewportTop() {
      const viewport = window.visualViewport;
      const top = viewport ? viewport.offsetTop : 0;
      document.documentElement.style.setProperty('--viewport-top', top + 'px');
      const headerHeight = headerEl ? Math.ceil(headerEl.getBoundingClientRect().height) : 67;
      const composerHeight = composerEl ? Math.ceil(composerEl.getBoundingClientRect().height) : 74;
      document.documentElement.style.setProperty('--header-height', headerHeight + 'px');
      document.documentElement.style.setProperty('--composer-height', composerHeight + 'px');
    }
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', syncViewportTop);
      window.visualViewport.addEventListener('scroll', syncViewportTop);
    }
    async function loadProfile() {
      const res = await fetch('/demo-chat/profile?candidate=' + encodeURIComponent(candidate.id));
      const json = await res.json();
      const profile = json.data.profile;
      if (profile) {
        document.getElementById('profileFullName').value = profile.fullName || candidate.name;
        document.getElementById('profileKana').value = profile.kana || '';
        document.getElementById('profilePhone').value = profile.phone || '';
        document.getElementById('profileAvailability').value = profile.availability || '';
        document.getElementById('profileMemo').value = profile.memo || '';
        document.querySelector('.job').textContent = (profile.fullName || candidate.name) + 'さんの対応チャット';
        return;
      }
      profileNotice.hidden = false;
    }
    async function loadMessages() {
      const res = await fetch('/demo-chat/messages?candidate=' + encodeURIComponent(candidate.id));
      const json = await res.json();
      const items = json.data.items || [];
      messagesEl.innerHTML = items.length ? '' : '<div class="empty">まだ履歴がありません</div>';
      for (const item of items) addBubble(item.text, item.direction === 'incoming' ? 'out' : 'in', item.createdAt);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
    function addBubble(text, cls, createdAt) {
      const wrap = document.createElement('div');
      wrap.className = 'bubble ' + cls;
      wrap.textContent = text;
      if (createdAt) {
        const meta = document.createElement('div');
        meta.className = 'meta';
        meta.textContent = createdAt.slice(5, 16).replace('T', ' ');
        wrap.appendChild(meta);
      }
      messagesEl.appendChild(wrap);
    }
    let keepKeyboardFromMessages = false;
    function keepKeyboardOpenFromMessages() {
      if (document.activeElement === textEl) keepKeyboardFromMessages = true;
    }
    messagesEl.addEventListener('touchstart', keepKeyboardOpenFromMessages, { passive: true });
    messagesEl.addEventListener('mousedown', (event) => {
      if (document.activeElement === textEl) {
        keepKeyboardFromMessages = true;
        event.preventDefault();
      }
    });
    textEl.addEventListener('focus', () => {
      document.body.classList.add('keyboard-open');
      requestAnimationFrame(syncViewportTop);
    });
    textEl.addEventListener('blur', () => {
      if (keepKeyboardFromMessages) {
        keepKeyboardFromMessages = false;
        setTimeout(() => textEl.focus({ preventScroll: true }), 0);
        return;
      }
      document.body.classList.remove('keyboard-open');
      requestAnimationFrame(syncViewportTop);
    });
    document.getElementById('profileButton').addEventListener('click', () => {
      profileSheet.hidden = false;
    });
    document.getElementById('profileClose').addEventListener('click', () => {
      profileSheet.hidden = true;
    });
    profileSheet.addEventListener('click', (event) => {
      if (event.target === profileSheet) profileSheet.hidden = true;
    });
    document.getElementById('profileForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      profileError.textContent = '';
      const payload = {
        candidate: candidate.id,
        fullName: document.getElementById('profileFullName').value.trim(),
        kana: document.getElementById('profileKana').value.trim(),
        phone: document.getElementById('profilePhone').value.trim(),
        availability: document.getElementById('profileAvailability').value.trim(),
        memo: document.getElementById('profileMemo').value.trim(),
      };
      if (!payload.fullName) {
        profileError.textContent = 'お名前を入力してください';
        return;
      }
      const res = await fetch('/demo-chat/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        profileError.textContent = '保存できませんでした。もう一度お試しください';
        return;
      }
      profileSheet.hidden = true;
      profileNotice.hidden = true;
      document.querySelector('.job').textContent = payload.fullName + 'さんの対応チャット';
    });
    document.getElementById('form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const text = textEl.value.trim();
      if (!text) return;
      textEl.value = '';
      addBubble(text, 'out', '');
      await fetch('/demo-candidate-chat/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ candidate: candidate.id, text }),
      });
      await loadMessages();
    });
    loadProfile().then(() => {
      if (openProfileOnLoad) profileSheet.hidden = false;
    });
    loadMessages();
    syncViewportTop();
  </script>
</body>
</html>`;
}

function renderDemoCandidateChatGateHtml(candidate: DemoCandidate): string {
  const jobsUrl = `${DEMO_WORKER_URL}/demo-candidate-jobs?candidate=${encodeURIComponent(candidate.id)}`;
  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>応募チャット</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100dvh; font-family: -apple-system, BlinkMacSystemFont, "Hiragino Sans", "Yu Gothic", system-ui, sans-serif; background: #f3f6fb; color: #111827; display: grid; place-items: center; padding: 20px; }
    main { width: min(100%, 420px); background: #fff; border: 1px solid #e5e7eb; border-radius: 18px; padding: 22px 18px; box-shadow: 0 10px 30px rgba(15,23,42,.08); }
    .eyebrow { font-size: 12px; font-weight: 900; color: #16A34A; }
    h1 { margin: 8px 0 8px; font-size: 23px; line-height: 1.35; letter-spacing: 0; }
    p { margin: 0; color: #4b5563; font-size: 14px; line-height: 1.75; }
    .candidate { margin: 14px 0 0; padding: 12px; border-radius: 14px; background: #f8fafc; border: 1px solid #e5e7eb; }
    .candidate strong { display: block; font-size: 15px; }
    .candidate span { display: block; margin-top: 4px; color: #6b7280; font-size: 12px; }
    .button { display: block; margin-top: 16px; text-align: center; text-decoration: none; border-radius: 14px; padding: 14px 16px; background: #16A34A; color: #fff; font-weight: 900; font-size: 15px; }
  </style>
</head>
<body>
  <main>
    <div class="eyebrow">${escapeHtml(DEMO_SERVICE_NAME)}</div>
    <h1>求人に応募してチャットを始めよう！！</h1>
    <p>企業とのチャットは、求人に応募してマッチングしたあとに開けます。まずはあなたに合いそうな求人をチェックしてください！！</p>
    <div class="candidate">
      <strong>${escapeHtml(candidate.name)}</strong>
      <span>${escapeHtml(candidate.job)}</span>
    </div>
    <a class="button" href="${escapeHtml(jobsUrl)}">求人を見る</a>
  </main>
</body>
</html>`;
}

function renderDemoCandidateJobsHtml(candidate: DemoCandidate, company: DemoCandidateCompany): string {
  const hasJobs = company.jobs.length > 0;
  const jobsHtml = hasJobs ? company.jobs.map((job) => `
    <section>
      <div class="banner-crop"><img class="job-banner" src="${escapeHtml(job.bannerUrl)}" alt="" style="${demoBannerStyle(job)}" /></div>
      <h2>${escapeHtml(job.title)}</h2>
      <div class="row"><div class="key">勤務地</div><div class="value">渋谷駅 徒歩5分</div></div>
      <div class="row"><div class="key">時給</div><div class="value">${escapeHtml(job.hourlyWage)}</div></div>
      <div class="row"><div class="key">勤務時間</div><div class="value">${escapeHtml(job.shift)}</div></div>
      <div class="row"><div class="key">仕事内容</div><div class="value">${escapeHtml(job.description)}</div></div>
    </section>
  `).join('') : `
    <section>
      <h2>掲載中の求人はまだありません</h2>
      <p class="note">この会社はまだ求職者向けに求人を出稿していません。求人が届いたらここに表示されます。</p>
    </section>
  `;
  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>求人をチェック</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Hiragino Sans", "Yu Gothic", system-ui, sans-serif; background: #f3f6fb; color: #111827; }
    header { position: sticky; top: 0; z-index: 2; padding: 16px 18px 14px; background: rgba(255,255,255,.96); border-bottom: 1px solid #e5e7eb; backdrop-filter: blur(10px); }
    .eyebrow { font-size: 12px; font-weight: 900; color: ${company.color}; }
    h1 { margin: 4px 0 2px; font-size: 22px; line-height: 1.3; letter-spacing: 0; }
    .sub { color: #6b7280; font-size: 13px; line-height: 1.5; }
    main { padding: 14px 14px calc(24px + env(safe-area-inset-bottom)); display: grid; gap: 12px; }
    section { background: #fff; border: 1px solid #e5e7eb; border-radius: 16px; padding: 14px; box-shadow: 0 1px 2px rgba(15,23,42,.05); }
    h2 { margin: 0 0 10px; font-size: 15px; line-height: 1.4; }
    .row { display: grid; grid-template-columns: 88px 1fr; gap: 8px 12px; padding: 8px 0; border-top: 1px solid #f3f4f6; font-size: 13px; line-height: 1.6; }
    .row:first-of-type { border-top: 0; padding-top: 0; }
    .key { color: #6b7280; font-weight: 800; }
    .value { color: #111827; font-weight: 700; overflow-wrap: anywhere; }
    .chips { display: flex; flex-wrap: wrap; gap: 8px; }
    .chip { padding: 7px 9px; border-radius: 999px; background: #eef2ff; color: #3730a3; font-size: 12px; font-weight: 900; }
    .note { color: #4b5563; font-size: 13px; line-height: 1.7; }
    .banner-crop { width: 100%; aspect-ratio: 20 / 10; overflow: hidden; border-radius: 12px; margin-bottom: 12px; background: #e5e7eb; }
    .job-banner { display: block; width: 100%; height: 100%; object-fit: cover; }
    body.is-cropping { overflow: hidden; overscroll-behavior: none; touch-action: none; }
    .button { display: block; text-align: center; text-decoration: none; border-radius: 14px; padding: 13px 14px; background: ${company.color}; color: #fff; font-weight: 900; font-size: 14px; }
  </style>
</head>
<body>
  <header>
    <div class="eyebrow">会社ページ</div>
    <h1>${escapeHtml(company.name)}</h1>
    <div class="sub">${hasJobs ? `${escapeHtml(candidate.name)}さんに合いそうな求人がこの会社にあります。` : 'この会社の求人はまだ準備中です。'}</div>
  </header>
  <main>
    <section>
      <h2>あなたにおすすめ</h2>
      <p class="note">${escapeHtml(company.reason)}</p>
    </section>
    ${jobsHtml}
    <section>
      <h2>この求人のポイント</h2>
      <div class="chips">
        <span class="chip">未経験OK</span>
        <span class="chip">シフト相談可</span>
        <span class="chip">駅近</span>
        <span class="chip">社員登用あり</span>
      </div>
    </section>
    <section>
      <h2>応募後の流れ</h2>
      <p class="note">企業からのメッセージ、面接日程、選考結果は応募チャットと応募状況から確認できます。求人内容を見直したあと、必要ならチャットで質問してください。</p>
      <a class="button" href="${DEMO_WORKER_URL}/demo-candidate-chat?candidate=${encodeURIComponent(candidate.id)}&matched=1&v=${DEMO_CHAT_VERSION}">進む</a>
    </section>
  </main>
</body>
</html>`;
}

function renderDemoCandidateJobCardsHtml(candidate: DemoCandidate, jobs: DemoCompanyJob[]): string {
  const hasJobs = jobs.length > 0;
  const jobsHtml = hasJobs ? jobs.map((job) => `
    <section class="job-card">
      <div class="banner-crop"><img class="job-banner" src="${escapeHtml(job.bannerUrl)}" alt="" style="${demoBannerStyle(job)}" /></div>
      <h2>${escapeHtml(job.title)}</h2>
      <div class="row"><div class="key">時給</div><div class="value">${escapeHtml(job.hourlyWage)}</div></div>
      <div class="row"><div class="key">勤務時間</div><div class="value">${escapeHtml(job.shift)}</div></div>
      <div class="row"><div class="key">仕事内容</div><div class="value">${escapeHtml(job.description)}</div></div>
      <a class="button" href="${DEMO_WORKER_URL}/demo-candidate-jobs?candidate=${encodeURIComponent(candidate.id)}&companyName=${encodeURIComponent(job.companyName)}">詳細を見る</a>
    </section>
  `).join('') : `
    <section>
      <h2>掲載中の求人はまだありません</h2>
      <p class="note">企業から求人が出稿されると、ここに求人カードとして表示されます。</p>
    </section>
  `;
  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>求人を見る</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Hiragino Sans", "Yu Gothic", system-ui, sans-serif; background: #f3f6fb; color: #111827; }
    header { position: sticky; top: 0; z-index: 2; padding: 16px 18px 14px; background: rgba(255,255,255,.96); border-bottom: 1px solid #e5e7eb; backdrop-filter: blur(10px); }
    .eyebrow { font-size: 12px; font-weight: 900; color: #2563EB; }
    h1 { margin: 4px 0 2px; font-size: 22px; line-height: 1.3; letter-spacing: 0; }
    .sub { color: #6b7280; font-size: 13px; line-height: 1.5; }
    main { padding: 14px 14px calc(24px + env(safe-area-inset-bottom)); display: grid; gap: 12px; }
    section { background: #fff; border: 1px solid #e5e7eb; border-radius: 16px; padding: 14px; box-shadow: 0 1px 2px rgba(15,23,42,.05); }
    h2 { margin: 0 0 10px; font-size: 15px; line-height: 1.4; }
    .row { display: grid; grid-template-columns: 88px 1fr; gap: 8px 12px; padding: 8px 0; border-top: 1px solid #f3f4f6; font-size: 13px; line-height: 1.6; }
    .row:first-of-type { border-top: 0; padding-top: 0; }
    .key { color: #6b7280; font-weight: 800; }
    .value { color: #111827; font-weight: 700; overflow-wrap: anywhere; }
    .note { color: #4b5563; font-size: 13px; line-height: 1.7; }
    .banner-crop { width: 100%; aspect-ratio: 20 / 10; overflow: hidden; border-radius: 12px; margin-bottom: 12px; background: #e5e7eb; }
    .job-banner { display: block; width: 100%; height: 100%; object-fit: cover; }
    .button { display: block; margin-top: 12px; text-align: center; text-decoration: none; border-radius: 14px; padding: 13px 14px; background: #2563EB; color: #fff; font-weight: 900; font-size: 14px; }
  </style>
</head>
<body>
  <header>
    <div class="eyebrow">求人カード</div>
    <h1>求人を見る</h1>
    <div class="sub">${escapeHtml(candidate.name)}さんに合いそうな求人カードを表示しています。</div>
  </header>
  <main>
    ${jobsHtml}
  </main>
</body>
</html>`;
}

function renderDemoCandidateStatusHtml(candidate: DemoCandidate, status: DemoCandidateStatus): string {
  const statusTone: Record<DemoCandidateStatus['status'], string> = {
    active: '#16A34A',
    interview: '#2563EB',
    rejected: '#DC2626',
    archived: '#6B7280',
  };
  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>応募状況</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Hiragino Sans", "Yu Gothic", system-ui, sans-serif; background: #f3f6fb; color: #111827; }
    header { position: sticky; top: 0; z-index: 2; padding: 16px 18px 14px; background: rgba(255,255,255,.96); border-bottom: 1px solid #e5e7eb; backdrop-filter: blur(10px); }
    .eyebrow { font-size: 12px; font-weight: 900; color: ${statusTone[status.status]}; }
    h1 { margin: 4px 0 2px; font-size: 22px; line-height: 1.3; letter-spacing: 0; }
    .sub { color: #6b7280; font-size: 13px; line-height: 1.5; }
    main { padding: 14px 14px calc(24px + env(safe-area-inset-bottom)); display: grid; gap: 12px; }
    section { background: #fff; border: 1px solid #e5e7eb; border-radius: 16px; padding: 14px; box-shadow: 0 1px 2px rgba(15,23,42,.05); }
    h2 { margin: 0 0 10px; font-size: 15px; line-height: 1.4; }
    .row { display: grid; grid-template-columns: 96px 1fr; gap: 8px 12px; padding: 9px 0; border-top: 1px solid #f3f4f6; font-size: 13px; line-height: 1.6; }
    .row:first-of-type { border-top: 0; padding-top: 0; }
    .key { color: #6b7280; font-weight: 800; }
    .value { color: #111827; font-weight: 800; overflow-wrap: anywhere; }
    .status-pill { display: inline-flex; align-items: center; min-height: 30px; padding: 5px 10px; border-radius: 999px; background: ${statusTone[status.status]}; color: #fff; font-size: 13px; font-weight: 900; }
    .note { color: #4b5563; font-size: 13px; line-height: 1.7; }
    .button { display: block; margin-top: 12px; text-align: center; text-decoration: none; border-radius: 14px; padding: 13px 14px; background: ${candidate.color}; color: #fff; font-weight: 900; font-size: 14px; }
  </style>
</head>
<body>
  <header>
    <div class="eyebrow">選考ステータス</div>
    <h1>応募状況</h1>
    <div class="sub">${escapeHtml(candidate.name)}さんの現在の選考状況を確認できます。</div>
  </header>
  <main>
    <section>
      <h2>現在のステータス</h2>
      <div class="status-pill">${escapeHtml(status.label)}</div>
      <div class="row"><div class="key">応募者</div><div class="value">${escapeHtml(candidate.name)}</div></div>
      <div class="row"><div class="key">応募求人</div><div class="value">${escapeHtml(candidate.job)}</div></div>
      <div class="row"><div class="key">次の確認</div><div class="value">${status.status === 'interview' ? '面接日程の連絡を確認してください。' : '企業からのメッセージを応募チャットで確認してください。'}</div></div>
    </section>
    <section>
      <h2>連絡先</h2>
      <p class="note">企業からのメッセージ、面接日程、選考結果は応募チャットに届きます。質問がある場合はチャットから返信してください。</p>
      <a class="button" href="${DEMO_WORKER_URL}/demo-candidate-chat?candidate=${encodeURIComponent(candidate.id)}&matched=1&v=${DEMO_CHAT_VERSION}">応募チャットを開く</a>
    </section>
  </main>
</body>
</html>`;
}

function renderDemoCompanyJobsHtml(job: DemoCompanyJob | null, companyName: string = DEMO_COMPANY_NAME): string {
  const editableJob = job ?? { ...DEFAULT_COMPANY_JOB, companyName };
  const publishedJobHtml = job ? `
    <section>
      <h2>掲載中の求人</h2>
      <div class="banner-crop"><img class="job-banner" src="${escapeHtml(job.bannerUrl)}" alt="" style="${demoBannerStyle(job)}" /></div>
      <div class="row"><div class="key">求人名</div><div class="value">${escapeHtml(job.title)}</div></div>
      <div class="row"><div class="key">時給</div><div class="value">${escapeHtml(job.hourlyWage)}</div></div>
      <div class="row"><div class="key">勤務条件</div><div class="value">${escapeHtml(job.shift)}</div></div>
      <div class="row"><div class="key">応募導線</div><div class="value">求職者LINEの「求人を見る」から確認可能</div></div>
    </section>
  ` : `
    <section>
      <h2>掲載中の求人はまだありません</h2>
      <p class="note">この会社ではまだ求人を出稿していません。下のフォームから作成すると、求職者LINEに通知できます。</p>
    </section>
  `;
  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
	  <title>採用PRO 求人案内設定</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Hiragino Sans", "Yu Gothic", system-ui, sans-serif; background: #f3f6fb; color: #111827; }
    header { position: sticky; top: 0; z-index: 2; padding: 16px 18px 14px; background: rgba(255,255,255,.96); border-bottom: 1px solid #e5e7eb; backdrop-filter: blur(10px); }
    .eyebrow { font-size: 12px; font-weight: 900; color: #7C3AED; }
    h1 { margin: 4px 0 2px; font-size: 22px; line-height: 1.3; letter-spacing: 0; }
    .sub { color: #6b7280; font-size: 13px; line-height: 1.5; }
    main { padding: 14px 14px calc(24px + env(safe-area-inset-bottom)); display: grid; gap: 12px; }
    section { background: #fff; border: 1px solid #e5e7eb; border-radius: 16px; padding: 14px; box-shadow: 0 1px 2px rgba(15,23,42,.05); }
    h2 { margin: 0 0 10px; font-size: 15px; line-height: 1.4; }
    .row { display: grid; grid-template-columns: 96px 1fr; gap: 8px 12px; padding: 8px 0; border-top: 1px solid #f3f4f6; font-size: 13px; line-height: 1.6; }
    .row:first-of-type { border-top: 0; padding-top: 0; }
    .key { color: #6b7280; font-weight: 800; }
    .value { color: #111827; font-weight: 700; overflow-wrap: anywhere; }
    .metric-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
    .metric { border: 1px solid #e5e7eb; border-radius: 14px; padding: 11px 8px; text-align: center; background: #fafafa; }
    .metric strong { display: block; font-size: 20px; line-height: 1.2; }
    .metric span { display: block; margin-top: 4px; color: #6b7280; font-size: 11px; font-weight: 800; }
    .note { color: #4b5563; font-size: 13px; line-height: 1.7; }
    .button { display: block; text-align: center; text-decoration: none; border-radius: 14px; padding: 13px 14px; background: #7C3AED; color: #fff; font-weight: 900; font-size: 14px; }
    .banner-crop { width: 100%; aspect-ratio: 20 / 10; overflow: hidden; border-radius: 12px; margin-bottom: 12px; background: #e5e7eb; }
    .job-banner { display: block; width: 100%; height: 100%; object-fit: cover; }
    body.is-cropping { overflow: hidden; overscroll-behavior: none; touch-action: none; }
    .banner-presets { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
    .preset { min-height: 40px; border-radius: 12px; border: 1px solid #d1d5db; background: #f9fafb; color: #374151; font-size: 12px; font-weight: 900; }
    .banner-mode { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
    .mode-option { display: flex; align-items: center; justify-content: center; min-height: 42px; border: 1px solid #d1d5db; border-radius: 12px; background: #f9fafb; color: #374151; font-size: 13px; font-weight: 900; }
    .mode-option input { width: auto; margin: 0 6px 0 0; }
    .banner-panel[hidden] { display: none; }
    .upload-label input { padding: 10px; background: #f9fafb; }
    .crop-help { margin: 0 0 8px; color: #4b5563; font-size: 12px; line-height: 1.6; font-weight: 800; }
    .banner-crop.is-editing { touch-action: none; cursor: grab; border: 1px dashed #94a3b8; user-select: none; -webkit-user-select: none; }
    .banner-crop.is-editing:active { cursor: grabbing; }
    .banner-crop.is-editing .job-banner { object-fit: cover; }
    .banner-preview-button { display: block; width: 100%; padding: 0; border: 0; border-radius: 12px; background: transparent; text-align: left; }
    .banner-preview-button .banner-crop { margin-bottom: 8px; }
    .editor-sheet[hidden] { display: none; }
    .editor-sheet { position: fixed; inset: 0; z-index: 10; display: grid; grid-template-rows: 1fr auto; background: rgba(15,23,42,.38); }
    .editor-panel { align-self: end; max-height: calc(100dvh - 34px); overflow-y: auto; border-radius: 22px 22px 0 0; background: #fff; padding: 14px; display: grid; gap: 12px; box-shadow: 0 -18px 40px rgba(15,23,42,.20); }
    .editor-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
    .editor-head h3 { margin: 0; font-size: 18px; line-height: 1.4; }
    .editor-close { width: 42px; min-height: 42px; border-radius: 999px; background: #f3f4f6; color: #111827; }
    .editor-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .editor-actions .secondary { background: #f3f4f6; color: #111827; }
    .range-row { display: grid; grid-template-columns: 1fr 44px; align-items: center; gap: 10px; }
    form { display: grid; gap: 12px; }
    label { display: grid; gap: 6px; font-size: 12px; font-weight: 900; color: #374151; }
    input, textarea { width: 100%; border: 1px solid #d1d5db; border-radius: 12px; padding: 12px; font: inherit; font-size: 16px; outline: none; background: #fff; }
    textarea { min-height: 96px; resize: vertical; line-height: 1.6; }
    button { min-height: 48px; border: 0; border-radius: 14px; background: #16A34A; color: #fff; font-weight: 900; font-size: 15px; }
    button[disabled] { opacity: .72; cursor: wait; }
    .status { min-height: 20px; color: #166534; font-size: 13px; font-weight: 800; line-height: 1.6; }
    .status.is-loading { display: flex; align-items: center; gap: 8px; color: #1d4ed8; }
    .status.is-loading::before { content: ""; width: 14px; height: 14px; flex: 0 0 auto; border: 2px solid #bfdbfe; border-top-color: #2563eb; border-radius: 999px; animation: spin .8s linear infinite; }
    .status.is-success { color: #166534; }
    .status.is-error { color: #991b1b; }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <header>
	    <div class="eyebrow">求人案内設定</div>
    <h1>${escapeHtml(companyName)}</h1>
	    <div class="sub">採用PRO経由で案内する求人内容を確認できます。</div>
  </header>
  <main>
    ${publishedJobHtml}
    <section>
	      <h2>求人案内を作成</h2>
      <form id="jobForm">
        <input id="companyName" name="companyName" type="hidden" value="${escapeHtml(companyName)}" />
        <label>求人名<input id="title" name="title" value="${escapeHtml(editableJob.title)}" /></label>
        <label>時給<input id="hourlyWage" name="hourlyWage" value="${escapeHtml(editableJob.hourlyWage)}" /></label>
        <label>勤務条件<input id="shift" name="shift" value="${escapeHtml(editableJob.shift)}" /></label>
        <label>仕事内容<textarea id="description" name="description">${escapeHtml(editableJob.description)}</textarea></label>
        <div>
          <div class="key">バナー設定</div>
          <button id="openBannerEditor" class="banner-preview-button" type="button">
            <div class="banner-crop"><img id="bannerMainPreview" class="job-banner" src="${escapeHtml(editableJob.bannerUrl)}" alt="" style="${demoBannerStyle(editableJob)}" /></div>
            <span class="note">バナーをタップして写真を編集できます。</span>
          </button>
        </div>
        <input id="bannerUrl" type="hidden" value="${escapeHtml(editableJob.bannerUrl)}" />
        <input id="bannerOffsetX" type="hidden" value="${editableJob.bannerOffsetX}" />
        <input id="bannerOffsetY" type="hidden" value="${editableJob.bannerOffsetY}" />
        <input id="bannerZoomHidden" type="hidden" value="${editableJob.bannerZoom}" />
        <button type="submit">求職者LINEへ出稿する</button>
        <div id="status" class="status"></div>
      </form>
    </section>
    <section id="bannerEditorSheet" class="editor-sheet" hidden>
      <div></div>
      <div class="editor-panel">
        <div class="editor-head">
          <h3>バナーを編集</h3>
          <button id="bannerEditorClose" class="editor-close" type="button">×</button>
        </div>
        <div class="banner-mode">
          <label class="mode-option"><input type="radio" name="bannerMode" value="url" checked />URLで指定</label>
          <label class="mode-option"><input type="radio" name="bannerMode" value="upload" />画像をアップロード</label>
        </div>
        <div id="bannerUrlPanel" class="banner-panel">
          <label>求人バナーURL<input id="bannerUrlInput" name="bannerUrlInput" value="${escapeHtml(editableJob.bannerUrl)}" /></label>
          <div class="banner-presets" aria-label="バナープリセット">
            <button class="preset" type="button" data-banner="https://placehold.co/1024x520/16A34A/FFFFFF/png?text=Staff+Wanted">飲食</button>
            <button class="preset" type="button" data-banner="https://placehold.co/1024x520/2563EB/FFFFFF/png?text=Now+Hiring">採用強化</button>
            <button class="preset" type="button" data-banner="https://placehold.co/1024x520/7C3AED/FFFFFF/png?text=Cafe+Staff">カフェ</button>
          </div>
        </div>
        <div id="bannerUploadPanel" class="banner-panel" hidden>
          <label class="upload-label">画像をアップロード<input id="bannerFile" type="file" accept="image/png,image/jpeg,image/jpg,image/webp" /></label>
        </div>
        <label>拡大率
          <div class="range-row">
            <input id="bannerZoom" type="range" min="1" max="1.8" step="0.05" value="${editableJob.bannerZoom}" />
            <span id="bannerZoomValue">${editableJob.bannerZoom.toFixed(2)}</span>
          </div>
        </label>
        <label>縦位置
          <div class="range-row">
            <input id="bannerVerticalOffset" type="range" min="-45" max="45" step="1" value="${editableJob.bannerOffsetY}" />
            <span id="bannerVerticalOffsetValue">${editableJob.bannerOffsetY}</span>
          </div>
        </label>
        <div>
          <div class="key">切り抜き位置</div>
          <p class="crop-help">横幅固定で、縦位置と拡大率を調整できます。画像をドラッグして位置調整、2本指でピンチ拡大できます。</p>
          <div id="bannerCropFrame" class="banner-crop is-editing"><img id="bannerPreview" class="job-banner" src="${escapeHtml(editableJob.bannerUrl)}" alt="" style="${demoBannerStyle(editableJob)}" /></div>
        </div>
        <div class="editor-actions">
          <button id="bannerEditorReset" class="secondary" type="button">リセット</button>
          <button id="bannerEditorDone" type="button">決定</button>
        </div>
      </div>
    </section>
    <section>
      <h2>応募状況</h2>
      <div class="metric-grid">
        <div class="metric"><strong>2</strong><span>応募者</span></div>
        <div class="metric"><strong>1</strong><span>面接調整</span></div>
        <div class="metric"><strong>0</strong><span>未返信</span></div>
      </div>
    </section>
    <section>
      <h2>応募率を上げる改善</h2>
      <p class="note">次に作るなら、写真、時給、シフト例、店長コメントをここで編集できるようにします。今のデモでは、企業側が求人の見え方を確認する場所として使えます。</p>
      <a class="button" href="${DEMO_WORKER_URL}/demo-chat?candidate=yamada">求職者対応へ戻る</a>
    </section>
  </main>
  <script>
    const form = document.getElementById('jobForm');
    const statusEl = document.getElementById('status');
    const bannerUrlEl = document.getElementById('bannerUrl');
    const bannerUrlInputEl = document.getElementById('bannerUrlInput');
    const bannerPreviewEl = document.getElementById('bannerPreview');
    const bannerMainPreviewEl = document.getElementById('bannerMainPreview');
    const bannerFileEl = document.getElementById('bannerFile');
    const bannerUrlPanel = document.getElementById('bannerUrlPanel');
    const bannerUploadPanel = document.getElementById('bannerUploadPanel');
    const bannerZoomEl = document.getElementById('bannerZoom');
    const bannerZoomHiddenEl = document.getElementById('bannerZoomHidden');
    const bannerZoomValueEl = document.getElementById('bannerZoomValue');
    const bannerVerticalOffsetEl = document.getElementById('bannerVerticalOffset');
    const bannerVerticalOffsetValueEl = document.getElementById('bannerVerticalOffsetValue');
    const bannerOffsetXEl = document.getElementById('bannerOffsetX');
    const bannerOffsetYEl = document.getElementById('bannerOffsetY');
    const bannerCropFrame = document.getElementById('bannerCropFrame');
    const bannerEditorSheet = document.getElementById('bannerEditorSheet');
    const openBannerEditor = document.getElementById('openBannerEditor');
    const bannerEditorDone = document.getElementById('bannerEditorDone');
    const bannerEditorClose = document.getElementById('bannerEditorClose');
    const bannerEditorReset = document.getElementById('bannerEditorReset');
    const submitButton = form.querySelector('button[type="submit"]');
    let cropDirty = false;
    let dragging = false;
    let dragStartX = 0;
    let dragStartY = 0;
    let dragBaseX = Number(bannerOffsetXEl.value || '0');
    let dragBaseY = Number(bannerOffsetYEl.value || '0');
    let pinchStartDistance = 0;
    let pinchStartZoom = Number(bannerZoomEl.value || '1');
    function clampOffset(value) {
      return Math.max(-45, Math.min(45, Math.round(value * 10) / 10));
    }
    function clampZoom(value) {
      return Math.max(1, Math.min(1.8, Math.round(value * 100) / 100));
    }
    function setStatus(message, state) {
      statusEl.textContent = message;
      statusEl.classList.remove('is-loading', 'is-success', 'is-error');
      if (state) statusEl.classList.add(state);
    }
    function setBusy(button, busy, label) {
      if (!button) return;
      if (!button.dataset.idleLabel) button.dataset.idleLabel = button.textContent || '';
      button.disabled = busy;
      button.textContent = busy ? label : button.dataset.idleLabel;
    }
    function currentOffsetX() {
      return Number(bannerOffsetXEl.value || '0');
    }
    function currentOffsetY() {
      return Number(bannerOffsetYEl.value || '0');
    }
    function verticalObjectPosition() {
      return Math.max(0, Math.min(100, 50 + currentOffsetY()));
    }
    function applyBannerPreview() {
      const zoom = Number(bannerZoomEl.value || '1');
      bannerPreviewEl.style.objectPosition = '50% ' + verticalObjectPosition() + '%';
      bannerPreviewEl.style.transform = 'scale(' + zoom + ')';
      bannerZoomValueEl.textContent = zoom.toFixed(2);
      bannerVerticalOffsetEl.value = String(currentOffsetY());
      bannerVerticalOffsetValueEl.textContent = String(currentOffsetY());
    }
    function applyMainPreview() {
      bannerMainPreviewEl.src = bannerUrlEl.value;
      bannerMainPreviewEl.style.objectPosition = '50% ' + verticalObjectPosition() + '%';
      bannerMainPreviewEl.style.transform = 'scale(' + (bannerZoomHiddenEl.value || '1') + ')';
    }
    function setBannerOffset(x, y) {
      bannerOffsetXEl.value = String(clampOffset(x));
      bannerOffsetYEl.value = String(clampOffset(y));
      cropDirty = true;
      applyBannerPreview();
    }
    function applyVerticalOffset(value) {
      setBannerOffset(0, value);
    }
    function setBannerZoom(value) {
      const zoom = clampZoom(value);
      bannerZoomEl.value = String(zoom);
      bannerZoomHiddenEl.value = String(zoom);
      cropDirty = true;
      applyBannerPreview();
    }
    function preventCropScroll(event) {
      if (dragging) event.preventDefault();
    }
    function startCropLock() {
      document.body.classList.add('is-cropping');
      document.addEventListener('touchmove', preventCropScroll, { passive: false });
      document.addEventListener('wheel', preventCropScroll, { passive: false });
    }
    function endCropLock() {
      dragging = false;
      pinchStartDistance = 0;
      document.body.classList.remove('is-cropping');
      document.removeEventListener('touchmove', preventCropScroll);
      document.removeEventListener('wheel', preventCropScroll);
    }
    function distanceBetweenTouches(touches) {
      const first = touches[0];
      const second = touches[1];
      const dx = second.clientX - first.clientX;
      const dy = second.clientY - first.clientY;
      return Math.sqrt(dx * dx + dy * dy);
    }
    function handlePinchStart(event) {
      if (event.touches.length !== 2) return;
      dragging = false;
      pinchStartDistance = distanceBetweenTouches(event.touches);
      pinchStartZoom = Number(bannerZoomEl.value || '1');
      startCropLock();
      event.preventDefault();
    }
    function handlePinchMove(event) {
      if (event.touches.length !== 2 || !pinchStartDistance) return;
      const nextDistance = distanceBetweenTouches(event.touches);
      setBannerZoom(pinchStartZoom * (nextDistance / pinchStartDistance));
      event.preventDefault();
    }
    function handlePinchEnd(event) {
      if (event.touches.length < 2) endCropLock();
    }
    function syncBannerMode() {
      const mode = document.querySelector('input[name="bannerMode"]:checked').value;
      bannerUrlPanel.hidden = mode !== 'url';
      bannerUploadPanel.hidden = mode !== 'upload';
    }
    document.querySelectorAll('input[name="bannerMode"]').forEach((input) => {
      input.addEventListener('change', syncBannerMode);
    });
    function openEditor() {
      bannerEditorSheet.hidden = false;
      bannerUrlInputEl.value = bannerUrlEl.value;
      bannerPreviewEl.src = bannerUrlEl.value;
      bannerZoomEl.value = bannerZoomHiddenEl.value || '1';
      bannerVerticalOffsetEl.value = bannerOffsetYEl.value || '0';
      bannerPreviewEl.style.objectFit = 'cover';
      requestAnimationFrame(applyBannerPreview);
    }
    function closeEditor() {
      bannerEditorSheet.hidden = true;
      endCropLock();
    }
    openBannerEditor.addEventListener('click', openEditor);
    bannerEditorClose.addEventListener('click', closeEditor);
    bannerEditorDone.addEventListener('click', () => {
      bannerUrlEl.value = bannerUrlInputEl.value.trim();
      bannerZoomHiddenEl.value = bannerZoomEl.value || '1';
      applyMainPreview();
      closeEditor();
    });
    bannerEditorReset.addEventListener('click', () => {
      setBannerZoom(1);
      setBannerOffset(0, 0);
      cropDirty = true;
      applyBannerPreview();
    });
    bannerUrlInputEl.addEventListener('input', () => {
      bannerPreviewEl.src = bannerUrlInputEl.value.trim();
      bannerPreviewEl.style.objectFit = 'cover';
      cropDirty = true;
      applyBannerPreview();
    });
    bannerCropFrame.addEventListener('pointerdown', (event) => {
      dragging = true;
      dragStartX = event.clientX;
      dragStartY = event.clientY;
      dragBaseX = 0;
      dragBaseY = currentOffsetY();
      document.body.classList.add('is-cropping');
      startCropLock();
      bannerCropFrame.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    bannerCropFrame.addEventListener('pointermove', (event) => {
      if (!dragging) return;
      event.preventDefault();
      const rect = bannerCropFrame.getBoundingClientRect();
      const dy = ((event.clientY - dragStartY) / Math.max(1, rect.height)) * 100;
      setBannerOffset(dragBaseX, dragBaseY - dy);
    });
    bannerCropFrame.addEventListener('pointerup', (event) => {
      endCropLock();
      bannerCropFrame.releasePointerCapture(event.pointerId);
    });
    bannerCropFrame.addEventListener('pointercancel', () => {
      endCropLock();
    });
    bannerCropFrame.addEventListener('touchstart', handlePinchStart, { passive: false });
    bannerCropFrame.addEventListener('touchmove', handlePinchMove, { passive: false });
    bannerCropFrame.addEventListener('touchend', handlePinchEnd);
    bannerCropFrame.addEventListener('touchcancel', handlePinchEnd);
    bannerZoomEl.addEventListener('input', () => {
      setBannerZoom(Number(bannerZoomEl.value || '1'));
    });
    bannerVerticalOffsetEl.addEventListener('input', () => {
      applyVerticalOffset(Number(bannerVerticalOffsetEl.value || '0'));
    });
    bannerFileEl.addEventListener('change', async () => {
      const file = bannerFileEl.files && bannerFileEl.files[0];
      if (!file) return;
      setStatus('画像をアップロードしています。数秒かかることがあります...', 'is-loading');
      bannerFileEl.disabled = true;
      setBusy(bannerEditorDone, true, 'アップロード中...');
      try {
        const res = await fetch('/demo-company-jobs/banner', {
          method: 'POST',
          headers: { 'Content-Type': file.type || 'image/png' },
          body: file,
        });
        const json = await res.json();
        if (!res.ok || !json.success || !json.data?.url) throw new Error(json.error || 'upload failed');
        bannerUrlEl.value = json.data.url;
        bannerUrlInputEl.value = json.data.url;
        bannerPreviewEl.src = json.data.url;
        bannerPreviewEl.style.objectFit = 'cover';
        setBannerOffset(0, 0);
        cropDirty = true;
        applyBannerPreview();
        setStatus('画像をアップロードしました。バナーを確認して「決定」を押してください。', 'is-success');
      } catch (err) {
        setStatus('画像をアップロードできませんでした。PNG/JPEG/WebPを選んでください。', 'is-error');
      } finally {
        bannerFileEl.disabled = false;
        setBusy(bannerEditorDone, false);
      }
    });
    document.querySelectorAll('[data-banner]').forEach((button) => {
      button.addEventListener('click', () => {
        bannerUrlEl.value = button.dataset.banner || '';
        bannerUrlInputEl.value = bannerUrlEl.value;
        bannerPreviewEl.src = bannerUrlEl.value;
        bannerPreviewEl.style.objectFit = 'cover';
        setBannerOffset(0, 0);
        cropDirty = true;
        applyBannerPreview();
      });
    });
    async function uploadCroppedBannerIfNeeded(payload) {
      const sourceUrl = bannerUrlInputEl.value.trim() || bannerUrlEl.value;
      if (!cropDirty || !sourceUrl.startsWith(window.location.origin + '/images/')) return payload;
      setStatus('バナーを最終保存しています...', 'is-loading');
      const image = new Image();
      image.crossOrigin = 'anonymous';
      image.src = sourceUrl;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = 1024;
      canvas.height = 512;
      const context = canvas.getContext('2d');
      const zoom = Number(bannerZoomEl.value || '1');
      const scale = Math.max(canvas.width / image.naturalWidth, canvas.height / image.naturalHeight) * zoom;
      const drawWidth = image.naturalWidth * scale;
      const drawHeight = image.naturalHeight * scale;
      const drawX = (canvas.width - drawWidth) / 2;
      const verticalPositionRatio = Math.max(0, Math.min(1, (50 + currentOffsetY()) / 100));
      const verticalExcess = Math.max(0, drawHeight - canvas.height);
      const drawY = -verticalExcess * verticalPositionRatio;
      context.drawImage(image, drawX, drawY, drawWidth, drawHeight);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
      if (!blob) return payload;
      const res = await fetch('/demo-company-jobs/banner', {
        method: 'POST',
        headers: { 'Content-Type': 'image/jpeg' },
        body: blob,
      });
      const json = await res.json();
      if (!res.ok || !json.success || !json.data?.url) return payload;
      payload.bannerUrl = json.data.url;
      payload.bannerOffsetX = 0;
      payload.bannerOffsetY = 0;
      payload.bannerZoom = 1;
      bannerUrlEl.value = json.data.url;
      bannerUrlInputEl.value = json.data.url;
      bannerPreviewEl.src = json.data.url;
      bannerZoomHiddenEl.value = '1';
      setBannerOffset(0, 0);
      bannerZoomEl.value = '1';
      cropDirty = false;
      applyBannerPreview();
      return payload;
    }
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      setBusy(submitButton, true, '出稿中...');
      setStatus('求人内容を確認しています...', 'is-loading');
      try {
        let payload = {
          companyName: document.getElementById('companyName').value.trim(),
          title: document.getElementById('title').value.trim(),
          hourlyWage: document.getElementById('hourlyWage').value.trim(),
          shift: document.getElementById('shift').value.trim(),
          description: document.getElementById('description').value.trim(),
          bannerUrl: bannerUrlEl.value.trim(),
          bannerOffsetX: currentOffsetX(),
          bannerOffsetY: currentOffsetY(),
          bannerZoom: Number(bannerZoomHiddenEl.value || bannerZoomEl.value || '1'),
        };
        payload = await uploadCroppedBannerIfNeeded(payload);
        setStatus('求人を保存しました。求職者LINEへ通知しています...', 'is-loading');
        const res = await fetch('/demo-company-jobs/publish', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const json = await res.json().catch(() => null);
        if (!res.ok || !json?.success) throw new Error(json?.error || 'publish failed');
        const notificationCount = Number(json.data?.notificationCount || 0);
        const notificationText = notificationCount > 0
          ? '求職者LINEへ' + notificationCount + '件通知しました。'
          : '通知できる求職者はまだいません。';
        setStatus('出稿完了。' + notificationText, 'is-success');
      } catch (err) {
        setStatus('出稿できませんでした。時間をおいてもう一度お試しください。', 'is-error');
      } finally {
        setBusy(submitButton, false);
      }
    });
    syncBannerMode();
    applyBannerPreview();
    applyMainPreview();
  </script>
</body>
</html>`;
}

function renderDemoCompanySettingsHtml(): string {
  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>採用PRO 対応設定</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Hiragino Sans", "Yu Gothic", system-ui, sans-serif; background: #f3f6fb; color: #111827; }
    header { position: sticky; top: 0; z-index: 2; padding: 16px 18px 14px; background: rgba(255,255,255,.96); border-bottom: 1px solid #e5e7eb; backdrop-filter: blur(10px); }
    .eyebrow { font-size: 12px; font-weight: 900; color: #4B5563; }
    h1 { margin: 4px 0 2px; font-size: 22px; line-height: 1.3; letter-spacing: 0; }
    .sub { color: #6b7280; font-size: 13px; line-height: 1.5; }
    main { padding: 14px 14px calc(24px + env(safe-area-inset-bottom)); display: grid; gap: 12px; }
    section { background: #fff; border: 1px solid #e5e7eb; border-radius: 16px; padding: 14px; box-shadow: 0 1px 2px rgba(15,23,42,.05); }
    section h2 { margin: 0 0 8px; font-size: 15px; line-height: 1.4; }
    section p { margin: 0; color: #4b5563; font-size: 13px; line-height: 1.7; }
    form { display: grid; gap: 12px; background: #fff; border: 1px solid #e5e7eb; border-radius: 16px; padding: 14px; box-shadow: 0 1px 2px rgba(15,23,42,.05); }
    label { display: grid; gap: 6px; font-size: 12px; font-weight: 900; color: #374151; }
    input, textarea { width: 100%; border: 1px solid #d1d5db; border-radius: 12px; padding: 12px; font: inherit; font-size: 16px; outline: none; background: #fff; }
    textarea { min-height: 96px; resize: vertical; line-height: 1.6; }
    button { min-height: 48px; border: 0; border-radius: 14px; background: #4B5563; color: #fff; font-weight: 900; font-size: 15px; }
    .status { min-height: 20px; color: #166534; font-size: 13px; font-weight: 800; }
  </style>
</head>
<body>
	  <header>
	    <div class="eyebrow">採用PRO 対応設定</div>
	    <h1>${escapeHtml(DEMO_COMPANY_NAME)}</h1>
	    <div class="sub">求人企業名、担当者名、面談URL、応募者へ送る案内文を設定します。</div>
  </header>
  <main>
    <form id="settingsForm">
	      <label>求人企業名<input id="companyName" name="companyName" value="${escapeHtml(DEFAULT_COMPANY_SETTINGS.companyName)}" /></label>
      <label>担当者名<input id="staffName" name="staffName" value="${escapeHtml(DEFAULT_COMPANY_SETTINGS.staffName)}" /></label>
      <label>面談URL<input id="interviewUrl" name="interviewUrl" inputmode="url" value="${escapeHtml(DEFAULT_COMPANY_SETTINGS.interviewUrl)}" /></label>
      <label>面接案内文<textarea id="interviewMessage" name="interviewMessage">${escapeHtml(DEFAULT_COMPANY_SETTINGS.interviewMessage)}</textarea></label>
      <button type="submit">保存</button>
      <div id="status" class="status"></div>
    </form>
  </main>
  <script>
    const form = document.getElementById('settingsForm');
    const statusEl = document.getElementById('status');
    async function loadSettings() {
      const res = await fetch('/demo-chat/settings');
      const json = await res.json();
      const settings = json.data.settings;
      document.getElementById('companyName').value = settings.companyName || '';
      document.getElementById('staffName').value = settings.staffName || '';
      document.getElementById('interviewUrl').value = settings.interviewUrl || '';
      document.getElementById('interviewMessage').value = settings.interviewMessage || '';
    }
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      statusEl.textContent = '';
      const payload = {
        companyName: document.getElementById('companyName').value.trim(),
        staffName: document.getElementById('staffName').value.trim(),
        interviewUrl: document.getElementById('interviewUrl').value.trim(),
        interviewMessage: document.getElementById('interviewMessage').value.trim(),
      };
      const res = await fetch('/demo-chat/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      statusEl.textContent = res.ok ? '保存しました' : '保存できませんでした';
    });
    loadSettings();
  </script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export { demoChat };
