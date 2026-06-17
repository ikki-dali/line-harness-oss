import { Hono } from 'hono';
import {
  getFriendById,
  getFriendByLineUserId,
  getLineAccountById,
  jstNow,
} from '@line-crm/db';
import type { Friend } from '@line-crm/db';
import { LineClient } from '@line-crm/line-sdk';
import { requireRole } from '../middleware/role-guard.js';
import { buildMessage, messageToLogPayload } from '../services/step-delivery.js';
import type { Env } from '../index.js';

const DEFAULT_FIVE_ACCOUNT_ID = 'five-rpo';

export type FiveSelectionResult = 'reject' | 'pass' | 'hold';

const RESULT_TEMPLATE_IDS: Record<FiveSelectionResult, string> = {
  reject: 'tpl-five-rpo-rejection-guide',
  pass: 'tpl-five-rpo-pass',
  hold: 'tpl-five-rpo-status-help',
};

function normalizeSelectionResult(value: unknown): FiveSelectionResult | null {
  if (value === 'reject' || value === 'pass' || value === 'hold') return value;
  return null;
}

function sourceForSelectionResult(result: FiveSelectionResult): string {
  return `five_rpo_selection_${result}`;
}

async function findScopedFriend(
  db: D1Database,
  input: { accountId: string; friendId?: string; lineUserId?: string },
): Promise<Friend | null> {
  if (input.friendId) {
    const friend = await getFriendById(db, input.friendId);
    if (!friend || friend.line_account_id !== input.accountId) return null;
    return friend;
  }
  if (input.lineUserId) {
    return getFriendByLineUserId(db, input.lineUserId, input.accountId);
  }
  return null;
}

async function getTemplate(
  db: D1Database,
  templateId: string,
): Promise<{ id: string; message_type: string; message_content: string } | null> {
  return db
    .prepare(`SELECT id, message_type, message_content FROM templates WHERE id = ?`)
    .bind(templateId)
    .first<{ id: string; message_type: string; message_content: string }>();
}

export const fiveRpo = new Hono<Env>();

fiveRpo.post('/api/saiyo-pro/five/selection-result', requireRole('owner', 'admin'), async (c) => {
  try {
    const body = await c.req.json<{
      accountId?: string;
      friendId?: string;
      lineUserId?: string;
      result?: unknown;
      messageType?: 'text' | 'flex';
      messageContent?: string;
      dryRun?: boolean;
    }>();

    const accountId = body.accountId?.trim() || DEFAULT_FIVE_ACCOUNT_ID;
    const result = normalizeSelectionResult(body.result);
    if (!result) {
      return c.json({ success: false, error: 'result must be reject, pass, or hold' }, 400);
    }
    if (!body.friendId && !body.lineUserId) {
      return c.json({ success: false, error: 'friendId or lineUserId is required' }, 400);
    }

    const account = await getLineAccountById(c.env.DB, accountId);
    if (!account) {
      return c.json({ success: false, error: `LINE account not found: ${accountId}` }, 404);
    }

    const friend = await findScopedFriend(c.env.DB, {
      accountId,
      friendId: body.friendId,
      lineUserId: body.lineUserId,
    });
    if (!friend) {
      return c.json({ success: false, error: 'Friend not found in the requested LINE account' }, 404);
    }
    if (!friend.is_following) {
      return c.json({ success: false, error: 'Friend is not following this LINE account' }, 409);
    }

    let messageType = body.messageType;
    let messageContent = body.messageContent;
    let templateIdAtSend: string | null = null;

    if (!messageType || !messageContent) {
      const templateId = RESULT_TEMPLATE_IDS[result];
      const template = await getTemplate(c.env.DB, templateId);
      if (!template) {
        return c.json({
          success: false,
          error: `Message template not found: ${templateId}. Run setup:five-rpo first.`,
        }, 409);
      }
      messageType = template.message_type as 'text' | 'flex';
      messageContent = template.message_content;
      templateIdAtSend = template.id;
    }

    if (messageType !== 'text' && messageType !== 'flex') {
      return c.json({ success: false, error: 'messageType must be text or flex' }, 400);
    }
    if (!messageContent) {
      return c.json({ success: false, error: 'messageContent is required' }, 400);
    }

    const message = buildMessage(messageType, messageContent);
    const logPayload = messageToLogPayload(message);
    const source = sourceForSelectionResult(result);

    if (!body.dryRun) {
      const client = new LineClient(account.channel_access_token);
      await client.pushMessage(friend.line_user_id, [message]);

      await c.env.DB
        .prepare(
          `INSERT INTO messages_log
             (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id,
              template_id_at_send, delivery_type, source, line_account_id, created_at)
           VALUES (?, ?, 'outgoing', ?, ?, NULL, NULL, ?, 'push', ?, ?, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          friend.id,
          logPayload.messageType,
          logPayload.content,
          templateIdAtSend,
          source,
          accountId,
          jstNow(),
        )
        .run();
    }

    return c.json({
      success: true,
      data: {
        accountId,
        friendId: friend.id,
        result,
        source,
        templateIdAtSend,
        dryRun: Boolean(body.dryRun),
      },
    });
  } catch (err) {
    console.error('POST /api/saiyo-pro/five/selection-result error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});
