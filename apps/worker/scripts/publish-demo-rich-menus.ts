import { execFile } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const OUT_DIR = 'tmp/demo-rich-menus';
const UPLOAD_IMAGE_EXT = 'jpg';
const UPLOAD_IMAGE_CONTENT_TYPE = 'image/jpeg';
const WIDTH = 2500;
const HEIGHT = 1686;
const COLS = 2;
const ROWS = 2;
const CELL_WIDTH = WIDTH / COLS;
const CELL_HEIGHT = HEIGHT / ROWS;

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

export const specs: DemoRichMenuSpec[] = [
  {
    accountId: COMPANY_ACCOUNT_ID,
    fileBase: 'company',
    name: '採用PRO 企業向け 4ボタン',
    chatBarText: '企業メニュー',
    imagePath: 'assets/rich-menus/saiyo-pro/company.png',
    tabs: [
      {
        title: '新着応募者',
        subtitle: '登録者を確認',
        text: '新着応募者',
        color: '#2563EB',
        action: { type: 'postback', label: '新着応募者', data: 'demo:company-menu:matches' },
      },
      {
        title: '未対応',
        subtitle: '返信が必要なチャット',
        text: '未対応チャット',
        color: '#16A34A',
        action: { type: 'postback', label: '未対応チャット', data: 'demo:company-menu:unread' },
      },
      {
        title: '求人管理',
        subtitle: '求人を出稿',
        text: '求人管理',
        color: '#7C3AED',
        action: {
          type: 'uri',
          label: '求人管理',
          uri: `${SAIYO_PRO_WORKER_URL}/demo-company-jobs`,
        },
      },
      {
        title: 'アカウント設定',
        subtitle: '情報と各種設定',
        text: 'アカウント設定',
        color: '#4B5563',
        action: {
          type: 'uri',
          label: 'アカウント設定',
          uri: `${SAIYO_PRO_WORKER_URL}/demo-company-settings`,
        },
      },
    ],
  },
  {
    accountId: CANDIDATE_ACCOUNT_ID,
    fileBase: 'candidate',
    name: '採用PRO 求職者向け 4ボタン',
    chatBarText: '応募メニュー',
    imagePath: 'assets/rich-menus/saiyo-pro/candidate.png',
    tabs: [
      {
        title: '求人を見る',
        subtitle: 'おすすめ求人',
        text: '求人を見る',
        color: '#2563EB',
        action: { type: 'postback', label: '求人を見る', data: 'demo:candidate-menu:jobs-card' },
      },
      {
        title: 'チャット',
        subtitle: '応募先と連絡',
        text: 'チャット',
        color: '#16A34A',
        action: {
          type: 'uri',
          label: 'チャット',
          uri: `${SAIYO_PRO_WORKER_URL}/demo-candidate-chat?candidate=yamada`,
        },
      },
      {
        title: 'プロフィール',
        subtitle: '情報を編集',
        text: 'プロフィール',
        color: '#7C3AED',
        action: {
          type: 'uri',
          label: 'プロフィール',
          uri: `${SAIYO_PRO_WORKER_URL}/demo-candidate-chat?candidate=yamada&profile=1`,
        },
      },
      {
        title: '応募状況',
        subtitle: '進捗を確認',
        text: '応募状況',
        color: '#4B5563',
        action: { type: 'postback', label: '応募状況', data: 'demo:candidate-menu:status' },
      },
    ],
  },
];

async function main() {
  const accounts = await loadLineAccountTokens();

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

    console.log(`${spec.name}: ${created.richMenuId}`);
  }
}

export function buildRichMenuPayload(spec: DemoRichMenuSpec) {
  return {
    size: { width: WIDTH, height: HEIGHT },
    selected: true,
    name: spec.name,
    chatBarText: spec.chatBarText,
    areas: spec.tabs.map((tab, index) => ({
      bounds: {
        x: (index % COLS) * CELL_WIDTH,
        y: Math.floor(index / COLS) * CELL_HEIGHT,
        width: CELL_WIDTH,
        height: CELL_HEIGHT,
      },
      action: tab.action ?? { type: 'message', label: tab.title, text: tab.text },
    })),
  };
}

async function renderRichMenuImage(spec: DemoRichMenuSpec, outputPath: string): Promise<void> {
  await execFileAsync('magick', [
    spec.imagePath,
    '-resize',
    `${WIDTH}x${HEIGHT}^`,
    '-gravity',
    'center',
    '-extent',
    `${WIDTH}x${HEIGHT}`,
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

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
