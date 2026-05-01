import { AuthnError } from "@assessiq/core";
import { apiKeys } from "../api-keys.js";
import type { AuthHook } from "./types.js";

// Reads `Authorization: Bearer aiq_live_<...>`, looks up the API key via
// `apiKeys.authenticate` (system-role lookup, audited via the api_key id),
// populates req.apiKey. Throws AuthnError on miss / revoked / expired.
//
// The session-cookie path and the API-key path are mutually exclusive in
// practice — but if both are present, the session takes precedence (this
// middleware is registered AFTER sessionLoader).

const PREFIX = "Bearer aiq_live_";

export const apiKeyAuthMiddleware: AuthHook = async (req, _reply) => {
  if (req.session !== undefined) return; // session takes precedence

  const auth = req.headers["authorization"];
  const value = Array.isArray(auth) ? auth[0] : auth;
  if (typeof value !== "string") return;
  if (!value.startsWith(PREFIX.slice(0, 7))) return; // not Bearer at all
  if (!value.startsWith(PREFIX)) {
    // Bearer prefix present but not aiq_live_ — reject to avoid silent
    // accept of malformed tokens.
    throw new AuthnError("invalid api key prefix");
  }

  const plaintext = value.slice("Bearer ".length);
  const record = await apiKeys.authenticate(plaintext);
  req.apiKey = {
    id: record.id,
    tenantId: record.tenantId,
    scopes: record.scopes,
  };
};
