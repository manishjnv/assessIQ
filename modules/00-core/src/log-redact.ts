/**
 * Pino redaction allowlist.
 *
 * Paths listed here are removed from log output before serialization. Coverage:
 *  - HTTP transport: authorization / cookie / set-cookie headers
 *  - Auth secrets: passwords, tokens, TOTP secrets, recovery codes, session cookies
 *  - PII: candidate-answer text on Phase-1 grading bodies, email addresses
 *  - OAuth/OIDC: client_secret, code-exchange responses
 *
 * Redaction is defense-in-depth, NOT the primary control. Adding a new field
 * to a log call requires asking: could this field carry PII or a secret? If
 * yes, redact at the source (don't include the field) — this list is the safety
 * net for accidental inclusion.
 *
 * Pino path syntax: dotted paths with `*` matching any object key at one
 * level, and `[\"key\"]` for keys with special characters. See pino docs.
 *
 * Cross-reference: docs/11-observability.md § Redaction allowlist.
 */
export const LOG_REDACT_PATHS: readonly string[] = [
  // HTTP transport — request/response headers
  "req.headers.authorization",
  "req.headers.cookie",
  "req.headers['set-cookie']",
  "res.headers['set-cookie']",
  "headers.authorization",
  "headers.cookie",

  // Auth secrets — top-level
  "password",
  "secret",
  "token",
  "apiKey",
  "api_key",
  "totpSecret",
  "totp_secret",
  "recoveryCode",
  "recovery_code",
  "client_secret",
  "clientSecret",
  "refresh_token",
  "refreshToken",
  "id_token",
  "idToken",

  // Session cookie value
  "aiq_sess",
  "session",
  "sessionToken",
  "session_token",

  // Candidate PII (Phase 1 grading carries answer text on request bodies)
  "answer",
  "answerText",
  "answer_text",
  "candidateText",

  // Wildcards (one level deep — pino does not deep-traverse by default)
  "*.password",
  "*.secret",
  "*.token",
  "*.apiKey",
  "*.api_key",
  "*.totpSecret",
  "*.totp_secret",
  "*.recoveryCode",
  "*.recovery_code",
  "*.client_secret",
  "*.clientSecret",
  "*.refresh_token",
  "*.refreshToken",
  "*.id_token",
  "*.idToken",
  "*.session",
  "*.sessionToken",
];
