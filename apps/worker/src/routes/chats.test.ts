import { describe, it, expect, vi, beforeEach } from 'vitest';

// chats.ts が import する @line-crm/db の named export を全て stub する
// （vi.mock の factory はモジュール全体を置換するため）。
const dbMocks = {
  getOperators: vi.fn(),
  getOperatorById: vi.fn(),
  createOperator: vi.fn(),
  updateOperator: vi.fn(),
  deleteOperator: vi.fn(),
  getChats: vi.fn(),
  getChatById: vi.fn(),
  createChat: vi.fn(),
  getFriendById: vi.fn(),
  getLineAccountById: vi.fn(),
  updateChat: vi.fn().mockResolvedValue(undefined),
  jstNow: () => '2026-06-02T00:00:00.000+09:00',
};
vi.mock('@line-crm/db', () => dbMocks);

const pushTextMessage = vi.fn().mockResolvedValue(undefined);
vi.mock('@line-crm/line-sdk', () => ({
  LineClient: vi.fn().mockImplementation(() => ({ pushTextMessage })),
}));

const setHandover = vi.fn().mockResolvedValue(undefined);
vi.mock('../lib/handover.js', () => ({
  setHandover: (...args: unknown[]) => setHandover(...args),
}));

const { chats } = await import('./chats.js');

function fakeEnvDb() {
  // send route の messages_log INSERT のみ叩く。run() を満たせば十分。
  return {
    prepare: () => ({ bind: () => ({ run: async () => ({ success: true }) }) }),
  } as unknown as D1Database;
}

describe('POST /api/chats/:id/send — takeover', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMocks.getChatById.mockResolvedValue({ id: 'chat-1', friend_id: 'friend-1', status: 'open' });
    dbMocks.getFriendById.mockResolvedValue({
      id: 'friend-1',
      line_user_id: 'U_test',
      line_account_id: null,
    });
  });

  it('sets handover=human after operator manual reply', async () => {
    const res = await chats.request(
      '/api/chats/chat-1/send',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messageType: 'text', content: '担当より失礼します' }),
      },
      { DB: fakeEnvDb(), LINE_CHANNEL_ACCESS_TOKEN: 'default-token' },
    );

    expect(res.status).toBe(200);
    expect(pushTextMessage).toHaveBeenCalledWith('U_test', '担当より失礼します');
    expect(setHandover).toHaveBeenCalledWith(expect.anything(), 'friend-1', 'human');
  });
});

describe('POST /api/chats/:id/resume-ai', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMocks.getChatById.mockResolvedValue({ id: 'chat-1', friend_id: 'friend-1', status: 'open' });
  });

  it('sets handover=ai', async () => {
    const res = await chats.request(
      '/api/chats/chat-1/resume-ai',
      { method: 'POST' },
      { DB: fakeEnvDb(), LINE_CHANNEL_ACCESS_TOKEN: 'default-token' },
    );

    expect(res.status).toBe(200);
    expect(setHandover).toHaveBeenCalledWith(expect.anything(), 'friend-1', 'ai');
  });
});
