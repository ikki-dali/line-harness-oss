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
  jstNow: () => '2026-06-02T00:00:00.000+09:00',
}));
vi.mock('./ai-reply.js', () => ({
  generateReply: (...args: unknown[]) => generateReply(...args),
}));

// getRecentHistory は db.prepare(SELECT).bind().all()、logAiReply は
// db.prepare(INSERT).bind().run() を叩く。両方に応え、INSERT を捕捉する。
interface CapturedInsert {
  sql: string;
  binds: unknown[];
}
function makeDb(): { db: D1Database; inserts: CapturedInsert[] } {
  const inserts: CapturedInsert[] = [];
  const db = {
    prepare(sql: string) {
      let bound: unknown[] = [];
      return {
        bind(...args: unknown[]) {
          bound = args;
          return this;
        },
        async all() {
          return { results: [] };
        },
        async run() {
          if (sql.includes('INSERT INTO messages_log')) inserts.push({ sql, binds: bound });
          return { success: true };
        },
      };
    },
  } as unknown as D1Database;
  return { db, inserts };
}
const fakeDb = makeDb().db;
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
    expect(generateReply).toHaveBeenCalledWith('sk-test', expect.any(Array), 'こんにちは', 'acc-1');
    expect(pushMessage).toHaveBeenCalledTimes(1);
    expect(pushMessage).toHaveBeenCalledWith('U_test', [{ type: 'text', text: 'AIの返信です' }]);
  });

  it('logs the AI reply to messages_log as outgoing/source=ai', async () => {
    const { db, inserts } = makeDb();
    await maybeAiReply(db, basePayload, 'token', 'acc-1', 'sk-test');
    expect(inserts).toHaveLength(1);
    const { sql, binds } = inserts[0];
    expect(sql).toContain("'outgoing'");
    expect(sql).toContain("'ai'");
    // bind 順: id, friendId, content, lineAccountId, createdAt
    expect(binds[1]).toBe('friend-1');
    expect(binds[2]).toBe('AIの返信です');
    expect(binds[3]).toBe('acc-1');
  });

  it('does nothing when aiApiKey is missing', async () => {
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
