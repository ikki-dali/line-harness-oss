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

    const history: ChatTurn[] = [{ role: 'user', content: '採用を始めたい' }];
    const text = await generateReply('sk-test', history, '何から相談できますか?', {
      serviceName: '採用プロ for Biz',
      audience: '企業の採用担当者',
    });

    expect(text).toBe('お力になります。');
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    // OpenAI は system を messages 先頭の role:'system' で渡す
    expect(body.messages[0]).toEqual({ role: 'system', content: expect.any(String) });
    expect(body.messages[0].content.length).toBeGreaterThan(0);
    expect(body.messages[0].content).toContain('採用プロ for Biz');
    expect(body.messages[0].content).toContain('企業の採用担当者');
    expect(body.messages.at(-1)).toEqual({ role: 'user', content: '何から相談できますか?' });
    // Bearer 認証ヘッダ
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer sk-test');
  });

  it('returns null on OpenAI API error (caller decides fallback)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('err', { status: 500 })));
    const text = await generateReply('sk-test', [], 'hi');
    expect(text).toBeNull();
  });
});
