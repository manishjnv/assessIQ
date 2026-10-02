/**
 * Service layer for module 04-question-bank.
 *
 * IMPORTANT — RLS-only scoping (same rule as 03-users):
 * All queries run through a PoolClient that has already received
 * `SET LOCAL ROLE assessiq_app` and `set_config('app.current_tenant', $tenantId, true)`
 * from withTenant(). Row-Level Security enforces tenant isolation at the Postgres layer.
 * Do NOT add redundant tenant_id WHERE filters in this file — that would mask RLS bugs.
 *
 * Transaction semantics:
 * withTenant wraps its callback in BEGIN / COMMIT so every multi-step operation
 * (publishPack, updateQuestion, restoreVersion, bulkImport) that runs inside a
 * single withTenant call is automatically a single database transaction.
 */

export * from "./service/packs.js";
export * from "./service/questions.js";
export * from "./service/generation.js";
