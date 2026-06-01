import { CAREER_COUNSELOR_SYSTEM } from './career-persona.js';
import type { ChatTurn } from '../lib/conversation-history.js';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 1024;

/**
 * 会話履歴 + 新規メッセージを Claude に渡し応答テキストを返す。
 * API エラー時は null を返し、fallback 判断を呼び出し側に委ねる。
 */
export async function generateReply(
  apiKey: string,
  history: ChatTurn[],
  newMessage: string,
): Promise<string | null> {
  const messages = [...history, { role: 'user' as const, content: newMessage }];
  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: CAREER_COUNSELOR_SYSTEM,
        messages,
      }),
    });
    if (!res.ok) {
      // レスポンスボディは出さない: Anthropic のエラー応答に入力テキスト（= LINE
      // 利用者の相談内容 = PII）や認証詳細がエコーされうるため、status のみ記録する。
      console.error('Claude API error:', res.status);
      return null;
    }
    const data = (await res.json()) as { content: Array<{ type: string; text?: string }> };
    const text = data.content.find((b) => b.type === 'text')?.text;
    return text ?? null;
  } catch (err) {
    console.error('generateReply fetch failed:', err);
    return null;
  }
}
