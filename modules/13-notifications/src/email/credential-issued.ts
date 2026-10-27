/**
 * modules/13-notifications/src/email/credential-issued.ts
 *
 * sendCredentialIssuedEmail - tells the holder that a certificate was issued (X3a).
 * Call it AFTER the issuing transaction commits. Loads the address itself (RLS) and skips
 * erased holders. The caller logs and swallows any failure: issuance stands.
 * Content: certificate title, credential id, public verify link. No score, no tier.
 *
 * NEVER import claude / @anthropic-ai from this file (Rule #1).
 */

import { withTenant } from '@assessiq/tenancy';
import { sendEmail } from './index.js';

export async function sendCredentialIssuedEmail(input: {
  tenantId: string;
  candidateId: string;
  courseTitle: string;
  credentialId: string;
}): Promise<void> {
  const base = (process.env['PUBLIC_BASE_URL'] ?? '').replace(/\/+$/, '');
  if (base.length === 0) return; // no absolute link possible
  const user = await withTenant(input.tenantId, async (client) => {
    const res = await client.query<{ email: string; name: string | null; erased_at: Date | null }>(
      'SELECT email, name, erased_at FROM users WHERE id = $1',
      [input.candidateId],
    );
    return res.rows[0] ?? null;
  });
  if (user === null || user.erased_at !== null) return; // DPDP: erased address is a tombstone
  await sendEmail({
    to: user.email,
    template: 'credential_issued',
    vars: {
      ...(user.name ? { recipientName: user.name } : {}),
      courseTitle: input.courseTitle,
      credentialId: input.credentialId,
      verifyLink: `${base}/verify/${input.credentialId}`,
    },
    tenantId: input.tenantId,
  });
}
