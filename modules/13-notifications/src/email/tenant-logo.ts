/**
 * modules/13-notifications/src/email/tenant-logo.ts
 *
 * Builds the public tenant-logo URL (Logo phase L3b) for candidate-facing
 * emails. Only the logo metadata is read (no bytes); the URL is derived from
 * the tenant id + stored sha, never from content. Data URIs are avoided: a
 * 512 KB logo would push Gmail past its 102 KB clipping limit and Gmail blocks
 * data: images anyway. Best-effort: any failure (or no logo) returns null and the email
 * renders exactly as before. A short per-process cache avoids one DB read per
 * recipient in a send batch.
 *
 * NEVER import claude / @anthropic-ai from this file (Rule #1).
 */

import { config } from '@assessiq/core';
import { getTenantLogoMeta, tenantLogoUrl } from '@assessiq/tenancy';
import type { EmailTemplateName } from '../types.js';

/** Candidate-facing templates that carry the tenant logo (admin/alert emails stay unbranded). */
const CANDIDATE_BRANDED: ReadonlySet<EmailTemplateName> = new Set<EmailTemplateName>([
  'invitation_candidate',
  'invitation_reminder',
  'candidate_login_link',
  'attempt_submitted_candidate',
  'attempt_graded_candidate',
  'result_released',
]);

export function isCandidateBrandedTemplate(name: EmailTemplateName): boolean {
  return CANDIDATE_BRANDED.has(name);
}

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { at: number; uri: string | null }>();

export async function loadTenantLogoUrl(tenantId: string): Promise<string | null> {
  const hit = cache.get(tenantId);
  if (hit !== undefined && Date.now() - hit.at < CACHE_TTL_MS) return hit.uri;
  let uri: string | null = null;
  try {
    const meta = await getTenantLogoMeta(tenantId);
    if (meta !== null) uri = new URL(tenantLogoUrl(tenantId, meta.sha256), config.ASSESSIQ_BASE_URL).toString();
  } catch {
    uri = null;
  }
  cache.set(tenantId, { at: Date.now(), uri });
  return uri;
}

/** Test hook. */
export function clearTenantLogoCache(): void {
  cache.clear();
}
