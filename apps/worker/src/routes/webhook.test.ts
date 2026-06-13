import { describe, expect, test, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const linePushMessageMock = vi.hoisted(() => vi.fn());
const lineReplyMessageMock = vi.hoisted(() => vi.fn());
const lineGetProfileMock = vi.hoisted(() => vi.fn());

// Stub the DB graph — these tests only exercise the size guard and
// signature-verify-before-parse path; webhook event handling is out of scope.
vi.mock('@line-crm/db', () => ({
  upsertFriend: vi.fn(),
  updateFriendFollowStatus: vi.fn(),
  getFriendByLineUserId: vi.fn(),
  getScenarios: vi.fn(),
  enrollFriendInScenario: vi.fn(),
  getScenarioSteps: vi.fn(),
  advanceFriendScenario: vi.fn(),
  completeFriendScenario: vi.fn(),
  upsertChatOnMessage: vi.fn(),
  getLineAccounts: vi.fn().mockResolvedValue([]),
  jstNow: vi.fn(),
  computeNextDeliveryAt: vi.fn(),
  resolveStepContent: vi.fn(),
  addTagToFriend: vi.fn(),
  getEntryRouteByRefCode: vi.fn(),
  getMessageTemplateById: vi.fn(),
}));

vi.mock('@line-crm/line-sdk', async () => {
  const actual = await vi.importActual<typeof import('@line-crm/line-sdk')>('@line-crm/line-sdk');
  return {
    ...actual,
    verifySignature: vi.fn(),
    LineClient: vi.fn().mockImplementation(() => ({
      getProfile: lineGetProfileMock,
      replyMessage: lineReplyMessageMock,
      pushMessage: linePushMessageMock,
    })),
  };
});

vi.mock('../services/event-bus.js', () => ({
  fireEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../services/step-delivery.js', () => ({
  buildMessage: vi.fn((type: string, content: string) => ({ type, text: content, contents: content })),
  expandVariables: vi.fn(),
  messageToLogPayload: vi.fn((message: { type?: string; text?: string; contents?: string }) => ({
    messageType: message.type ?? 'text',
    content: message.text ?? message.contents ?? '',
  })),
}));

import { getFriendByLineUserId, getLineAccounts, jstNow, upsertFriend } from '@line-crm/db';
import { verifySignature } from '@line-crm/line-sdk';
import { buildDemoApplicationStartFlex, buildDemoApplicationQuestionFlex, buildDemoCandidateJobsLinkFlex, buildDemoCandidateListFlex, buildDemoCandidateSelfMenuFlex, buildDemoCandidateCompanyCardsFlex, buildDemoCompanyAccountFromProfile, buildDemoCompanyMenuReply, buildDemoWelcomeText, webhook } from './webhook.js';

function setupApp() {
  const app = new Hono();
  app.route('/', webhook);
  return app;
}

const baseEnv = {
  DB: {} as D1Database,
  LINE_CHANNEL_SECRET: 'env-default-secret',
  LINE_CHANNEL_ACCESS_TOKEN: 'env-default-token',
} as Record<string, unknown>;

const baseExecutionCtx = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
  props: {},
} as unknown as ExecutionContext;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(jstNow).mockReturnValue('2026-06-10T12:00:00+09:00');
  lineGetProfileMock.mockResolvedValue({ displayName: '応募者', pictureUrl: null, statusMessage: null });
});

describe('POST /webhook — DoS defenses (#104)', () => {
  test('rejects with 413 when Content-Length declares an oversized body', async () => {
    const app = setupApp();
    const res = await app.request(
      '/webhook',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(2 * 1024 * 1024), // 2 MiB > 1 MiB cap
          'X-Line-Signature': 'whatever',
        },
        body: JSON.stringify({ events: [] }),
      },
      baseEnv,
      baseExecutionCtx,
    );
    expect(res.status).toBe(413);
    // Signature verification must not even be attempted on an oversized body.
    expect(verifySignature).not.toHaveBeenCalled();
  });

  test('rejects with 413 when actual body exceeds the cap even if Content-Length is absent', async () => {
    const app = setupApp();
    const oversizedBody = 'x'.repeat(1024 * 1024 + 1);
    const res = await app.request(
      '/webhook',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Line-Signature': 'whatever',
        },
        body: oversizedBody,
      },
      baseEnv,
      baseExecutionCtx,
    );
    expect(res.status).toBe(413);
    expect(verifySignature).not.toHaveBeenCalled();
  });

  test('verifies signature before parsing JSON — malformed body with invalid signature never reaches the parser', async () => {
    vi.mocked(verifySignature).mockResolvedValue(false);

    const app = setupApp();
    // 44-char signature (valid HMAC-SHA256 base64 length) so it clears the
    // length pre-check and reaches verifySignature. Malformed JSON body: if
    // signature were verified *after* parse (old behavior), we'd hit the
    // parser-failure branch first. With signature-first, we get the invalid-
    // signature branch and never attempt to parse.
    const validShapedSignature = 'A'.repeat(43) + '=';
    const res = await app.request(
      '/webhook',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Line-Signature': validShapedSignature,
        },
        body: '{not valid json',
      },
      baseEnv,
      baseExecutionCtx,
    );
    expect(res.status).toBe(200);
    // verifySignature must run; rejection happens before any parse attempt.
    expect(verifySignature).toHaveBeenCalled();
    expect(verifySignature).toHaveBeenCalledWith('env-default-secret', '{not valid json', validShapedSignature);
  });

  test('rejects unsigned or malformed-signature requests without hitting verifySignature or D1', async () => {
    const app = setupApp();
    const res = await app.request(
      '/webhook',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Missing X-Line-Signature header entirely.
        },
        body: JSON.stringify({ events: [] }),
      },
      baseEnv,
      baseExecutionCtx,
    );
    expect(res.status).toBe(200);
    // Fast-rejected before any crypto / DB work.
    expect(verifySignature).not.toHaveBeenCalled();
  });
});

describe('POST /webhook — Saiyo Pro candidate chat routing', () => {
  test('does not forward ordinary candidate LINE text to the company account', async () => {
    vi.mocked(verifySignature).mockResolvedValue(true);
    vi.mocked(getLineAccounts).mockResolvedValue([
      {
        id: 'saiyo-pro-candidate',
        channel_id: '2010342539',
        name: '採用PRO',
        channel_secret: 'candidate-secret',
        channel_access_token: 'candidate-token',
        liff_id: null,
        is_active: true,
        display_order: 1,
        created_at: '2026-06-10T12:00:00+09:00',
        updated_at: '2026-06-10T12:00:00+09:00',
      },
    ]);
    vi.mocked(getFriendByLineUserId).mockResolvedValue({
      id: 'friend-1',
      line_user_id: 'candidate-line-user-id',
      display_name: '応募者',
      picture_url: null,
      status_message: null,
      is_following: 1,
      metadata: JSON.stringify({ demo_company_line_user_id: 'company-line-user-id' }),
      user_id: null,
      ref_code: null,
      created_at: '2026-06-10T12:00:00+09:00',
      updated_at: '2026-06-10T12:00:00+09:00',
    });

    const statements: string[] = [];
    const db = {
      prepare(sql: string) {
        statements.push(sql);
        return {
          bind() {
            return {
              first: async () => {
                if (sql.includes('SELECT channel_access_token FROM line_accounts')) {
                  return { channel_access_token: 'company-token' };
                }
                if (sql.includes('SELECT metadata FROM friends')) {
                  return { metadata: JSON.stringify({ demo_company_line_user_id: 'company-line-user-id' }) };
                }
                return null;
              },
              all: async () => ({ results: [] }),
              run: async () => ({ success: true }),
            };
          },
          all: async () => ({ results: [] }),
          first: async () => null,
          run: async () => ({ success: true }),
        };
      },
    } as unknown as D1Database;
    const waitUntil = vi.fn();
    const app = setupApp();
    const body = JSON.stringify({
      events: [
        {
          type: 'message',
          replyToken: 'reply-token',
          source: { type: 'user', userId: 'candidate-line-user-id' },
          message: { id: 'message-1', type: 'text', text: 'こんにちは' },
        },
      ],
    });

    const res = await app.request(
      '/webhook',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Line-Signature': 'A'.repeat(43) + '=',
        },
        body,
      },
      { ...baseEnv, DB: db, LINE_CHANNEL_SECRET: 'candidate-secret', LINE_CHANNEL_ACCESS_TOKEN: 'candidate-token' },
      { ...baseExecutionCtx, waitUntil } as unknown as ExecutionContext,
    );
    await waitUntil.mock.calls[0]?.[0];

    expect(res.status).toBe(200);
    expect(linePushMessageMock).not.toHaveBeenCalled();
    expect(lineReplyMessageMock).toHaveBeenCalledWith('reply-token', [
      expect.objectContaining({ type: 'text', text: expect.stringContaining('ありがとうございます') }),
    ]);
    expect(statements.join('\n')).not.toContain('demo_candidate_reply_notification');
  });
});

describe('Saiyo Pro candidate application questionnaire', () => {
  test('candidate follow sends the greeting text and application start banner', async () => {
    vi.mocked(verifySignature).mockResolvedValue(true);
    vi.mocked(getLineAccounts).mockResolvedValue([
      {
        id: 'saiyo-pro-candidate',
        channel_id: '2010342539',
        name: '採用PRO',
        channel_secret: 'candidate-secret',
        channel_access_token: 'candidate-token',
        liff_id: null,
        is_active: true,
        display_order: 1,
        created_at: '2026-06-10T12:00:00+09:00',
        updated_at: '2026-06-10T12:00:00+09:00',
      },
    ]);
    vi.mocked(upsertFriend).mockResolvedValue({
      id: 'friend-1',
      line_user_id: 'candidate-line-user-id',
      display_name: '応募者',
      picture_url: null,
      status_message: null,
      is_following: 1,
      metadata: null,
      user_id: null,
      ref_code: null,
      created_at: '2026-06-10T12:00:00+09:00',
      updated_at: '2026-06-10T12:00:00+09:00',
    });
    const db = {
      prepare() {
        return {
          bind() {
            return {
              run: async () => ({ success: true }),
            };
          },
        };
      },
      batch: async () => [],
    } as unknown as D1Database;
    const waitUntil = vi.fn();
    const app = setupApp();
    const body = JSON.stringify({
      events: [
        {
          type: 'follow',
          replyToken: 'reply-token',
          source: { type: 'user', userId: 'candidate-line-user-id' },
        },
      ],
    });

    const res = await app.request(
      '/webhook',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Line-Signature': 'A'.repeat(43) + '=' },
        body,
      },
      { ...baseEnv, DB: db, LINE_CHANNEL_SECRET: 'candidate-secret', LINE_CHANNEL_ACCESS_TOKEN: 'candidate-token' },
      { ...baseExecutionCtx, waitUntil } as unknown as ExecutionContext,
    );
    await waitUntil.mock.calls[0]?.[0];

    expect(res.status).toBe(200);
    expect(lineReplyMessageMock).toHaveBeenCalledWith('reply-token', [
      expect.objectContaining({ type: 'text', text: expect.stringContaining('採用PROへのご登録ありがとうございます') }),
      expect.objectContaining({ type: 'flex', text: expect.stringContaining('採用PRO 求人案内') }),
    ]);
  });

  test('start flex is a greeting banner with a questionnaire CTA', () => {
    const flex = JSON.parse(buildDemoApplicationStartFlex()) as {
      type: string;
      hero: { type: string; url: string; aspectRatio: string; aspectMode: string };
      footer: { contents: Array<{ action: { type: string; label: string; text: string } }> };
    };

    expect(flex.type).toBe('bubble');
    expect(flex.hero).toMatchObject({
      type: 'image',
      aspectRatio: '3:2',
      aspectMode: 'cover',
    });
    expect(flex.hero.url).toContain('/images/saiyo-pro/application-start');
    expect(JSON.stringify(flex)).toContain('採用PRO 求人案内');
    expect(flex.footer.contents[0]?.action).toEqual({
      type: 'message',
      label: '求人案内の確認を始める',
      text: '求人案内の確認を始める',
    });
  });

  test('age question starts the application screening flow', () => {
    const flex = JSON.parse(buildDemoApplicationQuestionFlex('age')) as {
      type: string;
      body: { contents: Array<{ text?: string }> };
      footer: { contents: Array<{ action: { type: string; data: string; label: string } }> };
    };

    expect(flex.type).toBe('bubble');
    expect(JSON.stringify(flex)).toContain('年齢');
    expect(flex.footer.contents[0]?.action).toEqual({ type: 'postback', label: '22〜24歳', data: 'demo:application:age:age_22_24' });
    expect(flex.footer.contents[1]?.action).toEqual({ type: 'postback', label: '25〜27歳', data: 'demo:application:age:age_25_27' });
    expect(flex.footer.contents[2]?.action).toEqual({ type: 'postback', label: '28〜30歳', data: 'demo:application:age:age_28_30' });
    expect(flex.footer.contents[3]?.action).toEqual({ type: 'postback', label: '31歳以上', data: 'demo:application:age:age_31_plus' });
  });

  test('candidate application postbacks save answers and advance to the next question', async () => {
    vi.mocked(verifySignature).mockResolvedValue(true);
    vi.mocked(getLineAccounts).mockResolvedValue([
      {
        id: 'saiyo-pro-candidate',
        channel_id: '2010342539',
        name: '採用PRO',
        channel_secret: 'candidate-secret',
        channel_access_token: 'candidate-token',
        liff_id: null,
        is_active: true,
        display_order: 1,
        created_at: '2026-06-10T12:00:00+09:00',
        updated_at: '2026-06-10T12:00:00+09:00',
      },
    ]);
    vi.mocked(getFriendByLineUserId).mockResolvedValue({
      id: 'friend-1',
      line_user_id: 'candidate-line-user-id',
      display_name: '応募者',
      picture_url: null,
      status_message: null,
      is_following: 1,
      metadata: null,
      user_id: null,
      ref_code: null,
      created_at: '2026-06-10T12:00:00+09:00',
      updated_at: '2026-06-10T12:00:00+09:00',
    });

    const applicationBinds: unknown[][] = [];
    const db = {
      prepare(sql: string) {
        return {
          bind(...values: unknown[]) {
            return {
              first: async () => {
                if (sql.includes('SELECT metadata FROM friends')) return { metadata: null };
                return null;
              },
              all: async () => ({ results: [] }),
              run: async () => {
                if (sql.includes('INSERT INTO saiyo_pro_applications')) applicationBinds.push(values);
                return { success: true };
              },
            };
          },
          all: async () => ({ results: [] }),
          first: async () => null,
          run: async () => ({ success: true }),
        };
      },
    } as unknown as D1Database;
    const waitUntil = vi.fn();
    const app = setupApp();
    const body = JSON.stringify({
      events: [
        {
          type: 'postback',
          replyToken: 'reply-token',
          source: { type: 'user', userId: 'candidate-line-user-id' },
          postback: { data: 'demo:application:age:age_22_24' },
        },
      ],
    });

    const res = await app.request(
      '/webhook',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Line-Signature': 'A'.repeat(43) + '=' },
        body,
      },
      { ...baseEnv, DB: db, LINE_CHANNEL_SECRET: 'candidate-secret', LINE_CHANNEL_ACCESS_TOKEN: 'candidate-token' },
      { ...baseExecutionCtx, waitUntil } as unknown as ExecutionContext,
    );
    await waitUntil.mock.calls[0]?.[0];

    expect(res.status).toBe(200);
    expect(applicationBinds[0]).toEqual([
      expect.any(String),
      'friend-1',
      'saiyo-pro-candidate',
      'age_22_24',
      null,
      null,
      null,
      'pending',
      null,
      '2026-06-10T12:00:00+09:00',
      '2026-06-10T12:00:00+09:00',
    ]);
    expect(lineReplyMessageMock).toHaveBeenCalledWith('reply-token', [
      expect.objectContaining({ type: 'flex', text: expect.stringContaining('性別') }),
    ]);
    expect(linePushMessageMock).not.toHaveBeenCalled();
  });

  test('candidate can show the greeting banner from ordinary LINE text', async () => {
    vi.mocked(verifySignature).mockResolvedValue(true);
    vi.mocked(getLineAccounts).mockResolvedValue([
      {
        id: 'saiyo-pro-candidate',
        channel_id: '2010342539',
        name: '採用PRO',
        channel_secret: 'candidate-secret',
        channel_access_token: 'candidate-token',
        liff_id: null,
        is_active: true,
        display_order: 1,
        created_at: '2026-06-10T12:00:00+09:00',
        updated_at: '2026-06-10T12:00:00+09:00',
      },
    ]);
    vi.mocked(getFriendByLineUserId).mockResolvedValue({
      id: 'friend-1',
      line_user_id: 'candidate-line-user-id',
      display_name: '応募者',
      picture_url: null,
      status_message: null,
      is_following: 1,
      metadata: null,
      user_id: null,
      ref_code: null,
      created_at: '2026-06-10T12:00:00+09:00',
      updated_at: '2026-06-10T12:00:00+09:00',
    });
    const db = {
      prepare(sql: string) {
        return {
          bind() {
            return {
              first: async () => null,
              all: async () => ({ results: [] }),
              run: async () => ({ success: true }),
            };
          },
          all: async () => ({ results: [] }),
          first: async () => null,
          run: async () => ({ success: true }),
        };
      },
    } as unknown as D1Database;
    const waitUntil = vi.fn();
    const app = setupApp();
    const body = JSON.stringify({
      events: [
        {
          type: 'message',
          replyToken: 'reply-token',
          source: { type: 'user', userId: 'candidate-line-user-id' },
          message: { id: 'message-1', type: 'text', text: 'アンケート' },
        },
      ],
    });

    const res = await app.request(
      '/webhook',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Line-Signature': 'A'.repeat(43) + '=' },
        body,
      },
      { ...baseEnv, DB: db, LINE_CHANNEL_SECRET: 'candidate-secret', LINE_CHANNEL_ACCESS_TOKEN: 'candidate-token' },
      { ...baseExecutionCtx, waitUntil } as unknown as ExecutionContext,
    );
    await waitUntil.mock.calls[0]?.[0];

    expect(res.status).toBe(200);
    expect(lineReplyMessageMock).toHaveBeenCalledWith('reply-token', [
      expect.objectContaining({ type: 'flex', text: expect.stringContaining('採用PRO 求人案内') }),
    ]);
    expect(linePushMessageMock).not.toHaveBeenCalled();
  });

  test('candidate start button text opens the age question directly', async () => {
    vi.mocked(verifySignature).mockResolvedValue(true);
    vi.mocked(getLineAccounts).mockResolvedValue([
      {
        id: 'saiyo-pro-candidate',
        channel_id: '2010342539',
        name: '採用PRO',
        channel_secret: 'candidate-secret',
        channel_access_token: 'candidate-token',
        liff_id: null,
        is_active: true,
        display_order: 1,
        created_at: '2026-06-10T12:00:00+09:00',
        updated_at: '2026-06-10T12:00:00+09:00',
      },
    ]);
    vi.mocked(getFriendByLineUserId).mockResolvedValue({
      id: 'friend-1',
      line_user_id: 'candidate-line-user-id',
      display_name: '応募者',
      picture_url: null,
      status_message: null,
      is_following: 1,
      metadata: null,
      user_id: null,
      ref_code: null,
      created_at: '2026-06-10T12:00:00+09:00',
      updated_at: '2026-06-10T12:00:00+09:00',
    });
    const db = {
      prepare() {
        return {
          bind() {
            return {
              first: async () => null,
              all: async () => ({ results: [] }),
              run: async () => ({ success: true }),
            };
          },
          all: async () => ({ results: [] }),
          first: async () => null,
          run: async () => ({ success: true }),
        };
      },
    } as unknown as D1Database;
    const waitUntil = vi.fn();
    const app = setupApp();
    const body = JSON.stringify({
      events: [
        {
          type: 'message',
          replyToken: 'reply-token',
          source: { type: 'user', userId: 'candidate-line-user-id' },
          message: { id: 'message-1', type: 'text', text: '求人案内の確認を始める' },
        },
      ],
    });

    const res = await app.request(
      '/webhook',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Line-Signature': 'A'.repeat(43) + '=' },
        body,
      },
      { ...baseEnv, DB: db, LINE_CHANNEL_SECRET: 'candidate-secret', LINE_CHANNEL_ACCESS_TOKEN: 'candidate-token' },
      { ...baseExecutionCtx, waitUntil } as unknown as ExecutionContext,
    );
    await waitUntil.mock.calls[0]?.[0];

    expect(res.status).toBe(200);
    expect(lineReplyMessageMock).toHaveBeenCalledWith('reply-token', [
      expect.objectContaining({ type: 'flex', text: expect.stringContaining('年齢') }),
    ]);
  });

  test('candidate start text still works when DB account lookup misses the env account', async () => {
    vi.mocked(verifySignature).mockResolvedValue(true);
    vi.mocked(getLineAccounts).mockResolvedValue([]);
    vi.mocked(getFriendByLineUserId).mockResolvedValue({
      id: 'friend-1',
      line_user_id: 'candidate-line-user-id',
      display_name: '応募者',
      picture_url: null,
      status_message: null,
      is_following: 1,
      metadata: null,
      user_id: null,
      ref_code: null,
      created_at: '2026-06-10T12:00:00+09:00',
      updated_at: '2026-06-10T12:00:00+09:00',
    });
    const db = {
      prepare() {
        return {
          bind() {
            return {
              first: async () => null,
              all: async () => ({ results: [] }),
              run: async () => ({ success: true }),
            };
          },
          all: async () => ({ results: [] }),
          first: async () => null,
          run: async () => ({ success: true }),
        };
      },
    } as unknown as D1Database;
    const waitUntil = vi.fn();
    const app = setupApp();
    const body = JSON.stringify({
      events: [
        {
          type: 'message',
          replyToken: 'reply-token',
          source: { type: 'user', userId: 'candidate-line-user-id' },
          message: { id: 'message-1', type: 'text', text: '応募内容の確認を始める' },
        },
      ],
    });

    const res = await app.request(
      '/webhook',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Line-Signature': 'A'.repeat(43) + '=' },
        body,
      },
      { ...baseEnv, DB: db, LINE_CHANNEL_SECRET: 'candidate-secret', LINE_CHANNEL_ACCESS_TOKEN: 'candidate-token' },
      { ...baseExecutionCtx, waitUntil } as unknown as ExecutionContext,
    );
    await waitUntil.mock.calls[0]?.[0];

    expect(res.status).toBe(200);
    expect(lineReplyMessageMock).toHaveBeenCalledWith('reply-token', [
      expect.objectContaining({ type: 'flex', text: expect.stringContaining('年齢') }),
    ]);
  });

  test('application start postback opens the age question', async () => {
    vi.mocked(verifySignature).mockResolvedValue(true);
    vi.mocked(getLineAccounts).mockResolvedValue([
      {
        id: 'saiyo-pro-candidate',
        channel_id: '2010342539',
        name: '採用PRO',
        channel_secret: 'candidate-secret',
        channel_access_token: 'candidate-token',
        liff_id: null,
        is_active: true,
        display_order: 1,
        created_at: '2026-06-10T12:00:00+09:00',
        updated_at: '2026-06-10T12:00:00+09:00',
      },
    ]);
    vi.mocked(getFriendByLineUserId).mockResolvedValue({
      id: 'friend-1',
      line_user_id: 'candidate-line-user-id',
      display_name: '応募者',
      picture_url: null,
      status_message: null,
      is_following: 1,
      metadata: null,
      user_id: null,
      ref_code: null,
      created_at: '2026-06-10T12:00:00+09:00',
      updated_at: '2026-06-10T12:00:00+09:00',
    });
    const db = {
      prepare() {
        return {
          bind() {
            return {
              first: async () => null,
              all: async () => ({ results: [] }),
              run: async () => ({ success: true }),
            };
          },
          all: async () => ({ results: [] }),
          first: async () => null,
          run: async () => ({ success: true }),
        };
      },
    } as unknown as D1Database;
    const waitUntil = vi.fn();
    const app = setupApp();
    const body = JSON.stringify({
      events: [
        {
          type: 'postback',
          replyToken: 'reply-token',
          source: { type: 'user', userId: 'candidate-line-user-id' },
          postback: { data: 'demo:application:start' },
        },
      ],
    });

    const res = await app.request(
      '/webhook',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Line-Signature': 'A'.repeat(43) + '=' },
        body,
      },
      { ...baseEnv, DB: db, LINE_CHANNEL_SECRET: 'candidate-secret', LINE_CHANNEL_ACCESS_TOKEN: 'candidate-token' },
      { ...baseExecutionCtx, waitUntil } as unknown as ExecutionContext,
    );
    await waitUntil.mock.calls[0]?.[0];

    expect(res.status).toBe(200);
    expect(lineReplyMessageMock).toHaveBeenCalledWith('reply-token', [
      expect.objectContaining({ type: 'flex', text: expect.stringContaining('年齢') }),
    ]);
    expect(linePushMessageMock).not.toHaveBeenCalled();
  });

  test('completed eligible answers return the interview guidance without company forwarding', async () => {
    vi.mocked(verifySignature).mockResolvedValue(true);
    vi.mocked(getLineAccounts).mockResolvedValue([
      {
        id: 'saiyo-pro-candidate',
        channel_id: '2010342539',
        name: '採用PRO',
        channel_secret: 'candidate-secret',
        channel_access_token: 'candidate-token',
        liff_id: null,
        is_active: true,
        display_order: 1,
        created_at: '2026-06-10T12:00:00+09:00',
        updated_at: '2026-06-10T12:00:00+09:00',
      },
    ]);
    vi.mocked(getFriendByLineUserId).mockResolvedValue({
      id: 'friend-1',
      line_user_id: 'candidate-line-user-id',
      display_name: '応募者',
      picture_url: null,
      status_message: null,
      is_following: 1,
      metadata: JSON.stringify({ saiyo_pro_application: { age: 'age_22_24', gender: 'male', location: 'kanto' } }),
      user_id: null,
      ref_code: null,
      created_at: '2026-06-10T12:00:00+09:00',
      updated_at: '2026-06-10T12:00:00+09:00',
    });

    const db = {
      prepare(sql: string) {
        return {
          bind(...values: unknown[]) {
            return {
              first: async () => {
                if (sql.includes('SELECT metadata FROM friends')) {
                  return { metadata: JSON.stringify({ saiyo_pro_application: { age: 'age_22_24', gender: 'male', location: 'kanto' } }) };
                }
                return null;
              },
              all: async () => ({ results: [] }),
              run: async () => ({ success: true, values }),
            };
          },
          all: async () => ({ results: [] }),
          first: async () => null,
          run: async () => ({ success: true }),
        };
      },
    } as unknown as D1Database;
    const waitUntil = vi.fn();
    const app = setupApp();
    const body = JSON.stringify({
      events: [
        {
          type: 'postback',
          replyToken: 'reply-token',
          source: { type: 'user', userId: 'candidate-line-user-id' },
          postback: { data: 'demo:application:income:under300' },
        },
      ],
    });

    const res = await app.request(
      '/webhook',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Line-Signature': 'A'.repeat(43) + '=' },
        body,
      },
      { ...baseEnv, DB: db, LINE_CHANNEL_SECRET: 'candidate-secret', LINE_CHANNEL_ACCESS_TOKEN: 'candidate-token' },
      { ...baseExecutionCtx, waitUntil } as unknown as ExecutionContext,
    );
    await waitUntil.mock.calls[0]?.[0];

    expect(res.status).toBe(200);
    expect(lineReplyMessageMock).toHaveBeenCalledWith('reply-token', [
      expect.objectContaining({
        type: 'flex',
        text: expect.stringContaining('採用PROから求人案内'),
      }),
    ]);
    expect(lineReplyMessageMock).toHaveBeenCalledWith('reply-token', [
      expect.objectContaining({
        type: 'flex',
        text: expect.stringContaining('/images/saiyo-pro/office'),
      }),
    ]);
    expect(lineReplyMessageMock).toHaveBeenCalledWith('reply-token', [
      expect.objectContaining({ type: 'flex', text: expect.stringContaining('timerex.net') }),
    ]);
    expect(linePushMessageMock).not.toHaveBeenCalled();
  });

  test('answering age again clears stale later answers and does not send interview guidance early', async () => {
    vi.mocked(verifySignature).mockResolvedValue(true);
    vi.mocked(getLineAccounts).mockResolvedValue([
      {
        id: 'saiyo-pro-candidate',
        channel_id: '2010342539',
        name: '採用PRO',
        channel_secret: 'candidate-secret',
        channel_access_token: 'candidate-token',
        liff_id: null,
        is_active: true,
        display_order: 1,
        created_at: '2026-06-10T12:00:00+09:00',
        updated_at: '2026-06-10T12:00:00+09:00',
      },
    ]);
    vi.mocked(getFriendByLineUserId).mockResolvedValue({
      id: 'friend-1',
      line_user_id: 'candidate-line-user-id',
      display_name: '応募者',
      picture_url: null,
      status_message: null,
      is_following: 1,
      metadata: null,
      user_id: null,
      ref_code: null,
      created_at: '2026-06-10T12:00:00+09:00',
      updated_at: '2026-06-10T12:00:00+09:00',
    });

    const applicationBinds: unknown[][] = [];
    const db = {
      prepare(sql: string) {
        return {
          bind(...values: unknown[]) {
            return {
              first: async () => {
                if (sql.includes('SELECT age, gender, location, income')) {
                  return {
                    age: 'age_22_24',
                    gender: 'male',
                    location: 'kanto',
                    income: '300_400',
                  };
                }
                if (sql.includes('SELECT metadata FROM friends')) return { metadata: null };
                return null;
              },
              all: async () => ({ results: [] }),
              run: async () => {
                if (sql.includes('INSERT INTO saiyo_pro_applications')) applicationBinds.push(values);
                return { success: true };
              },
            };
          },
          all: async () => ({ results: [] }),
          first: async () => null,
          run: async () => ({ success: true }),
        };
      },
    } as unknown as D1Database;
    const waitUntil = vi.fn();
    const app = setupApp();
    const body = JSON.stringify({
      events: [
        {
          type: 'postback',
          replyToken: 'reply-token',
          source: { type: 'user', userId: 'candidate-line-user-id' },
          postback: { data: 'demo:application:age:age_22_24' },
        },
      ],
    });

    const res = await app.request(
      '/webhook',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Line-Signature': 'A'.repeat(43) + '=' },
        body,
      },
      { ...baseEnv, DB: db, LINE_CHANNEL_SECRET: 'candidate-secret', LINE_CHANNEL_ACCESS_TOKEN: 'candidate-token' },
      { ...baseExecutionCtx, waitUntil } as unknown as ExecutionContext,
    );
    await waitUntil.mock.calls[0]?.[0];

    expect(res.status).toBe(200);
    expect(applicationBinds[0]).toEqual([
      expect.any(String),
      'friend-1',
      'saiyo-pro-candidate',
      'age_22_24',
      null,
      null,
      null,
      'pending',
      null,
      '2026-06-10T12:00:00+09:00',
      '2026-06-10T12:00:00+09:00',
    ]);
    expect(lineReplyMessageMock).toHaveBeenCalledWith('reply-token', [
      expect.objectContaining({ type: 'flex', text: expect.stringContaining('性別') }),
    ]);
    expect(lineReplyMessageMock).not.toHaveBeenCalledWith('reply-token', [
      expect.objectContaining({ type: 'text', text: expect.stringContaining('timerex.net') }),
    ]);
  });

  test('changing gender clears stale location and income before re-evaluating eligibility', async () => {
    vi.mocked(verifySignature).mockResolvedValue(true);
    vi.mocked(getLineAccounts).mockResolvedValue([
      {
        id: 'saiyo-pro-candidate',
        channel_id: '2010342539',
        name: '採用PRO',
        channel_secret: 'candidate-secret',
        channel_access_token: 'candidate-token',
        liff_id: null,
        is_active: true,
        display_order: 1,
        created_at: '2026-06-10T12:00:00+09:00',
        updated_at: '2026-06-10T12:00:00+09:00',
      },
    ]);
    vi.mocked(getFriendByLineUserId).mockResolvedValue({
      id: 'friend-1',
      line_user_id: 'candidate-line-user-id',
      display_name: '応募者',
      picture_url: null,
      status_message: null,
      is_following: 1,
      metadata: null,
      user_id: null,
      ref_code: null,
      created_at: '2026-06-10T12:00:00+09:00',
      updated_at: '2026-06-10T12:00:00+09:00',
    });

    const applicationBinds: unknown[][] = [];
    const db = {
      prepare(sql: string) {
        return {
          bind(...values: unknown[]) {
            return {
              first: async () => {
                if (sql.includes('SELECT age, gender, location, income')) {
                  return {
                    age: 'age_22_24',
                    gender: 'male',
                    location: 'kanto',
                    income: '300_400',
                  };
                }
                if (sql.includes('SELECT metadata FROM friends')) return { metadata: null };
                return null;
              },
              all: async () => ({ results: [] }),
              run: async () => {
                if (sql.includes('INSERT INTO saiyo_pro_applications')) applicationBinds.push(values);
                return { success: true };
              },
            };
          },
          all: async () => ({ results: [] }),
          first: async () => null,
          run: async () => ({ success: true }),
        };
      },
    } as unknown as D1Database;
    const waitUntil = vi.fn();
    const app = setupApp();
    const body = JSON.stringify({
      events: [
        {
          type: 'postback',
          replyToken: 'reply-token',
          source: { type: 'user', userId: 'candidate-line-user-id' },
          postback: { data: 'demo:application:gender:female' },
        },
      ],
    });

    const res = await app.request(
      '/webhook',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Line-Signature': 'A'.repeat(43) + '=' },
        body,
      },
      { ...baseEnv, DB: db, LINE_CHANNEL_SECRET: 'candidate-secret', LINE_CHANNEL_ACCESS_TOKEN: 'candidate-token' },
      { ...baseExecutionCtx, waitUntil } as unknown as ExecutionContext,
    );
    await waitUntil.mock.calls[0]?.[0];

    expect(res.status).toBe(200);
    expect(applicationBinds[0]).toEqual([
      expect.any(String),
      'friend-1',
      'saiyo-pro-candidate',
      'age_22_24',
      'female',
      null,
      null,
      'pending',
      null,
      '2026-06-10T12:00:00+09:00',
      '2026-06-10T12:00:00+09:00',
    ]);
    expect(lineReplyMessageMock).toHaveBeenCalledWith('reply-token', [
      expect.objectContaining({ type: 'flex', text: expect.stringContaining('希望勤務地') }),
    ]);
    expect(lineReplyMessageMock).not.toHaveBeenCalledWith('reply-token', [
      expect.objectContaining({ type: 'text', text: expect.stringContaining('timerex.net') }),
    ]);
  });
});

describe('demo company candidate list', () => {
  test('hides archived candidates from rich-menu candidate lists', async () => {
    const db = {
      prepare(sql: string) {
        return {
          bind(pattern: string) {
            return {
              all: async () => {
                if (!sql.includes('FROM friends')) return { results: [] };
                return {
                  results: [
                    { id: 'friend-1', line_user_id: 'U-friend-1', display_name: 'Ikki Yamamoto', created_at: '2026-06-10T10:00:00+09:00' },
                    { id: 'friend-2', line_user_id: 'U-friend-2', display_name: '泰地', created_at: '2026-06-10T10:01:00+09:00' },
                  ],
                };
              },
              first: async () => {
                if (pattern.includes('"candidateId":"friend-1"')) {
                  return {
                    content: JSON.stringify({
                      candidateId: 'friend-1',
                      status: 'archived',
                      label: '削除済み',
                    }),
                  };
                }
                return {
                  content: JSON.stringify({
                    candidateId: 'friend-2',
                    status: 'active',
                    label: 'やり取り中',
                  }),
                };
              },
            };
          },
        };
      },
    } as unknown as D1Database;

    const flex = JSON.parse(await buildDemoCandidateListFlex(db, '候補者')) as {
      type: string;
      contents: Array<{ header: { contents: Array<{ text?: string }> } }>;
    };
    const names = flex.contents.flatMap((bubble) => bubble.header.contents.map((item) => item.text));

    expect(flex.type).toBe('carousel');
    expect(names).not.toContain('Ikki Yamamoto');
    expect(names).toContain('泰地');
    expect(names).not.toContain('山本 一気');
  });
});

describe('demo rich menu copy', () => {
  test('company pull-flow menu is scoped to Saiyo Pro applicants only', async () => {
    const db = {
      prepare(sql: string) {
        return {
          bind() {
            return {
              all: async () => sql.includes('FROM friends')
                ? {
                    results: [
                      { id: 'friend-1', line_user_id: 'U-friend-1', display_name: 'Ikki Yamamoto', created_at: '2026-06-10T10:00:00+09:00' },
                      { id: 'friend-2', line_user_id: 'U-friend-2', display_name: '泰地', created_at: '2026-06-10T10:01:00+09:00' },
                    ],
                  }
                : { results: [] },
              first: async () => null,
            };
          },
        };
      },
    } as unknown as D1Database;

    const matches = await buildDemoCompanyMenuReply(db, 'マッチ求職者一覧', null);
    const companyAccount = buildDemoCompanyAccountFromProfile('U-company-001', '山田商店');
    const jobs = await buildDemoCompanyMenuReply(db, '求人管理', null, companyAccount);
    const hires = await buildDemoCompanyMenuReply(db, '採用実績', null);
    const settings = await buildDemoCompanyMenuReply(db, '設定', null, companyAccount);

    expect(matches).toContain('マッチ求職者一覧');
    expect(matches).toContain('Ikki Yamamoto');
    expect(matches).toContain('泰地');
    expect(matches).not.toContain('山本 一気');
    expect(jobs).toBeNull();
    expect(hires).toBeNull();
    expect(settings).toBeNull();
  });

  test('company candidate list reads actual Saiyo Pro applicant friends', async () => {
    const db = {
      prepare(sql: string) {
        return {
          bind() {
            return {
              all: async () => sql.includes('FROM friends')
                ? {
                    results: [
                      { id: 'friend-1', line_user_id: 'U-friend-1', display_name: 'Ikki Yamamoto', created_at: '2026-06-10T10:00:00+09:00' },
                    ],
                  }
                : { results: [] },
              first: async () => null,
            };
          },
        };
      },
    } as unknown as D1Database;

    const candidateList = await buildDemoCandidateListFlex(db, '求職者');

    expect(candidateList).toContain('求職者');
    expect(candidateList).toContain('Ikki Yamamoto');
    expect(candidateList).not.toContain('山本 一気');
  });

  test('candidate jobs menu returns application start instead of job cards', async () => {
    const db = {
      prepare(sql: string) {
        return {
          all: async () => {
            if (!sql.includes('demo_company_job')) return { results: [] };
            return {
              results: [
                {
                  content: JSON.stringify({
                    companyName: '山田商店',
                    title: 'ホールスタッフ',
                    hourlyWage: '時給1,400円から',
                    shift: '週2日から',
                    description: '接客をお願いします。',
                    bannerUrl: 'https://example.com/yamada-banner.jpg',
                  }),
                },
                {
                  content: JSON.stringify({
                    companyName: '佐藤カフェ',
                    title: 'カフェスタッフ',
                    hourlyWage: '時給1,300円から',
                    shift: '朝シフト歓迎',
                    description: 'ドリンク作成をお願いします。',
                    bannerUrl: 'https://example.com/cafe-banner.jpg',
                  }),
                },
              ],
            };
          },
        };
      },
    } as unknown as D1Database;

    const flex = JSON.parse(await buildDemoCandidateCompanyCardsFlex(
      db,
      { id: 'yamada', name: '山本 一気', job: '採用PRO 求人案内対象者', color: '#16A34A', status: '面接日程 調整中', lastMessage: '明日15時でお願いします。' },
    )) as {
      type: string;
      footer: { contents: Array<{ action: { type: string; label: string; data?: string; uri?: string } }> };
    };

    expect(flex.type).toBe('carousel');
    expect(JSON.stringify(flex)).toContain('あなたに合いそうな求人です！！');
    expect(JSON.stringify(flex)).toContain('ホールスタッフ');
    expect(JSON.stringify(flex)).toContain('カフェスタッフ');
    expect(JSON.stringify(flex)).toContain('https://example.com/yamada-banner.jpg');
    expect(JSON.stringify(flex)).toContain('/demo-candidate-jobs');
    expect(JSON.stringify(flex)).toContain('companyName=');
  });

  test('candidate jobs menu falls back to the jobs page link when no jobs are published', async () => {
    const db = {
      prepare(sql: string) {
        return {
          all: async () => ({ results: [] }),
        };
      },
    } as unknown as D1Database;

    const flex = JSON.parse(await buildDemoCandidateCompanyCardsFlex(
      db,
      { id: 'yamada', name: '山本 一気', job: '採用PRO 求人案内対象者', color: '#16A34A', status: '面接日程 調整中', lastMessage: '明日15時でお願いします。' },
    )) as {
      type: string;
      footer: { contents: Array<{ action: { type: string; label: string; uri?: string; data?: string } }> };
    };

    expect(flex.type).toBe('bubble');
    expect(JSON.stringify(flex)).toContain('求人カードを確認できます');
    expect(flex.footer.contents[0]?.action).toEqual({
      type: 'uri',
      label: '求人を見る',
      uri: 'https://saiyo-pro-harness.ikki-y.workers.dev/demo-candidate-jobs?candidate=yamada',
    });
  });

  test('legacy candidate jobs helper returns application start instead of job links', () => {
    const flex = JSON.parse(buildDemoCandidateJobsLinkFlex(
      { id: 'yamada', name: '山本 一気', job: '採用PRO 求人案内対象者', color: '#16A34A', status: '面接日程 調整中', lastMessage: '明日15時でお願いします。' },
    )) as {
      type: string;
      footer: { contents: Array<{ action: { type: string; label: string; uri?: string; data?: string } }> };
    };

    expect(flex.type).toBe('bubble');
    expect(JSON.stringify(flex)).toContain('採用PRO 求人案内');
    expect(flex.footer.contents[0]?.action).toEqual({
      type: 'message',
      label: '求人案内の確認を始める',
      text: '求人案内の確認を始める',
    });
  });

  test('candidate chat menu asks the user to match before opening chat', () => {
    const flex = JSON.parse(buildDemoCandidateSelfMenuFlex(
      { id: 'yamada', name: '山本 一気', job: '採用PRO 求人案内対象者', color: '#16A34A', status: '面接日程 調整中', lastMessage: '明日15時でお願いします。' },
      'チャット',
    )) as {
      type: string;
      footer: { contents: Array<{ action: { type: string; label: string; uri?: string; data?: string } }> };
    };

    expect(flex.type).toBe('bubble');
    expect(JSON.stringify(flex)).toContain('山本 一気');
    expect(JSON.stringify(flex)).toContain('まずは求人に応募してマッチングしましょう！！');
    expect(JSON.stringify(flex)).toContain('マッチングしたあとに企業とのチャットが開けます');
    expect(JSON.stringify(flex)).not.toContain('時原 陸');
    expect(JSON.stringify(flex)).not.toContain('/demo-candidate-chat');
    expect(flex.footer.contents[0]?.action).toEqual({
      type: 'postback',
      label: '求人を見る',
      data: 'demo:candidate-menu:jobs-card',
    });
  });

  test('candidate status menu does not open the legacy jobs page', () => {
    const flex = JSON.parse(buildDemoCandidateSelfMenuFlex(
      { id: 'yamada', name: '山本 一気', job: '採用PRO 求人案内対象者', color: '#16A34A', status: '面接日程 調整中', lastMessage: '明日15時でお願いします。' },
      '応募状況',
    )) as {
      type: string;
      footer: { contents: Array<{ action: { label: string; uri?: string } }> };
    };

    expect(flex.type).toBe('bubble');
    expect(flex.footer.contents[0]?.action.label).toBe('応募状況を見る');
    expect(flex.footer.contents[0]?.action.uri).toContain('/demo-candidate-chat?candidate=yamada');
    expect(flex.footer.contents[0]?.action.uri).not.toContain('/demo-candidate-jobs');
  });

  test('demo welcome messages are soft plain text instead of flex cards', () => {
    const company = buildDemoWelcomeText('saiyo-pro-company');
    const candidate = buildDemoWelcomeText('saiyo-pro-candidate');

    expect(company).toContain('こんにちは');
    expect(company).toContain('採用PRO 企業向け');
    expect(company).toContain('まずは「アカウント連携」');
    expect(company).toContain('新着応募者');
    expect(company).toContain('未対応チャット');
    expect(company).toContain('求人管理');
    expect(company).toContain('アカウント連携');
    expect(company).not.toContain('採用実績');
    expect(company).not.toContain('"type":"bubble"');
    expect(candidate).toContain('採用PROへのご登録ありがとうございます');
    expect(candidate).toContain('あなたに合いそうな求人');
    expect(candidate).toContain('求人を見る');
    expect(candidate).toContain('応募チャット');
    expect(candidate).not.toContain('アカウント連携');
    expect(candidate).not.toContain('"type":"bubble"');
  });
});
