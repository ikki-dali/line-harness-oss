import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_ACCOUNT_ID = 'five-rpo';
const DEFAULT_PRODUCT_CODE = 'saiyou-pro';
const DEFAULT_PRODUCT_NAME = '採用プロ';
const DEFAULT_WEBHOOK_URL = 'http://localhost:8080/v1/line-harness/events';
const DEFAULT_D1_DATABASE = 'saiyo-pro-harness';
const DEFAULT_WRANGLER_CONFIG = 'wrangler.saiyo-pro.toml';

type AttachSaiyouProInput = {
  productCode: string;
  productName: string;
  lineAccountId: string;
  webhookUrl: string;
  webhookSecret: string;
  productOrgId?: string;
  productUserId?: string;
};

type AttachSaiyouProSummary = {
  productCode: string;
  productName: string;
  lineAccountId: string;
  webhookUrl: string;
  hasWebhookSecret: boolean;
  productOrgId?: string;
  productUserId?: string;
};

export function buildAttachSaiyouProSql(input: AttachSaiyouProInput): string {
  const nowExpr = `strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')`;
  return [
    `INSERT INTO product_integrations (`,
    `  id, product_code, name, line_account_id, webhook_url, webhook_secret,`,
    `  is_active, metadata, created_at, updated_at`,
    `)`,
    `VALUES (`,
    `  ${sql(`prodint-${input.productCode}-${input.lineAccountId}`)},`,
    `  ${sql(input.productCode)},`,
    `  ${sql(input.productName)},`,
    `  ${sql(input.lineAccountId)},`,
    `  ${sql(input.webhookUrl)},`,
    `  ${sql(input.webhookSecret)},`,
    `  1,`,
    `  ${sql(JSON.stringify({
      source: 'attach-saiyou-pro-product',
      productOrgId: input.productOrgId,
      productUserId: input.productUserId,
    }))},`,
    `  ${nowExpr},`,
    `  ${nowExpr}`,
    `)`,
    `ON CONFLICT(product_code, line_account_id) DO UPDATE SET`,
    `  name = excluded.name,`,
    `  webhook_url = excluded.webhook_url,`,
    `  webhook_secret = excluded.webhook_secret,`,
    `  is_active = 1,`,
    `  metadata = excluded.metadata,`,
    `  updated_at = ${nowExpr};`,
  ].join('\n');
}

export function buildAttachSaiyouProSummary(input: AttachSaiyouProInput): AttachSaiyouProSummary {
  return {
    productCode: input.productCode,
    productName: input.productName,
    lineAccountId: input.lineAccountId,
    webhookUrl: input.webhookUrl,
    hasWebhookSecret: input.webhookSecret.length > 0,
    ...(input.productOrgId ? { productOrgId: input.productOrgId } : {}),
    ...(input.productUserId ? { productUserId: input.productUserId } : {}),
  };
}

function readInputFromEnv(): AttachSaiyouProInput {
  return {
    productCode: process.env.SAIYOU_PRO_PRODUCT_CODE ?? DEFAULT_PRODUCT_CODE,
    productName: process.env.SAIYOU_PRO_PRODUCT_NAME ?? DEFAULT_PRODUCT_NAME,
    lineAccountId: process.env.SAIYOU_PRO_LINE_ACCOUNT_ID ?? DEFAULT_ACCOUNT_ID,
    webhookUrl: process.env.SAIYOU_PRO_WEBHOOK_URL ?? DEFAULT_WEBHOOK_URL,
    webhookSecret: requiredEnv('LINE_HARNESS_WEBHOOK_SECRET'),
    productOrgId: process.env.SAIYOU_PRO_ORG_ID,
    productUserId: process.env.SAIYOU_PRO_USER_ID,
  };
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function sql(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function main() {
  const apply = process.argv.includes('--apply');
  const input = readInputFromEnv();
  validateApplyInput(input, apply);
  const summary = buildAttachSaiyouProSummary(input);
  const sqlText = buildAttachSaiyouProSql(input);

  console.log(JSON.stringify(summary, null, 2));
  if (!apply) {
    console.log('Dry run only. Re-run with --apply to update D1.');
    return;
  }

  const dir = mkdtempSync(join(tmpdir(), 'attach-saiyou-pro-'));
  const sqlPath = join(dir, 'attach.sql');
  try {
    writeFileSync(sqlPath, sqlText, { encoding: 'utf8', mode: 0o600 });
    execFileSync(
      'wrangler',
      [
        'd1',
        'execute',
        process.env.D1_DATABASE ?? DEFAULT_D1_DATABASE,
        '--config',
        process.env.WRANGLER_CONFIG ?? DEFAULT_WRANGLER_CONFIG,
        '--file',
        sqlPath,
        ...(process.env.LOCAL_D1 === '1' ? ['--local'] : ['--remote']),
      ],
      { stdio: 'inherit' },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function validateApplyInput(input: AttachSaiyouProInput, apply: boolean) {
  if (!apply) return;
  if (!input.productOrgId) {
    throw new Error('SAIYOU_PRO_ORG_ID is required when applying the Saiyou Pro product integration');
  }
  if (process.env.LOCAL_D1 !== '1' && !process.env.SAIYOU_PRO_WEBHOOK_URL) {
    throw new Error('SAIYOU_PRO_WEBHOOK_URL is required when applying to remote D1');
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
