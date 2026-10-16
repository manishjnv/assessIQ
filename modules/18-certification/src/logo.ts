// AssessIQ — modules/18-certification/src/logo.ts
//
// Tenant logo for the public verify page, the OG image and the certificate PDF
// (Logo phases L3c/L4). Bytes are read server-side from the tenant's own stored
// logo via @assessiq/tenancy (its own withTenant) — never from a URL held in
// content. Call it AFTER the certificate row (which carries tenant_id) is
// loaded: withPublicVerifyContext has no tenant GUC, so tenant_logos cannot be
// read through RLS inside it. Best-effort: null on no logo or any failure.
//
// INVARIANT: NEVER import from @anthropic-ai, claude, or any AI SDK.

import { getTenantLogoBytes } from '@assessiq/tenancy';

export { SAFE_LOGO_DATA_URI } from './logo-pattern.js';

export async function loadLogoDataUri(tenantId: string): Promise<string | null> {
  try {
    const logo = await getTenantLogoBytes(tenantId);
    if (logo === null || !/^image\/(?:png|jpeg)$/.test(logo.mime)) return null;
    return `data:${logo.mime};base64,${logo.bytes.toString('base64')}`;
  } catch {
    return null;
  }
}
