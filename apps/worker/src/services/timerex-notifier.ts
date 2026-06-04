// TimeRex 予約イベントの LINE 通知。booking-notifier.ts と同形。
// kind ごとにテキストを組み立て、LineClient.pushMessage で push する。

import { LineClient } from '@line-crm/line-sdk';

export type TimerexNotificationKind =
  | 'confirmed'
  | 'rescheduled'
  | 'cancelled'
  | 'day_before'
  | 'hours_before';

export interface TimerexNotificationContext {
  calendarName: string;
  hostName: string;
  startsAtJst: string; // 例: "2026-05-10 14:00"
  hoursBefore: number;
}

export function renderTimerexNotificationText(
  kind: TimerexNotificationKind,
  ctx: TimerexNotificationContext,
): string {
  const detail = `\n面談: ${ctx.calendarName}\n担当: ${ctx.hostName}\n日時: ${ctx.startsAtJst}`;
  switch (kind) {
    case 'confirmed':
      return `面談の予約が確定しました。${detail}\n\n当日お待ちしております。`;
    case 'rescheduled':
      return `面談の日程が変更されました。${detail}\n\nお間違いのないようご確認ください。`;
    case 'cancelled':
      return `面談の予約がキャンセルされました。${detail}\n\n再度ご予約をご希望の場合はお知らせください。`;
    case 'day_before':
      return `明日の面談のお知らせです。${detail}`;
    case 'hours_before':
      return `本日の面談まであと ${ctx.hoursBefore} 時間です。${detail}`;
  }
}

export interface SendTimerexNotificationParams {
  channelAccessToken: string;
  toLineUserId: string;
  kind: TimerexNotificationKind;
  ctx: TimerexNotificationContext;
}

export async function sendTimerexNotification(
  params: SendTimerexNotificationParams,
): Promise<void> {
  const text = renderTimerexNotificationText(params.kind, params.ctx);
  const client = new LineClient(params.channelAccessToken);
  await client.pushMessage(params.toLineUserId, [{ type: 'text', text }]);
}

export type TimerexNotificationSender = (
  params: SendTimerexNotificationParams,
) => Promise<void>;
