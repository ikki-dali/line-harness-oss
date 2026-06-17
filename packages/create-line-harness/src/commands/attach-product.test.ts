import { describe, expect, it } from "vitest";
import {
  buildAttachProductSql,
  buildAttachProductSummary,
  validateAttachProductInput,
} from "./attach-product.js";

describe("attach-product", () => {
  it("builds idempotent product integration SQL and keeps the secret out of the summary", () => {
    const input = {
      productCode: "saiyou-pro",
      productName: "採用プロ",
      lineAccountId: "five-rpo",
      webhookUrl: "https://api.example.com/v1/line-harness/events",
      webhookSecret: "shared-secret",
      productOrgId: "org-001",
      metadata: { rollout: "five" },
    };

    const sql = buildAttachProductSql(input);

    expect(sql).toContain("INSERT INTO product_integrations");
    expect(sql).toContain("ON CONFLICT(product_code, line_account_id) DO UPDATE");
    expect(sql).toContain("saiyou-pro");
    expect(sql).toContain("five-rpo");
    expect(sql).toContain("shared-secret");
    expect(sql).toContain("org-001");
    expect(sql).toContain("rollout");

    const summary = buildAttachProductSummary(input);
    expect(summary).toEqual({
      productCode: "saiyou-pro",
      productName: "採用プロ",
      lineAccountId: "five-rpo",
      webhookUrl: "https://api.example.com/v1/line-harness/events",
      hasWebhookSecret: true,
      productOrgId: "org-001",
      metadataKeys: ["rollout"],
    });
    expect(JSON.stringify(summary)).not.toContain("shared-secret");
  });

  it("requires the generic attach env shape", () => {
    expect(() => validateAttachProductInput({
      productCode: "saiyou-pro",
      productName: "採用プロ",
      lineAccountId: "",
      webhookUrl: "",
      webhookSecret: "",
    })).toThrow(/LINE_HARNESS_ACCOUNT_ID, PRODUCT_WEBHOOK_URL, LINE_HARNESS_WEBHOOK_SECRET/);
  });
});
