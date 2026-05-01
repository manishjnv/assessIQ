import { AsyncLocalStorage } from "node:async_hooks";
import { AppError } from "./errors.js";

export interface RequestContext {
  requestId: string;
  tenantId?: string;
  userId?: string;
  roles?: string[];
  ip?: string;
  ua?: string;
}

const als = new AsyncLocalStorage<RequestContext>();

export function withRequestContext<T>(
  ctx: RequestContext,
  fn: () => Promise<T> | T
): Promise<T> | T {
  return als.run(ctx, fn);
}

/**
 * Enter a request context for the *current* async resource and onwards,
 * without wrapping a callback. Use from HTTP framework hooks (Fastify
 * onRequest) where the framework owns the call site of the route handler.
 *
 * Caveat: this leaks the store onto the current async resource until it is
 * disposed. Always call this exactly once per request, in onRequest.
 *
 * Mutating the stored context (e.g. populating tenantId/userId after auth
 * resolves) is supported via `updateRequestContext()` below.
 */
export function enterWithRequestContext(ctx: RequestContext): void {
  als.enterWith(ctx);
}

/**
 * Mutate the active request context in place. Used by auth/tenancy hooks
 * to populate tenantId/userId after onRequest has already entered the ALS.
 * Throws if no context is active (programmer error).
 */
export function updateRequestContext(patch: Partial<RequestContext>): void {
  const ctx = als.getStore();
  if (ctx === undefined) {
    throw new AppError(
      "No request context active",
      "NO_REQUEST_CONTEXT",
      500
    );
  }
  Object.assign(ctx, patch);
}

export function getRequestContext(): RequestContext | undefined {
  return als.getStore();
}

export function getRequestContextOrThrow(): RequestContext {
  const ctx = als.getStore();
  if (ctx === undefined) {
    throw new AppError(
      "No request context active",
      "NO_REQUEST_CONTEXT",
      500
    );
  }
  return ctx;
}

/**
 * Exposed for use by logger.ts to retrieve the current requestId without
 * creating a circular import. logger.ts imports this getter; request-context.ts
 * does NOT import from logger.ts.
 */
export function getRequestId(): string | undefined {
  return als.getStore()?.requestId;
}
