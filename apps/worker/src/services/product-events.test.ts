import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildProductEventHeaders,
  buildProductEventPayload,
  deliverProductEvent,
} from './product-events.js';

const dbMocks = vi.hoisted(() => ({
  createProductEventDelivery: vi.fn(),
  getProductEventDeliveryByDeliveryId: vi.fn(),
  getProductIntegrationForAccount: vi.fn(),
  markProductEventDeliveryDelivered: vi.fn(),
  markProductEventDeliveryFailed: vi.fn(),
}));

vi.mock('@line-crm/db', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@line-crm/db');
  return {
    ...actual,
    createProductEventDelivery: dbMocks.createProductEventDelivery,
    getProductEventDeliveryByDeliveryId: dbMocks.getProductEventDeliveryByDeliveryId,
    getProductIntegrationForAccount: dbMocks.getProductIntegrationForAccount,
    jstNow: () => '2026-06-17T02:00:00.000+09:00',
    markProductEventDeliveryDelivered: dbMocks.markProductEventDeliveryDelivered,
    markProductEventDeliveryFailed: dbMocks.markProductEventDeliveryFailed,
  };
});

describe('product-events', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('builds a stable product event payload for product receivers', () => {
    const payload = buildProductEventPayload({
      productCode: 'saiyou-pro',
      lineAccountId: 'five-rpo',
      eventType: 'candidate_intake_completed',
      deliveryId: 'delivery-001',
      friendId: 'friend-001',
      lineUserId: 'U123',
      productOrgId: 'org-001',
      data: { resumeStatus: 'resume_creation_requested' },
    });

    expect(payload).toEqual({
      id: 'delivery-001',
      type: 'candidate_intake_completed',
      occurredAt: '2026-06-17T02:00:00.000+09:00',
      productCode: 'saiyou-pro',
      lineAccountId: 'five-rpo',
      friendId: 'friend-001',
      lineUserId: 'U123',
      productOrgId: 'org-001',
      productUserId: undefined,
      data: { resumeStatus: 'resume_creation_requested' },
    });
  });

  it('signs the exact JSON body sent to the product app', async () => {
    const body = JSON.stringify({ id: 'delivery-001', ok: true });
    const headers = await buildProductEventHeaders({
      eventType: 'candidate_intake_completed',
      deliveryId: 'delivery-001',
      body,
      secret: 'shared-secret',
    });

    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['X-Line-Harness-Event']).toBe('candidate_intake_completed');
    expect(headers['X-Line-Harness-Delivery']).toBe('delivery-001');
    expect(headers['X-Line-Harness-Signature']).toMatch(/^[0-9a-f]{64}$/);
  });

  it('sends once and marks delivery as delivered', async () => {
    dbMocks.getProductIntegrationForAccount.mockResolvedValue({
      id: 'integration-001',
      product_code: 'saiyou-pro',
      line_account_id: 'five-rpo',
      webhook_url: 'https://api.example.com/line-harness/events',
      webhook_secret: 'shared-secret',
      metadata: '{}',
      is_active: 1,
    });
    dbMocks.getProductEventDeliveryByDeliveryId.mockResolvedValue(null);
    dbMocks.createProductEventDelivery.mockResolvedValue({
      id: 'row-001',
      status: 'pending',
    });
    dbMocks.markProductEventDeliveryDelivered.mockResolvedValue({
      id: 'row-001',
      status: 'delivered',
    });
    const fetchImpl = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));

    const result = await deliverProductEvent(
      {} as D1Database,
      {
        productCode: 'saiyou-pro',
        lineAccountId: 'five-rpo',
        eventType: 'candidate_intake_completed',
        deliveryId: 'delivery-001',
        sourceTable: 'form_submissions',
        sourceId: 'submission-001',
        data: { answer: true },
      },
      fetchImpl,
    );

    expect(result.status).toBe('delivered');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, init] = fetchImpl.mock.calls[0];
    expect(init.headers['X-Line-Harness-Delivery']).toBe('delivery-001');
    expect(dbMocks.markProductEventDeliveryDelivered).toHaveBeenCalledWith(
      {} as D1Database,
      'row-001',
    );
  });

  it('uses product integration metadata as the trusted product org binding', async () => {
    dbMocks.getProductIntegrationForAccount.mockResolvedValue({
      id: 'integration-001',
      webhook_url: 'https://api.example.com/line-harness/events',
      webhook_secret: 'shared-secret',
      metadata: JSON.stringify({
        productOrgId: 'trusted-org',
        productUserId: 'trusted-user',
      }),
      is_active: 1,
    });
    dbMocks.getProductEventDeliveryByDeliveryId.mockResolvedValue(null);
    dbMocks.createProductEventDelivery.mockResolvedValue({
      id: 'row-001',
      status: 'pending',
    });
    dbMocks.markProductEventDeliveryDelivered.mockResolvedValue({
      id: 'row-001',
      status: 'delivered',
    });
    const fetchImpl = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));

    await deliverProductEvent(
      {} as D1Database,
      {
        productCode: 'saiyou-pro',
        lineAccountId: 'five-rpo',
        eventType: 'candidate_intake_completed',
        deliveryId: 'delivery-001',
        productOrgId: 'client-supplied-org',
        requireProductOrgId: true,
      },
      fetchImpl,
    );

    const [, init] = fetchImpl.mock.calls[0];
    const payload = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(payload.productOrgId).toBe('trusted-org');
    expect(payload.productUserId).toBe('trusted-user');
  });

  it('skips delivery when a required product org binding is missing', async () => {
    dbMocks.getProductIntegrationForAccount.mockResolvedValue({
      id: 'integration-001',
      webhook_url: 'https://api.example.com/line-harness/events',
      webhook_secret: 'shared-secret',
      metadata: '{}',
      is_active: 1,
    });
    dbMocks.getProductEventDeliveryByDeliveryId.mockResolvedValue(null);
    const fetchImpl = vi.fn();

    const result = await deliverProductEvent(
      {} as D1Database,
      {
        productCode: 'saiyou-pro',
        lineAccountId: 'five-rpo',
        eventType: 'candidate_intake_completed',
        deliveryId: 'delivery-001',
        requireProductOrgId: true,
      },
      fetchImpl,
    );

    expect(result).toEqual({ status: 'skipped', reason: 'product_org_missing' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(dbMocks.createProductEventDelivery).not.toHaveBeenCalled();
  });

  it('does not resend an already delivered event', async () => {
    dbMocks.getProductIntegrationForAccount.mockResolvedValue({
      id: 'integration-001',
      webhook_url: 'https://api.example.com/line-harness/events',
      webhook_secret: 'shared-secret',
      is_active: 1,
    });
    dbMocks.getProductEventDeliveryByDeliveryId.mockResolvedValue({
      id: 'row-001',
      status: 'delivered',
    });
    const fetchImpl = vi.fn();

    const result = await deliverProductEvent(
      {} as D1Database,
      {
        productCode: 'saiyou-pro',
        lineAccountId: 'five-rpo',
        eventType: 'candidate_intake_completed',
        deliveryId: 'delivery-001',
      },
      fetchImpl,
    );

    expect(result).toMatchObject({
      status: 'skipped',
      reason: 'delivery_already_delivered',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('marks delivery as failed when the product app returns an error', async () => {
    dbMocks.getProductIntegrationForAccount.mockResolvedValue({
      id: 'integration-001',
      webhook_url: 'https://api.example.com/line-harness/events',
      webhook_secret: 'shared-secret',
      is_active: 1,
    });
    dbMocks.getProductEventDeliveryByDeliveryId.mockResolvedValue(null);
    dbMocks.createProductEventDelivery.mockResolvedValue({
      id: 'row-001',
      status: 'pending',
    });
    dbMocks.markProductEventDeliveryFailed.mockResolvedValue({
      id: 'row-001',
      status: 'failed',
      last_error: 'HTTP 500',
    });

    const result = await deliverProductEvent(
      {} as D1Database,
      {
        productCode: 'saiyou-pro',
        lineAccountId: 'five-rpo',
        eventType: 'candidate_intake_completed',
        deliveryId: 'delivery-001',
      },
      vi.fn().mockResolvedValue(new Response('error', { status: 500 })),
    );

    expect(result).toMatchObject({ status: 'failed', error: 'HTTP 500' });
    expect(dbMocks.markProductEventDeliveryFailed).toHaveBeenCalledWith(
      {} as D1Database,
      'row-001',
      'HTTP 500',
    );
  });
});
