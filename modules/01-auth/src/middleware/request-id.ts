import { uuidv7 } from "@assessiq/core";
import type { AuthHook } from "./types.js";

// Sets req.requestId from `x-request-id` header (Caddy/Cloudflare may forward
// upstream value) or mints a new uuidv7. The downstream pino logger reads
// this via the AsyncLocalStorage request context (00-core) — wiring that
// integration is the route layer's responsibility (Fastify onRequest hook
// inside withRequestContext({...})).

const HEADER = "x-request-id";

export const requestIdMiddleware: AuthHook = (req, _reply) => {
  const incoming = req.headers[HEADER];
  if (typeof incoming === "string" && incoming.length > 0 && incoming.length <= 128) {
    req.requestId = incoming;
    return;
  }
  req.requestId = uuidv7();
};
