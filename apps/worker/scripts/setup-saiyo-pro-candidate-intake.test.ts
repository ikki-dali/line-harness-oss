import { describe, expect, it } from 'vitest';
import {
  buildCandidateIntakeFields,
  buildCandidateIntakeIntroFlex,
  buildCandidateIntakeSetupSql,
  buildCandidateIntakeUrl,
} from './setup-saiyo-pro-candidate-intake.js';

const input = {
  formId: 'form-saiyo-pro-candidate-intake',
  introTemplateId: 'mtpl-five-rpo-saiyo-pro-intake-intro',
  workerUrl: 'https://saiyo-pro-harness.example.dev/',
  refCode: 'five-rpo-rejection',
};

describe('setup-saiyo-pro-candidate-intake', () => {
  it('builds a FIVE rejection intake URL with form param', () => {
    expect(buildCandidateIntakeUrl(input)).toBe(
      'https://saiyo-pro-harness.example.dev/r/five-rpo-rejection?form=form-saiyo-pro-candidate-intake',
    );
  });

  it('adds resume branch fields for candidates without a resume', () => {
    const fields = buildCandidateIntakeFields();

    expect(fields.slice(0, 3).map((field) => field.name)).toEqual([
      'employment_type',
      'job_change_timing',
      'resume_status',
    ]);
    expect(fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'resume_status', type: 'radio', required: false, hidden: true }),
        expect.objectContaining({
          name: 'resume_work_history',
          label: '現職・前職の仕事内容と年数',
          placeholder: expect.stringContaining('現職:'),
          showIf: { field: 'resume_status', equals: 'まだ持っていない' },
          requiredIf: { field: 'resume_status', equals: 'まだ持っていない' },
        }),
        expect.objectContaining({
          name: 'resume_upload',
          showIf: { field: 'resume_status', equals: '提出できる' },
          type: 'file',
          accept: 'image/*,application/pdf',
        }),
      ]),
    );
  });

  it('builds an intro Flex template with a replaceable form URL', () => {
    const flex = buildCandidateIntakeIntroFlex();
    const json = JSON.stringify(flex);

    expect(json).toContain('FIVE 選考エントリー');
    expect(json).toContain('ご登録ありがとうございます');
    expect(json).toContain('年齢・希望条件の確認');
    expect(json).toContain('職務経歴書の提出または作成');
    expect(json).toContain('入力が必要なところだけ');
    expect(json).toContain('応募を開始する');
    expect(json).toContain('five:intake:start');
    expect(json).not.toContain('"hero"');
    expect(json).not.toContain('年齢を教えてください');
    expect(json).not.toContain('{formUrl}');
    expect(json).not.toContain('resume_status=');
    expect(json).not.toContain('採用PRO');
    expect(json).not.toContain('採用プロ');
    expect(json).not.toContain('特典');
  });

  it('creates idempotent SQL for form seed and FIVE rejection template update', () => {
    const sql = buildCandidateIntakeSetupSql(input);

    expect(sql).toContain('ON CONFLICT(id) DO UPDATE SET');
    expect(sql).toContain('form-saiyo-pro-candidate-intake');
    expect(sql).toContain('FIVE 選考情報確認');
    expect(sql).toContain('職務経歴書がある方はファイル・写真・リンクを登録できます。');
    expect(sql).toContain('ご回答ありがとうございます。いただいた内容を確認し、次のご案内をLINEでお送りします。');
    expect(sql).toContain('resume_upload');
    expect(sql).toContain('現職・前職の仕事内容と年数');
    expect(sql).toContain('前職がなければ現職のみで大丈夫です。');
    expect(sql).toContain('five:intake:start');
    expect(sql).toContain('tpl-five-rpo-rejection-guide');
    expect(sql).toContain('mtpl-five-rpo-saiyo-pro-intake-intro');
    expect(sql).toContain('intro_template_id');
    expect(sql).toContain('https://saiyo-pro-harness.example.dev/r/five-rpo-rejection?form=form-saiyo-pro-candidate-intake');
    expect(sql).not.toContain('採用PRO');
    expect(sql).not.toContain('採用プロ');
    expect(sql).not.toContain('特典');
  });
});
