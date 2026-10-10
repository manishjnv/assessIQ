// AssessIQ — apps/api/src/routes/_validate.ts
//
// RW-36(b): Zod request validation for route handlers.
//
// Failure -> ValidationError (400), mapped by the global error handler in
// server.ts to the standard envelope:
//   { error: { code: 'VALIDATION_FAILED', message, details: { code, part, issues } } }
// `details.code` keeps the domain code the handler used before (e.g.
// INVALID_SCOPE), so existing clients that branch on it are unaffected.

import { z } from 'zod';
import { ValidationError } from '@assessiq/core';

export { z };

export type RequestPart = 'body' | 'params' | 'query';

export interface ParseOpts {
  /**
   * Domain code placed in details.code. A string applies to every failure; a map
   * is keyed by the first failing field name. Default INVALID_BODY /
   * INVALID_PARAMS / INVALID_QUERY.
   */
  code?: string | Record<string, string>;
}

/**
 * Parse `data` with `schema`; throw ValidationError (400) on failure. The
 * thrown message is the first issue's message so field-level messages written
 * in the schema surface unchanged.
 */
export function parse<S extends z.ZodTypeAny>(
  schema: S,
  data: unknown,
  part: RequestPart,
  opts: ParseOpts = {},
): z.infer<S> {
  const r = schema.safeParse(data);
  if (r.success) return r.data as z.infer<S>;
  const issues = r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
  const first = r.error.issues[0]?.path[0];
  // Precedence: code set on the failing refinement (`refine(fn, { message, params: { code } })`),
  // then the per-call option, then the generic INVALID_<PART>.
  const issueCode = (r.error.issues[0] as { params?: { code?: unknown } } | undefined)?.params?.code;
  const code =
    typeof issueCode === 'string'
      ? issueCode
      : typeof opts.code === 'string'
        ? opts.code
        : (opts.code !== undefined && first !== undefined ? opts.code[String(first)] : undefined) ??
          `INVALID_${part.toUpperCase()}`;
  throw new ValidationError(issues[0]?.message ?? `invalid request ${part}`, {
    details: { code, part, issues },
  });
}

/**
 * Non-throwing variant for anti-enumeration endpoints, which must answer a
 * malformed body with their documented neutral response (204 / 200 ok:false),
 * never a distinguishable 400. Returns null on failure.
 */
export const tryParse = <S extends z.ZodTypeAny>(schema: S, data: unknown): z.infer<S> | null => {
  const r = schema.safeParse(data ?? {});
  return r.success ? (r.data as z.infer<S>) : null;
};

/** A missing body (undefined/null) is treated as `{}` so optional-only schemas pass. */
export const parseBody = <S extends z.ZodTypeAny>(schema: S, body: unknown, opts?: ParseOpts) =>
  parse(schema, body ?? {}, 'body', opts);

export const parseParams = <S extends z.ZodTypeAny>(schema: S, params: unknown, opts?: ParseOpts) =>
  parse(schema, params ?? {}, 'params', opts);

export const parseQuery = <S extends z.ZodTypeAny>(schema: S, query: unknown, opts?: ParseOpts) =>
  parse(schema, query ?? {}, 'query', opts);

// ---------------------------------------------------------------------------
// Reusable pieces
// ---------------------------------------------------------------------------

/** A path-parameter UUID (every AssessIQ id column is uuid). */
export const uuidParam = (name: string) =>
  z.string({ required_error: `${name} is required`, invalid_type_error: `${name} must be a UUID` })
    .uuid(`${name} must be a UUID`);

export const tenantIdParams = z.object({ tenantId: uuidParam('tenantId') });
export const userIdParams = z.object({ userId: uuidParam('userId') });
export const idParams = z.object({ id: uuidParam('id') });
export const invitationIdParams = z.object({ invitationId: uuidParam('invitationId') });

/**
 * Lifecycle body { reason?, confirm_last_admin? }. `reason` content (type,
 * length, control characters) is validated by parseLifecycleBody with its
 * INVALID_REASON code, so it stays `unknown` here; this schema guarantees the
 * body is an object and the override flag is a real boolean.
 */
export const lifecycleBody = z
  .object({ reason: z.unknown().optional(), confirm_last_admin: z.boolean().optional() })
  .passthrough();

/**
 * Required string that must contain non-whitespace. Optional `max` is checked on
 * the raw value; `codes` sets details.code per failure kind.
 */
export const requiredString = (
  msg: string,
  opts: { code?: string; max?: number; maxMsg?: string; maxCode?: string } = {},
) => {
  let s: z.ZodTypeAny = z
    .string({ required_error: msg, invalid_type_error: msg })
    .refine((v) => v.trim().length > 0, {
      message: msg,
      ...(opts.code !== undefined ? { params: { code: opts.code } } : {}),
    });
  if (opts.max !== undefined) {
    const max = opts.max;
    s = s.refine((v: string) => v.length <= max, {
      message: opts.maxMsg ?? `must be ${max} characters or fewer`,
      ...(opts.maxCode !== undefined ? { params: { code: opts.maxCode } } : {}),
    });
  }
  return s as z.ZodEffects<z.ZodString, string, string>;
};

/** Query string flag ('1' / 'true' / anything else = false, as the handlers read it). */
export const queryFlag = z.string().max(16).optional();
