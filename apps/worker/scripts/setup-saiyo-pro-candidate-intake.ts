import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_FORM_ID = 'form-saiyo-pro-candidate-intake';
const DEFAULT_INTRO_TEMPLATE_ID = 'mtpl-five-rpo-saiyo-pro-intake-intro';
const DEFAULT_WORKER_URL = 'https://saiyo-pro-harness.ikki-y.workers.dev';
const DEFAULT_REF_CODE = 'five-rpo-rejection';
const DEFAULT_D1_DATABASE = 'saiyo-pro-harness';
const DEFAULT_WRANGLER_CONFIG = 'wrangler.saiyo-pro.toml';

type CandidateIntakeSetupInput = {
  formId: string;
  introTemplateId: string;
  workerUrl: string;
  refCode: string;
};

export function buildCandidateIntakeUrl(input: CandidateIntakeSetupInput): string {
  const base = input.workerUrl.replace(/\/+$/, '');
  const params = new URLSearchParams({ form: input.formId });
  return `${base}/r/${encodeURIComponent(input.refCode)}?${params.toString()}`;
}

export function buildCandidateIntakeFields(): Array<Record<string, unknown>> {
  return [
    {
      name: 'employment_type',
      label: '希望する働き方',
      type: 'radio',
      required: false,
      hidden: true,
      columns: 2,
      options: ['正社員', '契約社員', 'アルバイト', 'まだ決めていない'],
    },
    {
      name: 'job_change_timing',
      label: '選考への希望',
      type: 'radio',
      required: false,
      hidden: true,
      options: ['早めに進めたい', '条件を確認してから進めたい', 'まず説明を聞きたい'],
    },
    {
      name: 'resume_status',
      label: '職務経歴書はありますか？',
      type: 'radio',
      required: false,
      hidden: true,
      options: ['提出できる', 'まだ持っていない'],
    },
    {
      name: 'current_position',
      label: '現在の状況・経験職種',
      type: 'text',
      required: true,
      placeholder: '例: ホールスタッフ、営業、事務、未経験など',
    },
    {
      name: 'desired_job',
      label: '希望職種',
      type: 'text',
      required: true,
      placeholder: '例: 接客、営業、ITサポート、事務など',
    },
    {
      name: 'preferred_location',
      label: '希望勤務地',
      type: 'text',
      required: true,
      placeholder: '例: 渋谷、新宿、リモート可、東京都内など',
    },
    {
      name: 'contact_time',
      label: '連絡しやすい時間帯',
      type: 'text',
      required: true,
      placeholder: '例: 平日19時以降、土日、いつでも可',
    },
    {
      name: 'resume_upload',
      label: '職務経歴書の写真・PDFファイル',
      type: 'file',
      accept: 'image/*,application/pdf',
      showIf: { field: 'resume_status', equals: '提出できる' },
    },
    {
      name: 'resume_url',
      label: '職務経歴書のリンク',
      type: 'text',
      placeholder: 'Google Drive、Notion、PDFリンクなど。チャットで送った場合は「LINEで送付済み」と入力してください。',
      showIf: { field: 'resume_status', equals: '提出できる' },
    },
    {
      name: 'resume_work_history',
      label: '現職・前職の仕事内容と年数',
      type: 'textarea',
      placeholder: '例: 現職: 飲食店ホールを2年、接客・新人教育を担当。前職: アパレル販売を1年、レジ・在庫管理を担当。前職がなければ現職のみで大丈夫です。',
      showIf: { field: 'resume_status', equals: 'まだ持っていない' },
      requiredIf: { field: 'resume_status', equals: 'まだ持っていない' },
    },
    {
      name: 'resume_strengths',
      label: '得意なこと・アピールできそうなこと',
      type: 'textarea',
      placeholder: '例: 接客、継続力、数字管理、PC操作、コミュニケーションなど',
      showIf: { field: 'resume_status', equals: 'まだ持っていない' },
      requiredIf: { field: 'resume_status', equals: 'まだ持っていない' },
    },
    {
      name: 'resume_notes',
      label: '職務経歴書に入れたい補足',
      type: 'textarea',
      placeholder: '空欄でもOKです。資格、希望、避けたい条件などがあれば書いてください。',
      showIf: { field: 'resume_status', equals: 'まだ持っていない' },
    },
  ];
}

export function buildCandidateIntakeIntroFlex(): Record<string, unknown> {
  return {
    type: 'bubble',
    size: 'mega',
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'lg',
      paddingAll: '20px',
      backgroundColor: '#F8FAFC',
      contents: [
        {
          type: 'text',
          text: 'FIVE 選考エントリー',
          size: 'xs',
          weight: 'bold',
          color: '#16A34A',
          wrap: true,
        },
        {
          type: 'text',
          text: 'ご登録ありがとうございます',
          weight: 'bold',
          size: 'xl',
          color: '#0F172A',
          wrap: true,
        },
        {
          type: 'text',
          text: '選考を進めるために必要な確認を、このLINE上で順番に進めます。まずは選択式の質問から始めます。',
          size: 'sm',
          color: '#475569',
          wrap: true,
        },
        {
          type: 'box',
          layout: 'vertical',
          spacing: 'sm',
          margin: 'lg',
          paddingAll: '14px',
          backgroundColor: '#FFFFFF',
          borderColor: '#E2E8F0',
          borderWidth: '1px',
          cornerRadius: '12px',
          contents: [
            {
              type: 'box',
              layout: 'baseline',
              spacing: 'sm',
              contents: [
                { type: 'text', text: '1', flex: 0, size: 'xs', weight: 'bold', color: '#16A34A' },
                { type: 'text', text: '年齢・希望条件の確認', size: 'sm', color: '#0F172A', wrap: true },
              ],
            },
            {
              type: 'separator',
              color: '#E2E8F0',
            },
            {
              type: 'box',
              layout: 'baseline',
              spacing: 'sm',
              contents: [
                { type: 'text', text: '2', flex: 0, size: 'xs', weight: 'bold', color: '#16A34A' },
                { type: 'text', text: '職務経歴書の提出または作成', size: 'sm', color: '#0F172A', wrap: true },
              ],
            },
            {
              type: 'separator',
              color: '#E2E8F0',
            },
            {
              type: 'box',
              layout: 'baseline',
              spacing: 'sm',
              contents: [
                { type: 'text', text: '3', flex: 0, size: 'xs', weight: 'bold', color: '#16A34A' },
                { type: 'text', text: '確認後、次のご案内をお送りします', size: 'sm', color: '#0F172A', wrap: true },
              ],
            },
          ],
        },
        {
          type: 'text',
          text: '入力が必要なところだけ、専用ページを開いてご回答いただきます。',
          size: 'xs',
          color: '#64748B',
          wrap: true,
        },
      ],
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      contents: [
        {
          type: 'button',
          style: 'primary',
          color: '#06C755',
          action: {
            type: 'postback',
            label: '応募を開始する',
            data: 'five:intake:start',
            displayText: '応募を開始する',
          },
        },
      ],
    },
  };
}

function buildFiveIntakeQuestionFlex(input: {
  question: string;
  title: string;
  description: string;
  options: Array<{ label: string; value: string; primary?: boolean }>;
}): Record<string, unknown> {
  return {
    type: 'bubble',
    size: 'mega',
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'md',
      contents: [
        {
          type: 'text',
          text: '選考情報の確認',
          weight: 'bold',
          size: 'xs',
          color: '#047857',
          wrap: true,
        },
        {
          type: 'text',
          text: input.title,
          weight: 'bold',
          size: 'lg',
          color: '#0F172A',
          wrap: true,
        },
        {
          type: 'text',
          text: input.description,
          size: 'sm',
          color: '#475569',
          wrap: true,
        },
      ],
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      contents: input.options.map((option) => ({
        type: 'button',
        style: option.primary ? 'primary' : 'secondary',
        color: option.primary ? '#06C755' : undefined,
        action: {
          type: 'postback',
          label: option.label,
          data: `five:intake:${input.question}:${option.value}`,
          displayText: option.label,
        },
      })),
    },
  };
}

export function buildCandidateIntakeSetupSql(input: CandidateIntakeSetupInput): string {
  const nowExpr = `strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')`;
  const fieldsJson = JSON.stringify(buildCandidateIntakeFields());
  const intakeUrl = buildCandidateIntakeUrl(input);
  const introFlexJson = JSON.stringify(buildCandidateIntakeIntroFlex());

  return [
    `INSERT INTO tags (id, name, color, created_at)`,
    `VALUES ('tag-saiyo-pro-candidate-intake-completed', 'FIVE 選考情報回答完了', '#00B8C8', ${nowExpr})`,
    `ON CONFLICT(id) DO UPDATE SET name = excluded.name, color = excluded.color;`,
    '',
    `INSERT INTO forms`,
    `  (id, name, description, fields, on_submit_tag_id, on_submit_scenario_id, on_submit_message_type, on_submit_message_content, on_submit_webhook_url, on_submit_webhook_headers, on_submit_webhook_fail_message, save_to_metadata, is_active, submit_count, created_at, updated_at)`,
    `VALUES`,
    `  (${sql(input.formId)}, 'FIVE 選考情報確認', '選考を進めるために必要な情報を確認します。職務経歴書がある方はファイル・写真・リンクを登録できます。', ${sql(fieldsJson)}, 'tag-saiyo-pro-candidate-intake-completed', NULL, 'text', ${sql('ご回答ありがとうございます。いただいた内容を確認し、次のご案内をLINEでお送りします。')}, NULL, NULL, NULL, 1, 1, 0, ${nowExpr}, ${nowExpr})`,
    `ON CONFLICT(id) DO UPDATE SET`,
    `  name = excluded.name,`,
    `  description = excluded.description,`,
    `  fields = excluded.fields,`,
    `  on_submit_tag_id = excluded.on_submit_tag_id,`,
    `  on_submit_scenario_id = excluded.on_submit_scenario_id,`,
    `  on_submit_message_type = excluded.on_submit_message_type,`,
    `  on_submit_message_content = excluded.on_submit_message_content,`,
    `  save_to_metadata = excluded.save_to_metadata,`,
    `  is_active = 1,`,
    `  updated_at = ${nowExpr};`,
    '',
    `UPDATE templates`,
    `SET name = 'FIVE 選考情報確認',`,
    `    message_content = ${sql(`選考情報の確認が必要です。\n下記から職務経歴書の状況と必要事項の入力をお願いします。\n${intakeUrl}`)},`,
    `    updated_at = ${nowExpr}`,
    `WHERE id = 'tpl-five-rpo-rejection-guide';`,
    '',
    `INSERT INTO message_templates (id, name, message_type, message_content, created_at, updated_at)`,
    `VALUES (${sql(input.introTemplateId)}, 'FIVE 選考情報確認', 'flex', ${sql(introFlexJson)}, ${nowExpr}, ${nowExpr})`,
    `ON CONFLICT(id) DO UPDATE SET`,
    `  name = excluded.name,`,
    `  message_type = excluded.message_type,`,
    `  message_content = excluded.message_content,`,
    `  updated_at = ${nowExpr};`,
    '',
    `UPDATE entry_routes`,
    `SET intro_template_id = ${sql(input.introTemplateId)},`,
    `    run_account_friend_add_scenarios = 1,`,
    `    is_active = 1,`,
    `    updated_at = ${nowExpr}`,
    `WHERE ref_code = ${sql(input.refCode)};`,
    '',
  ].join('\n');
}

function readInput(): CandidateIntakeSetupInput {
  return {
    formId: process.env.SAIYO_PRO_CANDIDATE_INTAKE_FORM_ID ?? DEFAULT_FORM_ID,
    introTemplateId: process.env.SAIYO_PRO_CANDIDATE_INTAKE_INTRO_TEMPLATE_ID ?? DEFAULT_INTRO_TEMPLATE_ID,
    workerUrl: process.env.SAIYO_PRO_WORKER_URL ?? DEFAULT_WORKER_URL,
    refCode: process.env.FIVE_SAIYOU_PRO_REF_CODE ?? DEFAULT_REF_CODE,
  };
}

function sql(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function main() {
  const apply = process.argv.includes('--apply');
  const input = readInput();
  const summary = {
    formId: input.formId,
    introTemplateId: input.introTemplateId,
    intakeUrl: buildCandidateIntakeUrl(input),
  };
  console.log(JSON.stringify(summary, null, 2));
  if (!apply) {
    console.log('Dry run only. Re-run with --apply to update D1.');
    return;
  }

  const dir = mkdtempSync(join(tmpdir(), 'saiyo-pro-intake-'));
  const sqlPath = join(dir, 'setup.sql');
  try {
    writeFileSync(sqlPath, buildCandidateIntakeSetupSql(input), { encoding: 'utf8', mode: 0o600 });
    execFileSync(
      'wrangler',
      [
        'd1',
        'execute',
        process.env.SAIYO_PRO_D1_DATABASE ?? DEFAULT_D1_DATABASE,
        '--remote',
        '--config',
        process.env.SAIYO_PRO_WRANGLER_CONFIG ?? DEFAULT_WRANGLER_CONFIG,
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
