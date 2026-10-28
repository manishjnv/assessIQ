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
import { getTenantById, getTenantLogoMeta, tenantLogoUrl } from '@assessiq/tenancy';
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

/** Public logo URL plus the stored pixel size (used to set the email img width/height). */
export interface TenantLogoRef {
  url: string;
  width: number;
  height: number;
}

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { at: number; logo: TenantLogoRef | null }>();

export async function loadTenantLogo(tenantId: string): Promise<TenantLogoRef | null> {
  const hit = cache.get(tenantId);
  if (hit !== undefined && Date.now() - hit.at < CACHE_TTL_MS) return hit.logo;
  let logo: TenantLogoRef | null = null;
  try {
    const meta = await getTenantLogoMeta(tenantId);
    if (meta !== null) {
      logo = {
        url: new URL(tenantLogoUrl(tenantId, meta.sha256), config.ASSESSIQ_BASE_URL).toString(),
        width: meta.width,
        height: meta.height,
      };
    }
  } catch {
    logo = null;
  }
  cache.set(tenantId, { at: Date.now(), logo });
  return logo;
}

/** Test hook. */
export function clearTenantLogoCache(): void {
  cache.clear();
}

const slugCache = new Map<string, { at: number; slug: string | null }>();

/**
 * Org code (the tenant slug) for the "sign in to see your results" line of the invitation (UAT 2026-10-29, Option A).
 * Best-effort like the logo: any failure returns null and the email renders without that line.
 */
export async function loadTenantSlug(tenantId: string): Promise<string | null> {
  const hit = slugCache.get(tenantId);
  if (hit !== undefined && Date.now() - hit.at < CACHE_TTL_MS) return hit.slug;
  let slug: string | null = null;
  try {
    const t = await getTenantById(tenantId);
    slug = typeof t.slug === 'string' && t.slug.length > 0 ? t.slug : null;
  } catch {
    slug = null;
  }
  slugCache.set(tenantId, { at: Date.now(), slug });
  return slug;
}

