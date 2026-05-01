import { sessions } from "./sessions.js";
import type { CreateSessionOutput } from "./sessions.js";

// Magic link — candidate session minting helper.
//
// Phase 0 ships only the session-mint helper. The route handler
// `POST /api/take/start { token }` and the token validation against
// `assessment_invitations` (owned by 05-assessment-lifecycle) ship in
// Phase 1. This file is the cross-module surface those routes will call
// once the table and route layer exist.
//
// Spec: modules/01-auth/SKILL.md § Decisions captured § 8 — candidate
// session minted with totpVerified=true, role='candidate'. Cookie name
// is the same aiq_sess; role discrimination is server-side via
// req.session.role + requireRole('candidate').

export interface MintCandidateSessionInput {
  userId: string;
  tenantId: string;
  ip: string;
  ua: string;
}

export async function mintCandidateSession(
  input: MintCandidateSessionInput,
): Promise<CreateSessionOutput> {
  return sessions.create({
    userId: input.userId,
    tenantId: input.tenantId,
    role: "candidate",
    totpVerified: true,    // candidates skip MFA — magic link IS the auth factor
    ip: input.ip,
    ua: input.ua,
  });
}
