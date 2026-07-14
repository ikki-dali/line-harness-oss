import { getRecentHistory } from '../lib/conversation-history.js';
import { getHandover } from '../lib/handover.js';
import { generateReply } from './ai-reply.js';
import type { EventPayload } from './event-bus.js';
import { getFriendById, jstNow } from '@line-crm/db';
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
 * messages_log の直近履歴 + 新規メッセージを LLM に渡し、応答を LINE へ push する。
 * LLM が落ちた場合は無言にせず fallback 文を返す。
 * aiApiKey / lineAccessToken / friendId が欠ける場合は何もしない（無言）。
 */
export async function maybeAiReply(
  db: D1Database,
  payload: EventPayload,
  lineAccessToken?: string,
  _lineAccountId?: string | null,
  aiApiKey?: string,
): Promise<void> {
  if (!aiApiKey || !lineAccessToken || !payload.friendId) return;

  const friend = await getFriendById(db, payload.friendId);
  if (!friend?.line_user_id) return;

  // 有人対応中（handover='human'）は AI を黙らせる。
  if (getHandover(friend) === 'human') return;

  const newMessage = String(payload.eventData?.text ?? '');
  const history = await getRecentHistory(db, payload.friendId, HISTORY_TURNS);
  const reply = (await generateReply(aiApiKey, history, newMessage)) ?? FALLBACK_TEXT;

  const client = new LineClient(lineAccessToken);
  // 長文は複数 LINE メッセージに分割し、1 回の push でまとめて送る。
  const messages = splitForLine(reply).map((text) => ({ type: 'text' as const, text }));
  await client.pushMessage(friend.line_user_id, messages);

  // 送信した AI 応答を messages_log に記録する。これで管理画面 inbox に表示され、
  // 次ターンの会話履歴（getRecentHistory）でも assistant ターンとして拾われる
  // （= AI が自分の過去発言を踏まえられる）。
  await logAiReply(db, payload.friendId, reply, _lineAccountId);
}

/**
 * AI 応答を messages_log に outgoing/source='ai' で記録する。
 * push は既に成功しているので、ここの失敗で例外を上げない（ログのみ）。
 */
async function logAiReply(
  db: D1Database,
  friendId: string,
  content: string,
  lineAccountId?: string | null,
): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, delivery_type, source, line_account_id, created_at)
         VALUES (?, ?, 'outgoing', 'text', ?, NULL, NULL, 'push', 'ai', ?, ?)`,
      )
      .bind(crypto.randomUUID(), friendId, content, lineAccountId ?? null, jstNow())
      .run();
  } catch (err) {
    console.error('logAiReply failed:', err);
  }
}
