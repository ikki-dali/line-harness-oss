// TimeRex Webhook のビジネスロジック。
// route (timerex.ts) が token 検証・timestamp 窓・冪等 INSERT を済ませた後、
// waitUntil 内でこのハンドラを呼ぶ。例外は呼び出し側 (.catch) でログする。
//
// フロー:
//   1. url_params から line_user_id / nonce / sig を回収し HMAC 照合（案A）。
//      照合 NG は「通知スキップ」（予約記録は残す）。なりすまし通知を防ぐ。
//   2. 通知先 = active primary line_account（friends に line_account_id 列が無い
//      ため。multi-account は将来）。
//   3. event_confirmed → 確定/リスケ通知 + リマインド登録。
//      event_cancelled → リマインド取消 + キャンセル通知。

import {
  getFriendByLineUserId,
  getLineAccounts,
  upsertTimerexBooking,
  updateTimerexBookingStatus,
  insertTimerexReminder,
  cancelTimerexRemindersByEvent,
  ensureConversionPointByEventType,
  trackConversion,
  type TimerexBookingStatus,
} from '@line-crm/db';
import { verifyTimerexBookingSignature } from './timerex-link.js';
import { sendAdConversions } from './ad-conversion.js';

/** TimeRex 予約確定を表す CV イベント種別（広告オフラインCV・レポート共通キー）。 */
const TIMEREX_CV_EVENT_TYPE = 'timerex_booking_confirmed';
const TIMEREX_CV_NAME = 'TimeRex予約確定';
import {
  sendTimerexNotification,
  type TimerexNotificationKind,
  type TimerexNotificationSender,
} from './timerex-notifier.js';

// ── TimeRex payload 型（必要フィールドのみ。findings の完全仕様に基づく）──

export interface TimerexEventHost {
  name?: string;
  email?: string;
}

export interface TimerexEvent {
  id: string;
  start_datetime?: string; // UTC ISO8601
  end_datetime?: string;
  hosts?: TimerexEventHost[];
  url_params?: Array<Record<string, unknown>>;
  is_changed?: boolean;
  old_event_id?: string | null;
  new_event_id?: string | null;
  created_at?: string;
}

export interface TimerexPayload {
  webhook_type: 'event_confirmed' | 'event_cancelled';
  calendar_url_path?: string;
  calendar_name?: string;
  event: TimerexEvent;
}

export interface TimerexHandlerEnv {
  db: D1Database;
  linkSecret: string | undefined;
  reminderHoursBefore: number;
  sender?: TimerexNotificationSender; // テスト差し替え用。既定 sendTimerexNotification
}

const JST_OFFSET_MS = 9 * 3600_000;

function startsAtJst(utcIso: string): string {
  const jst = new Date(new Date(utcIso).getTime() + JST_OFFSET_MS).toISOString();
  return `${jst.slice(0, 10)} ${jst.slice(11, 16)}`;
}

/** url_params ([{k:v},...]) を string 値だけのマップに平坦化。 */
function flattenUrlParams(arr: Array<Record<string, unknown>> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!Array.isArray(arr)) return out;
  for (const obj of arr) {
    if (!obj || typeof obj !== 'object') continue;
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === 'string') out[k] = v;
    }
  }
  return out;
}

/** active な line_account のうち display_order 最小（primary）を返す。 */
async function resolvePrimaryLineAccount(
  db: D1Database,
): Promise<{ id: string; channel_access_token: string } | null> {
  const accounts = await getLineAccounts(db);
  const active = accounts
    .filter((a) => a.is_active)
    .sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0));
  const primary = active[0];
  return primary
    ? { id: primary.id, channel_access_token: primary.channel_access_token }
    : null;
}

export async function handleTimerexEvent(
  payload: TimerexPayload,
  env: TimerexHandlerEnv,
  now: Date,
): Promise<void> {
  const ev = payload.event;
  const params = flattenUrlParams(ev.url_params);

  // ── なりすまし対策: 署名照合（spec CRITICAL 案A）──
  let verifiedUserId: string | null = null;
  if (env.linkSecret) {
    const ok = await verifyTimerexBookingSignature(
      params.line_user_id,
      params.nonce,
      params.sig,
      env.linkSecret,
    );
    if (ok) {
      verifiedUserId = params.line_user_id;
    } else {
      console.warn(
        `[timerex] signature verify failed or absent — notify skipped. event=${ev.id}`,
      );
    }
  } else {
    console.warn('[timerex] TIMEREX_LINK_SECRET unset — notify skipped. event=' + ev.id);
  }

  const account = await resolvePrimaryLineAccount(env.db);
  const friend = verifiedUserId ? await getFriendByLineUserId(env.db, verifiedUserId) : null;
  const hostName = ev.hosts?.[0]?.name ?? null;
  const sender = env.sender ?? sendTimerexNotification;

  if (payload.webhook_type === 'event_cancelled') {
    await updateTimerexBookingStatus(env.db, ev.id, 'cancelled');
    await cancelTimerexRemindersByEvent(env.db, ev.id);
    if (verifiedUserId && account && ev.start_datetime) {
      await sender({
        channelAccessToken: account.channel_access_token,
        toLineUserId: verifiedUserId,
        kind: 'cancelled',
        ctx: {
          calendarName: payload.calendar_name ?? '面談',
          hostName: hostName ?? '担当者',
          startsAtJst: startsAtJst(ev.start_datetime),
          hoursBefore: env.reminderHoursBefore,
        },
      });
    }
    return;
  }

  // event_confirmed（新規確定 or リスケ）
  const isReschedule = Boolean(ev.is_changed);
  const status: TimerexBookingStatus = isReschedule ? 'rescheduled' : 'confirmed';

  // リスケ: 旧 event の予約・リマインドを無効化
  if (isReschedule && ev.old_event_id) {
    await updateTimerexBookingStatus(env.db, ev.old_event_id, 'rescheduled');
    await cancelTimerexRemindersByEvent(env.db, ev.old_event_id);
  }

  await upsertTimerexBooking(env.db, {
    eventId: ev.id,
    calendarUrlPath: payload.calendar_url_path ?? null,
    calendarName: payload.calendar_name ?? null,
    lineAccountId: account?.id ?? null,
    friendId: friend?.id ?? null,
    lineUserId: verifiedUserId,
    hostName,
    startsAt: ev.start_datetime ?? null,
    endsAt: ev.end_datetime ?? null,
    status,
    isChanged: isReschedule,
    oldEventId: ev.old_event_id ?? null,
  });

  if (!verifiedUserId || !account) return;

  const startsAt = ev.start_datetime;
  await sender({
    channelAccessToken: account.channel_access_token,
    toLineUserId: verifiedUserId,
    kind: (isReschedule ? 'rescheduled' : 'confirmed') as TimerexNotificationKind,
    ctx: {
      calendarName: payload.calendar_name ?? '面談',
      hostName: hostName ?? '担当者',
      startsAtJst: startsAt ? startsAtJst(startsAt) : '(日時未定)',
      hoursBefore: env.reminderHoursBefore,
    },
  });

  // リマインド登録（開始 reminderHoursBefore 時間前。過去なら登録しない）
  if (startsAt) {
    const remindMs = new Date(startsAt).getTime() - env.reminderHoursBefore * 3600_000;
    if (remindMs > now.getTime()) {
      await insertTimerexReminder(env.db, {
        eventId: ev.id,
        kind: 'hours_before',
        scheduledAt: new Date(remindMs).toISOString(),
      });
    }
  }

  // 広告オフライン CV（広告→LINE→予約のファネル計測）。
  // 新規確定のみ送る。リスケ(is_changed)は元予約で既に CV 済のため二重計上防止でスキップ。
  // friend が紐付き、広告クリックID (ref_tracking) が残っていれば sendAdConversions が
  // 各媒体へ送信（clid 無しなら no-op）。外部 API 失敗は予約処理本体に波及させない。
  if (friend && !isReschedule) {
    try {
      const cp = await ensureConversionPointByEventType(
        env.db,
        TIMEREX_CV_EVENT_TYPE,
        TIMEREX_CV_NAME,
      );
      await trackConversion(env.db, {
        conversionPointId: cp.id,
        friendId: friend.id,
        metadata: JSON.stringify({ eventId: ev.id, calendarName: payload.calendar_name ?? null }),
      });
      await sendAdConversions(env.db, friend.id, TIMEREX_CV_EVENT_TYPE, cp.value ?? undefined);
    } catch (e) {
      console.error('[timerex] ad-conversion error:', e);
    }
  }
}
