import type { AuthHook } from "./types.js";

// Lightweight Cookie header parser. Phase 0 ships without @fastify/cookie —
// the route layer adds it later when more cookie features are needed
// (signed cookies, prefix matching). For now we only need plain name=value
// pairs to read aiq_sess, aiq_oauth_state, aiq_oauth_nonce.
//
// RFC 6265 §5.4: cookies are semi-colon separated; whitespace around `=`
// allowed; values may be quoted (we do NOT unquote — none of our cookies
// contain quotes).

export function parseCookieHeader(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (header === undefined || header.length === 0) return out;

  const parts = header.split(";");
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name.length === 0) continue;
    // First occurrence wins — defends against header-injection that
    // appends a duplicate cookie name with attacker-controlled value.
    if (!Object.prototype.hasOwnProperty.call(out, name)) {
      out[name] = value;
    }
  }
  return out;
}

export const cookieParserMiddleware: AuthHook = (req, _reply) => {
  const raw = req.headers["cookie"];
  const header = Array.isArray(raw) ? raw.join("; ") : raw;
  req.cookies = parseCookieHeader(header);
};
