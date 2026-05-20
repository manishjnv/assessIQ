/* eslint-disable no-console */
// One-shot invite tester. Calls inviteUsers directly to verify the
// 2026-05-09 tenantId-threading fix produces a real email_log row.
import { inviteUsers } from "@assessiq/assessment-lifecycle";

const TENANT_ID = "019d8000-0001-7f00-8000-000000000001";
const ADMIN_USER_ID = "26a8f5b1-979d-4188-a2dc-a0e8745a2a62";
const ASSESSMENT_ID = "019dedd9-a832-7086-afcb-374030b7875b";
const CANDIDATE_USER_ID = "019e0e80-0000-7000-8000-000000000001"; // manishjnvk+stage15@gmail.com

async function main() {
  console.log(`[invite-test] inviting ${CANDIDATE_USER_ID.slice(0, 8)} to ${ASSESSMENT_ID.slice(0, 8)}`);
  const result = await inviteUsers(TENANT_ID, ASSESSMENT_ID, [CANDIDATE_USER_ID], ADMIN_USER_ID);
  console.log("[invite-test] result:", JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
