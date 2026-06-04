// Cron handler: send due TimeRex booking reminders.
// 既存 booking-reminders.ts と同形だが、TimeRex 専用テーブル
// (timerex_reminders / timerex_bookings / line_accounts) を join する独立スキャン。
// 通知先 line_user_id は受信時に sig 検証済で timerex_bookings に保存済のものを使う。

import type { TimerexNotificationSender } from './timerex-notifier.js';
import { REMINDER_MAX_RETRY } from './booking-types.js';

interface DueRow {
  id: string;
  kind: 'day_before' | 'hours_before';
  retry_count: number;
  starts_at: string;
  calendar_name: string | null;
  host_name: string | null;
  channel_access_token: string;
  line_user_id: string;
}

export interface ProcessTimerexRemindersParams {
  now: Date;
  sender: TimerexNotificationSender;
  reminderHoursBefore: number;
}

const JST_OFFSET_MS = 9 * 3600_000;

function startsAtJst(utcIso: string): string {
  const jst = new Date(new Date(utcIso).getTime() + JST_OFFSET_MS).toISOString();
  return `${jst.slice(0, 10)} ${jst.slice(11, 16)}`;
}

export async function processDueTimerexReminders(
  db: D1Database,
  params: ProcessTimerexRemindersParams,
): Promise<{ sent: number; failed: number }> {
  // 'pending' / 'failed'（retry 残あり）を拾う。
  // 'failed_permanent' / 'sent' / 'cancelled' は対象外。
  // line_user_id / line_account_id が解決済みの予約のみ通知する。
  const due = await db
    .prepare(
      `SELECT r.id, r.kind, r.retry_count,
              b.starts_at, b.calendar_name, b.host_name, b.line_user_id,
              la.channel_access_token
         FROM timerex_reminders r
         INNER JOIN timerex_bookings b ON b.event_id = r.event_id
         INNER JOIN line_accounts la ON la.id = b.line_account_id
        WHERE r.status IN ('pending','failed')
          AND r.scheduled_at <= ?
          AND b.status = 'confirmed'
          AND b.starts_at > ?
          AND b.line_user_id IS NOT NULL
        LIMIT 100`,
    )
    .bind(params.now.toISOString(), params.now.toISOString())
    .all<DueRow>();

  let sent = 0;
  let failed = 0;
  for (const row of due.results) {
    try {
      await params.sender({
        channelAccessToken: row.channel_access_token,
        toLineUserId: row.line_user_id,
        kind: row.kind,
        ctx: {
          calendarName: row.calendar_name ?? '面談',
          hostName: row.host_name ?? '担当者',
          startsAtJst: startsAtJst(row.starts_at),
          hoursBefore: params.reminderHoursBefore,
        },
      });
      await db
        .prepare(`UPDATE timerex_reminders SET status='sent', sent_at = ? WHERE id = ?`)
        .bind(params.now.toISOString(), row.id)
        .run();
      sent++;
    } catch (e) {
      const newRetry = row.retry_count + 1;
      const newStatus = newRetry >= REMINDER_MAX_RETRY ? 'failed_permanent' : 'failed';
      await db
        .prepare(
          `UPDATE timerex_reminders SET status = ?, retry_count = ?, last_error = ? WHERE id = ?`,
        )
        .bind(newStatus, newRetry, e instanceof Error ? e.message : String(e), row.id)
        .run();
      failed++;
    }
  }
  return { sent, failed };
}
