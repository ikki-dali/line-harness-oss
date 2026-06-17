import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { fiveRpo } from './five-rpo.js';
import type { Env } from '../index.js';

function mockDb(): D1Database {
  return {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          return {
            async first() {
              if (sql.includes('FROM line_accounts')) {
                return {
                  id: values[0],
                  channel_access_token: 'line-token',
                };
              }
              if (sql.includes('FROM friends WHERE line_user_id = ? AND line_account_id = ?')) {
                return {
                  id: 'friend-1',
                  line_user_id: values[0],
                  line_account_id: values[1],
                  is_following: 1,
                };
              }
              if (sql.includes('FROM templates')) {
                return {
                  id: values[0],
                  message_type: 'text',
                  message_content: '採用プロ案内',
                };
              }
              if (sql.includes('FROM message_templates')) {
                throw new Error('FIVE selection results must use templates table');
              }
              return null;
            },
            async run() {
              return { meta: { changes: 1 } };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

function createApp() {
  const app = new Hono<Env>();
  app.use('*', async (c, next) => {
    c.set('staff', { id: 'staff-1', name: 'Owner', role: 'owner' });
    return next();
  });
  app.route('/', fiveRpo);
  return app;
}

describe('fiveRpo', () => {
  it('resolves result templates from the shared templates table', async () => {
    const app = createApp();

    const res = await app.request(
      '/api/saiyo-pro/five/selection-result',
      {
        method: 'POST',
        body: JSON.stringify({
          lineUserId: 'U_candidate',
          result: 'reject',
          dryRun: true,
        }),
        headers: { 'content-type': 'application/json' },
      },
      { DB: mockDb() } as Env['Bindings'],
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      success: true,
      data: {
        accountId: 'five-rpo',
        friendId: 'friend-1',
        result: 'reject',
        source: 'five_rpo_selection_reject',
        templateIdAtSend: 'tpl-five-rpo-rejection-guide',
        dryRun: true,
      },
    });
  });
});
