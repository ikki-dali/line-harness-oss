import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type FiveRpoSetupInput = {
  accountId: string;
  accountName: string;
  channelId: string;
  channelAccessToken: string;
  channelSecret: string;
  liffId?: string;
  refCode: string;
  workerUrl: string;
  trafficPoolSlug?: string;
};

type SetupSummary = {
  accountId: string;
  accountName: string;
  refCode: string;
  saiyouProGuideUrl: string;
  hasChannelId: boolean;
  hasChannelAccessToken: boolean;
  hasChannelSecret: boolean;
  hasLiffId: boolean;
};

const DEFAULT_ACCOUNT_ID = 'five-rpo';
const DEFAULT_ACCOUNT_NAME = 'FIVE公式LINE';
const DEFAULT_REF_CODE = 'five-rpo-rejection';
const DEFAULT_TRAFFIC_POOL_ID = 'pool-five-rpo';
const DEFAULT_TRAFFIC_POOL_SLUG = 'five-rpo';
const DEFAULT_TRAFFIC_POOL_NAME = 'FIVE公式LINE';
const DEFAULT_WORKER_URL = 'https://saiyo-pro-harness.ikki-y.workers.dev';
const DEFAULT_D1_DATABASE = 'saiyo-pro-harness';
const DEFAULT_WRANGLER_CONFIG = 'wrangler.saiyo-pro.toml';

export function buildSaiyouProGuideUrl(workerUrl: string, refCode: string): string {
  return `${workerUrl.replace(/\/+$/, '')}/r/${encodeURIComponent(refCode)}`;
}

export function buildFiveRpoSetupSql(input: FiveRpoSetupInput): string {
  const nowExpr = `strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')`;
  const saiyouProGuideUrl = buildSaiyouProGuideUrl(input.workerUrl, input.refCode);
  const trafficPoolSlug = input.trafficPoolSlug ?? DEFAULT_TRAFFIC_POOL_SLUG;
  const trafficPoolId =
    trafficPoolSlug === DEFAULT_TRAFFIC_POOL_SLUG
      ? DEFAULT_TRAFFIC_POOL_ID
      : `pool-${trafficPoolSlug.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase()}`;

  return [
    `INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret, is_active, created_at, updated_at)`,
    `VALUES (${sql(input.accountId)}, ${sql(input.channelId)}, ${sql(input.accountName)}, ${sql(input.channelAccessToken)}, ${sql(input.channelSecret)}, 1, ${nowExpr}, ${nowExpr})`,
    `ON CONFLICT(id) DO UPDATE SET`,
    `  channel_id = excluded.channel_id,`,
    `  name = excluded.name,`,
    `  channel_access_token = excluded.channel_access_token,`,
    `  channel_secret = excluded.channel_secret,`,
    `  is_active = 1,`,
    `  updated_at = ${nowExpr};`,
    '',
    input.liffId
      ? `UPDATE line_accounts SET liff_id = ${sql(input.liffId)}, updated_at = ${nowExpr} WHERE id = ${sql(input.accountId)};`
      : `UPDATE line_accounts SET updated_at = ${nowExpr} WHERE id = ${sql(input.accountId)};`,
    '',
    `INSERT INTO traffic_pools (id, slug, name, active_account_id, is_active, created_at, updated_at)`,
    `VALUES (${sql(trafficPoolId)}, ${sql(trafficPoolSlug)}, ${sql(DEFAULT_TRAFFIC_POOL_NAME)}, ${sql(input.accountId)}, 1, ${nowExpr}, ${nowExpr})`,
    `ON CONFLICT(slug) DO UPDATE SET`,
    `  name = excluded.name,`,
    `  active_account_id = excluded.active_account_id,`,
    `  is_active = 1,`,
    `  updated_at = ${nowExpr};`,
    '',
    `INSERT INTO pool_accounts (id, pool_id, line_account_id, is_active, created_at)`,
    `VALUES (${sql(`poolacct-${input.accountId}`)}, (SELECT id FROM traffic_pools WHERE slug = ${sql(trafficPoolSlug)} LIMIT 1), ${sql(input.accountId)}, 1, ${nowExpr})`,
    `ON CONFLICT(pool_id, line_account_id) DO UPDATE SET is_active = 1;`,
    '',
    `INSERT INTO tags (id, name, color, created_at)`,
    `VALUES ('tag-five-rpo-rejected', 'FIVE 選考情報確認', '#F59E0B', ${nowExpr})`,
    `ON CONFLICT(id) DO UPDATE SET name = excluded.name, color = excluded.color;`,
    '',
    `INSERT INTO entry_routes (id, ref_code, name, tag_id, scenario_id, redirect_url, pool_id, intro_template_id, run_account_friend_add_scenarios, is_active, created_at, updated_at)`,
    `VALUES ('route-five-rpo-rejection', ${sql(input.refCode)}, 'FIVE 選考情報確認', 'tag-five-rpo-rejected', NULL, NULL, (SELECT id FROM traffic_pools WHERE slug = ${sql(trafficPoolSlug)} AND is_active = 1 LIMIT 1), NULL, 1, 1, ${nowExpr}, ${nowExpr})`,
    `ON CONFLICT(ref_code) DO UPDATE SET`,
    `  name = excluded.name,`,
    `  tag_id = excluded.tag_id,`,
    `  pool_id = excluded.pool_id,`,
    `  is_active = 1,`,
    `  updated_at = ${nowExpr};`,
    '',
    `INSERT INTO templates (id, name, category, message_type, message_content, created_at, updated_at)`,
    `VALUES`,
    `  ('tpl-five-rpo-status-help', 'FIVE 選考状況確認', 'five-rpo', 'text', ${sql('現在、選考状況を確認しています。結果のご案内まで少々お待ちください。')}, ${nowExpr}, ${nowExpr}),`,
    `  ('tpl-five-rpo-rejection-guide', 'FIVE 選考情報確認', 'five-rpo', 'text', ${sql(`選考情報の確認が必要です。\n下記から職務経歴書の状況と必要事項の入力をお願いします。\n${saiyouProGuideUrl}`)}, ${nowExpr}, ${nowExpr}),`,
    `  ('tpl-five-rpo-pass', 'FIVE 書類選考通過', 'five-rpo', 'text', ${sql('書類選考を通過しました。次の選考について、担当者より順次ご案内します。')}, ${nowExpr}, ${nowExpr})`,
    `ON CONFLICT(id) DO UPDATE SET`,
    `  name = excluded.name,`,
    `  category = excluded.category,`,
    `  message_type = excluded.message_type,`,
    `  message_content = excluded.message_content,`,
    `  updated_at = ${nowExpr};`,
    '',
    `INSERT INTO auto_replies (id, keyword, match_type, response_type, response_content, template_id, line_account_id, is_active, created_at)`,
    `VALUES`,
    `  ('ar-five-rpo-status', '選考状況', 'contains', 'text', '', 'tpl-five-rpo-status-help', ${sql(input.accountId)}, 1, ${nowExpr}),`,
    `  ('ar-five-rpo-help', '問い合わせ', 'contains', 'text', ${sql('お問い合わせありがとうございます。担当者が確認して順次ご連絡します。')}, NULL, ${sql(input.accountId)}, 1, ${nowExpr}),`,
    `  ('ar-five-rpo-saiyou-pro', '他の求人', 'contains', 'text', '', 'tpl-five-rpo-rejection-guide', ${sql(input.accountId)}, 1, ${nowExpr})`,
    `ON CONFLICT(id) DO UPDATE SET`,
    `  keyword = excluded.keyword,`,
    `  match_type = excluded.match_type,`,
    `  response_type = excluded.response_type,`,
    `  response_content = excluded.response_content,`,
    `  template_id = excluded.template_id,`,
    `  line_account_id = excluded.line_account_id,`,
    `  is_active = 1;`,
    '',
  ].join('\n');
}

export function buildSetupSummary(input: FiveRpoSetupInput): SetupSummary {
  return {
    accountId: input.accountId,
    accountName: input.accountName,
    refCode: input.refCode,
    saiyouProGuideUrl: buildSaiyouProGuideUrl(input.workerUrl, input.refCode),
    hasChannelId: input.channelId.length > 0,
    hasChannelAccessToken: input.channelAccessToken.length > 0,
    hasChannelSecret: input.channelSecret.length > 0,
    hasLiffId: Boolean(input.liffId),
  };
}

function readInputFromEnv(): FiveRpoSetupInput {
  return {
    accountId: process.env.FIVE_LINE_ACCOUNT_ID ?? DEFAULT_ACCOUNT_ID,
    accountName: process.env.FIVE_LINE_ACCOUNT_NAME ?? DEFAULT_ACCOUNT_NAME,
    channelId: requiredEnv('FIVE_LINE_CHANNEL_ID'),
    channelAccessToken: requiredEnv('FIVE_LINE_CHANNEL_ACCESS_TOKEN'),
    channelSecret: requiredEnv('FIVE_LINE_CHANNEL_SECRET'),
    liffId: process.env.FIVE_LINE_LIFF_ID,
    refCode: process.env.FIVE_SAIYOU_PRO_REF_CODE ?? DEFAULT_REF_CODE,
    workerUrl: process.env.SAIYO_PRO_WORKER_URL ?? DEFAULT_WORKER_URL,
    trafficPoolSlug: process.env.FIVE_SAIYOU_PRO_TRAFFIC_POOL ?? DEFAULT_TRAFFIC_POOL_SLUG,
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
  const summary = buildSetupSummary(input);
  const sqlText = buildFiveRpoSetupSql(input);

  console.log(JSON.stringify(summary, null, 2));

  if (!apply) {
    console.log('Dry run only. Re-run with --apply to update D1.');
    return;
  }

  const dir = mkdtempSync(join(tmpdir(), 'five-rpo-'));
  const sqlPath = join(dir, 'setup.sql');
  try {
    writeFileSync(sqlPath, sqlText, { encoding: 'utf8', mode: 0o600 });
    execFileSync(
      'wrangler',
      [
        'd1',
        'execute',
        process.env.FIVE_RPO_D1_DATABASE ?? DEFAULT_D1_DATABASE,
        '--remote',
        '--config',
        process.env.FIVE_RPO_WRANGLER_CONFIG ?? DEFAULT_WRANGLER_CONFIG,
        '--file',
        sqlPath,
      ],
      { stdio: 'inherit' },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
