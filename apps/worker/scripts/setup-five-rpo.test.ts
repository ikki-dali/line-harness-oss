import { describe, expect, it } from 'vitest';
import {
  buildFiveRpoSetupSql,
  buildSaiyouProGuideUrl,
  buildSetupSummary,
} from './setup-five-rpo.js';

const input = {
  accountId: 'five-rpo',
  accountName: 'FIVE公式LINE',
  channelId: 'channel-123',
  channelAccessToken: 'token-secret',
  channelSecret: 'channel-secret',
  liffId: '123456-liff',
  refCode: 'five-rpo-rejection',
  workerUrl: 'https://saiyo-pro-harness.example.dev/',
  trafficPoolSlug: 'five-rpo',
};

describe('setup-five-rpo', () => {
  it('builds the saiyou-pro guide URL under /r/:ref', () => {
    expect(buildSaiyouProGuideUrl(input.workerUrl, input.refCode)).toBe(
      'https://saiyo-pro-harness.example.dev/r/five-rpo-rejection',
    );
  });

  it('creates idempotent SQL for FIVE account, templates, auto replies, and ref route', () => {
    const sql = buildFiveRpoSetupSql(input);

    expect(sql).toContain('ON CONFLICT(id) DO UPDATE SET');
    expect(sql).toContain("'five-rpo'");
    expect(sql).toContain("'five-rpo-rejection'");
    expect(sql).toContain('route-five-rpo-rejection');
    expect(sql).toContain('pool-five-rpo');
    expect(sql).toContain('poolacct-five-rpo');
    expect(sql).toContain('traffic_pools');
    expect(sql).toContain('pool_accounts');
    expect(sql).toContain('tpl-five-rpo-rejection-guide');
    expect(sql).toContain('ar-five-rpo-saiyou-pro');
    expect(sql).toContain('https://saiyo-pro-harness.example.dev/r/five-rpo-rejection');
    expect(sql).toContain('FIVE 選考情報確認');
    expect(sql).toContain('職務経歴書の状況と必要事項の入力');
    expect(sql).not.toContain('採用PRO');
    expect(sql).not.toContain('採用プロ');
    expect(sql).not.toContain('特典');
  });

  it('redacts secret values from the public summary', () => {
    const summary = buildSetupSummary(input);

    expect(summary).toEqual({
      accountId: 'five-rpo',
      accountName: 'FIVE公式LINE',
      refCode: 'five-rpo-rejection',
      saiyouProGuideUrl: 'https://saiyo-pro-harness.example.dev/r/five-rpo-rejection',
      hasChannelId: true,
      hasChannelAccessToken: true,
      hasChannelSecret: true,
      hasLiffId: true,
    });
    expect(JSON.stringify(summary)).not.toContain('token-secret');
    expect(JSON.stringify(summary)).not.toContain('channel-secret');
  });
});
