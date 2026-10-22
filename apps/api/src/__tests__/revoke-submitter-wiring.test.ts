/**
 * GATE-8 A3-2: revoking an invitation submits and grades the running attempt. Module 05 cannot import 06,
 * so apps/api must inject the submit step at boot. Without it a revoke with a running attempt fails loud.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

describe("revoke attempt submitter wiring", () => {
  it("server.ts registers submitAttemptForRevokeInTx as the revoke submitter", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "server.ts"), "utf8");
    expect(src).toMatch(/setRevokeAttemptSubmitter\(submitAttemptForRevokeInTx\)/);
  });
});
