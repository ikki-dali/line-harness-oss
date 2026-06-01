import { describe, it, expect, vi, beforeEach } from 'vitest';
import { splitForLine, maybeAiReply } from './ai-reply-handler.js';
import type { EventPayload } from './event-bus.js';

const pushMessage = vi.fn().mockResolvedValue(undefined);
const generateReply = vi.fn();
const getFriendById = vi.fn();

vi.mock('@line-crm/line-sdk', () => ({
  LineClient: vi.fn().mockImplementation(() => ({ pushMessage })),
}));
vi.mock('@line-crm/db', () => ({
  getFriendById: (...args: unknown[]) => getFriendById(...args),
}));
vi.mock('./ai-reply.js', () => ({
  generateReply: (...args: unknown[]) => generateReply(...args),
}));

// getRecentHistory が db.prepare(...).bind(...).all() を叩くので最小スタブを返す。
const fakeDb = {
  prepare: () => ({
    bind: () => ({ all: async () => ({ results: [] }) }),
  }),
} as unknown as D1Database;
const basePayload: EventPayload = { friendId: 'friend-1', eventData: { text: 'こんにちは' } };

describe('maybeAiReply — handover guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getFriendById.mockResolvedValue({ line_user_id: 'U_test', metadata: null });
    generateReply.mockResolvedValue('AIの返信です');
  });

  it('does NOT reply while friend is in human handover', async () => {
    getFriendById.mockResolvedValue({
      line_user_id: 'U_test',
      metadata: JSON.stringify({ handover: 'human' }),
    });
    await maybeAiReply(fakeDb, basePayload, 'token', 'acc-1', 'sk-test');
    expect(generateReply).not.toHaveBeenCalled();
    expect(pushMessage).not.toHaveBeenCalled();
  });

  it('replies via AI when handover is ai (default)', async () => {
    await maybeAiReply(fakeDb, basePayload, 'token', 'acc-1', 'sk-test');
    expect(generateReply).toHaveBeenCalledTimes(1);
    expect(pushMessage).toHaveBeenCalledTimes(1);
    expect(pushMessage).toHaveBeenCalledWith('U_test', [{ type: 'text', text: 'AIの返信です' }]);
  });

  it('does nothing when anthropicApiKey is missing', async () => {
    await maybeAiReply(fakeDb, basePayload, 'token', 'acc-1', undefined);
    expect(getFriendById).not.toHaveBeenCalled();
    expect(pushMessage).not.toHaveBeenCalled();
  });
});

describe('splitForLine', () => {
  it('keeps short text as single chunk', () => {
    expect(splitForLine('短い返信')).toEqual(['短い返信']);
  });

  it('splits long text on sentence boundaries under the limit', () => {
    const long = 'あ'.repeat(700);
    const chunks = splitForLine(long);
    expect(chunks.length).toBeGreaterThan(1);
    chunks.forEach((c) => expect(c.length).toBeLessThanOrEqual(500));
  });

  it('prefers sentence boundaries when splitting', () => {
    const text = 'これは一文目です。' + 'い'.repeat(495) + '。' + 'これは三文目です。';
    const chunks = splitForLine(text);
    expect(chunks.length).toBeGreaterThan(1);
    // 最初のチャンクは一文目で区切られる（句点で割れている）
    expect(chunks[0].endsWith('。')).toBe(true);
  });
});
