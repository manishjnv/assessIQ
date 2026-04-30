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
