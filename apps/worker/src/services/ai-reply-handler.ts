import { getRecentHistory } from '../lib/conversation-history.js';
import { generateReply } from './ai-reply.js';
import type { EventPayload } from './event-bus.js';
import { getFriendById } from '@line-crm/db';
import { LineClient } from '@line-crm/line-sdk';

const HISTORY_TURNS = 10;
const FALLBACK_TEXT = '申し訳ありません、少し確認しますね。担当からあらためてご連絡します。';
const LINE_SOFT_LIMIT = 500;

/**
 * 長い AI 応答を LINE メッセージとして自然な単位に分割する。
 * できるだけ文末（。！？改行）で区切り、各チャンクを LINE_SOFT_LIMIT 以内に収める。
 * 1 文自体が上限を超える場合は強制スライスで複数チャンクに割る
 * （末尾切り捨てによるデータ消失を避ける）。
 */
export function splitForLine(text: string): string[] {
  if (text.length <= LINE_SOFT_LIMIT) return [text];
  const chunks: string[] = [];
  let buf = '';
  for (const sentence of text.split(/(?<=[。！？\n])/)) {
    if ((buf + sentence).length > LINE_SOFT_LIMIT && buf) {
      chunks.push(buf);
      buf = '';
    }
    if (sentence.length > LINE_SOFT_LIMIT) {
      // 1 文が上限超 → 強制分割（切り捨てない）。残りは buf に戻さず独立チャンク化。
      for (let i = 0; i < sentence.length; i += LINE_SOFT_LIMIT) {
        chunks.push(sentence.slice(i, i + LINE_SOFT_LIMIT));
      }
      continue;
    }
    buf += sentence;
  }
  if (buf) chunks.push(buf);
  return chunks;
}

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
  // 長文は複数 LINE メッセージに分割し、1 回の push でまとめて送る。
  const messages = splitForLine(reply).map((text) => ({ type: 'text' as const, text }));
  await client.pushMessage(friend.line_user_id, messages);
}
