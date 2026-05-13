// tools/test-issue-cert.ts
//
// One-shot certificate-issuance smoke. Issues a real certificate against an
// existing attempt + candidate so the public verify path (HTML + og.svg +
// og.png) can be smoke-tested end-to-end against the live DB.
//
// Runs inside the assessiq-api container so it inherits the DB pool config,
// the CERT_SIGNING_SECRET, and the @assessiq/* workspace resolution:
//
//   ssh assessiq-vps 'docker exec -e ATTEMPT_ID=<uuid> assessiq-api \
//     pnpm tsx tools/test-issue-cert.ts'
//
// All inputs accept env-var overrides; the defaults target the Wipro SOC
// tenant + the manishjnvk+stage15 test candidate. issueCertificate is
// idempotent on (tenant_id, candidate_id, attempt_id), so re-running with
// the same inputs returns the existing row (and same credential_id).
//
// INVARIANT: NEVER import from @anthropic-ai, claude, or any AI SDK.

// Relative imports because tools/ is not a pnpm workspace member; the
// @assessiq/* package aliases only resolve from within apps/* or modules/*.
import { issueCertificate } from "../modules/18-certification/src/index.js";
import type { Tier } from "../modules/18-certification/src/types.js";
import { withTenant } from "../modules/02-tenancy/src/index.js";

const TENANT_ID = process.env["TENANT_ID"] ?? "019d8000-0001-7f00-8000-000000000001";
const ATTEMPT_ID = process.env["ATTEMPT_ID"];
const CANDIDATE_USER_ID =
  process.env["CANDIDATE_USER_ID"] ?? "019e0e80-0000-7000-8000-000000000001";
const ADMIN_USER_ID =
  process.env["ADMIN_USER_ID"] ?? "26a8f5b1-979d-4188-a2dc-a0e8745a2a62";
const DISPLAY_NAME = process.env["DISPLAY_NAME"] ?? "Stage Test Candidate";
const COURSE_TITLE = process.env["COURSE_TITLE"] ?? "SOC L1 Readiness";
const LEVEL = process.env["LEVEL"] ?? "L1";
const TIER = (process.env["TIER"] ?? "completion") as Tier;
const TEMPLATE_KEY = process.env["TEMPLATE_KEY"] ?? "default";

if (ATTEMPT_ID === undefined || ATTEMPT_ID.length === 0) {
  console.error(
    "[test-cert] ATTEMPT_ID env var required. Find one with:\n" +
      "  docker exec assessiq-postgres psql -U assessiq -d assessiq -c \\\n" +
      "    \"SELECT id, user_id, status FROM attempts WHERE tenant_id='<TENANT_ID>' LIMIT 5;\"",
  );
  process.exit(1);
}

async function main(): Promise<void> {
  console.log(`[test-cert] issuing cert for attempt=${ATTEMPT_ID?.slice(0, 8)} tenant=${TENANT_ID.slice(0, 8)} tier=${TIER}`);

  const cert = await withTenant(TENANT_ID, async (client) =>
    issueCertificate(client, {
      tenant_id: TENANT_ID,
      attempt_id: ATTEMPT_ID!,
      candidate_id: CANDIDATE_USER_ID,
      template_key: TEMPLATE_KEY,
      display_name: DISPLAY_NAME,
      course_title: COURSE_TITLE,
      level: LEVEL,
      tier: TIER,
      actor_user_id: ADMIN_USER_ID,
    }),
  );

  console.log(`[test-cert] OK: credential_id=${cert.credential_id}`);
  console.log(`[test-cert]     tier=${cert.tier} signed_hash=${cert.signed_hash.slice(0, 16)}...`);
  console.log(`[test-cert]     issued_at=${cert.issued_at}`);
  console.log(`[test-cert] smoke URLs (run from your shell):`);
  console.log(`  curl -sI https://assessiq.automateedge.cloud/verify/${cert.credential_id}`);
  console.log(`  curl -sI https://assessiq.automateedge.cloud/verify/${cert.credential_id}/og.svg`);
  console.log(`  curl -sI https://assessiq.automateedge.cloud/verify/${cert.credential_id}/og.png`);
}

main().catch((err) => {
  console.error("[test-cert] FAIL:", err);
  process.exit(1);
});
