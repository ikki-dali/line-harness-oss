import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateReply } from './ai-reply.js';
import type { ChatTurn } from '../lib/conversation-history.js';

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('generateReply', () => {
  it('sends history + new message to Claude and returns text', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ content: [{ type: 'text', text: 'お力になります。' }] }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const history: ChatTurn[] = [{ role: 'user', content: '転職したい' }];
    const text = await generateReply('sk-test', history, '未経験でも大丈夫?');

    expect(text).toBe('お力になります。');
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.messages.at(-1)).toEqual({ role: 'user', content: '未経験でも大丈夫?' });
    expect(body.system).toBeTruthy();
  });

  it('returns null on Claude API error (caller decides fallback)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('err', { status: 500 })));
    const text = await generateReply('sk-test', [], 'hi');
    expect(text).toBeNull();
  });
});
