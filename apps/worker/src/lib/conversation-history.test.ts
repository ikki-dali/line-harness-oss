import { describe, it, expect } from 'vitest';
import { getRecentHistory, type ChatTurn } from './conversation-history.js';

// mock は messages_log の "ORDER BY created_at DESC"（新しい順）を模す
function mockDb(rows: Array<{ direction: string; content: string; created_at: string }>) {
  return {
    prepare: () => ({
      bind: () => ({
        all: async () => ({ results: rows }),
      }),
    }),
  } as unknown as D1Database;
}

describe('getRecentHistory', () => {
  it('maps incoming→user and outgoing→assistant in chronological (ascending) order', async () => {
    // DESC で取得される想定なので新しい順で渡す → 実装が時系列昇順に直す
    const db = mockDb([
      { direction: 'outgoing', content: 'はじめまして', created_at: '2026-06-02T01:00:05Z' },
      { direction: 'incoming', content: 'こんにちは', created_at: '2026-06-02T01:00:00Z' },
    ]);
    const turns: ChatTurn[] = await getRecentHistory(db, 'friend-1', 10);
    expect(turns).toEqual([
      { role: 'user', content: 'こんにちは' },
      { role: 'assistant', content: 'はじめまして' },
    ]);
  });

  it('returns empty array when no history', async () => {
    const turns = await getRecentHistory(mockDb([]), 'friend-1', 10);
    expect(turns).toEqual([]);
  });
});
