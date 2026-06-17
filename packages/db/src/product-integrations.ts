import { jstNow } from './utils.js';

export type ProductEventDeliveryStatus = 'pending' | 'delivered' | 'failed' | 'skipped';

export interface ProductIntegration {
  id: string;
  product_code: string;
  name: string;
  line_account_id: string;
  webhook_url: string | null;
  webhook_secret: string | null;
  is_active: number;
  metadata: string;
  created_at: string;
  updated_at: string;
}

export interface ProductEventDelivery {
  id: string;
  product_integration_id: string;
  event_type: string;
  source_table: string | null;
  source_id: string | null;
  delivery_id: string;
  payload: string;
  status: ProductEventDeliveryStatus;
  attempts: number;
  last_error: string | null;
  delivered_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface UpsertProductIntegrationInput {
  productCode: string;
  name: string;
  lineAccountId: string;
  webhookUrl?: string | null;
  webhookSecret?: string | null;
  isActive?: boolean;
  metadata?: string;
}

export interface CreateProductEventDeliveryInput {
  productIntegrationId: string;
  eventType: string;
  sourceTable?: string | null;
  sourceId?: string | null;
  deliveryId: string;
  payload: string;
}

export async function getProductIntegrationById(
  db: D1Database,
  id: string,
): Promise<ProductIntegration | null> {
  return db
    .prepare('SELECT * FROM product_integrations WHERE id = ?')
    .bind(id)
    .first<ProductIntegration>();
}

export async function getProductIntegrationForAccount(
  db: D1Database,
  productCode: string,
  lineAccountId: string,
): Promise<ProductIntegration | null> {
  return db
    .prepare(
      `SELECT * FROM product_integrations
       WHERE product_code = ? AND line_account_id = ?`,
    )
    .bind(productCode, lineAccountId)
    .first<ProductIntegration>();
}

export async function listActiveProductIntegrationsForAccount(
  db: D1Database,
  lineAccountId: string,
): Promise<ProductIntegration[]> {
  const result = await db
    .prepare(
      `SELECT * FROM product_integrations
       WHERE line_account_id = ? AND is_active = 1
       ORDER BY product_code ASC`,
    )
    .bind(lineAccountId)
    .all<ProductIntegration>();
  return result.results ?? [];
}

export async function upsertProductIntegration(
  db: D1Database,
  input: UpsertProductIntegrationInput,
): Promise<ProductIntegration> {
  const existing = await getProductIntegrationForAccount(
    db,
    input.productCode,
    input.lineAccountId,
  );
  const now = jstNow();

  if (existing) {
    await db
      .prepare(
        `UPDATE product_integrations
         SET name = ?,
             webhook_url = ?,
             webhook_secret = ?,
             is_active = ?,
             metadata = ?,
             updated_at = ?
         WHERE id = ?`,
      )
      .bind(
        input.name,
        input.webhookUrl ?? existing.webhook_url,
        input.webhookSecret ?? existing.webhook_secret,
        input.isActive === false ? 0 : 1,
        input.metadata ?? existing.metadata,
        now,
        existing.id,
      )
      .run();
    return (await getProductIntegrationById(db, existing.id))!;
  }

  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO product_integrations (
         id, product_code, name, line_account_id, webhook_url, webhook_secret,
         is_active, metadata, created_at, updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.productCode,
      input.name,
      input.lineAccountId,
      input.webhookUrl ?? null,
      input.webhookSecret ?? null,
      input.isActive === false ? 0 : 1,
      input.metadata ?? '{}',
      now,
      now,
    )
    .run();

  return (await getProductIntegrationById(db, id))!;
}

export async function createProductEventDelivery(
  db: D1Database,
  input: CreateProductEventDeliveryInput,
): Promise<ProductEventDelivery> {
  const existing = await getProductEventDeliveryByDeliveryId(
    db,
    input.productIntegrationId,
    input.deliveryId,
  );
  if (existing) return existing;

  const id = crypto.randomUUID();
  const now = jstNow();
  await db
    .prepare(
      `INSERT INTO product_event_deliveries (
         id, product_integration_id, event_type, source_table, source_id,
         delivery_id, payload, status, attempts, created_at, updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
    )
    .bind(
      id,
      input.productIntegrationId,
      input.eventType,
      input.sourceTable ?? null,
      input.sourceId ?? null,
      input.deliveryId,
      input.payload,
      now,
      now,
    )
    .run();

  return (await getProductEventDeliveryById(db, id))!;
}

export async function getProductEventDeliveryById(
  db: D1Database,
  id: string,
): Promise<ProductEventDelivery | null> {
  return db
    .prepare('SELECT * FROM product_event_deliveries WHERE id = ?')
    .bind(id)
    .first<ProductEventDelivery>();
}

export async function getProductEventDeliveryByDeliveryId(
  db: D1Database,
  productIntegrationId: string,
  deliveryId: string,
): Promise<ProductEventDelivery | null> {
  return db
    .prepare(
      `SELECT * FROM product_event_deliveries
       WHERE product_integration_id = ? AND delivery_id = ?`,
    )
    .bind(productIntegrationId, deliveryId)
    .first<ProductEventDelivery>();
}

export async function markProductEventDeliveryDelivered(
  db: D1Database,
  id: string,
): Promise<ProductEventDelivery | null> {
  const now = jstNow();
  await db
    .prepare(
      `UPDATE product_event_deliveries
       SET status = 'delivered',
           attempts = attempts + 1,
           last_error = NULL,
           delivered_at = ?,
           updated_at = ?
       WHERE id = ?`,
    )
    .bind(now, now, id)
    .run();
  return getProductEventDeliveryById(db, id);
}

export async function markProductEventDeliveryFailed(
  db: D1Database,
  id: string,
  errorMessage: string,
): Promise<ProductEventDelivery | null> {
  const now = jstNow();
  await db
    .prepare(
      `UPDATE product_event_deliveries
       SET status = 'failed',
           attempts = attempts + 1,
           last_error = ?,
           updated_at = ?
       WHERE id = ?`,
    )
    .bind(errorMessage, now, id)
    .run();
  return getProductEventDeliveryById(db, id);
}
