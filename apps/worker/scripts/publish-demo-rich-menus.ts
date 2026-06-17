import { execFile } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const OUT_DIR = 'tmp/demo-rich-menus';
const UPLOAD_IMAGE_EXT = 'jpg';
const UPLOAD_IMAGE_CONTENT_TYPE = 'image/jpeg';
const COLS = 2;
const ROWS = 2;

const COMPANY_ACCOUNT_ID = 'saiyo-pro-company';
const CANDIDATE_ACCOUNT_ID = 'saiyo-pro-candidate';
const LINE_API_BASE = 'https://api.line.me';
const LINE_API_DATA_BASE = 'https://api-data.line.me';
const SAIYO_PRO_WORKER_URL = 'https://saiyo-pro-harness.ikki-y.workers.dev';

type DemoRichMenuSpec = {
  accountId: string;
  fileBase: string;
  name: string;
  chatBarText: string;
  imagePath: string;
  size: {
    width: number;
    height: number;
  };
  tabs: Array<{
    title: string;
    subtitle: string;
    text: string;
    color: string;
    action?: DemoRichMenuAction;
  }>;
};

type DemoRichMenuAction =
  | { type: 'message'; label: string; text: string }
  | { type: 'postback'; label: string; data: string }
  | { type: 'uri'; label: string; uri: string };

type FriendLineUserRow = {
  line_account_id: string | null;
  line_user_id: string | null;
};

export const specs: DemoRichMenuSpec[] = [
  {
    accountId: COMPANY_ACCOUNT_ID,
    fileBase: 'company',
    name: '採用PRO 企業向け 4ボタン',
    chatBarText: '企業メニュー',
    imagePath: 'assets/rich-menus/saiyo-pro/company.png',
    size: { width: 2500, height: 1250 },
    tabs: [
      {
        title: '新着応募者',
        subtitle: '登録者を確認',
        text: '新着応募者',
        color: '#2563EB',
        action: { type: 'message', label: '新着応募者', text: '新着応募者' },
      },
      {
        title: '未対応',
        subtitle: '返信が必要なチャット',
        text: '未対応チャット',
        color: '#16A34A',
        action: { type: 'message', label: '未対応チャット', text: '未対応チャット' },
      },
      {
        title: '求人管理',
        subtitle: '求人を出稿',
        text: '求人管理',
        color: '#7C3AED',
        action: { type: 'message', label: '求人管理', text: '求人管理' },
      },
      {
        title: 'アカウント設定',
        subtitle: '情報と各種設定',
        text: 'アカウント設定',
        color: '#4B5563',
        action: { type: 'message', label: 'アカウント設定', text: 'アカウント設定' },
      },
    ],
  },
  {
    accountId: CANDIDATE_ACCOUNT_ID,
    fileBase: 'candidate',
    name: '採用PRO 求職者向け 4ボタン',
    chatBarText: '応募メニュー',
    imagePath: 'assets/rich-menus/saiyo-pro/candidate.png',
    size: { width: 2500, height: 988 },
    tabs: [
      {
        title: '求人を見る',
        subtitle: 'おすすめ求人',
        text: '求人を見る',
        color: '#2563EB',
        action: { type: 'message', label: '求人を見る', text: '求人案内の確認を始める' },
      },
      {
        title: 'チャット',
        subtitle: '応募先と連絡',
        text: 'チャット',
        color: '#16A34A',
        action: { type: 'message', label: 'チャット', text: 'チャット' },
      },
      {
        title: 'プロフィール',
        subtitle: '情報を編集',
        text: 'プロフィール',
        color: '#7C3AED',
        action: { type: 'message', label: 'プロフィール', text: 'プロフィール' },
      },
      {
        title: '応募状況',
        subtitle: '進捗を確認',
        text: '応募状況',
        color: '#4B5563',
        action: { type: 'message', label: '応募状況', text: '応募状況' },
      },
    ],
  },
];

async function main() {
  const accounts = await loadLineAccountTokens();
  const userIdsByAccount = await loadFriendUserIdsByAccount();

  await mkdir(OUT_DIR, { recursive: true });

  for (const spec of specs) {
    const token = accounts.get(spec.accountId);
    if (!token) throw new Error(`line_accounts に ${spec.accountId} の channel_access_token がありません`);
    const imagePath = join(OUT_DIR, `${spec.fileBase}.${UPLOAD_IMAGE_EXT}`);
    await renderRichMenuImage(spec, imagePath);

    const created = await lineJson<{ richMenuId: string }>(token, '/v2/bot/richmenu', {
      method: 'POST',
      body: JSON.stringify(buildRichMenuPayload(spec)),
    });

    const image = await readFile(imagePath);
    await lineImage(token, created.richMenuId, image);
    await lineJson<undefined>(token, `/v2/bot/user/all/richmenu/${encodeURIComponent(created.richMenuId)}`, { method: 'POST' });
    for (const userId of userIdsByAccount.get(spec.accountId) ?? []) {
      await unlinkUserRichMenu(token, userId);
    }

    console.log(`${spec.name}: ${created.richMenuId}`);
  }
}

export function buildRichMenuPayload(spec: DemoRichMenuSpec) {
  const cellWidth = spec.size.width / COLS;
  const cellHeight = spec.size.height / ROWS;

  return {
    size: spec.size,
    selected: true,
    name: spec.name,
    chatBarText: spec.chatBarText,
    areas: spec.tabs.map((tab, index) => ({
      bounds: {
        x: (index % COLS) * cellWidth,
        y: Math.floor(index / COLS) * cellHeight,
        width: cellWidth,
        height: cellHeight,
      },
      action: tab.action ?? { type: 'message', label: tab.title, text: tab.text },
    })),
  };
}

async function renderRichMenuImage(spec: DemoRichMenuSpec, outputPath: string): Promise<void> {
  await execFileAsync('magick', [
    spec.imagePath,
    '-resize',
    `${spec.size.width}x${spec.size.height}^`,
    '-gravity',
    'center',
    '-extent',
    `${spec.size.width}x${spec.size.height}`,
    '-strip',
    '-interlace',
    'Plane',
    '-quality',
    '82',
    outputPath,
  ]);
}

async function lineJson<T>(token: string, path: string, init: RequestInit): Promise<T> {
  const res = await fetch(`${LINE_API_BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    throw new Error(`${path} failed: ${res.status} ${await res.text().catch(() => '')}`);
  }
  const contentType = res.headers.get('content-type') ?? '';
  return contentType.includes('application/json') ? await res.json() as T : undefined as T;
}

async function lineImage(token: string, richMenuId: string, image: Buffer): Promise<void> {
  const res = await fetch(`${LINE_API_DATA_BASE}/v2/bot/richmenu/${encodeURIComponent(richMenuId)}/content`, {
    method: 'POST',
    headers: {
      'Content-Type': UPLOAD_IMAGE_CONTENT_TYPE,
      Authorization: `Bearer ${token}`,
    },
    body: image,
  });
  if (!res.ok) {
    throw new Error(`upload image failed: ${res.status} ${await res.text().catch(() => '')}`);
  }
}

async function unlinkUserRichMenu(token: string, userId: string): Promise<void> {
  await lineJson<undefined>(token, `/v2/bot/user/${encodeURIComponent(userId)}/richmenu`, { method: 'DELETE' });
}

async function loadLineAccountTokens(): Promise<Map<string, string>> {
  const ids = specs.map((spec) => spec.accountId);
  const { stdout } = await execFileAsync('wrangler', [
    'd1',
    'execute',
    'saiyo-pro-harness',
    '--remote',
    '--json',
    '--command',
    `SELECT id, channel_access_token FROM line_accounts WHERE id IN (${ids.map((id) => `'${id}'`).join(',')});`,
  ]);
  const parsed = JSON.parse(stdout) as Array<{ results?: Array<{ id: string; channel_access_token: string }> }>;
  const rows = parsed[0]?.results ?? [];
  return new Map(rows.map((row) => [row.id, row.channel_access_token]));
}

async function loadFriendUserIdsByAccount(): Promise<Map<string, string[]>> {
  const ids = specs.map((spec) => spec.accountId);
  const { stdout } = await execFileAsync('wrangler', [
    'd1',
    'execute',
    'saiyo-pro-harness',
    '--remote',
    '--json',
    '--command',
    `SELECT line_account_id, line_user_id FROM friends WHERE is_following = 1 AND line_account_id IN (${ids.map((id) => `'${id}'`).join(',')});`,
  ]);
  const parsed = JSON.parse(stdout) as Array<{ results?: FriendLineUserRow[] }>;
  return groupFriendUserIdsByAccount(parsed[0]?.results ?? []);
}

export function groupFriendUserIdsByAccount(rows: FriendLineUserRow[]): Map<string, string[]> {
  const grouped = new Map<string, string[]>();
  for (const row of rows) {
    if (!row.line_account_id || !row.line_user_id) continue;
    const userIds = grouped.get(row.line_account_id) ?? [];
    userIds.push(row.line_user_id);
    grouped.set(row.line_account_id, userIds);
  }
  return grouped;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
