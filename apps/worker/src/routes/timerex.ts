import { Hono } from 'hono';
import {
  recordTimerexEventOnce,
  markTimerexEventProcessed,
} from '@line-crm/db';
import { handleTimerexEvent, type TimerexPayload } from '../services/timerex-handler.js';
import { buildTimerexBookingUrl } from '../services/timerex-link.js';
import { DEFAULT_ACCOUNT_SETTINGS } from '../services/booking-types.js';
import { timingSafeEqual } from '../lib/hmac.js';
import type { Env } from '../index.js';

const timerex = new Hono<Env>();

const EVENT_ID_RE = /^[A-Za-z0-9_-]{8,}$/;

function isValidPayload(p: unknown): p is TimerexPayload {
  if (!p || typeof p !== 'object') return false;
  const o = p as Record<string, unknown>;
  if (o.webhook_type !== 'event_confirmed' && o.webhook_type !== 'event_cancelled') return false;
  const ev = o.event;
  if (!ev || typeof ev !== 'object') return false;
  const id = (ev as Record<string, unknown>).id;
  // 空文字 PK で冪等台帳が壊れるのを防ぐため文字種・最小長を強制。
  return typeof id === 'string' && EVENT_ID_RE.test(id);
}

// ========== 受け口: TimeRex Webhook 受信 ==========
// auth は middleware/auth.ts で skip（固定トークンで認可）。
timerex.post('/api/webhooks/timerex/receive', async (c) => {
  try {
    const token = c.env.TIMEREX_WEBHOOK_TOKEN;
    if (!token) {
      // 未設定なら fail closed（誤って無認証で開かない）。
      return c.json({ success: false, error: 'TimeRex webhook not configured' }, 503);
    }
    const provided = c.req.header('x-timerex-authorization');
    if (!provided) {
      return c.json({ success: false, error: 'x-timerex-authorization header is required' }, 401);
    }
    if (!timingSafeEqual(provided, token)) {
      return c.json({ success: false, error: 'Invalid token' }, 403);
    }

    const rawBody = await c.req.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      return c.json({ success: false, error: 'Invalid JSON body' }, 400);
    }
    if (!isValidPayload(parsed)) {
      return c.json({ success: false, error: 'Invalid payload' }, 400);
    }
    const payload = parsed;

    // リプレイ・重複配信は冪等台帳で無害化（初回のみ処理）。
    // 注: TimeRex payload に「送信時刻」は無く created_at は予約作成時刻のため、
    // タイムスタンプ許容窓は cancelled (過去の作成時刻) を誤って弾く。よって窓は
    // 採用せず冪等で代替する（security-reviewer 指摘への設計上の回答）。
    const nowIso = new Date().toISOString();
    const fresh = await recordTimerexEventOnce(
      c.env.DB,
      payload.event.id,
      payload.webhook_type,
      nowIso,
    );
    if (!fresh) {
      return c.json({ success: true, data: { received: true, duplicate: true } });
    }

    const handlerEnv = {
      db: c.env.DB,
      linkSecret: c.env.TIMEREX_LINK_SECRET,
      reminderHoursBefore: DEFAULT_ACCOUNT_SETTINGS.reminder_hours_before,
    };
    // 重い処理は即 200 を返してから非同期で（LINE webhook と同じ流儀）。
    c.executionCtx.waitUntil(
      handleTimerexEvent(payload, handlerEnv, new Date())
        .then(() =>
          markTimerexEventProcessed(
            c.env.DB,
            payload.event.id,
            payload.webhook_type,
            new Date().toISOString(),
          ),
        )
        .catch((e) => console.error('[timerex] handler error:', e)),
    );

    return c.json({ success: true, data: { received: true } });
  } catch (err) {
    console.error('POST /api/webhooks/timerex/receive error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ========== 予約リンク発行（認証必須・bot/管理から呼ぶ）==========
// 友だちごとに line_user_id + nonce + sig を埋めた予約 URL を返す（案A）。
timerex.post('/api/timerex/booking-link', async (c) => {
  try {
    const secret = c.env.TIMEREX_LINK_SECRET;
    if (!secret) {
      return c.json({ success: false, error: 'TIMEREX_LINK_SECRET is not configured' }, 503);
    }
    const body = await c.req.json<{ lineUserId?: unknown; calendarUrl?: unknown }>();
    if (
      typeof body.lineUserId !== 'string' ||
      body.lineUserId.length === 0 ||
      typeof body.calendarUrl !== 'string' ||
      body.calendarUrl.length === 0
    ) {
      return c.json(
        { success: false, error: 'lineUserId and calendarUrl (non-empty string) are required' },
        400,
      );
    }
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(body.calendarUrl);
    } catch {
      return c.json({ success: false, error: 'calendarUrl must be a valid URL' }, 400);
    }
    if (parsedUrl.protocol !== 'https:') {
      return c.json({ success: false, error: 'calendarUrl must use https://' }, 400);
    }
    // 署名付き URL を発行できるのは TimeRex 予約ドメインに限定（オープンリダイレクト/
    // 署名の他用途流用を防ぐ。security-reviewer 指摘）。
    if (parsedUrl.hostname !== 'timerex.net' && !parsedUrl.hostname.endsWith('.timerex.net')) {
      return c.json({ success: false, error: 'calendarUrl must be a timerex.net domain' }, 400);
    }
    const url = await buildTimerexBookingUrl(body.calendarUrl, body.lineUserId, secret);
    return c.json({ success: true, data: { url } });
  } catch (err) {
    console.error('POST /api/timerex/booking-link error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { timerex };
