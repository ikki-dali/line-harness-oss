-- Product integrations: external product apps that receive selected LINE events.
CREATE TABLE IF NOT EXISTS product_integrations (
  id              TEXT PRIMARY KEY,
  product_code    TEXT NOT NULL,
  name            TEXT NOT NULL,
  line_account_id TEXT NOT NULL,
  webhook_url     TEXT,
  webhook_secret  TEXT,
  is_active       INTEGER NOT NULL DEFAULT 1,
  metadata        TEXT NOT NULL DEFAULT '{}',
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  FOREIGN KEY (line_account_id) REFERENCES line_accounts(id) ON DELETE CASCADE,
  UNIQUE (product_code, line_account_id)
);

CREATE INDEX IF NOT EXISTS idx_product_integrations_account_active
  ON product_integrations (line_account_id, is_active);

CREATE INDEX IF NOT EXISTS idx_product_integrations_product_active
  ON product_integrations (product_code, is_active);

-- Delivery ledger for idempotent product event dispatch.
CREATE TABLE IF NOT EXISTS product_event_deliveries (
  id                     TEXT PRIMARY KEY,
  product_integration_id TEXT NOT NULL,
  event_type             TEXT NOT NULL,
  source_table           TEXT,
  source_id              TEXT,
  delivery_id            TEXT NOT NULL,
  payload                TEXT NOT NULL,
  status                 TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','delivered','failed','skipped')),
  attempts               INTEGER NOT NULL DEFAULT 0,
  last_error             TEXT,
  delivered_at           TEXT,
  created_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  FOREIGN KEY (product_integration_id) REFERENCES product_integrations(id) ON DELETE CASCADE,
  UNIQUE (product_integration_id, delivery_id)
);

CREATE INDEX IF NOT EXISTS idx_product_event_deliveries_integration_status
  ON product_event_deliveries (product_integration_id, status, created_at);

CREATE INDEX IF NOT EXISTS idx_product_event_deliveries_source
  ON product_event_deliveries (source_table, source_id);
