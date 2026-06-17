import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { forms } from './forms.js';
import type { Env } from '../index.js';

const dbMocks = vi.hoisted(() => ({
  addTagToFriend: vi.fn(),
  createForm: vi.fn(),
  createFormSubmission: vi.fn(),
  deleteForm: vi.fn(),
  enrollFriendInScenario: vi.fn(),
  getFormById: vi.fn(),
  getFormSubmissions: vi.fn(),
  getForms: vi.fn(),
  getFormsWithStats: vi.fn(),
  getFriendById: vi.fn(),
  getFriendByLineUserId: vi.fn(),
  getLineAccountById: vi.fn(),
  getMessageTemplateById: vi.fn(),
  getTrackedLinkById: vi.fn(),
  jstNow: vi.fn(),
  updateForm: vi.fn(),
}));

const deliverProductEventMock = vi.hoisted(() => vi.fn());
const pushMessageMock = vi.hoisted(() => vi.fn());

vi.mock('@line-crm/db', () => ({
  addTagToFriend: dbMocks.addTagToFriend,
  createForm: dbMocks.createForm,
  createFormSubmission: dbMocks.createFormSubmission,
  deleteForm: dbMocks.deleteForm,
  enrollFriendInScenario: dbMocks.enrollFriendInScenario,
  getFormById: dbMocks.getFormById,
  getFormSubmissions: dbMocks.getFormSubmissions,
  getForms: dbMocks.getForms,
  getFormsWithStats: dbMocks.getFormsWithStats,
  getFriendById: dbMocks.getFriendById,
  getFriendByLineUserId: dbMocks.getFriendByLineUserId,
  getLineAccountById: dbMocks.getLineAccountById,
  getMessageTemplateById: dbMocks.getMessageTemplateById,
  getTrackedLinkById: dbMocks.getTrackedLinkById,
  jstNow: dbMocks.jstNow,
  updateForm: dbMocks.updateForm,
}));

vi.mock('../services/product-events.js', () => ({
  deliverProductEvent: deliverProductEventMock,
}));

vi.mock('../services/reward-resolver.js', () => ({
  resolveRewardTemplate: vi.fn().mockResolvedValue(null),
}));

vi.mock('@line-crm/line-sdk', () => ({
  LineClient: vi.fn().mockImplementation(() => ({
    pushMessage: pushMessageMock,
  })),
}));

vi.mock('../services/step-delivery.js', () => ({
  buildMessage: vi.fn((type: string, content: string) => ({ type, contents: content })),
  expandVariables: vi.fn((content: string) => content),
  messageToLogPayload: vi.fn((message: { type: string; contents?: string }) => ({
    messageType: message.type,
    content: message.contents ?? '',
  })),
  resolveMetadata: vi.fn().mockResolvedValue({}),
}));

function createApp() {
  const app = new Hono<Env>();
  app.route('/', forms);
  const db = {
    prepare: vi.fn(() => ({
      bind: vi.fn(() => ({
        run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
      })),
    })),
  } as unknown as D1Database;
  return {
    request: (path: string, init?: RequestInit) =>
      app.request(path, init, {
        DB: db,
        LINE_CHANNEL_ACCESS_TOKEN: 'line-token',
      } as Env['Bindings']),
  };
}

describe('forms route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMocks.jstNow.mockReturnValue('2026-06-17T03:30:00.000+09:00');
    dbMocks.getLineAccountById.mockResolvedValue({
      id: 'five-rpo',
      channel_access_token: 'line-token',
    });
    pushMessageMock.mockResolvedValue(undefined);
  });

  it('emits a trusted Saiyou Pro product event when candidate intake is submitted', async () => {
    dbMocks.getFormById.mockResolvedValueOnce({
      id: 'form-saiyo-pro-candidate-intake',
      name: '採用プロ候補者入力',
      description: null,
      fields: JSON.stringify([
        { name: 'current_position', label: '現在の状況', type: 'text', required: true },
        { name: 'desired_job', label: '希望職種', type: 'text', required: true },
      ]),
      on_submit_tag_id: null,
      on_submit_scenario_id: null,
      on_submit_message_type: null,
      on_submit_message_content: null,
      on_submit_webhook_url: null,
      on_submit_webhook_headers: null,
      on_submit_webhook_fail_message: null,
      save_to_metadata: 0,
      is_active: 1,
      submit_count: 0,
      created_at: '2026-06-17T03:00:00.000+09:00',
      updated_at: '2026-06-17T03:00:00.000+09:00',
    });
    dbMocks.createFormSubmission.mockResolvedValueOnce({
      id: 'submission-001',
      form_id: 'form-saiyo-pro-candidate-intake',
      friend_id: 'friend-001',
      data: JSON.stringify({
        resume_status: 'まだ持っていない',
        current_position: '営業',
        desired_job: '採用コンサル',
      }),
      created_at: '2026-06-17T03:30:00.000+09:00',
    });
    dbMocks.getFriendById.mockResolvedValue({
      id: 'friend-001',
      line_user_id: 'U_candidate',
      line_account_id: 'five-rpo',
      display_name: '候補者',
      metadata: null,
      user_id: null,
      ref_code: null,
    });
    deliverProductEventMock.mockResolvedValueOnce({ status: 'delivered', delivery: { id: 'delivery-row' } });

    const res = await createApp().request('/api/forms/form-saiyo-pro-candidate-intake/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        friendId: 'friend-001',
        data: {
          resume_status: 'まだ持っていない',
          current_position: '営業',
          desired_job: '採用コンサル',
          product_org_id: 'client-supplied-org',
          org_id: 'client-supplied-org',
        },
      }),
    });

    expect(res.status).toBe(201);
    expect(deliverProductEventMock).toHaveBeenCalledWith(expect.anything(), {
      productCode: 'saiyou-pro',
      lineAccountId: 'five-rpo',
      eventType: 'candidate_intake_completed',
      deliveryId: 'form-submission:submission-001',
      sourceTable: 'form_submissions',
      sourceId: 'submission-001',
      friendId: 'friend-001',
      lineUserId: 'U_candidate',
      requireProductOrgId: true,
      data: {
        formId: 'form-saiyo-pro-candidate-intake',
        submissionId: 'submission-001',
        resumeStatus: 'resume_creation_requested',
        answers: {
          resume_status: 'まだ持っていない',
          current_position: '営業',
          desired_job: '採用コンサル',
          product_org_id: 'client-supplied-org',
          org_id: 'client-supplied-org',
        },
      },
    });
    expect(deliverProductEventMock.mock.calls[0][1]).not.toHaveProperty('productOrgId');
    expect(deliverProductEventMock.mock.calls[0][1]).not.toHaveProperty('productUserId');
  });
});
