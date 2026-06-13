import { describe, expect, test } from 'vitest';

import { buildRichMenuPayload, specs } from './publish-demo-rich-menus.js';

describe('demo rich menu payloads', () => {
  test('company rich menu exposes applicant handling, job management, and account linking', () => {
    const companySpec = specs.find((spec) => spec.fileBase === 'company');
    if (!companySpec) throw new Error('company spec missing');

    const payload = buildRichMenuPayload(companySpec);
    const actions = payload.areas.map((area) => area.action);
    const subtitles = companySpec.tabs.map((tab) => tab.subtitle);

    expect(companySpec.name).toBe('採用PRO 企業向け 4ボタン');
    expect(companySpec.imagePath).toBe('assets/rich-menus/saiyo-pro/company.png');
    expect(actions[0]).toEqual({ type: 'postback', label: '新着応募者', data: 'demo:company-menu:matches' });
    expect(actions[1]).toEqual({ type: 'postback', label: '未対応チャット', data: 'demo:company-menu:unread' });
    expect(actions[2]).toEqual({ type: 'uri', label: '求人管理', uri: 'https://saiyo-pro-harness.ikki-y.workers.dev/demo-company-jobs' });
    expect(actions[3]).toEqual({ type: 'uri', label: 'アカウント設定', uri: 'https://saiyo-pro-harness.ikki-y.workers.dev/demo-company-settings' });
    expect(JSON.stringify(companySpec)).toContain('求人管理');
    expect(JSON.stringify(companySpec)).toContain('アカウント設定');
    expect(JSON.stringify(companySpec)).not.toContain('採用実績');
    expect(subtitles).toEqual(['登録者を確認', '返信が必要なチャット', '求人を出稿', '情報と各種設定']);
  });

  test('candidate rich menu routes each button to the candidate experience', () => {
    const candidateSpec = specs.find((spec) => spec.fileBase === 'candidate');
    if (!candidateSpec) throw new Error('candidate spec missing');

    const payload = buildRichMenuPayload(candidateSpec);
    const actions = payload.areas.map((area) => area.action);

    expect(candidateSpec.name).toBe('採用PRO 求職者向け 4ボタン');
    expect(candidateSpec.imagePath).toBe('assets/rich-menus/saiyo-pro/candidate.png');
    expect(actions[0]).toEqual({ type: 'postback', label: '求人を見る', data: 'demo:candidate-menu:jobs-card' });
    expect(actions[1]).toEqual({ type: 'uri', label: 'チャット', uri: 'https://saiyo-pro-harness.ikki-y.workers.dev/demo-candidate-chat?candidate=yamada' });
    expect(actions[2]).toEqual({ type: 'uri', label: 'プロフィール', uri: 'https://saiyo-pro-harness.ikki-y.workers.dev/demo-candidate-chat?candidate=yamada&profile=1' });
    expect(actions[3]).toEqual({ type: 'postback', label: '応募状況', data: 'demo:candidate-menu:status' });
  });
});
