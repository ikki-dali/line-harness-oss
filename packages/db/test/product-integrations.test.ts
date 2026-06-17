import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  createProductEventDelivery,
  getProductEventDeliveryByDeliveryId,
  listActiveProductIntegrationsForAccount,
  markProductEventDeliveryDelivered,
  markProductEventDeliveryFailed,
  upsertProductIntegration,
} from '../src/product-integrations.js';

function createD1Database(): D1Database {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE product_integrations (
      id TEXT PRIMARY KEY,
      product_code TEXT NOT NULL,
      name TEXT NOT NULL,
      line_account_id TEXT NOT NULL,
      webhook_url TEXT,
      webhook_secret TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (product_code, line_account_id)
    );
    CREATE TABLE product_event_deliveries (
      id TEXT PRIMARY KEY,
      product_integration_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      source_table TEXT,
      source_id TEXT,
      delivery_id TEXT NOT NULL,
      payload TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      delivered_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (product_integration_id, delivery_id)
    );
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

describe('product integrations', () => {
  it('upserts one product integration per product and LINE account', async () => {
    const db = createD1Database();

    const created = await upsertProductIntegration(db, {
      productCode: 'saiyou-pro',
      name: '採用プロ',
      lineAccountId: 'five-rpo',
      webhookUrl: 'https://api.example.com/line/events',
      webhookSecret: 'secret-v1',
    });

    const updated = await upsertProductIntegration(db, {
      productCode: 'saiyou-pro',
      name: '採用プロ Candidate Intake',
      lineAccountId: 'five-rpo',
      webhookUrl: 'https://api.example.com/line/events/v2',
      webhookSecret: 'secret-v2',
    });

    expect(updated.id).toBe(created.id);
    expect(updated.name).toBe('採用プロ Candidate Intake');
    expect(updated.webhook_url).toBe('https://api.example.com/line/events/v2');

    const active = await listActiveProductIntegrationsForAccount(db, 'five-rpo');
    expect(active).toHaveLength(1);
    expect(active[0]?.product_code).toBe('saiyou-pro');
  });

  it('deduplicates event deliveries by integration and delivery id', async () => {
    const db = createD1Database();
    const integration = await upsertProductIntegration(db, {
      productCode: 'saiyou-pro',
      name: '採用プロ',
      lineAccountId: 'five-rpo',
    });

    const created = await createProductEventDelivery(db, {
      productIntegrationId: integration.id,
      eventType: 'candidate.form_submitted',
      sourceTable: 'form_submissions',
      sourceId: 'submission-001',
      deliveryId: 'delivery-001',
      payload: '{"ok":true}',
    });
    const duplicate = await createProductEventDelivery(db, {
      productIntegrationId: integration.id,
      eventType: 'candidate.form_submitted',
      deliveryId: 'delivery-001',
      payload: '{"ok":false}',
    });

    expect(duplicate.id).toBe(created.id);
    expect(duplicate.payload).toBe('{"ok":true}');

    const delivered = await markProductEventDeliveryDelivered(db, created.id);
    expect(delivered?.status).toBe('delivered');
    expect(delivered?.attempts).toBe(1);
    expect(delivered?.delivered_at).toBeTruthy();

    const failed = await markProductEventDeliveryFailed(db, created.id, '500');
    expect(failed?.status).toBe('failed');
    expect(failed?.attempts).toBe(2);
    expect(failed?.last_error).toBe('500');

    const found = await getProductEventDeliveryByDeliveryId(
      db,
      integration.id,
      'delivery-001',
    );
    expect(found?.id).toBe(created.id);
  });
});
