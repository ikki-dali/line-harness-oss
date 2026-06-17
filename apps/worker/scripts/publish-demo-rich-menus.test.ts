import { describe, expect, test } from 'vitest';

import { buildRichMenuPayload, groupFriendUserIdsByAccount, specs } from './publish-demo-rich-menus.js';

describe('demo rich menu payloads', () => {
  test('company rich menu exposes applicant handling, job management, and account linking', () => {
    const companySpec = specs.find((spec) => spec.fileBase === 'company');
    if (!companySpec) throw new Error('company spec missing');

    const payload = buildRichMenuPayload(companySpec);
    const actions = payload.areas.map((area) => area.action);
    const subtitles = companySpec.tabs.map((tab) => tab.subtitle);

    expect(companySpec.name).toBe('採用PRO 企業向け 4ボタン');
    expect(companySpec.imagePath).toBe('assets/rich-menus/saiyo-pro/company.png');
    expect(payload.size).toEqual({ width: 2500, height: 1250 });
    expect(payload.areas[0]?.bounds).toEqual({ x: 0, y: 0, width: 1250, height: 625 });
    expect(payload.areas[3]?.bounds).toEqual({ x: 1250, y: 625, width: 1250, height: 625 });
    expect(actions[0]).toEqual({ type: 'message', label: '新着応募者', text: '新着応募者' });
    expect(actions[1]).toEqual({ type: 'message', label: '未対応チャット', text: '未対応チャット' });
    expect(actions[2]).toEqual({ type: 'message', label: '求人管理', text: '求人管理' });
    expect(actions[3]).toEqual({ type: 'message', label: 'アカウント設定', text: 'アカウント設定' });
    expect(JSON.stringify(companySpec)).toContain('求人管理');
    expect(JSON.stringify(companySpec)).toContain('アカウント設定');
    expect(JSON.stringify(companySpec)).not.toContain('採用実績');
    expect(JSON.stringify(actions)).not.toContain('demo:company-menu');
    expect(JSON.stringify(actions)).not.toContain('/demo-company');
    expect(subtitles).toEqual(['登録者を確認', '返信が必要なチャット', '求人を出稿', '情報と各種設定']);
  });

  test('candidate rich menu routes each button to the candidate experience', () => {
    const candidateSpec = specs.find((spec) => spec.fileBase === 'candidate');
    if (!candidateSpec) throw new Error('candidate spec missing');

    const payload = buildRichMenuPayload(candidateSpec);
    const actions = payload.areas.map((area) => area.action);

    expect(candidateSpec.name).toBe('採用PRO 求職者向け 4ボタン');
    expect(candidateSpec.imagePath).toBe('assets/rich-menus/saiyo-pro/candidate.png');
    expect(payload.size).toEqual({ width: 2500, height: 988 });
    expect(payload.areas[0]?.bounds).toEqual({ x: 0, y: 0, width: 1250, height: 494 });
    expect(payload.areas[3]?.bounds).toEqual({ x: 1250, y: 494, width: 1250, height: 494 });
    expect(actions[0]).toEqual({ type: 'message', label: '求人を見る', text: '求人案内の確認を始める' });
    expect(actions[1]).toEqual({ type: 'message', label: 'チャット', text: 'チャット' });
    expect(actions[2]).toEqual({ type: 'message', label: 'プロフィール', text: 'プロフィール' });
    expect(actions[3]).toEqual({ type: 'message', label: '応募状況', text: '応募状況' });
    expect(JSON.stringify(actions)).not.toContain('demo:candidate-menu');
    expect(JSON.stringify(actions)).not.toContain('/demo-candidate-chat');
  });

  test('groups existing friend user IDs by line account for user-specific rich menu unlinking', () => {
    const grouped = groupFriendUserIdsByAccount([
      { line_account_id: 'saiyo-pro-company', line_user_id: 'U-company-1' },
      { line_account_id: 'saiyo-pro-company', line_user_id: 'U-company-2' },
      { line_account_id: 'saiyo-pro-candidate', line_user_id: 'U-candidate-1' },
      { line_account_id: 'saiyo-pro-candidate', line_user_id: '' },
      { line_account_id: null, line_user_id: 'U-no-account' },
    ]);

    expect(grouped.get('saiyo-pro-company')).toEqual(['U-company-1', 'U-company-2']);
    expect(grouped.get('saiyo-pro-candidate')).toEqual(['U-candidate-1']);
    expect(grouped.has('')).toBe(false);
  });
});
