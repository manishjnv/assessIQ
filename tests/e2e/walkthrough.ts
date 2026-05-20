/* eslint-disable no-console */
/**
 * E2E walkthrough smoke test — 2026-05-15
 *
 * Documents the full production run: pack → questions → assessment →
 * candidate → invite → take → grade → accept → release → cert → leaderboard.
 *
 * Run:  pnpm exec tsx tests/e2e/walkthrough.ts
 * Env:  NODE_ENV=test (skips user-status check)
 *
 * This script verifies the database state of the completed walkthrough
 * and serves as a regression anchor for all major subsystems.
 */

import { withTenant } from "@assessiq/tenancy";
import {
  E2E_TENANT_ID,
  E2E_ASSESSMENT_ID,
  E2E_ATTEMPT_ID,
  E2E_CERT_CREDENTIAL_ID,
} from "./walkthrough-questions.js";

const PASS = "✓";
const FAIL = "✗";
let failures = 0;

function check(label: string, condition: boolean): void {
  if (condition) {
    console.log(`  ${PASS} ${label}`);
  } else {
    console.error(`  ${FAIL} ${label}`);
    failures++;
  }
}

async function run(): Promise<void> {
  console.log("E2E Walkthrough — production state verification\n");

  await withTenant(E2E_TENANT_ID, async (client) => {
    // ── Phase A: Pack + Assessment ──────────────────────────────────────────
    console.log("Phase A: Pack + Assessment");

    const assessmentRow = await client.query<{
      id: string; name: string; status: string; level_id: string;
    }>(
      `SELECT id, name, status, level_id FROM assessments WHERE id = $1`,
      [E2E_ASSESSMENT_ID],
    );
    check("assessment exists", assessmentRow.rows.length === 1);
    check("assessment is active or closed", ["active", "closed"].includes(assessmentRow.rows[0]?.status ?? ""));
    check("assessment has a level_id", assessmentRow.rows[0]?.level_id != null);

    const questionCount = await client.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM questions q
       JOIN levels l ON l.id = (SELECT level_id FROM assessments WHERE id = $1)
       WHERE q.pack_id = l.pack_id AND q.status = 'active'`,
      [E2E_ASSESSMENT_ID],
    );
    check("≥5 active questions in pack", parseInt(questionCount.rows[0]?.count ?? "0") >= 5);

    // ── Phase B: Attempt ────────────────────────────────────────────────────
    console.log("\nPhase B: Attempt");

    const attemptRow = await client.query<{
      id: string; status: string; user_id: string;
    }>(
      `SELECT id, status, user_id FROM attempts WHERE id = $1`,
      [E2E_ATTEMPT_ID],
    );
    check("attempt exists", attemptRow.rows.length === 1);
    check("attempt is released", attemptRow.rows[0]?.status === "released");

    const answerCount = await client.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM attempt_answers WHERE attempt_id = $1`,
      [E2E_ATTEMPT_ID],
    );
    check("≥1 answers recorded", parseInt(answerCount.rows[0]?.count ?? "0") >= 1);

    // ── Phase C: Grading ────────────────────────────────────────────────────
    console.log("\nPhase C: AI Grading");

    const gradingCount = await client.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM gradings WHERE attempt_id = $1`,
      [E2E_ATTEMPT_ID],
    );
    check("≥1 grading rows", parseInt(gradingCount.rows[0]?.count ?? "0") >= 1);

    const scoresRow = await client.query<{
      auto_pct: string; pending_review: boolean;
    }>(
      `SELECT auto_pct, pending_review FROM attempt_scores WHERE attempt_id = $1`,
      [E2E_ATTEMPT_ID],
    );
    check("attempt_scores row exists", scoresRow.rows.length === 1);
    check("auto_pct ≥ 90", parseFloat(scoresRow.rows[0]?.auto_pct ?? "0") >= 90);
    check("no pending_review", scoresRow.rows[0]?.pending_review === false);

    // ── Phase D: Certification ──────────────────────────────────────────────
    console.log("\nPhase D: Certification");

    const certRow = await client.query<{
      credential_id: string; tier: string; signed_hash: string | null; revoked_at: string | null;
    }>(
      `SELECT credential_id, tier, signed_hash, revoked_at FROM certificates WHERE attempt_id = $1`,
      [E2E_ATTEMPT_ID],
    );
    check("certificate exists", certRow.rows.length === 1);
    check(`credential_id is ${E2E_CERT_CREDENTIAL_ID}`, certRow.rows[0]?.credential_id === E2E_CERT_CREDENTIAL_ID);
    check("tier is distinction (100%)", certRow.rows[0]?.tier === "distinction");
    check("has HMAC signed_hash", certRow.rows[0]?.signed_hash != null);
    check("not revoked", certRow.rows[0]?.revoked_at == null);

    // ── Phase E: Leaderboard ────────────────────────────────────────────────
    console.log("\nPhase E: Leaderboard");

    const lbRow = await client.query<{ auto_pct: string; attempt_id: string }>(
      `SELECT auto_pct, attempt_id FROM attempt_scores
       WHERE attempt_id IN (
         SELECT id FROM attempts WHERE assessment_id = $1 AND status = 'released'
       )
       ORDER BY auto_pct DESC LIMIT 1`,
      [E2E_ASSESSMENT_ID],
    );
    check("leaderboard has rank-1 entry", lbRow.rows.length === 1);
    check("rank-1 is the walkthrough attempt", lbRow.rows[0]?.attempt_id === E2E_ATTEMPT_ID);
    check("rank-1 auto_pct = 100", parseFloat(lbRow.rows[0]?.auto_pct ?? "0") === 100);

    // ── Phase F: Email ──────────────────────────────────────────────────────
    console.log("\nPhase F: Email");

    const emailRow = await client.query<{ template_id: string; status: string }>(
      `SELECT template_id, status FROM email_log WHERE tenant_id = $1 AND template_id = 'invitation_candidate'`,
      [E2E_TENANT_ID],
    );
    check("invite email logged", emailRow.rows.length >= 1);
    // NOTE: status stays 'queued' in DB — email was sent via transport but
    // email_log.status is not updated to 'sent' (known gap, see RCA).
  });

  console.log(`\n${"─".repeat(50)}`);
  if (failures === 0) {
    console.log(`${PASS} All checks passed`);
    process.exit(0);
  } else {
    console.error(`${FAIL} ${failures} check(s) failed`);
    process.exit(1);
  }
}

run().catch((e) => {
  console.error("Smoke test crashed:", e);
  process.exit(1);
});
