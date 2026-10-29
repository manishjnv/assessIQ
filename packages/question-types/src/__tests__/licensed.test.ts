import { describe, it, expect } from "vitest";
import { redactMasterKey, mayReadMasterKey, licensedQuestionSql, adminViewFor } from "../index.js";

describe("FUT-2 redaction", () => {
  const row = {
    type: "mcq",
    content: { question: "Q?", options: ["a", "b"], correct: 1, rationale: "secret" },
    rubric: { secret: true },
    content_i18n: { hi: { rationale: "secret" } },
    source_ref: "REF",
    source_url: "https://x",
    topic: "t",
  };

  it("keeps the stem and options, drops the key and the reference fields", () => {
    const out = redactMasterKey(row);
    expect(out.content).toEqual({ question: "Q?", options: ["a", "b"] });
    expect(out.rubric).toBeNull();
    expect(out.content_i18n).toBeNull();
    expect(out.source_ref).toBeNull();
    expect(out.source_url).toBeNull();
    expect(out.topic).toBe("t");
    expect(row.content.correct).toBe(1); // input untouched
  });

  it("a shuffled field is shown in an order independent of the stored order", () => {
    const items = ["Detect", "Triage", "Contain", "Recover"];
    const a = adminViewFor("ordering", { question: "Q", items, correct_order: [0, 1, 2, 3] }) as { items: string[] };
    const b = adminViewFor("ordering", { question: "Q", items: [...items].reverse(), correct_order: [3, 2, 1, 0] }) as { items: string[] };
    expect(a.items).toEqual(b.items);
    expect([...a.items].sort()).toEqual([...items].sort());
    expect(a).not.toHaveProperty("correct_order");
  });

  it("unknown type fails closed to the stem only", () => {
    expect(adminViewFor("nope", { question: "Q", correct: 1 })).toEqual({ question: "Q" });
  });

  it("only super_admin may read master keys", () => {
    expect(mayReadMasterKey("super_admin")).toBe(true);
    expect(mayReadMasterKey("admin")).toBe(false);
    expect(mayReadMasterKey(undefined)).toBe(false);
  });

  it("predicate covers clones and other-tenant rows", () => {
    const sql = licensedQuestionSql("q");
    expect(sql).toContain("q.source_question_id IS NOT NULL");
    expect(sql).toContain("q.tenant_id <> current_setting('app.current_tenant', true)::uuid");
  });
});
