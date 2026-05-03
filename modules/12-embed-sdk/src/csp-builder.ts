// modules/12-embed-sdk/src/csp-builder.ts
//
// Build the Content-Security-Policy header value for GET /embed responses.
//
// Spec: modules/12-embed-sdk/SKILL.md § Decisions captured D8.
//
// DESIGN:
//   - frame-ancestors directive is derived per-tenant per request from tenants.embed_origins.
//   - When origins is empty (no allow-list configured) or on any error, returns
//     frame-ancestors 'none' — FAIL CLOSED. An unconfigured tenant cannot be framed.
//   - The caller (embed route handler) is responsible for removing X-Frame-Options
//     so the CSP directive is authoritative (browsers honor CSP frame-ancestors over XFO).
//
// INVARIANT: this file MUST NOT import from @anthropic-ai, claude, or any AI SDK.

/**
 * Build the value of the Content-Security-Policy header for an embed response.
 *
 * @param origins  Array of allowed frame origins for this tenant.
 *                 Each origin should be scheme://hostname[:port], e.g. "https://acme.com".
 * @returns        A CSP header value string, e.g.
 *                 "frame-ancestors https://acme.com https://portal.wipro.com"
 *                 OR "frame-ancestors 'none'" if origins is empty.
 */
export function buildEmbedCsp(origins: string[]): string {
  if (origins.length === 0) {
    // No origins configured — fail closed. No framing permitted.
    return "frame-ancestors 'none'";
  }
  // Sanitize each origin: only allow safe characters (prevents header injection).
  // Origin spec: scheme://hostname[:port] — alphanumerics, -, ., :, /
  const safe = origins
    .map((o) => o.trim())
    .filter((o) => /^https?:\/\/[a-zA-Z0-9.-]+(:\d+)?$/.test(o));

  if (safe.length === 0) {
    // All configured origins were malformed — fail closed.
    return "frame-ancestors 'none'";
  }
  return `frame-ancestors ${safe.join(" ")}`;
}
