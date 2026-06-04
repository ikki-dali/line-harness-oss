// TimeRex 連携のデータアクセス層。
// テーブル定義は migration 046_timerex.sql。時刻列 (starts_at/ends_at/
// scheduled_at/received_at) は呼び出し側が UTC ISO8601 で渡す。

export type TimerexBookingStatus = 'confirmed' | 'cancelled' | 'rescheduled';
export type TimerexReminderKind = 'day_before' | 'hours_before';

export interface TimerexBookingInput {
  eventId: string;
  calendarUrlPath: string | null;
  calendarName: string | null;
  lineAccountId: string | null;
  friendId: string | null;
  lineUserId: string | null;
  hostName: string | null;
  startsAt: string | null; // UTC ISO8601
  endsAt: string | null; // UTC ISO8601
  status: TimerexBookingStatus;
  isChanged: boolean;
  oldEventId: string | null;
}

export interface TimerexReminderInput {
  eventId: string;
  kind: TimerexReminderKind;
  scheduledAt: string; // UTC ISO8601
}

/**
 * 冪等台帳に記録する。初回 (新規配信) なら true、既に処理済み (重複/リプレイ)
 * なら false を返す。呼び出し側は false のとき処理をスキップする。
 * 冪等キーは "<event_id>:<webhook_type>"（confirmed と cancelled は同一
 * event_id で別配信されるため複合）。
 */
export async function recordTimerexEventOnce(
  db: D1Database,
  eventId: string,
  webhookType: string,
  receivedAtIso: string,
): Promise<boolean> {
  const key = `${eventId}:${webhookType}`;
  const res = await db
    .prepare(
      `INSERT OR IGNORE INTO timerex_events
         (idempotency_key, event_id, webhook_type, received_at)
       VALUES (?, ?, ?, ?)`,
    )
    .bind(key, eventId, webhookType, receivedAtIso)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

/** 処理完了マーク（デバッグ・運用観測用）。 */
export async function markTimerexEventProcessed(
  db: D1Database,
  eventId: string,
  webhookType: string,
  processedAtIso: string,
): Promise<void> {
  const key = `${eventId}:${webhookType}`;
  await db
    .prepare(`UPDATE timerex_events SET processed_at = ? WHERE idempotency_key = ?`)
    .bind(processedAtIso, key)
    .run();
}

/** 予約を upsert。リスケ・再受信で同 event_id が来たら状態を更新する。 */
export async function upsertTimerexBooking(
  db: D1Database,
  input: TimerexBookingInput,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO timerex_bookings
         (event_id, calendar_url_path, calendar_name, line_account_id,
          friend_id, line_user_id, host_name, starts_at, ends_at,
          status, is_changed, old_event_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(event_id) DO UPDATE SET
         calendar_url_path = excluded.calendar_url_path,
         calendar_name     = excluded.calendar_name,
         line_account_id   = excluded.line_account_id,
         friend_id         = excluded.friend_id,
         line_user_id      = excluded.line_user_id,
         host_name         = excluded.host_name,
         starts_at         = excluded.starts_at,
         ends_at           = excluded.ends_at,
         status            = excluded.status,
         is_changed        = excluded.is_changed,
         old_event_id      = excluded.old_event_id,
         updated_at        = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')`,
    )
    .bind(
      input.eventId,
      input.calendarUrlPath,
      input.calendarName,
      input.lineAccountId,
      input.friendId,
      input.lineUserId,
      input.hostName,
      input.startsAt,
      input.endsAt,
      input.status,
      input.isChanged ? 1 : 0,
      input.oldEventId,
    )
    .run();
}

/** 予約の状態だけ更新（キャンセル等）。 */
export async function updateTimerexBookingStatus(
  db: D1Database,
  eventId: string,
  status: TimerexBookingStatus,
): Promise<void> {
  await db
    .prepare(
      `UPDATE timerex_bookings
          SET status = ?,
              updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')
        WHERE event_id = ?`,
    )
    .bind(status, eventId)
    .run();
}

/** リマインドを 1 件登録する。 */
export async function insertTimerexReminder(
  db: D1Database,
  input: TimerexReminderInput,
): Promise<void> {
  // UNIQUE(event_id, kind) 制約により、再配信・再試行での二重登録は無視される。
  await db
    .prepare(
      `INSERT OR IGNORE INTO timerex_reminders (id, event_id, kind, scheduled_at)
       VALUES (?, ?, ?, ?)`,
    )
    .bind(crypto.randomUUID(), input.eventId, input.kind, input.scheduledAt)
    .run();
}

/**
 * 指定 event の未送信リマインドを cancelled にする（キャンセル・リスケ時）。
 * 既に sent のものは触らない。
 */
export async function cancelTimerexRemindersByEvent(
  db: D1Database,
  eventId: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE timerex_reminders
          SET status = 'cancelled'
        WHERE event_id = ?
          AND status IN ('pending','failed')`,
    )
    .bind(eventId)
    .run();
}
