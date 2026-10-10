// RW-37 static guard: the pack/level mutations must be in the audit catalog and
// each service function must call auditInTx (same-tx audit, no fire-and-forget).
// This is a shallow text check only. The real check is the DB test in
// modules/04-question-bank/src/__tests__/audit-writes.test.ts (same-tx + rollback).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { ACTION_CATALOG } from "../types.js";

const packsSrc = readFileSync(
  new URL("../../../04-question-bank/src/service/packs.ts", import.meta.url),
  "utf8",
);

function fnBody(name: string): string {
  const start = packsSrc.indexOf(`export async function ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const next = packsSrc.indexOf("\nexport async function ", start + 1);
  return packsSrc.slice(start, next === -1 ? undefined : next);
}

describe("RW-37 audit guard", () => {
  it.each([
    ["updatePack", "pack.updated"],
    ["addLevel", "level.added"],
    ["updateLevel", "level.updated"],
  ])("%s emits %s via auditInTx and the action is in the catalog", (fn, action) => {
    expect(ACTION_CATALOG).toContain(action);
    const body = fnBody(fn);
    expect(body).toContain("await auditInTx(client");
    expect(body).toContain(`"${action}"`);
  });
});
