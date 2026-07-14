import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateReply } from './ai-reply.js';
import type { ChatTurn } from '../lib/conversation-history.js';

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('generateReply (OpenAI Chat Completions)', () => {
  it('sends system + history + new message and returns text', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'お力になります。' } }] }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const history: ChatTurn[] = [{ role: 'user', content: '転職したい' }];
    const text = await generateReply('sk-test', history, '未経験でも大丈夫?');

    expect(text).toBe('お力になります。');
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    // OpenAI は system を messages 先頭の role:'system' で渡す
    expect(body.messages[0]).toEqual({ role: 'system', content: expect.any(String) });
    expect(body.messages[0].content.length).toBeGreaterThan(0);
    expect(body.messages.at(-1)).toEqual({ role: 'user', content: '未経験でも大丈夫?' });
    // Bearer 認証ヘッダ
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer sk-test');
  });

  it('returns null on OpenAI API error (caller decides fallback)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('err', { status: 500 })));
    const text = await generateReply('sk-test', [], 'hi');
    expect(text).toBeNull();
  });

  it('uses the recruiting-business persona for 採用プロ for Biz', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ choices: [{ message: { role: 'assistant', content: '承知いたしました。' } }] }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await generateReply('sk-test', [], '採用支援について聞きたいです', 'saiyo-pro-company');

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    const systemPrompt = body.messages[0].content as string;
    expect(systemPrompt).toContain('採用プロ for Biz');
    expect(systemPrompt).toContain('企業の採用担当者');
    expect(systemPrompt).toContain('丁寧で落ち着いた日本語');
    expect(systemPrompt).toContain('必要に応じて担当者へ連携');
    expect(systemPrompt).toContain('求人情報の登録・管理');
    expect(systemPrompt).toContain('応募者・候補者の確認');
    expect(systemPrompt).toContain('一度の返信で尋ねることは1つまで');
    expect(systemPrompt).toContain('箇条書きにせず1〜2文');
    expect(systemPrompt).toContain('具体的な選択質問');
    expect(systemPrompt).not.toContain('堅すぎない');
    expect(systemPrompt).not.toContain('口語でよい');
  });
});
