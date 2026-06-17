import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pc from "picocolors";
import type { DeployConfig } from "../lib/config.js";

export type AttachProductInput = {
  productCode: string;
  productName: string;
  lineAccountId: string;
  webhookUrl: string;
  webhookSecret: string;
  productOrgId?: string;
  productUserId?: string;
  metadata?: Record<string, unknown>;
};

export type AttachProductSummary = {
  productCode: string;
  productName: string;
  lineAccountId: string;
  webhookUrl: string;
  hasWebhookSecret: boolean;
  productOrgId?: string;
  productUserId?: string;
  metadataKeys: string[];
};

type AttachProductOptions = {
  apply: boolean;
  localD1: boolean;
  d1Database: string;
  wranglerConfig: string;
};

export async function runAttachProduct(repoDir: string): Promise<void> {
  const apply = process.argv.includes("--apply");
  const localD1 = process.argv.includes("--local");
  const config = readDeployConfig(repoDir);
  const input = readInputFromEnv();
  validateAttachProductInput(input);

  const options: AttachProductOptions = {
    apply,
    localD1,
    d1Database: process.env.D1_DATABASE ?? config?.d1DatabaseName ?? "line-crm",
    wranglerConfig: process.env.WRANGLER_CONFIG ?? join(repoDir, "wrangler.toml"),
  };

  const summary = buildAttachProductSummary(input);
  const sqlText = buildAttachProductSql(input);

  console.log(JSON.stringify(summary, null, 2));
  if (!options.apply) {
    console.log(pc.yellow("Dry run only. Re-run with --apply to update D1."));
    return;
  }

  applyAttachProductSql(sqlText, options);
}

export function buildAttachProductSql(input: AttachProductInput): string {
  const nowExpr = `strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')`;
  const metadata = {
    source: "create-line-harness attach-product",
    productOrgId: input.productOrgId,
    productUserId: input.productUserId,
    ...(input.metadata ?? {}),
  };

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
    `  ${sql(JSON.stringify(metadata))},`,
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
  ].join("\n");
}

export function buildAttachProductSummary(input: AttachProductInput): AttachProductSummary {
  return {
    productCode: input.productCode,
    productName: input.productName,
    lineAccountId: input.lineAccountId,
    webhookUrl: input.webhookUrl,
    hasWebhookSecret: input.webhookSecret.length > 0,
    ...(input.productOrgId ? { productOrgId: input.productOrgId } : {}),
    ...(input.productUserId ? { productUserId: input.productUserId } : {}),
    metadataKeys: Object.keys(input.metadata ?? {}).sort(),
  };
}

export function validateAttachProductInput(input: AttachProductInput): void {
  const missing = [
    ["PRODUCT_CODE", input.productCode],
    ["PRODUCT_NAME", input.productName],
    ["LINE_HARNESS_ACCOUNT_ID", input.lineAccountId],
    ["PRODUCT_WEBHOOK_URL", input.webhookUrl],
    ["LINE_HARNESS_WEBHOOK_SECRET", input.webhookSecret],
  ].filter(([, value]) => !value);

  if (missing.length > 0) {
    throw new Error(`${missing.map(([name]) => name).join(", ")} is required`);
  }
}

function readInputFromEnv(): AttachProductInput {
  return {
    productCode: requiredEnv("PRODUCT_CODE"),
    productName: requiredEnv("PRODUCT_NAME"),
    lineAccountId: process.env.LINE_HARNESS_ACCOUNT_ID ?? process.env.LINE_ACCOUNT_ID ?? "",
    webhookUrl: requiredEnv("PRODUCT_WEBHOOK_URL"),
    webhookSecret: requiredEnv("LINE_HARNESS_WEBHOOK_SECRET"),
    productOrgId: process.env.PRODUCT_ORG_ID,
    productUserId: process.env.PRODUCT_USER_ID,
    metadata: parseMetadata(process.env.PRODUCT_METADATA_JSON),
  };
}

function parseMetadata(value: string | undefined): Record<string, unknown> | undefined {
  if (!value) return undefined;
  const parsed = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("PRODUCT_METADATA_JSON must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function readDeployConfig(repoDir: string): DeployConfig | null {
  const configPath = join(repoDir, ".line-harness-config.json");
  if (!existsSync(configPath)) return null;
  return JSON.parse(readFileSync(configPath, "utf8")) as DeployConfig;
}

function applyAttachProductSql(sqlText: string, options: AttachProductOptions): void {
  const dir = mkdtempSync(join(tmpdir(), "attach-product-"));
  const sqlPath = join(dir, "attach.sql");
  try {
    writeFileSync(sqlPath, sqlText, { encoding: "utf8", mode: 0o600 });
    execFileSync(
      "wrangler",
      [
        "d1",
        "execute",
        options.d1Database,
        "--config",
        options.wranglerConfig,
        "--file",
        sqlPath,
        options.localD1 ? "--local" : "--remote",
      ],
      { stdio: "inherit" },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function requiredEnv(name: string): string {
  return process.env[name] ?? "";
}

function sql(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
