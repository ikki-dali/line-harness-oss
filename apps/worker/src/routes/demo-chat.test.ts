import { describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';
import { demoChat } from './demo-chat.js';

const linePushMessageMock = vi.hoisted(() => vi.fn());

vi.mock('@line-crm/db', () => ({
  jstNow: vi.fn(() => '2026-06-07T12:00:00+09:00'),
}));

vi.mock('@line-crm/line-sdk', () => ({
  LineClient: vi.fn().mockImplementation(() => ({
    pushMessage: linePushMessageMock,
  })),
}));

function setupApp(db: D1Database, overrides: Partial<{ IMAGES: R2Bucket; WORKER_URL: string }> = {}) {
  const app = new Hono();
  app.route('/', demoChat);
  return {
    request: (path: string, init?: RequestInit) => app.request(path, init, { DB: db, ...overrides }),
  };
}

function createProfileDb(
  candidateStatus: 'active' | 'interview' | 'rejected' | 'archived' = 'active',
  options: Partial<{ rememberedCandidateLineUserId: string; primaryCandidateLineUserId: string; hasOldCandidateChatLog: boolean }> = {},
) {
  const insertBinds: unknown[][] = [];
  const companyJobs: string[] = [];
  const rememberedCandidateLineUserId = options.rememberedCandidateLineUserId ?? 'candidate-line-user-id';
  const primaryCandidateLineUserId = options.primaryCandidateLineUserId ?? 'candidate-line-user-id';
  const statusLabels = {
    active: 'やり取り中',
    interview: '面接',
    rejected: '不合格',
    archived: '削除済み',
  };
  const settings = {
    companyName: 'Ikki Yamamoto 会社アカウント',
    staffName: '採用担当',
    interviewUrl: 'https://timerex.net/s/demo',
    interviewMessage: '面接日程をご調整ください。',
  };
  const db = {
    prepare(sql: string) {
      const first = async () => {
        if (sql.includes('SELECT id FROM friends')) return { id: 'friend-1' };
        if (options.hasOldCandidateChatLog && sql.includes('FROM messages_log')) return { id: 'message-1' };
        if (sql.includes('SELECT content') && sql.includes('demo_company_job')) {
          return companyJobs.length ? { content: companyJobs[companyJobs.length - 1] } : null;
        }
        return null;
      };
      const all = async () => {
        if (sql.includes('FROM friends') && sql.includes('line_account_id')) {
          return {
            results: [
              {
                id: 'friend-1',
                line_user_id: 'candidate-line-user-id',
                display_name: 'Ikki Yamamoto',
                created_at: '2026-06-09T10:00:00+09:00',
                updated_at: '2026-06-09T10:00:00+09:00',
              },
              {
                id: 'friend-2',
                line_user_id: 'candidate-line-user-id-2',
                display_name: '泰地',
                created_at: '2026-06-09T11:00:00+09:00',
                updated_at: '2026-06-09T11:00:00+09:00',
              },
            ],
          };
        }
        if (sql.includes('SELECT content') && sql.includes('demo_company_job')) {
          return { results: companyJobs.map((content) => ({ content })).reverse() };
        }
        return { results: [] };
      };
      return {
        first,
        all,
        bind(...values: unknown[]) {
          return {
            first: async () => {
              if (sql.includes('SELECT channel_access_token FROM line_accounts')) {
                return { channel_access_token: 'line-token' };
              }
              if (options.hasOldCandidateChatLog && sql.includes('FROM messages_log')) {
                return { id: 'message-1' };
              }
              if (sql.includes('SELECT line_user_id') && sql.includes('FROM friends')) {
                if (sql.includes('display_name') || sql.includes('created_at ASC')) {
                  return { line_user_id: primaryCandidateLineUserId, metadata: null };
                }
                return { line_user_id: rememberedCandidateLineUserId, metadata: null };
              }
              if (sql.includes('SELECT content') && sql.includes('demo_candidate_profile')) {
                return {
                  content: JSON.stringify({
                    candidateId: 'friend-1',
                    fullName: 'Ikki Yamamoto',
                    kana: 'やまもと いっき',
                    phone: '090-1234-5678',
                    availability: '週3 夜',
                    memo: '接客経験あり',
                  }),
                };
              }
              if (sql.includes('SELECT content') && sql.includes('demo_company_settings')) {
                return { content: JSON.stringify(settings) };
              }
              if (sql.includes('SELECT content') && sql.includes('demo_company_job')) {
                return companyJobs.length ? { content: companyJobs[companyJobs.length - 1] } : null;
              }
              if (sql.includes('SELECT content') && sql.includes('demo_candidate_status')) {
                return {
                  content: JSON.stringify({
                    candidateId: 'friend-1',
                    status: candidateStatus,
                    label: statusLabels[candidateStatus],
                  }),
                };
              }
              if (sql.includes('SELECT id FROM friends')) return { id: 'friend-1' };
              return null;
            },
            run: async () => {
              insertBinds.push(values);
              if (values.includes('demo_company_job') && typeof values[2] === 'string') {
                companyJobs.push(values[2]);
              }
              return { success: true };
            },
            all,
          };
        },
      };
    },
  } as unknown as D1Database;

  return { db, insertBinds };
}

describe('demo candidate profile', () => {
  test('returns the saved profile for a candidate', async () => {
    const { db } = createProfileDb();
    const app = setupApp(db);

    const res = await app.request('/demo-chat/profile?candidate=yamada');

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      success: true,
      data: {
        candidate: expect.objectContaining({ id: 'friend-1', name: 'Ikki Yamamoto' }),
        profile: {
          candidateId: 'friend-1',
          fullName: 'Ikki Yamamoto',
          kana: 'やまもと いっき',
          phone: '090-1234-5678',
          availability: '週3 夜',
          memo: '接客経験あり',
        },
      },
    });
  });

  test('saves a candidate-created profile into the demo log', async () => {
    const { db, insertBinds } = createProfileDb();
    const app = setupApp(db);

    const res = await app.request('/demo-chat/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        candidate: 'yamada',
        fullName: '山本 一気',
        kana: 'やまもと いっき',
        phone: '090-1234-5678',
        availability: '週3 夜',
        memo: '接客経験あり',
      }),
    });

    expect(res.status).toBe(200);
    const json = await res.json() as { success: boolean; data: { profile: { fullName: string } } };
    expect(json.success).toBe(true);
    expect(json.data.profile.fullName).toBe('山本 一気');
    expect(insertBinds).toHaveLength(1);
    expect(insertBinds[0][1]).toBe('friend-1');
    expect(JSON.parse(insertBinds[0][2] as string)).toMatchObject({
      candidateId: 'yamada',
      fullName: '山本 一気',
      availability: '週3 夜',
    });
  });

  test('candidate chat page exposes profile editing from the header', async () => {
    const { db } = createProfileDb();
    const app = setupApp(db);

    const res = await app.request('/demo-candidate-chat?candidate=yamada&matched=1');
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain('id="profileButton"');
    expect(html).toContain('プロフィールを設定してください');
    expect(html).toContain('プロフィール編集');
    expect(html).toContain('採用上のお名前');
    expect(html).toContain('/demo-chat/profile');
  });

  test('matched candidate chat uses service header instead of a fixed company header', async () => {
    const { db } = createProfileDb();
    const app = setupApp(db);

    const res = await app.request('/demo-candidate-chat?candidate=yamada&matched=1');
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain('<title>応募チャット</title>');
    expect(html).toContain('<div class="name">採用PRO 応募チャット</div>');
    expect(html).not.toContain('<title>ボードルアー とのチャット</title>');
    expect(html).not.toContain('<div class="name">ボードルアー</div>');
  });

  test('candidate chat page asks the user to apply before opening chat when not matched', async () => {
    const { db } = createProfileDb();
    const app = setupApp(db);

    const res = await app.request('/demo-candidate-chat?candidate=yamada');
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain('求人に応募してチャットを始めよう！！');
    expect(html).toContain('/demo-candidate-jobs?candidate=yamada');
    expect(html).not.toContain('id="messages"');
    expect(html).not.toContain('id="form"');
    expect(html).not.toContain('ボードルアー とのチャット');
  });

  test('candidate chat page does not open from old logs without an explicit match', async () => {
    const { db } = createProfileDb('active', { hasOldCandidateChatLog: true });
    const app = setupApp(db);

    const res = await app.request('/demo-candidate-chat?candidate=yamada');
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain('求人に応募してチャットを始めよう！！');
    expect(html).not.toContain('<main id="messages"');
    expect(html).not.toContain('placeholder="メッセージを入力"');
  });

  test('demo pages do not expose legacy Mos Burger copy or Baudroie links', async () => {
    const { db } = createProfileDb();
    const app = setupApp(db);

    const pages = await Promise.all([
      app.request('/demo-chat').then((res) => res.text()),
      app.request('/demo-company-jobs').then((res) => res.text()),
      app.request('/demo-candidate-chat?candidate=yamada&matched=1').then((res) => res.text()),
      app.request('/demo-candidate-jobs?candidate=yamada').then((res) => res.text()),
    ]);
    const combined = pages.join('\n');

    expect(combined).not.toContain('モスバーガー');
    expect(combined).not.toContain('baudroie-harness.ikki-y.workers.dev');
    expect(combined).toContain('Ikki Yamamoto 会社アカウント');
    expect(combined).toContain('saiyo-pro-harness.ikki-y.workers.dev');
  });

  test('profile editor avoids mobile Safari focus zoom', async () => {
    const { db } = createProfileDb();
    const app = setupApp(db);

    const res = await app.request('/demo-candidate-chat?candidate=yamada&matched=1');
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain('font-size: 16px');
    expect(html).not.toContain("document.getElementById('profileFullName').focus()");
  });

  test('candidate profile deep link opens the profile sheet on load', async () => {
    const { db } = createProfileDb();
    const app = setupApp(db);

    const res = await app.request('/demo-candidate-chat?candidate=yamada&matched=1&profile=1');
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain('openProfileOnLoad');
    expect(html).toContain('profileSheet.hidden = false');
  });

  test('candidate status deep link opens the application status page', async () => {
    const { db } = createProfileDb('interview');
    const app = setupApp(db);

    const res = await app.request('/demo-candidate-chat?candidate=yamada&matched=1&status=1');
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain('<title>応募状況</title>');
    expect(html).toContain('<h1>応募状況</h1>');
    expect(html).toContain('山本 一気さんの現在の選考状況');
    expect(html).toContain('面接');
    expect(html).toContain('/demo-candidate-chat?candidate=yamada&matched=1');
  });

  test('candidate company page shows jobs inside the selected company', async () => {
    const { db } = createProfileDb();
    const app = setupApp(db);

    const res = await app.request('/demo-candidate-jobs?candidate=yamada&company=default');
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain('会社ページ');
    expect(html).toContain('Ikki Yamamoto 会社アカウント');
    expect(html).toContain('未経験エンジニア');
    expect(html).toContain('ITサポート');
    expect(html).toContain('あなたにおすすめ');
    expect(html).toContain('>進む</a>');
    expect(html).not.toContain('応募チャットへ戻る');
    expect(html).not.toContain('id="messages"');
    expect(html).not.toContain('id="form"');
  });

  test('candidate jobs page shows published job cards without requiring company selection', async () => {
    const { db } = createProfileDb();
    const app = setupApp(db);

    await app.request('/demo-company-jobs/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        companyName: '山田商店',
        title: 'ホールスタッフ',
        hourlyWage: '時給1,400円から',
        shift: '週2日から',
        description: '接客をお願いします。',
      }),
    });
    await app.request('/demo-company-jobs/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        companyName: '佐藤カフェ',
        title: 'カフェスタッフ',
        hourlyWage: '時給1,300円から',
        shift: '朝シフト歓迎',
        description: 'ドリンク作成をお願いします。',
      }),
    });

    const res = await app.request('/demo-candidate-jobs?candidate=yamada');
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain('求人を見る');
    expect(html).toContain('求人カード');
    expect(html).toContain('ホールスタッフ');
    expect(html).toContain('カフェスタッフ');
    expect(html).toContain('詳細を見る');
    expect(html).toContain('companyName=');
    expect(html).not.toContain('会社ページ');
    expect(html).not.toContain('会社を見る');
  });

  test('candidate jobs page shows an empty state when no company has published jobs', async () => {
    const { db } = createProfileDb();
    const app = setupApp(db);

    const res = await app.request('/demo-candidate-jobs?candidate=yamada');
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain('求人を見る');
    expect(html).toContain('掲載中の求人はまだありません');
    expect(html).not.toContain('ボードルアー');
    expect(html).not.toContain('すき家 渋谷駅前店');
  });

  test('candidate company page honors companyName links from registered company cards', async () => {
    const { db } = createProfileDb();
    const app = setupApp(db);

    const res = await app.request('/demo-candidate-jobs?candidate=yamada&companyName=%E5%B1%B1%E7%94%B0%E5%95%86%E5%BA%97');
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain('山田商店');
    expect(html).not.toContain('<h1>ボードルアー</h1>');
    expect(html).toContain('企業向けLINEから登録された会社の求人です');
  });

  test('company jobs page shows hiring-side job controls without candidate chat', async () => {
    const { db } = createProfileDb();
    const app = setupApp(db);

    const res = await app.request('/demo-company-jobs');
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain('求人案内設定');
    expect(html).toContain('掲載中の求人');
    expect(html).toContain('求人案内を作成');
    expect(html).toContain('/demo-company-jobs/publish');
    expect(html).toContain('採用PRO経由で案内する求人内容');
    expect(html).not.toContain('id="messages"');
    expect(html).not.toContain('id="form"');
  });

  test('company jobs page can render an independent company account name', async () => {
    const { db } = createProfileDb();
    const app = setupApp(db);

    const res = await app.request('/demo-company-jobs?companyName=%E5%B1%B1%E7%94%B0%E5%95%86%E5%BA%97');
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain('山田商店');
    expect(html).not.toContain('<h1>ボードルアー</h1>');
  });

  test('company can publish a job and notify the candidate LINE', async () => {
    linePushMessageMock.mockClear();
    const { db, insertBinds } = createProfileDb();
    const app = setupApp(db);

    const res = await app.request('/demo-company-jobs/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: '店舗スタッフ / アルバイト',
        hourlyWage: '時給1,300円から',
        shift: '週2日から、1日4時間から',
        description: '接客、レジ、商品提供をお願いします。',
      }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      success: true,
      data: { job: { title: '店舗スタッフ / アルバイト' }, notified: true, notificationCount: 1 },
    });
    expect(insertBinds.some((values) => values.includes('demo_company_job'))).toBe(true);
    expect(linePushMessageMock).toHaveBeenCalledWith('candidate-line-user-id', [
      expect.objectContaining({
        type: 'flex',
        altText: expect.stringContaining('あなたにあった求人が届きました！！'),
      }),
    ]);
    const pushPayload = linePushMessageMock.mock.calls[0]?.[1]?.[0] as { contents?: unknown } | undefined;
    expect(JSON.stringify(pushPayload?.contents)).toContain('/images/saiyo-pro/job-arrived-20260613.png');
    expect(JSON.stringify(pushPayload?.contents)).toContain('#00B8C8');
    expect(JSON.stringify(pushPayload?.contents)).not.toContain('#2563EB');
  });

  test('company job notification uses the primary demo candidate instead of the latest touched candidate', async () => {
    linePushMessageMock.mockClear();
    const { db } = createProfileDb('active', {
      rememberedCandidateLineUserId: 'candidate-line-user-id-2',
      primaryCandidateLineUserId: 'candidate-line-user-id',
    });
    const app = setupApp(db);

    const res = await app.request('/demo-company-jobs/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: '店舗スタッフ / アルバイト',
        hourlyWage: '時給1,300円から',
        shift: '週2日から、1日4時間から',
        description: '接客、レジ、商品提供をお願いします。',
      }),
    });

    expect(res.status).toBe(200);
    expect(linePushMessageMock).toHaveBeenCalledWith('candidate-line-user-id', expect.any(Array));
    expect(linePushMessageMock).not.toHaveBeenCalledWith('candidate-line-user-id-2', expect.any(Array));
  });

  test('company can attach a banner to the published job flex', async () => {
    linePushMessageMock.mockClear();
    const { db, insertBinds } = createProfileDb();
    const app = setupApp(db);
    const bannerUrl = 'https://example.com/job-banner.png';

    const res = await app.request('/demo-company-jobs/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        companyName: '山田商店',
        title: 'オープニングスタッフ',
        hourlyWage: '時給1,400円から',
        shift: '週2日から',
        description: '接客をお願いします。',
        bannerUrl,
        bannerOffsetX: 12,
        bannerOffsetY: -8,
        bannerZoom: 1.35,
      }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      success: true,
      data: { job: { companyName: '山田商店', bannerUrl, bannerOffsetX: 12, bannerOffsetY: -8, bannerZoom: 1.35 } },
    });
    expect(JSON.stringify(insertBinds)).toContain(bannerUrl);
    expect(JSON.stringify(insertBinds)).toContain('bannerOffsetX');
    const pushPayload = linePushMessageMock.mock.calls[0]?.[1]?.[0] as { contents?: unknown } | undefined;
    expect(JSON.stringify(pushPayload?.contents)).toContain(bannerUrl);
    expect(JSON.stringify(pushPayload?.contents)).toContain('companyName=');
    expect(JSON.stringify(pushPayload?.contents)).not.toContain('company=default');
  });

  test('candidate company page does not reuse another company published job', async () => {
    const { db } = createProfileDb();
    const app = setupApp(db);

    await app.request('/demo-company-jobs/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        companyName: '山田商店',
        title: '山田商店だけの求人',
        hourlyWage: '時給1,400円から',
        shift: '週2日から',
        description: '接客をお願いします。',
      }),
    });

    const res = await app.request('/demo-candidate-jobs?candidate=yamada&companyName=%E4%BD%90%E8%97%A4%E5%95%86%E5%BA%97');
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain('佐藤商店');
    expect(html).toContain('掲載中の求人はまだありません');
    expect(html).not.toContain('山田商店だけの求人');
  });

  test('candidate company page shows only the selected company published job', async () => {
    const { db } = createProfileDb();
    const app = setupApp(db);

    await app.request('/demo-company-jobs/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        companyName: '山田商店',
        title: '山田商店だけの求人',
        hourlyWage: '時給1,400円から',
        shift: '週2日から',
        description: '接客をお願いします。',
      }),
    });

    const res = await app.request('/demo-candidate-jobs?candidate=yamada&companyName=%E5%B1%B1%E7%94%B0%E5%95%86%E5%BA%97');
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain('山田商店');
    expect(html).toContain('山田商店だけの求人');
    expect(html).not.toContain('掲載中の求人はまだありません');
  });

  test('company jobs page lets company upload a banner image from the device', async () => {
    const { db } = createProfileDb();
    const app = setupApp(db);

    const res = await app.request('/demo-company-jobs');
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain('バナー設定');
    expect(html).toContain('id="openBannerEditor"');
    expect(html).toContain('id="bannerEditorSheet"');
    expect(html).toContain('バナーを編集');
    expect(html).toContain('決定');
    expect(html).toContain('リセット');
    expect(html).toContain('URLで指定');
    expect(html).toContain('画像をアップロード');
    expect(html).toContain('name="bannerMode"');
    expect(html).toContain('id="bannerUrlPanel"');
    expect(html).toContain('id="bannerUploadPanel"');
    expect(html).toContain('id="bannerFile"');
    expect(html).toContain('accept="image/png,image/jpeg,image/jpg,image/webp"');
    expect(html).toContain('画像をドラッグして位置調整');
    expect(html).toContain('横幅固定で、縦位置と拡大率を調整');
    expect(html).toContain('id="bannerCropFrame"');
    expect(html).toContain('id="bannerOffsetX"');
    expect(html).toContain('id="bannerOffsetY"');
    expect(html).toContain('id="bannerZoom"');
    expect(html).toContain('id="bannerVerticalOffset"');
    expect(html).toContain('id="bannerVerticalOffsetValue"');
    expect(html).toContain('applyBannerPreview');
    expect(html).toContain('applyVerticalOffset');
    expect(html).toContain('setBannerZoom');
    expect(html).toContain('bannerPreviewEl.style.transform');
    expect(html).toContain('bannerPreviewEl.style.objectPosition');
    expect(html).toContain('body.is-cropping');
    expect(html).toContain('.status.is-loading');
    expect(html).toContain('@keyframes spin');
    expect(html).toContain('preventCropScroll');
    expect(html).toContain('document.body.classList.add');
    expect(html).toContain('document.body.classList.remove');
    expect(html).toContain('bannerPreviewEl.style.objectFit');
    expect(html).toContain("bannerCropFrame.addEventListener('pointerdown'");
    expect(html).toContain("bannerCropFrame.addEventListener('pointermove'");
    expect(html).toContain('setBannerOffset(dragBaseX, dragBaseY - dy)');
    expect(html).toContain("bannerCropFrame.addEventListener('touchstart'");
    expect(html).toContain('handlePinchStart');
    expect(html).toContain('handlePinchMove');
    expect(html).toContain('pinchStartDistance');
    expect(html).toContain("bannerVerticalOffsetEl.addEventListener('input'");
    expect(html).toContain('uploadCroppedBannerIfNeeded');
    expect(html).toContain('canvas.toBlob');
    expect(html).toContain('Math.max(canvas.width / image.naturalWidth, canvas.height / image.naturalHeight)');
    expect(html).toContain('verticalPositionRatio');
    expect(html).toContain('verticalExcess');
    expect(html).toContain("fetch('/demo-company-jobs/banner'");
    expect(html).not.toContain("fetch('/api/images'");
    expect(html).toContain('bannerUrlEl.value = json.data.url');
    expect(html).toContain('bannerPreviewEl.src = json.data.url');
    expect(html).toContain('syncBannerMode');
    expect(html).toContain('function setStatus');
    expect(html).toContain('function setBusy');
    expect(html).toContain('画像をアップロードしています。数秒かかることがあります');
    expect(html).toContain('バナーを最終保存しています');
    expect(html).toContain('求人を保存しました。求職者LINEへ通知しています');
    expect(html).toContain('notificationCount');
    expect(html).toContain("求職者LINEへ' + notificationCount + '件通知しました");
    expect(html).toContain('button.disabled = busy');
    expect(html).toContain("openBannerEditor.addEventListener('click'");
    expect(html).toContain("bannerEditorDone.addEventListener('click'");
    expect(html).toContain("bannerEditorClose.addEventListener('click'");
  });

  test('candidate job page applies saved banner crop settings', async () => {
    const { db } = createProfileDb();
    const app = setupApp(db);

    await app.request('/demo-company-jobs/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'テスト求人',
        bannerUrl: 'https://example.com/banner.jpg',
        bannerOffsetX: 10,
        bannerOffsetY: -15,
        bannerZoom: 1.5,
      }),
    });

    const res = await app.request('/demo-candidate-jobs?candidate=yamada&company=default');
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain('translate(10%, -15%) scale(1.5)');
  });

  test('company banner upload endpoint accepts jpeg without API auth', async () => {
    const { db } = createProfileDb();
    const putMock = vi.fn(async () => undefined);
    const app = setupApp(db, {
      WORKER_URL: 'https://worker.example.com',
      IMAGES: { put: putMock } as unknown as R2Bucket,
    });

    const res = await app.request('/demo-company-jobs/banner', {
      method: 'POST',
      headers: { 'Content-Type': 'image/jpeg' },
      body: new Uint8Array([1, 2, 3]),
    });

    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toMatchObject({
      success: true,
      data: { url: expect.stringMatching(/^https:\/\/worker\.example\.com\/images\/demo-job-banners\/.+\.jpg$/), mimeType: 'image/jpeg' },
    });
    expect(putMock).toHaveBeenCalledWith(
      expect.stringMatching(/^demo-job-banners\/.+\.jpg$/),
      expect.any(ArrayBuffer),
      expect.objectContaining({ httpMetadata: { contentType: 'image/jpeg' } }),
    );
  });

  test('company settings page lets company edit store and interview defaults', async () => {
    const { db } = createProfileDb();
    const app = setupApp(db);

    const res = await app.request('/demo-company-settings');
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain('採用PRO 対応設定');
    expect(html).toContain('求人企業名');
    expect(html).toContain('担当者名');
    expect(html).toContain('面談URL');
    expect(html).not.toContain('採用PROアカウント連携');
    expect(html).not.toContain('採用PROにログイン');
    expect(html).not.toContain('linkLineAccount');
    expect(html).not.toContain('https://liff.line.me/2010260616-EluNlqNv');
    expect(html).toContain('/demo-chat/settings');
    expect(html).not.toContain('id="messages"');
  });

  test('company chat page exposes hiring operation buttons and settings', async () => {
    const { db } = createProfileDb();
    const app = setupApp(db);

    const res = await app.request('/demo-chat?candidate=yamada');
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain('<button id="settingsButton" class="header-settings" type="button">対応設定</button>');
    expect(html).not.toContain('<button id="settingsButton" type="button">対応設定</button>');
    expect(html).toContain('面接を送る');
    expect(html).toContain('不合格');
    expect(html).toContain('削除');
    expect(html).toContain('応募者切替');
    expect(html).toContain('候補者リスト');
    expect(html).toContain('Ikki Yamamoto');
    expect(html).toContain('泰地');
    expect(html).toContain('/demo-chat?candidate=friend-1');
    expect(html).toContain('/demo-chat?candidate=friend-2');
    expect(html).not.toContain('山本 一気');
    expect(html).not.toContain('/demo-chat?candidate=yamada');
    expect(html).toContain('<section id="confirmSheet" class="confirm-sheet" hidden>');
    expect(html).toContain('もうこの求職者とはやり取りができません。それでも大丈夫ですか？');
    expect(html).toContain('openTerminalConfirm');
    expect(html).toContain("document.getElementById('rejectCandidate').addEventListener('click', () => openTerminalConfirm('rejected'))");
    expect(html).toContain("document.getElementById('archiveCandidate').addEventListener('click', () => openTerminalConfirm('archived'))");
    expect(html).toContain('applyStatus');
    expect(html).toContain("textEl.placeholder = closed ? 'この求職者とのやり取りは停止されています'");
    expect(html).toContain('formEl.classList.toggle');
    expect(html).toContain('対応設定');
    expect(html).toContain('<span id="statusLabel" class="status-pill">');
    expect(html).not.toContain('<section id="statusCard"');
    expect(html).toContain('header { position: fixed; left: 0; right: 0; top: var(--viewport-top, 0px);');
    expect(html).toContain('.app { min-height: 100dvh; overflow: hidden; }');
    expect(html).toContain('top: calc(var(--viewport-top, 0px) + var(--header-height, 78px))');
    expect(html).toContain("document.documentElement.style.setProperty('--header-height'");
    expect(html).toContain("document.documentElement.style.setProperty('--top-chrome-height'");
    expect(html).toContain("document.documentElement.style.setProperty('--composer-height'");
    expect(html).not.toContain('--bottom-chrome-height');
    expect(html).not.toContain('--visual-viewport-height');
    expect(html).not.toContain('--keyboard-bottom');
    expect(html).toContain('.composer { position: fixed; left: 0; right: 0; bottom: 0;');
    expect(html).not.toContain('class="quick"');
    expect(html).not.toContain('.quick {');
    expect(html).toContain('.keyboard-open .action-bar');
    expect(html).toContain('visualViewport');
    expect(html).toContain("document.documentElement.style.setProperty('--viewport-top'");
    expect(html).toContain("document.body.classList.add('keyboard-open')");
    expect(html).toContain("document.body.classList.remove('keyboard-open')");
    expect(html).toContain('requestAnimationFrame(syncViewportTop)');
    expect(html).toContain('keepKeyboardFromMessages');
    expect(html).toContain("messagesEl.addEventListener('touchstart'");
    expect(html).toContain('textEl.focus({ preventScroll: true })');
    expect(html).toContain('body { height: 100dvh; overflow: hidden;');
    expect(html).toContain('.messages { position: fixed; left: 0; right: 0; top: calc(var(--viewport-top, 0px) + var(--top-chrome-height, 132px)); bottom: var(--composer-height, 74px); overflow-y: auto;');
    expect(html).toContain('.keyboard-open .messages { top: calc(var(--viewport-top, 0px) + var(--header-height, 78px)); }');
    expect(html).toContain('-webkit-overflow-scrolling: touch');
    expect(html).toContain('/demo-chat/interview');
    expect(html).toContain('/demo-chat/status');
    expect(html).toContain('/demo-chat/settings');
    expect(html.indexOf('<div class="action-bar">')).toBeLessThan(html.indexOf('<section id="profileCard"'));
    expect(html.indexOf('<main id="messages"')).toBeLessThan(html.indexOf('<form id="form" class="composer">'));
  });

  test('company settings deep link opens the settings sheet on load', async () => {
    const { db } = createProfileDb();
    const app = setupApp(db);

    const res = await app.request('/demo-chat?candidate=yamada&settings=1');
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain('openSettingsOnLoad');
    expect(html).toContain('settingsSheet.hidden = false');
  });

  test('candidate chat keeps its header fixed while typing', async () => {
    const { db } = createProfileDb();
    const app = setupApp(db);

    const res = await app.request('/demo-candidate-chat?candidate=yamada&matched=1');
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain('header { position: fixed; left: 0; right: 0; top: var(--viewport-top, 0px);');
    expect(html).toContain('.app { min-height: 100dvh; overflow: hidden; }');
    expect(html).toContain('body { height: 100dvh; overflow: hidden;');
    expect(html).toContain('.messages { position: fixed; left: 0; right: 0; top: calc(var(--viewport-top, 0px) + var(--header-height, 67px)); bottom: var(--composer-height, 74px); overflow-y: auto;');
    expect(html).not.toContain('class="quick"');
    expect(html).not.toContain('.quick {');
    expect(html).toContain('.composer { position: fixed; left: 0; right: 0; bottom: 0;');
    expect(html).toContain('-webkit-overflow-scrolling: touch');
    expect(html).toContain('visualViewport');
    expect(html).toContain("document.documentElement.style.setProperty('--viewport-top'");
    expect(html).toContain("document.documentElement.style.setProperty('--header-height'");
    expect(html).toContain("document.documentElement.style.setProperty('--composer-height'");
    expect(html).not.toContain('--bottom-chrome-height');
    expect(html).not.toContain('--visual-viewport-height');
    expect(html).not.toContain('--keyboard-bottom');
    expect(html).toContain('keepKeyboardFromMessages');
    expect(html).toContain("messagesEl.addEventListener('touchstart'");
    expect(html).toContain("document.body.classList.add('keyboard-open')");
    expect(html).toContain('textEl.focus({ preventScroll: true })');
  });

  test('blocks new messages after a candidate is rejected or archived', async () => {
    const { db } = createProfileDb('rejected');
    const app = setupApp(db);

    const companyRes = await app.request('/demo-chat/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ candidate: 'yamada', text: '確認です' }),
    });
    const candidateRes = await app.request('/demo-candidate-chat/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ candidate: 'yamada', text: '返信です' }),
    });

    expect(companyRes.status).toBe(409);
    await expect(companyRes.json()).resolves.toMatchObject({
      success: false,
      error: 'candidate_closed',
      data: { status: { status: 'rejected', label: '不合格' } },
    });
    expect(candidateRes.status).toBe(409);
    await expect(candidateRes.json()).resolves.toMatchObject({
      success: false,
      error: 'candidate_closed',
      data: { status: { status: 'rejected', label: '不合格' } },
    });
  });

  test('saves company interview settings', async () => {
    const { db, insertBinds } = createProfileDb();
    const app = setupApp(db);

    const res = await app.request('/demo-chat/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        companyName: 'Ikki Yamamoto 会社アカウント',
        staffName: '山本',
        interviewUrl: 'https://timerex.net/s/saiyo-pro-demo',
        interviewMessage: 'こちらから面接日程を選んでください。',
      }),
    });

    expect(res.status).toBe(200);
    const json = await res.json() as { success: boolean; data: { settings: { interviewUrl: string } } };
    expect(json.success).toBe(true);
    expect(json.data.settings.interviewUrl).toBe('https://timerex.net/s/saiyo-pro-demo');
    expect(JSON.parse(insertBinds[0][2] as string)).toMatchObject({
      staffName: '山本',
      interviewUrl: 'https://timerex.net/s/saiyo-pro-demo',
    });
  });

  test('saves candidate rejection and archive status', async () => {
    linePushMessageMock.mockReset();
    linePushMessageMock.mockResolvedValue(undefined);
    const { db, insertBinds } = createProfileDb();
    const app = setupApp(db);

    const rejected = await app.request('/demo-chat/status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ candidate: 'yamada', status: 'rejected' }),
    });
    const archived = await app.request('/demo-chat/status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ candidate: 'yamada', status: 'archived' }),
    });

    expect(rejected.status).toBe(200);
    expect(archived.status).toBe(200);
    expect(insertBinds.map((binds) => JSON.parse(binds[2] as string))).toEqual([
      expect.objectContaining({ candidateId: 'friend-1', status: 'rejected', label: '不合格' }),
      expect.objectContaining({ candidateId: 'friend-1', status: 'archived', label: '削除済み' }),
    ]);
    expect(linePushMessageMock).toHaveBeenCalledTimes(2);
    expect(linePushMessageMock).toHaveBeenNthCalledWith(
      1,
      'candidate-line-user-id',
      [expect.objectContaining({ altText: '選考結果のご連絡' })],
    );
    expect(linePushMessageMock).toHaveBeenNthCalledWith(
      2,
      'candidate-line-user-id',
      [expect.objectContaining({ altText: 'やり取り終了のお知らせ' })],
    );
  });
});
