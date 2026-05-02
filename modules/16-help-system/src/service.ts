/**
 * Help-system service layer.
 *
 * Two DB-context modes:
 *   • Tenant-scoped  — `tenantId !== null` → `withTenant(tenantId, fn)`
 *   • Globals-only   — `tenantId === null`  → `withGlobalsOnly(fn)`
 *
 * `withGlobalsOnly` explanation
 * ─────────────────────────────
 * The help_content RLS policy uses the nullable-tenant variant:
 *   USING (tenant_id IS NULL OR tenant_id = current_setting('app.current_tenant')::uuid)
 *
 * If we enter a transaction with `SET LOCAL ROLE assessiq_app` but do NOT call
 * `set_config('app.current_tenant', ...)`, then `current_setting('app.current_tenant', true)`
 * returns NULL (the second arg `true` suppresses the "unrecognized configuration parameter"
 * error). NULL::uuid is NULL, so the `= current_setting(...)::uuid` predicate is always
 * false, leaving only the `tenant_id IS NULL` arm of the OR as true.
 *
 * Result: only global (tenant_id IS NULL) rows are visible — exactly what anonymous/
 * public reads need. This is the intended fail-closed behaviour: a missing GUC means
 * "show globals only", never "show everything".
 *
 * We COMMIT (not ROLLBACK) because these are reads; it makes no functional difference
 * but avoids a spurious rollback log line on read-only transactions.
 */

import type { PoolClient } from "pg";
import { getPool } from "@assessiq/tenancy";
import { withTenant } from "@assessiq/tenancy";
import { streamLogger } from "@assessiq/core";
import type { Audience, HelpEntry, HelpReadEnvelope, UpsertHelpInput } from "./types.js";
import {
  listHelpForPage,
  getHelpKey as repoGetHelpKey,
  upsertHelp,
  exportTenantHelp,
  bulkUpsertHelp,
} from "./repository.js";

const helpLog = streamLogger("app");

// ---------------------------------------------------------------------------
// withGlobalsOnly — anonymous read context (no tenant GUC set)
// ---------------------------------------------------------------------------

async function withGlobalsOnly<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    // SET LOCAL ROLE is defense-in-depth: if the connection user is a superuser
    // (e.g. during local dev), this re-engages RLS. In production the connection
    // is already assessiq_app and this is a cheap no-op.
    await client.query("SET LOCAL ROLE assessiq_app");
    // Explicitly reset app.current_tenant to its default (unset / NULL).
    //
    // WHY this is necessary: pg.Pool reuses connections across transactions.
    // A prior withTenant() call may have set app.current_tenant at the
    // session level (session-level SET persists past COMMIT). Even though
    // withTenant uses set_config(..., true) (transaction-local), the GUC
    // could also exist as a session-level value of "" from a prior connection
    // lifecycle event, causing current_setting(..., true)::uuid to throw
    // `invalid input syntax for type uuid: ""` when evaluated by RLS.
    //
    // `SET LOCAL app.current_tenant TO DEFAULT` resets the GUC to its
    // compiled-in default (NULL for custom GUCs) for the duration of this
    // transaction, so current_setting('app.current_tenant', true) returns
    // NULL and only the `tenant_id IS NULL` arm of the RLS USING clause fires.
    await client.query("SET LOCAL app.current_tenant TO DEFAULT");
    // After the reset above:
    // current_setting('app.current_tenant', true) → NULL → only tenant_id IS NULL rows visible.
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {
      // Secondary failure during rollback — connection is likely dead.
      // Swallow so the caller sees the original error.
    });
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Tenant-override merge: when both a tenant row and a global row exist for
// the same (key, locale), prefer the one with tenant_id IS NOT NULL.
// ---------------------------------------------------------------------------

function preferTenantOverride(rows: HelpEntry[]): HelpEntry | undefined {
  if (rows.length === 0) return undefined;
  // repository returns ORDER BY tenant_id NULLS LAST, so tenant row is first.
  const tenantRow = rows.find((r) => r.tenantId !== null);
  return tenantRow ?? rows[0];
}

function toEnvelope(entry: HelpEntry, fallback?: boolean): HelpReadEnvelope {
  const base: HelpReadEnvelope = {
    key: entry.key,
    audience: entry.audience,
    locale: entry.locale,
    shortText: entry.shortText,
    longMd: entry.longMd,
  };
  if (fallback === true) {
    return { ...base, _fallback: true };
  }
  return base;
}

// ---------------------------------------------------------------------------
// Locale fallback (decision #17)
// If (key, locale) yields 0 rows and locale !== 'en', retry with locale='en'.
// If found, return with _fallback: true. Logic lives here, not in the repo.
// ---------------------------------------------------------------------------

async function getHelpKeyWithFallback(
  client: PoolClient,
  key: string,
  locale: string,
): Promise<HelpReadEnvelope | null> {
  const rows = await repoGetHelpKey(client, key, locale);
  const entry = preferTenantOverride(rows);

  if (entry !== undefined) {
    return toEnvelope(entry);
  }

  if (locale !== "en") {
    const fallbackRows = await repoGetHelpKey(client, key, "en");
    const fallbackEntry = preferTenantOverride(fallbackRows);
    if (fallbackEntry !== undefined) {
      return toEnvelope(fallbackEntry, true);
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Public service functions
// ---------------------------------------------------------------------------

/**
 * Batch fetch for a page. `tenantId === null` → globals only (anonymous/public).
 */
export async function getHelpForPage(
  tenantId: string | null,
  page: string,
  audience: Audience,
  locale: string,
): Promise<HelpReadEnvelope[]> {
  const run = async (client: PoolClient): Promise<HelpReadEnvelope[]> => {
    const rows = await listHelpForPage(client, page, audience, locale);

    // Group by key, prefer tenant override per (key, locale).
    const byKey = new Map<string, HelpEntry>();
    for (const row of rows) {
      const existing = byKey.get(row.key);
      if (existing === undefined || row.tenantId !== null) {
        byKey.set(row.key, row);
      }
    }

    // Locale fallback for keys that had no row in the requested locale:
    // listHelpForPage already filters by locale so missing keys won't appear.
    // Fallback must be done per-missing-key; however for page-batch we skip
    // per-key fallback to avoid N+1 — callers that need fallback use getHelpKey.
    return Array.from(byKey.values()).map((e) => toEnvelope(e));
  };

  if (tenantId === null) {
    return withGlobalsOnly(run);
  }
  return withTenant(tenantId, run);
}

/**
 * Single key fetch. `tenantId === null` → globals only (anonymous/public).
 * Applies locale fallback (decision #17).
 */
export async function getHelpKey(
  tenantId: string | null,
  key: string,
  locale: string,
): Promise<HelpReadEnvelope | null> {
  const run = (client: PoolClient) => getHelpKeyWithFallback(client, key, locale);

  if (tenantId === null) {
    return withGlobalsOnly(run);
  }
  return withTenant(tenantId, run);
}

/**
 * Admin write: upsert a help entry for the given tenant.
 * `tenantId` is required — globals are seeded via YAML migration only.
 */
export async function upsertHelpForTenant(
  tenantId: string,
  key: string,
  input: UpsertHelpInput,
): Promise<HelpEntry> {
  return withTenant(tenantId, (client) => upsertHelp(client, tenantId, key, input));
}

/**
 * Export all active help rows visible to the tenant (includes globals).
 */
export async function exportHelp(tenantId: string, locale: string): Promise<HelpEntry[]> {
  return withTenant(tenantId, (client) => exportTenantHelp(client, locale));
}

/**
 * Bulk import (translation workflow). Creates new versioned rows.
 */
export async function importHelp(
  tenantId: string,
  locale: string,
  rows: Array<{ key: string; input: UpsertHelpInput }>,
): Promise<{ inserted: number; skipped: number }> {
  // Normalise locale on every input row so imports using the ?locale= query
  // param don't conflict with per-row locale fields.
  const normalised = rows.map(({ key, input }) => ({
    key,
    input: { ...input, locale },
  }));
  return withTenant(tenantId, (client) =>
    bulkUpsertHelp(client, tenantId, normalised),
  );
}

// ---------------------------------------------------------------------------
// Telemetry
// ---------------------------------------------------------------------------

/**
 * Deterministic 10%-sampler keyed on `key`.
 *
 * Uses a djb2-style hash of `key` to produce a stable bucket number
 * [0..9] then accepts if bucket < floor(sampleRate * 10).
 * A small random salt per call prevents all keys in the same bucket from
 * always appearing in the same request batch, while keeping the long-run
 * accept rate close to `sampleRate`.
 */
export function shouldSampleHelpEvent(key: string, sampleRate: number): boolean {
  // djb2 hash
  let h = 5381;
  for (let i = 0; i < key.length; i++) {
    h = ((h << 5) + h + key.charCodeAt(i)) >>> 0;
  }
  const bucket = h % 10;
  const threshold = Math.floor(sampleRate * 10);
  // Small random jitter: independently flip with probability sampleRate so
  // that keys landing on bucket boundaries don't form a systematic bias.
  return bucket < threshold || Math.random() < sampleRate * 0.1;
}

/**
 * Record a help telemetry event.
 *
 * NOTE: does NOT log short_text or long_md — admin-pasted content may be
 * sensitive (embedded URLs, tenant-specific context). Only key + metadata.
 *
 * TODO(audit) — Phase 3 (14-audit-log): replace pino log with real audit_log writes.
 */
export async function recordHelpEvent(
  event: "tooltip.shown" | "drawer.opened" | "feedback",
  payload: {
    key: string;
    tenantId: string | null;
    userId: string | null;
    thumbsUp?: boolean;
  },
): Promise<void> {
  // Intentionally fire-and-forget; telemetry must not block the response path.
  helpLog.info(
    {
      event: `help.${event}`,
      key: payload.key,
      tenantId: payload.tenantId,
      userId: payload.userId,
      // Only log thumbsUp for feedback events.
      ...(event === "feedback" && payload.thumbsUp !== undefined
        ? { thumbsUp: payload.thumbsUp }
        : {}),
      sampleRate: 0.1,
    },
    "help.telemetry",
  );
}
