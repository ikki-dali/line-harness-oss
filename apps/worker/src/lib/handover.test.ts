import { describe, it, expect, vi } from 'vitest';
import { getHandover, setHandover } from './handover.js';

describe('getHandover', () => {
  it('defaults to ai when metadata is null', () => {
    expect(getHandover({ metadata: null })).toBe('ai');
  });

  it('returns human when metadata.handover is human', () => {
    expect(getHandover({ metadata: JSON.stringify({ handover: 'human' }) })).toBe('human');
  });

  it('returns ai when metadata.handover is anything else', () => {
    expect(getHandover({ metadata: JSON.stringify({ handover: 'ai' }) })).toBe('ai');
    expect(getHandover({ metadata: JSON.stringify({ foo: 'bar' }) })).toBe('ai');
  });

  it('returns ai when metadata is invalid JSON', () => {
    expect(getHandover({ metadata: 'not-json' })).toBe('ai');
  });
});

describe('setHandover', () => {
  it('merges handover into existing metadata and persists', async () => {
    let persisted = '';
    const db = {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            if (sql.startsWith('UPDATE')) persisted = String(args[0]);
            return this;
          },
          async first<T>(): Promise<T> {
            return { metadata: JSON.stringify({ keep: 1 }) } as T;
          },
          async run(): Promise<{ success: true }> {
            return { success: true };
          },
        };
      },
    } as unknown as D1Database;

    await setHandover(db, 'friend-1', 'human');
    expect(JSON.parse(persisted)).toEqual({ keep: 1, handover: 'human' });
  });

  it('still persists handover when existing metadata is corrupt JSON', async () => {
    let persisted = '';
    const db = {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            if (sql.startsWith('UPDATE')) persisted = String(args[0]);
            return this;
          },
          async first<T>(): Promise<T> {
            return { metadata: 'not-json{' } as T;
          },
          async run(): Promise<{ success: true }> {
            return { success: true };
          },
        };
      },
    } as unknown as D1Database;

    // 破損 metadata でも throw せず handover を書き込めること（takeover を落とさない）
    await expect(setHandover(db, 'friend-1', 'human')).resolves.toBeUndefined();
    expect(JSON.parse(persisted)).toEqual({ handover: 'human' });
  });
});
