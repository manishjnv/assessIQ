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
  // ---- Credentials (original G3.A set) ----
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

  // ---- PII (added 2026-05-29 per modules/20-data-rights/SKILL.md D7) ----
  // D7 audit (Haiku, 2026-05-29) found candidate plaintext email written
  // to audit_log JSONB at modules/01-auth/src/candidate-login.ts:246 +
  // admin emails in modules/03-users/src/invitations.ts. These patterns
  // are forward-protection for every future write; historical rows are
  // redacted by migration 0104_audit_log_pii_redact_backfill.sql
  // (codex:rescue-gated append-only exception, applied once).
  //
  // Patterns are intentionally broad in the suffix form (/_name$/i,
  // /_email$/i, etc.) so that future call sites that add new field names
  // (recipient_email, candidate_name, etc.) are covered without
  // re-editing this file. Over-redaction of non-PII fields with these
  // suffixes (tenant_name, pack_name) is acceptable: audit_log is for
  // "did this change?" forensics, not "what was the name called?".
  /^email$/i,
  /_email$/i,                  // recipient_email, customer_email, ...
  /^name$/i,
  /_name$/i,                   // first_name, last_name, display_name, full_name, candidate_name
  /^display_?name$/i,
  /^full_?name$/i,
  /^phone$/i,
  /_phone$/i,                  // mobile_phone, primary_phone, ...
  /^phone_?number$/i,
  /^phone_?number_?e164$/i,    // ITU E.164 normalized phone (codex:rescue V6)
  /^mobile$/i,                 // bare 'mobile' as candidate phone (codex:rescue V6)
  /^whats_?app$/i,             // whatsapp / whats_app contact field (codex:rescue V6)
  /^linkedin_?url$/i,          // linkedin profile URL (codex:rescue V6)
  /^resume_?url$/i,            // resume / CV URL (codex:rescue V6)
  /^answer_?text$/i,           // candidate free-text answer content
  /_answer_?text$/i,           // candidate_answer_text, ...
  /^candidate_?answer$/i,      // narrow — does not catch correct_answer (rubric ground-truth)
  /^feedback_?text$/i,         // free-text feedback (codex:rescue V6)
  /^comment_?text$/i,          // free-text comment (codex:rescue V6)
  /^notes_?text$/i,            // free-text notes (codex:rescue V6)
  /^ip$/i,
  /_ip$/i,                     // client_ip, request_ip, source_ip, recipient_ip
  /^ip_?address$/i,
  /^user_?agent$/i,
  /_user_?agent$/i,            // client_user_agent, ...
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
