import { buildAiReplySystemPrompt } from './career-persona.js';
import type { AiReplyPersona } from './career-persona.js';
import type { ChatTurn } from '../lib/conversation-history.js';

// === AI プロバイダ設定 ===
// ここが唯一のプロバイダ依存点（seam）。別プロバイダ/別モデルへの切替はこの定数群と
// リクエスト整形だけ直せばよく、呼び出し側（ai-reply-handler / event-bus）は無変更。
// 現状: OpenAI Chat Completions。MVP は gpt-4o（自然対話の品質優先）。
// コスト次第で gpt-4o-mini に下げる。
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const MODEL = 'gpt-4o';
const MAX_TOKENS = 1024;

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

/**
 * 会話履歴 + 新規メッセージを LLM に渡し応答テキストを返す。
 * API エラー時は null を返し、fallback 判断を呼び出し側に委ねる。
 */
export async function generateReply(
  apiKey: string,
  history: ChatTurn[],
  newMessage: string,
  persona?: Partial<AiReplyPersona>,
): Promise<string | null> {
  const messages = [
    { role: 'system' as const, content: buildAiReplySystemPrompt(persona) },
    ...history,
    { role: 'user' as const, content: newMessage },
  ];
  try {
    const res = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        messages,
      }),
    });
    if (!res.ok) {
      // レスポンスボディは出さない: エラー応答に入力テキスト（= LINE 利用者の相談内容
      // = PII）や認証詳細がエコーされうるため、status のみ記録する。
      console.error('OpenAI API error:', res.status);
      return null;
    }
    const data = (await res.json()) as ChatCompletionResponse;
    const text = data.choices?.[0]?.message?.content;
    return text ?? null;
  } catch (err) {
    console.error('generateReply fetch failed:', err);
    return null;
  }
}
