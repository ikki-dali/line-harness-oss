import { describe, expect, it } from 'vitest';
import {
  buildAttachSaiyouProSql,
  buildAttachSaiyouProSummary,
  validateApplyInput,
} from './attach-saiyou-pro-product.js';

describe('attach-saiyou-pro-product', () => {
  it('builds idempotent product integration SQL without exposing the secret in summary', () => {
    const input = {
      productCode: 'saiyou-pro',
      productName: '採用プロ',
      lineAccountId: 'five-rpo',
      webhookUrl: 'http://localhost:8080/v1/line-harness/events',
      webhookSecret: 'shared-secret',
      productOrgId: 'org-001',
    };

    const sql = buildAttachSaiyouProSql(input);
    expect(sql).toContain('INSERT INTO product_integrations');
    expect(sql).toContain('ON CONFLICT(product_code, line_account_id) DO UPDATE');
    expect(sql).toContain('http://localhost:8080/v1/line-harness/events');
    expect(sql).toContain('shared-secret');
    expect(sql).toContain('org-001');

    const summary = buildAttachSaiyouProSummary(input);
    expect(summary).toEqual({
      productCode: 'saiyou-pro',
      productName: '採用プロ',
      lineAccountId: 'five-rpo',
      webhookUrl: 'http://localhost:8080/v1/line-harness/events',
      hasWebhookSecret: true,
      productOrgId: 'org-001',
    });
    expect(JSON.stringify(summary)).not.toContain('shared-secret');
  });

  it('requires product org id when applying', () => {
    expect(() => validateApplyInput({
      productCode: 'saiyou-pro',
      productName: '採用プロ',
      lineAccountId: 'five-rpo',
      webhookUrl: 'http://localhost:8080/v1/line-harness/events',
      webhookSecret: 'shared-secret',
    }, true)).toThrow(/SAIYOU_PRO_ORG_ID/);
  });

  it('requires an explicit webhook URL when applying to remote D1', () => {
    const original = process.env.SAIYOU_PRO_WEBHOOK_URL;
    const originalLocal = process.env.LOCAL_D1;
    delete process.env.SAIYOU_PRO_WEBHOOK_URL;
    delete process.env.LOCAL_D1;
    try {
      expect(() => validateApplyInput({
        productCode: 'saiyou-pro',
        productName: '採用プロ',
        lineAccountId: 'five-rpo',
        webhookUrl: 'http://localhost:8080/v1/line-harness/events',
        webhookSecret: 'shared-secret',
        productOrgId: 'org-001',
      }, true)).toThrow(/SAIYOU_PRO_WEBHOOK_URL/);
    } finally {
      if (original === undefined) delete process.env.SAIYOU_PRO_WEBHOOK_URL;
      else process.env.SAIYOU_PRO_WEBHOOK_URL = original;
      if (originalLocal === undefined) delete process.env.LOCAL_D1;
      else process.env.LOCAL_D1 = originalLocal;
    }
  });
});
