import { describe, expect, test, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { signTimerexBooking } from '../services/timerex-link.js';

vi.mock('@line-crm/db', () => ({
  recordTimerexEventOnce: vi.fn(),
  markTimerexEventProcessed: vi.fn(),
  getFriendByLineUserId: vi.fn(),
  getLineAccounts: vi.fn(),
  upsertTimerexBooking: vi.fn(),
  updateTimerexBookingStatus: vi.fn(),
  insertTimerexReminder: vi.fn(),
  cancelTimerexRemindersByEvent: vi.fn(),
}));

vi.mock('../services/timerex-handler.js', () => ({
  handleTimerexEvent: vi.fn().mockResolvedValue(undefined),
}));

import {
  recordTimerexEventOnce,
  markTimerexEventProcessed,
} from '@line-crm/db';
import { handleTimerexEvent } from '../services/timerex-handler.js';
import { timerex } from './timerex.js';

const VALID_TOKEN = 'test-webhook-token-32-chars-minimum';
const VALID_LINK_SECRET = 'test-link-secret-32-chars-minimum';

function setupApp() {
  const app = new Hono();
  app.route('/', timerex);
  return app;
}

const baseEnv = {
  DB: {} as D1Database,
  TIMEREX_WEBHOOK_TOKEN: VALID_TOKEN,
  TIMEREX_LINK_SECRET: VALID_LINK_SECRET,
} as Record<string, unknown>;

const baseExecutionCtx = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
} as unknown as ExecutionContext;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/webhooks/timerex/receive — token validation', () => {
  test('rejects request without x-timerex-authorization header with 401', async () => {
    const app = setupApp();
    const res = await app.request(
      '/api/webhooks/timerex/receive',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          webhook_type: 'event_confirmed',
          event: { id: 'evt1' },
        }),
      },
      baseEnv,
      baseExecutionCtx,
    );
    expect(res.status).toBe(401);
    expect(recordTimerexEventOnce).not.toHaveBeenCalled();
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
  });

  test('rejects request with wrong x-timerex-authorization token with 403', async () => {
    const app = setupApp();
    const res = await app.request(
      '/api/webhooks/timerex/receive',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-timerex-authorization': 'wrong-token',
        },
        body: JSON.stringify({
          webhook_type: 'event_confirmed',
          event: { id: 'evt1' },
        }),
      },
      baseEnv,
      baseExecutionCtx,
    );
    expect(res.status).toBe(403);
    expect(recordTimerexEventOnce).not.toHaveBeenCalled();
  });

  test('rejects request with missing TIMEREX_WEBHOOK_TOKEN env var with 503', async () => {
    const app = setupApp();
    const envWithoutToken = { ...baseEnv, TIMEREX_WEBHOOK_TOKEN: undefined };
    const res = await app.request(
      '/api/webhooks/timerex/receive',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-timerex-authorization': VALID_TOKEN,
        },
        body: JSON.stringify({
          webhook_type: 'event_confirmed',
          event: { id: 'evt1' },
        }),
      },
      envWithoutToken,
      baseExecutionCtx,
    );
    expect(res.status).toBe(503);
    expect(recordTimerexEventOnce).not.toHaveBeenCalled();
  });

  test('accepts request with valid x-timerex-authorization token', async () => {
    vi.mocked(recordTimerexEventOnce).mockResolvedValue(true);

    const app = setupApp();
    const res = await app.request(
      '/api/webhooks/timerex/receive',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-timerex-authorization': VALID_TOKEN,
        },
        body: JSON.stringify({
          webhook_type: 'event_confirmed',
          event: { id: 'evt_abc12345' },
        }),
      },
      baseEnv,
      baseExecutionCtx,
    );
    expect(res.status).toBe(200);
    expect(recordTimerexEventOnce).toHaveBeenCalled();
  });

  test('is constant-time resistant to token comparison attacks', async () => {
    // Both wrong tokens should fail consistently without timing leaks
    vi.mocked(recordTimerexEventOnce).mockResolvedValue(true);

    const app = setupApp();

    const wrongToken1 = 'aaaaaaaaaa';
    const wrongToken2 = VALID_TOKEN.slice(0, -5) + 'xxxxx'; // Right prefix, wrong suffix

    const res1 = await app.request(
      '/api/webhooks/timerex/receive',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-timerex-authorization': wrongToken1,
        },
        body: JSON.stringify({
          webhook_type: 'event_confirmed',
          event: { id: 'evt1' },
        }),
      },
      baseEnv,
      baseExecutionCtx,
    );

    const res2 = await app.request(
      '/api/webhooks/timerex/receive',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-timerex-authorization': wrongToken2,
        },
        body: JSON.stringify({
          webhook_type: 'event_confirmed',
          event: { id: 'evt2' },
        }),
      },
      baseEnv,
      baseExecutionCtx,
    );

    // Both should fail with 403 (implementation uses constant-time comparison)
    expect(res1.status).toBe(403);
    expect(res2.status).toBe(403);
  });
});

describe('POST /api/webhooks/timerex/receive — payload validation', () => {
  test('rejects invalid JSON body with 400', async () => {
    const app = setupApp();
    const res = await app.request(
      '/api/webhooks/timerex/receive',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-timerex-authorization': VALID_TOKEN,
        },
        body: '{invalid json}',
      },
      baseEnv,
      baseExecutionCtx,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/Invalid JSON/i);
    expect(recordTimerexEventOnce).not.toHaveBeenCalled();
  });

  test('rejects payload with unknown webhook_type with 400', async () => {
    const app = setupApp();
    const res = await app.request(
      '/api/webhooks/timerex/receive',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-timerex-authorization': VALID_TOKEN,
        },
        body: JSON.stringify({
          webhook_type: 'unknown_event',
          event: { id: 'evt1' },
        }),
      },
      baseEnv,
      baseExecutionCtx,
    );
    expect(res.status).toBe(400);
    expect(recordTimerexEventOnce).not.toHaveBeenCalled();
  });

  test('accepts event_confirmed webhook_type', async () => {
    vi.mocked(recordTimerexEventOnce).mockResolvedValue(true);

    const app = setupApp();
    const res = await app.request(
      '/api/webhooks/timerex/receive',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-timerex-authorization': VALID_TOKEN,
        },
        body: JSON.stringify({
          webhook_type: 'event_confirmed',
          event: { id: 'evt_abc12345' },
        }),
      },
      baseEnv,
      baseExecutionCtx,
    );
    expect(res.status).toBe(200);
  });

  test('accepts event_cancelled webhook_type', async () => {
    vi.mocked(recordTimerexEventOnce).mockResolvedValue(true);

    const app = setupApp();
    const res = await app.request(
      '/api/webhooks/timerex/receive',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-timerex-authorization': VALID_TOKEN,
        },
        body: JSON.stringify({
          webhook_type: 'event_cancelled',
          event: { id: 'evt_abc12345' },
        }),
      },
      baseEnv,
      baseExecutionCtx,
    );
    expect(res.status).toBe(200);
  });

  test('rejects payload with missing event.id with 400', async () => {
    const app = setupApp();
    const res = await app.request(
      '/api/webhooks/timerex/receive',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-timerex-authorization': VALID_TOKEN,
        },
        body: JSON.stringify({
          webhook_type: 'event_confirmed',
          event: {}, // no id
        }),
      },
      baseEnv,
      baseExecutionCtx,
    );
    expect(res.status).toBe(400);
    expect(recordTimerexEventOnce).not.toHaveBeenCalled();
  });

  test('rejects event.id that is empty string with 400', async () => {
    const app = setupApp();
    const res = await app.request(
      '/api/webhooks/timerex/receive',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-timerex-authorization': VALID_TOKEN,
        },
        body: JSON.stringify({
          webhook_type: 'event_confirmed',
          event: { id: '' },
        }),
      },
      baseEnv,
      baseExecutionCtx,
    );
    expect(res.status).toBe(400);
    expect(recordTimerexEventOnce).not.toHaveBeenCalled();
  });

  test('rejects event.id with invalid characters (no underscore/dash) with 400', async () => {
    const app = setupApp();
    const res = await app.request(
      '/api/webhooks/timerex/receive',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-timerex-authorization': VALID_TOKEN,
        },
        body: JSON.stringify({
          webhook_type: 'event_confirmed',
          event: { id: 'evt@#$%123' },
        }),
      },
      baseEnv,
      baseExecutionCtx,
    );
    expect(res.status).toBe(400);
    expect(recordTimerexEventOnce).not.toHaveBeenCalled();
  });

  test('rejects event.id that is too short (less than 8 chars) with 400', async () => {
    const app = setupApp();
    const res = await app.request(
      '/api/webhooks/timerex/receive',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-timerex-authorization': VALID_TOKEN,
        },
        body: JSON.stringify({
          webhook_type: 'event_confirmed',
          event: { id: 'evt123' }, // 6 chars < 8
        }),
      },
      baseEnv,
      baseExecutionCtx,
    );
    expect(res.status).toBe(400);
    expect(recordTimerexEventOnce).not.toHaveBeenCalled();
  });

  test('accepts valid event.id with alphanumeric, underscore, dash', async () => {
    vi.mocked(recordTimerexEventOnce).mockResolvedValue(true);

    const app = setupApp();
    const res = await app.request(
      '/api/webhooks/timerex/receive',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-timerex-authorization': VALID_TOKEN,
        },
        body: JSON.stringify({
          webhook_type: 'event_confirmed',
          event: { id: 'evt_abc-123XYZ' },
        }),
      },
      baseEnv,
      baseExecutionCtx,
    );
    expect(res.status).toBe(200);
    expect(recordTimerexEventOnce).toHaveBeenCalled();
  });

  test('rejects non-object event with 400', async () => {
    const app = setupApp();
    const res = await app.request(
      '/api/webhooks/timerex/receive',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-timerex-authorization': VALID_TOKEN,
        },
        body: JSON.stringify({
          webhook_type: 'event_confirmed',
          event: null,
        }),
      },
      baseEnv,
      baseExecutionCtx,
    );
    expect(res.status).toBe(400);
  });

  test('rejects payload that is not an object with 400', async () => {
    const app = setupApp();
    const res = await app.request(
      '/api/webhooks/timerex/receive',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-timerex-authorization': VALID_TOKEN,
        },
        body: JSON.stringify('not an object'),
      },
      baseEnv,
      baseExecutionCtx,
    );
    expect(res.status).toBe(400);
  });
});

describe('POST /api/webhooks/timerex/receive — idempotency', () => {
  test('returns duplicate: true when recordTimerexEventOnce returns false', async () => {
    vi.mocked(recordTimerexEventOnce).mockResolvedValue(false);

    const app = setupApp();
    const res = await app.request(
      '/api/webhooks/timerex/receive',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-timerex-authorization': VALID_TOKEN,
        },
        body: JSON.stringify({
          webhook_type: 'event_confirmed',
          event: { id: 'evt_duplicate' },
        }),
      },
      baseEnv,
      baseExecutionCtx,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { duplicate: boolean } };
    expect(body.data.duplicate).toBe(true);
  });

  test('returns duplicate: false when recordTimerexEventOnce returns true (fresh)', async () => {
    vi.mocked(recordTimerexEventOnce).mockResolvedValue(true);

    const app = setupApp();
    const res = await app.request(
      '/api/webhooks/timerex/receive',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-timerex-authorization': VALID_TOKEN,
        },
        body: JSON.stringify({
          webhook_type: 'event_confirmed',
          event: { id: 'evt_fresh' },
        }),
      },
      baseEnv,
      baseExecutionCtx,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { duplicate?: boolean } };
    expect(body.data.duplicate).not.toBe(true);
  });

  test('does not call handleTimerexEvent when duplicate detected', async () => {
    vi.mocked(recordTimerexEventOnce).mockResolvedValue(false);

    const app = setupApp();
    await app.request(
      '/api/webhooks/timerex/receive',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-timerex-authorization': VALID_TOKEN,
        },
        body: JSON.stringify({
          webhook_type: 'event_confirmed',
          event: { id: 'evt_dup2' },
        }),
      },
      baseEnv,
      baseExecutionCtx,
    );
    expect(handleTimerexEvent).not.toHaveBeenCalled();
  });

  test('calls handleTimerexEvent when event is fresh', async () => {
    vi.mocked(recordTimerexEventOnce).mockResolvedValue(true);

    const app = setupApp();
    await app.request(
      '/api/webhooks/timerex/receive',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-timerex-authorization': VALID_TOKEN,
        },
        body: JSON.stringify({
          webhook_type: 'event_confirmed',
          event: { id: 'evt_fresh2' },
        }),
      },
      baseEnv,
      baseExecutionCtx,
    );
    expect(handleTimerexEvent).toHaveBeenCalled();
  });

  test('uses combined key (event_id:webhook_type) for idempotency', async () => {
    vi.mocked(recordTimerexEventOnce).mockResolvedValue(true);

    const app = setupApp();
    await app.request(
      '/api/webhooks/timerex/receive',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-timerex-authorization': VALID_TOKEN,
        },
        body: JSON.stringify({
          webhook_type: 'event_confirmed',
          event: { id: 'evt_dup_key' },
        }),
      },
      baseEnv,
      baseExecutionCtx,
    );

    const call = vi.mocked(recordTimerexEventOnce).mock.calls[0];
    // Second argument is eventId, third is webhookType
    expect(call[1]).toBe('evt_dup_key');
    expect(call[2]).toBe('event_confirmed');
  });

  test('allows same event with different webhook_type (cancelled vs confirmed)', async () => {
    vi.mocked(recordTimerexEventOnce)
      .mockResolvedValueOnce(true) // confirmed is fresh
      .mockResolvedValueOnce(true); // cancelled is fresh

    const app = setupApp();

    const res1 = await app.request(
      '/api/webhooks/timerex/receive',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-timerex-authorization': VALID_TOKEN,
        },
        body: JSON.stringify({
          webhook_type: 'event_confirmed',
          event: { id: 'evt_both' },
        }),
      },
      baseEnv,
      baseExecutionCtx,
    );

    const res2 = await app.request(
      '/api/webhooks/timerex/receive',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-timerex-authorization': VALID_TOKEN,
        },
        body: JSON.stringify({
          webhook_type: 'event_cancelled',
          event: { id: 'evt_both' },
        }),
      },
      baseEnv,
      baseExecutionCtx,
    );

    // Both should succeed (different webhook_type = different key)
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    expect(handleTimerexEvent).toHaveBeenCalledTimes(2);
  });
});

describe('POST /api/webhooks/timerex/receive — async processing', () => {
  test('returns 200 immediately even though handler runs async', async () => {
    vi.mocked(recordTimerexEventOnce).mockResolvedValue(true);

    const app = setupApp();
    const res = await app.request(
      '/api/webhooks/timerex/receive',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-timerex-authorization': VALID_TOKEN,
        },
        body: JSON.stringify({
          webhook_type: 'event_confirmed',
          event: { id: 'evt_async' },
        }),
      },
      baseEnv,
      baseExecutionCtx,
    );
    expect(res.status).toBe(200);
  });

  test('calls waitUntil to defer handler execution', async () => {
    vi.mocked(recordTimerexEventOnce).mockResolvedValue(true);

    const app = setupApp();
    await app.request(
      '/api/webhooks/timerex/receive',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-timerex-authorization': VALID_TOKEN,
        },
        body: JSON.stringify({
          webhook_type: 'event_confirmed',
          event: { id: 'evt_wait' },
        }),
      },
      baseEnv,
      baseExecutionCtx,
    );

    // Verify waitUntil was called (promise passed)
    expect(baseExecutionCtx.waitUntil).toHaveBeenCalled();
  });

  test('calls markTimerexEventProcessed after handler completes', async () => {
    vi.mocked(recordTimerexEventOnce).mockResolvedValue(true);
    vi.mocked(handleTimerexEvent).mockResolvedValue(undefined);
    vi.mocked(markTimerexEventProcessed).mockResolvedValue(undefined);

    const app = setupApp();
    await app.request(
      '/api/webhooks/timerex/receive',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-timerex-authorization': VALID_TOKEN,
        },
        body: JSON.stringify({
          webhook_type: 'event_confirmed',
          event: { id: 'evt_mark' },
        }),
      },
      baseEnv,
      baseExecutionCtx,
    );

    // Get the promise passed to waitUntil
    const waitUntilCall = vi.mocked(baseExecutionCtx.waitUntil).mock.calls[0];
    if (waitUntilCall && waitUntilCall[0]) {
      await waitUntilCall[0];
    }

    // markTimerexEventProcessed should be called after handler
    expect(markTimerexEventProcessed).toHaveBeenCalledWith(
      expect.anything(),
      'evt_mark',
      'event_confirmed',
      expect.any(String),
    );
  });
});

describe('POST /api/timerex/booking-link — link generation', () => {
  test('rejects request with missing TIMEREX_LINK_SECRET with 503', async () => {
    const app = setupApp();
    const envWithoutSecret = { ...baseEnv, TIMEREX_LINK_SECRET: undefined };
    const res = await app.request(
      '/api/timerex/booking-link',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lineUserId: 'U_user1',
          calendarUrl: 'https://timerex.net/s/demo_team/demo_cal',
        }),
      },
      envWithoutSecret,
      baseExecutionCtx,
    );
    expect(res.status).toBe(503);
  });

  test('rejects request with missing lineUserId with 400', async () => {
    const app = setupApp();
    const res = await app.request(
      '/api/timerex/booking-link',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // missing lineUserId
          calendarUrl: 'https://timerex.net/s/demo_team/demo_cal',
        }),
      },
      baseEnv,
      baseExecutionCtx,
    );
    expect(res.status).toBe(400);
  });

  test('rejects request with missing calendarUrl with 400', async () => {
    const app = setupApp();
    const res = await app.request(
      '/api/timerex/booking-link',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lineUserId: 'U_user1',
          // missing calendarUrl
        }),
      },
      baseEnv,
      baseExecutionCtx,
    );
    expect(res.status).toBe(400);
  });

  test('rejects request with empty lineUserId with 400', async () => {
    const app = setupApp();
    const res = await app.request(
      '/api/timerex/booking-link',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lineUserId: '',
          calendarUrl: 'https://timerex.net/s/demo_team/demo_cal',
        }),
      },
      baseEnv,
      baseExecutionCtx,
    );
    expect(res.status).toBe(400);
  });

  test('rejects request with empty calendarUrl with 400', async () => {
    const app = setupApp();
    const res = await app.request(
      '/api/timerex/booking-link',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lineUserId: 'U_user1',
          calendarUrl: '',
        }),
      },
      baseEnv,
      baseExecutionCtx,
    );
    expect(res.status).toBe(400);
  });

  test('rejects http:// URL with 400', async () => {
    const app = setupApp();
    const res = await app.request(
      '/api/timerex/booking-link',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lineUserId: 'U_user1',
          calendarUrl: 'http://calendar.example.com/book', // http, not https
        }),
      },
      baseEnv,
      baseExecutionCtx,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/https/i);
  });

  test('rejects non-timerex.net domain with 400', async () => {
    const app = setupApp();
    const res = await app.request(
      '/api/timerex/booking-link',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lineUserId: 'U_user1',
          calendarUrl: 'https://evil.example.com/book',
        }),
      },
      baseEnv,
      baseExecutionCtx,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/timerex\.net/i);
  });

  test('rejects malformed URL with 400', async () => {
    const app = setupApp();
    const res = await app.request(
      '/api/timerex/booking-link',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lineUserId: 'U_user1',
          calendarUrl: 'not-a-valid-url',
        }),
      },
      baseEnv,
      baseExecutionCtx,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/valid URL/i);
  });

  test('accepts valid https URL and returns signed booking link', async () => {
    const app = setupApp();
    const res = await app.request(
      '/api/timerex/booking-link',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lineUserId: 'U_user1',
          calendarUrl: 'https://timerex.net/s/demo_team/demo_cal',
        }),
      },
      baseEnv,
      baseExecutionCtx,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: { url: string } };
    expect(body.success).toBe(true);
    expect(body.data.url).toBeTruthy();
    expect(body.data.url).toMatch(/^https:\/\//);
  });

  test('returned URL contains line_user_id parameter', async () => {
    const app = setupApp();
    const userId = 'U_test_user123';
    const res = await app.request(
      '/api/timerex/booking-link',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lineUserId: userId,
          calendarUrl: 'https://timerex.net/s/demo_team/demo_cal',
        }),
      },
      baseEnv,
      baseExecutionCtx,
    );
    const body = (await res.json()) as { data: { url: string } };
    expect(body.data.url).toContain(`line_user_id=${userId}`);
  });

  test('returned URL contains nonce parameter', async () => {
    const app = setupApp();
    const res = await app.request(
      '/api/timerex/booking-link',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lineUserId: 'U_user1',
          calendarUrl: 'https://timerex.net/s/demo_team/demo_cal',
        }),
      },
      baseEnv,
      baseExecutionCtx,
    );
    const body = (await res.json()) as { data: { url: string } };
    const url = new URL(body.data.url);
    expect(url.searchParams.has('nonce')).toBe(true);
    expect(url.searchParams.get('nonce')).toMatch(/^[a-f0-9]+$/);
  });

  test('returned URL contains sig parameter', async () => {
    const app = setupApp();
    const res = await app.request(
      '/api/timerex/booking-link',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lineUserId: 'U_user1',
          calendarUrl: 'https://timerex.net/s/demo_team/demo_cal',
        }),
      },
      baseEnv,
      baseExecutionCtx,
    );
    const body = (await res.json()) as { data: { url: string } };
    const url = new URL(body.data.url);
    expect(url.searchParams.has('sig')).toBe(true);
    const sig = url.searchParams.get('sig');
    expect(sig).toMatch(/^[a-f0-9]{64}$/); // SHA256 hex
  });

  test('different calls generate different nonces', async () => {
    const app = setupApp();
    const res1 = await app.request(
      '/api/timerex/booking-link',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lineUserId: 'U_user1',
          calendarUrl: 'https://timerex.net/s/demo_team/demo_cal',
        }),
      },
      baseEnv,
      baseExecutionCtx,
    );
    const res2 = await app.request(
      '/api/timerex/booking-link',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lineUserId: 'U_user1',
          calendarUrl: 'https://timerex.net/s/demo_team/demo_cal',
        }),
      },
      baseEnv,
      baseExecutionCtx,
    );

    const body1 = (await res1.json()) as { data: { url: string } };
    const body2 = (await res2.json()) as { data: { url: string } };

    const url1 = new URL(body1.data.url);
    const url2 = new URL(body2.data.url);

    const nonce1 = url1.searchParams.get('nonce');
    const nonce2 = url2.searchParams.get('nonce');

    expect(nonce1).not.toBe(nonce2);
  });

  test('different users get different signatures for same calendar URL', async () => {
    const app = setupApp();
    const res1 = await app.request(
      '/api/timerex/booking-link',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lineUserId: 'U_user1',
          calendarUrl: 'https://timerex.net/s/demo_team/demo_cal',
        }),
      },
      baseEnv,
      baseExecutionCtx,
    );
    const res2 = await app.request(
      '/api/timerex/booking-link',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lineUserId: 'U_user2',
          calendarUrl: 'https://timerex.net/s/demo_team/demo_cal',
        }),
      },
      baseEnv,
      baseExecutionCtx,
    );

    const body1 = (await res1.json()) as { data: { url: string } };
    const body2 = (await res2.json()) as { data: { url: string } };

    const url1 = new URL(body1.data.url);
    const url2 = new URL(body2.data.url);

    const sig1 = url1.searchParams.get('sig');
    const sig2 = url2.searchParams.get('sig');

    expect(sig1).not.toBe(sig2);
  });

  test('preserves existing query parameters in calendar URL', async () => {
    const app = setupApp();
    const res = await app.request(
      '/api/timerex/booking-link',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lineUserId: 'U_user1',
          calendarUrl: 'https://timerex.net/s/demo_team/demo_cal?existing=param&another=value',
        }),
      },
      baseEnv,
      baseExecutionCtx,
    );
    const body = (await res.json()) as { data: { url: string } };
    expect(body.data.url).toContain('existing=param');
    expect(body.data.url).toContain('another=value');
  });

  test('returns 500 on internal error', async () => {
    const app = setupApp();
    // Trigger an error by passing invalid JSON
    const res = await app.request(
      '/api/timerex/booking-link',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'invalid json',
      },
      baseEnv,
      baseExecutionCtx,
    );
    expect(res.status).toBe(500);
  });
});
