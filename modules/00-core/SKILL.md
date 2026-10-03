# 00-core — Foundation

> Cross-cutting concerns every other module depends on. Load this skill in any session that touches request lifecycle, configuration, logging, or error handling.

## Purpose
Provide the bedrock primitives — runtime config, env validation, structured logging, base error types, request-scoped context, time and ID utilities. No business logic.

## Scope
- **In:** env loader (Zod-validated), pino logger config, base `AppError` hierarchy, request ID + correlation, async-local-storage for tenant/user context, time helpers (UTC normalization), UUIDv7 helper.
- **Out:** anything tied to a specific feature; persistence; HTTP routing primitives (those live in module-specific code).

## Dependencies
None. This is the leaf — every other module imports from here.

## Public surface
```ts
// config.ts
export const config = loadConfig();   // throws on invalid env
// LOG_DIR is optional — when set (e.g. /var/log/assessiq), per-stream JSONL
// files are written there alongside stdout. See docs/11-observability.md § 3.

// logger.ts
export const logger: Logger;                          // alias of streamLogger('app')
export function streamLogger(name: string): Logger;   // memoized per stream
export function childLogger(bindings: object): Logger;
export function createLogger(opts?: LoggerOptions): Logger;
export const LOG_REDACT_PATHS: readonly string[];     // see docs/11-observability.md § 4
// Known stream names with dedicated files: app, request, auth, grading,
// migration, webhook, frontend. Anything else falls through to app.log.
// Mixin auto-attaches requestId/tenantId/userId from AsyncLocalStorage —
// callers must NOT pass these manually. Convention + triage runbooks live
// in docs/11-observability.md.

// errors.ts
export class AppError extends Error { code: string; status: number; details?: object; }
export class ValidationError extends AppError {}
export class AuthnError extends AppError {}
export class AuthzError extends AppError {}
export class NotFoundError extends AppError {}
export class ConflictError extends AppError {}
export class RateLimitError extends AppError {}

// context.ts (AsyncLocalStorage-backed)
export function withRequestContext<T>(ctx: RequestContext, fn: () => Promise<T>): Promise<T>;
export function enterWithRequestContext(ctx: RequestContext): void;  // for HTTP onRequest hooks
export function updateRequestContext(patch: Partial<RequestContext>): void;
export function getRequestContext(): RequestContext;
// RequestContext = { requestId, tenantId, userId, roles, ip, ua }

// id.ts
export function uuidv7(): string;
export function shortId(): string;        // 12 char base32 for human-shareable IDs

// time.ts
export function nowIso(): string;
export function parseIso(s: string): Date;
```

## Conventions enforced here
- All timestamps are UTC strings in ISO 8601 (no Date objects in API payloads).
- All errors thrown server-side derive from `AppError`; the global error handler maps them to HTTP responses with `{ code, message, details }`.
- `requestId` flows from nginx (`X-Request-Id`) or is minted, propagated to every log line and outbound API call (Anthropic, webhooks).
- Secrets are NEVER logged. The logger has a redaction allowlist via pino redact paths.

## Help/tooltip surface
None directly. Other modules' help content references config-derived limits (e.g., max session length) — exposed via `/api/admin/system-info` for help text interpolation.

## Open questions
- Telemetry tracer (OpenTelemetry) — defer to Phase 3 unless we hit perf debugging needs earlier.

## Test-only minters (E5)

`ENABLE_E2E_TEST_MINTER` and `ENABLE_EMBED_TEST_MINTER` are both declared in `config.ts` and both rejected when `NODE_ENV=production` (tests in `__tests__/config.test.ts`). Caveat: `NODE_ENV` defaults to `development` when unset, so prod relies on compose setting `NODE_ENV=production`. The CI quality step "No test-minter enabled in prod templates" greps tracked env templates/compose/Dockerfiles for either flag set to true/1.

## Status

- 2026-05-01: implemented in Phase 0 G0.A. Vitest suite green. Public surface frozen at the contract above.
- Open question (telemetry tracer / OpenTelemetry) remains deferred to Phase 3 unless perf debugging needs arise earlier.

## Shared AES-256-GCM core (N24, 2026-10-03)

`src/aes-gcm.ts` exports `sealTagLast`, `openTagLast`, `sealTagMid`, `openTagMid` (previous-key fallback, 16-byte auth tag, "envelope too short" under 28 bytes). It is also a subpath `@assessiq/core/aes-gcm`: `package.json` has a new `exports` map. Tests that mock the `@assessiq/core` barrel (13-notifications) must import the subpath for crypto. Both stored layouts are kept; no data migration. Test: `src/__tests__/aes-gcm.test.ts`.
