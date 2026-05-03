// AssessIQ — modules/14-audit-log/src/redact.ts
//
// Phase 3 G3.A — JSONB redaction for audit before/after payloads.
//
// Strips sensitive field values from arbitrary JSONB objects before they are
// written to the audit_log table. Defense-in-depth: callers should already
// avoid passing raw secrets, but this ensures they never reach the DB even
// if a caller is careless.
//
// RULE: redaction MUST happen BEFORE the INSERT. Never store plaintext
// secrets in audit_log rows. Per docs/11-observability.md § 4.
//
// INVARIANT: this file MUST NOT import from @anthropic-ai, claude, or any AI SDK.

/** Fields whose values are replaced with "[REDACTED]" (case-insensitive match). */
const SENSITIVE_FIELD_PATTERNS: RegExp[] = [
  /^password$/i,
  /^secret$/i,
  /secret$/i,          // *_secret, embed_secret, smtp_secret, client_secret
  /^token$/i,
  /token$/i,           // *_token, refresh_token, id_token, session_token
  /^api_?key$/i,
  /^apikey$/i,
  /key$/i,             // *_key (master_key, signing_key, etc.)
  /^totp_?secret$/i,
  /^recovery_?code$/i,
  /^recovery_?codes$/i,
  /hash$/i,            // *_hash (password_hash, code_hash, etc.)
  /^id_?token$/i,
  /^refresh_?token$/i,
  /^client_?secret$/i,
  /^session$/i,
  /^aiq_sess$/i,
  /^smtp_?password$/i,
  /^smtp_?pass$/i,
];

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_FIELD_PATTERNS.some((p) => p.test(key));
}

/**
 * Recursively redact sensitive fields from a JSONB-like object.
 * Returns a new object — never mutates in place.
 * Non-object values (arrays, primitives) are returned as-is unless they are
 * a top-level object.
 */
export function redactPayload(
  value: unknown,
  depth = 0,
): unknown {
  // Guard against deeply nested objects (max 8 levels — audit payloads are shallow).
  if (depth > 8) return value;

  if (value === null || typeof value !== 'object') return value;

  if (Array.isArray(value)) {
    return value.map((item) => redactPayload(item, depth + 1));
  }

  const obj = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    result[k] = isSensitiveKey(k) ? '[REDACTED]' : redactPayload(v, depth + 1);
  }
  return result;
}
