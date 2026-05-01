/**
 * MOCK ONLY — see SKILL.md § 12. Window 5 ships with this mock;
 * Window 4 (01-auth) replaces it via a 5-line swap commit.
 * Grep for `FIXME(post-01-auth)` to find every call site.
 */

import { uuidv7 } from '@assessiq/core';

export interface SessionsCreateInput {
  userId: string;
  tenantId: string;
  role: 'admin' | 'reviewer' | 'candidate';
  totpVerified: boolean;
  ip: string;
  ua: string;
}

export interface SessionsCreateResult {
  id: string;
  token: string;
  expiresAt: string;
}

export const sessions = {
  // FIXME(post-01-auth): swap mock for real @assessiq/auth.sessions on G0.C-4 merge.
  // This deterministic mock returns a synthetically-generated token.
  // See modules/03-users/SKILL.md § 12 for the contract this matches.
  async create(_input: SessionsCreateInput): Promise<SessionsCreateResult> {
    const id = uuidv7();
    const token = `mock_${uuidv7()}_${Date.now().toString(36)}`;
    // 8 hours from now
    const expiresAtMs = Date.now() + 8 * 60 * 60 * 1000;
    const expiresAt = new Date(expiresAtMs).toISOString();
    return { id, token, expiresAt };
  },
};
