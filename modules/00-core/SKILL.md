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

// logger.ts
export const logger = createLogger();
export function childLogger(bindings: object): Logger;

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
