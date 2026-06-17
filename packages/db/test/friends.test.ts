import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { getFriendByLineUserId, upsertFriend } from '../src/friends.js';

type SqliteDb = Database.Database;

function createD1Database(): D1Database {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE friends (
      id TEXT PRIMARY KEY,
      line_user_id TEXT NOT NULL,
      line_account_id TEXT,
      display_name TEXT,
      picture_url TEXT,
      status_message TEXT,
      is_following INTEGER NOT NULL DEFAULT 1,
      user_id TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      first_tracked_link_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX idx_friends_line_user_account
      ON friends (line_user_id, line_account_id)
      WHERE line_account_id IS NOT NULL;
    CREATE UNIQUE INDEX idx_friends_line_user_null_account
      ON friends (line_user_id)
      WHERE line_account_id IS NULL;
  `);

  return {
    prepare(sql: string) {
      const statement = sqlite.prepare(sql);
      const bindValues: unknown[] = [];
      const bound = {
        bind(...values: unknown[]) {
          bindValues.splice(0, bindValues.length, ...values);
          return bound;
        },
        async first<T>() {
          return (statement.get(...bindValues) as T | undefined) ?? null;
        },
        async all<T>() {
          return { results: statement.all(...bindValues) as T[] };
        },
        async run() {
          const info = statement.run(...bindValues);
          return { meta: { changes: info.changes } };
        },
      };
      return bound;
    },
  } as unknown as D1Database;
}

describe('friends', () => {
  it('updates only the scoped friend when the same LINE user exists across accounts', async () => {
    const db = createD1Database();

    const fiveFriend = await upsertFriend(db, {
      lineUserId: 'U_same_user',
      lineAccountId: 'five-rpo',
      displayName: 'FIVE candidate',
    });
    const saiyoFriend = await upsertFriend(db, {
      lineUserId: 'U_same_user',
      lineAccountId: 'saiyou-pro',
      displayName: 'Saiyou candidate',
    });

    const updatedFiveFriend = await upsertFriend(db, {
      lineUserId: 'U_same_user',
      lineAccountId: 'five-rpo',
      displayName: 'FIVE updated',
    });

    expect(updatedFiveFriend.id).toBe(fiveFriend.id);
    expect(updatedFiveFriend.display_name).toBe('FIVE updated');

    const untouchedSaiyoFriend = await getFriendByLineUserId(db, 'U_same_user', 'saiyou-pro');
    expect(untouchedSaiyoFriend?.id).toBe(saiyoFriend.id);
    expect(untouchedSaiyoFriend?.display_name).toBe('Saiyou candidate');
  });
});
