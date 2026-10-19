// AssessIQ — tier lock helper (Z-80).
//
// A 403 TIER_NOT_INCLUDED means the tenant's plan does not include the feature.
// Pages keep the feature visible and open LockedFeatureModal instead of showing an error.
//
// Duck-typed on purpose: it matches the AdminApiError / ApiCallError shape
// (status + apiError) without instanceof, so it works with test doubles too.

export function isTierLocked(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { status?: unknown; apiError?: { code?: unknown; details?: Record<string, unknown> } };
  if (e.status !== 403 || e.apiError === undefined) return false;
  return e.apiError.code === "TIER_NOT_INCLUDED" || e.apiError.details?.["code"] === "TIER_NOT_INCLUDED";
}
