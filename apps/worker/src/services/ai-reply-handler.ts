import { getRecentHistory } from '../lib/conversation-history.js';
import { generateReply } from './ai-reply.js';
import type { EventPayload } from './event-bus.js';
import { getFriendById } from '@line-crm/db';
import { LineClient } from '@line-crm/line-sdk';

const HISTORY_TURNS = 10;
const FALLBACK_TEXT = '申し訳ありません、少し確認しますね。担当からあらためてご連絡します。';

/**
 * messages_log の直近履歴 + 新規メッセージを Claude に渡し、応答を LINE へ push する。
 * Claude が落ちた場合は無言にせず fallback 文を返す。
 * anthropicApiKey / lineAccessToken / friendId が欠ける場合は何もしない（無言）。
 */
export async function maybeAiReply(
  db: D1Database,
  payload: EventPayload,
  lineAccessToken?: string,
  _lineAccountId?: string | null,
  anthropicApiKey?: string,
): Promise<void> {
  if (!anthropicApiKey || !lineAccessToken || !payload.friendId) return;

  const friend = await getFriendById(db, payload.friendId);
  if (!friend?.line_user_id) return;

  const newMessage = String(payload.eventData?.text ?? '');
  const history = await getRecentHistory(db, payload.friendId, HISTORY_TURNS);
  const reply = (await generateReply(anthropicApiKey, history, newMessage)) ?? FALLBACK_TEXT;

  const client = new LineClient(lineAccessToken);
  await client.pushTextMessage(friend.line_user_id, reply);
}
