import {
  createProductEventDelivery,
  getProductEventDeliveryByDeliveryId,
  getProductIntegrationForAccount,
  jstNow,
  markProductEventDeliveryDelivered,
  markProductEventDeliveryFailed,
  type ProductEventDelivery,
} from '@line-crm/db';
import { hmacSha256Hex } from '../lib/hmac.js';

export interface ProductEventPayload {
  id: string;
  type: string;
  occurredAt: string;
  productCode: string;
  lineAccountId: string;
  friendId?: string;
  lineUserId?: string;
  productOrgId?: string;
  productUserId?: string;
  data: Record<string, unknown>;
}

export interface DeliverProductEventInput {
  productCode: string;
  lineAccountId: string;
  eventType: string;
  deliveryId: string;
  sourceTable?: string | null;
  sourceId?: string | null;
  friendId?: string;
  lineUserId?: string;
  productOrgId?: string;
  productUserId?: string;
  requireProductOrgId?: boolean;
  data?: Record<string, unknown>;
}

export type DeliverProductEventResult =
  | { status: 'delivered'; delivery: ProductEventDelivery }
  | { status: 'failed'; delivery: ProductEventDelivery | null; error: string }
  | { status: 'skipped'; reason: string; delivery?: ProductEventDelivery };

export interface FetchLike {
  (input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export function buildProductEventPayload(input: DeliverProductEventInput): ProductEventPayload {
  return {
    id: input.deliveryId,
    type: input.eventType,
    occurredAt: jstNow(),
    productCode: input.productCode,
    lineAccountId: input.lineAccountId,
    friendId: input.friendId,
    lineUserId: input.lineUserId,
    productOrgId: input.productOrgId,
    productUserId: input.productUserId,
    data: input.data ?? {},
  };
}

function readMetadataString(metadata: string | null | undefined, key: string): string | undefined {
  if (!metadata) return undefined;
  try {
    const parsed = JSON.parse(metadata) as Record<string, unknown>;
    const value = parsed[key];
    return typeof value === 'string' && value.trim() ? value : undefined;
  } catch {
    return undefined;
  }
}

export async function buildProductEventHeaders(params: {
  eventType: string;
  deliveryId: string;
  body: string;
  secret: string;
}): Promise<Record<string, string>> {
  return {
    'Content-Type': 'application/json',
    'X-Line-Harness-Event': params.eventType,
    'X-Line-Harness-Delivery': params.deliveryId,
    'X-Line-Harness-Signature': await hmacSha256Hex(params.secret, params.body),
  };
}

export async function deliverProductEvent(
  db: D1Database,
  input: DeliverProductEventInput,
  fetchImpl: FetchLike = fetch,
): Promise<DeliverProductEventResult> {
  const integration = await getProductIntegrationForAccount(
    db,
    input.productCode,
    input.lineAccountId,
  );

  if (!integration || integration.is_active !== 1) {
    return { status: 'skipped', reason: 'product_integration_inactive' };
  }
  if (!integration.webhook_url) {
    return { status: 'skipped', reason: 'product_integration_webhook_missing' };
  }
  if (!integration.webhook_secret) {
    return { status: 'skipped', reason: 'product_integration_secret_missing' };
  }

  const existing = await getProductEventDeliveryByDeliveryId(
    db,
    integration.id,
    input.deliveryId,
  );
  if (existing?.status === 'delivered') {
    return { status: 'skipped', reason: 'delivery_already_delivered', delivery: existing };
  }

  const productOrgId = readMetadataString(integration.metadata, 'productOrgId') ?? input.productOrgId;
  if (input.requireProductOrgId && !productOrgId) {
    return { status: 'skipped', reason: 'product_org_missing' };
  }
  const productUserId = readMetadataString(integration.metadata, 'productUserId') ?? input.productUserId;

  const payload = buildProductEventPayload({
    ...input,
    productOrgId,
    productUserId,
  });
  const body = JSON.stringify(payload);
  const delivery = await createProductEventDelivery(db, {
    productIntegrationId: integration.id,
    eventType: input.eventType,
    sourceTable: input.sourceTable ?? null,
    sourceId: input.sourceId ?? null,
    deliveryId: input.deliveryId,
    payload: body,
  });

  try {
    const res = await fetchImpl(integration.webhook_url, {
      method: 'POST',
      headers: await buildProductEventHeaders({
        eventType: input.eventType,
        deliveryId: input.deliveryId,
        body,
        secret: integration.webhook_secret,
      }),
      body,
    });

    if (!res.ok) {
      const error = `HTTP ${res.status}`;
      const failed = await markProductEventDeliveryFailed(db, delivery.id, error);
      return { status: 'failed', delivery: failed, error };
    }

    const delivered = await markProductEventDeliveryDelivered(db, delivery.id);
    return { status: 'delivered', delivery: delivered ?? delivery };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failed = await markProductEventDeliveryFailed(db, delivery.id, message);
    return { status: 'failed', delivery: failed, error: message };
  }
}
