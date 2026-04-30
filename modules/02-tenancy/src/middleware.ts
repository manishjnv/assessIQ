import type { PoolClient } from "pg";
import { config, AuthnError } from "@assessiq/core";
import { getPool } from "./pool.js";

/**
 * Tenant-context middleware for the Fastify request lifecycle.
 *
 * Phase 0 deliberately avoids a hard dependency on `fastify` (the API server
 * isn't built yet). Instead, this module exports the two hook functions
 * (`preHandler`, `onResponse`) with structurally-typed `req` / `reply`
 * shapes. G0.C session 4 (01-auth) wires them into a real Fastify instance
 * via `app.addHook("preHandler", handle.preHandler)` etc.
 *
 * Lifecycle:
 *   preHandler: resolve tenantId → acquire pool client → BEGIN →
 *               SET LOCAL ROLE assessiq_app →
 *               set_config('app.current_tenant', $1, true) →
 *               attach req.tenant + req.db.
 *   onResponse: COMMIT (2xx/3xx) or ROLLBACK (4xx/5xx) →
 *               release client → clear req state.
 *
 * onResponse fires once per request whether the handler succeeded, threw,
 * or sent an error reply, so the client is always returned to the pool.
 *
 * Why not use `withTenant()` directly here? `withTenant` is a synchronous
 * BEGIN-COMMIT-RELEASE wrapper. Fastify's lifecycle splits acquire/release
 * across two hooks, so we manage the transaction by hand. The transaction
 * shape is otherwise identical to `withTenant`.
 */

export interface TenantRequest {
  headers: Record<string, string | string[] | undefined>;
  session?: { tenantId?: string } | undefined;
  tenant?: { id: string } | undefined;
  db?: PoolClient | undefined;
  // Structurally compatible with Fastify's `req.log` (pino). Optional so
  // tests / standalone use can omit it.
  log?: {
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  } | undefined;
}

export interface TenantReply {
  statusCode: number;
  code: (status: number) => TenantReply;
  send: (payload: unknown) => TenantReply;
}

export interface TenantContextHooks {
  preHandler: (req: TenantRequest, reply: TenantReply) => Promise<void>;
  onResponse: (req: TenantRequest, reply: TenantReply) => Promise<void>;
}

const TEST_TENANT_HEADER = "x-aiq-test-tenant";

/**
 * Resolve a tenant id from the request.
 *
 * Production source: `req.session.tenantId`, set by 01-auth's sessionLoader.
 * Dev/test source: `x-aiq-test-tenant` header — gated on
 * `config.NODE_ENV !== 'production'` so a misrouted header in prod cannot
 * impersonate a tenant.
 */
function resolveTenantId(req: TenantRequest): string | null {
  const sessionTenant = req.session?.tenantId;
  if (typeof sessionTenant === "string" && sessionTenant.length > 0) {
    return sessionTenant;
  }

  if (config.NODE_ENV !== "production") {
    const header = req.headers[TEST_TENANT_HEADER];
    if (typeof header === "string" && header.length > 0) {
      return header;
    }
  }

  return null;
}

export function tenantContextMiddleware(): TenantContextHooks {
  return {
    preHandler: async (req, _reply) => {
      const tenantId = resolveTenantId(req);
      if (tenantId === null) {
        throw new AuthnError("no tenant context resolved for request");
      }

      const client = await getPool().connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL ROLE assessiq_app");
        await client.query(
          "SELECT set_config('app.current_tenant', $1, true)",
          [tenantId],
        );
      } catch (err) {
        // Setup failed mid-transaction; release the client immediately and
        // propagate. ROLLBACK first in case BEGIN itself succeeded.
        try {
          await client.query("ROLLBACK").catch(() => {
            /* connection dead; release will reset */
          });
        } finally {
          client.release();
        }
        throw err;
      }

      req.tenant = { id: tenantId };
      req.db = client;
    },

    onResponse: async (req, reply) => {
      const client = req.db;
      if (client === undefined) {
        // preHandler never ran (e.g. an earlier hook short-circuited) — nothing to clean up.
        return;
      }

      try {
        if (reply.statusCode >= 200 && reply.statusCode < 400) {
          await client.query("COMMIT").catch((err: unknown) => {
            // Critical: response was already serialized as 2xx/3xx by the
            // time onResponse fires, but the writes never landed. The
            // client believes the request succeeded. Surface as `error`
            // with a structured `kind` for SIEM / alert filtering — this
            // condition warrants paging on-call in production.
            req.log?.error(
              { err, kind: "tenant-commit-failed", tenantId: req.tenant?.id },
              "tenant-context middleware: COMMIT failed after success response — writes lost",
            );
            return client.query("ROLLBACK").catch(() => {
              /* connection dead — release() will reset */
            });
          });
        } else {
          await client.query("ROLLBACK").catch(() => {
            /* dead connection — release will reset */
          });
        }
      } finally {
        client.release();
        req.db = undefined;
        req.tenant = undefined;
      }
    },
  };
}
