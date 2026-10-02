/**
 * Shared private helpers for the service split (E9). Moved verbatim from service.ts; only `export` added.
 */

import {
  streamLogger,
  ValidationError,
  ConflictError,
  AppError,
} from "@assessiq/core";
import {
  validateQuestionContent,
  validateRubric,
  rubricRequiredFor,
  QB_ERROR_CODES,
} from "../types.js";
import type {
  QuestionType,
} from "../types.js";

export const log = streamLogger("app");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const SLUG_REGEX = /^[a-z0-9-]{3,80}$/;
export const MAX_PAGE_SIZE = 500;
export const MAX_SLUG_RETRIES = 10;

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

export function assertValidSlug(slug: string): void {
  if (!SLUG_REGEX.test(slug)) {
    throw new ValidationError(
      `Pack slug must match /^[a-z0-9-]{3,80}$/: got '${slug}'`,
      { details: { code: QB_ERROR_CODES.IMPORT_VALIDATION_FAILED, field: "slug" } },
    );
  }
}

/**
 * Derive a URL-safe slug from an arbitrary display name.
 * Steps: lowercase → NFKD normalise → strip non-alphanumeric/space/hyphen →
 * trim → collapse whitespace+underscores to hyphens → collapse runs → cap 64.
 * Returns an empty string if no alphanumeric characters survive.
 */
export function generateSlugFromName(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9\s-]/g, "")  // drop accents, punctuation, emoji
    .trim()
    .replace(/[\s_]+/g, "-")         // spaces/underscores → hyphens
    .replace(/-+/g, "-")             // collapse multiple hyphens
    .replace(/^-|-$/g, "")           // strip leading/trailing hyphens
    .slice(0, 64);
}

export function isUniqueViolation(err: unknown): boolean {
  return (
    err !== null &&
    typeof err === "object" &&
    "code" in err &&
    (err as { code: string }).code === "23505"
  );
}

export function assertNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new ValidationError(
      `'${field}' must not be empty`,
      { details: { code: "MISSING_REQUIRED", field } },
    );
  }
}

export function assertPageSize(pageSize: number): void {
  if (pageSize > MAX_PAGE_SIZE) {
    throw new ValidationError(
      `pageSize must not exceed ${MAX_PAGE_SIZE}`,
      { details: { code: QB_ERROR_CODES.INVALID_PAGE_SIZE, pageSize, max: MAX_PAGE_SIZE } },
    );
  }
}

/**
 * Translate a Postgres unique-violation (23505) to a ConflictError with the
 * given domain error code. Re-throws all other errors unchanged.
 */
export function rethrowUnique(err: unknown, code: string, message: string): never {
  if (
    err !== null &&
    typeof err === "object" &&
    "code" in err &&
    (err as { code: string }).code === "23505"
  ) {
    throw new ConflictError(message, { details: { code } });
  }
  throw err;
}

/**
 * Validate content + rubric for a question type and throw typed ValidationErrors.
 * Used by both createQuestion and updateQuestion.
 */
export function assertValidContent(type: QuestionType, content: unknown): void {
  const result = validateQuestionContent(type, content);
  if (!result.ok) {
    throw new ValidationError(
      `Invalid content for question type '${type}'`,
      { details: { code: QB_ERROR_CODES.INVALID_CONTENT, errors: result.errors } },
    );
  }
}

export function assertValidRubric(rubric: unknown): void {
  const result = validateRubric(rubric);
  if (!result.ok) {
    throw new ValidationError(
      `Invalid rubric`,
      { details: { code: QB_ERROR_CODES.INVALID_RUBRIC, errors: result.errors } },
    );
  }
}

/**
 * True iff `rubric` is a usable anchor rubric (non-null object with ≥1 anchor).
 * Used by publishPack's #2 quality gate. Distinct from assertValidRubric (which
 * only validates shape WHEN a rubric is present): a `subjective` can become
 * active with NO rubric (legacy seed bypassing the create gate, migration/import
 * paths), and such a question can then only be graded holistically via the
 * reasoning-only fallback. The publish gate requires real anchors for any
 * subjective that will be served.
 */
export function hasAnchorRubric(rubric: unknown): boolean {
  return (
    rubric != null &&
    typeof rubric === "object" &&
    Array.isArray((rubric as { anchors?: unknown }).anchors) &&
    (rubric as { anchors: unknown[] }).anchors.length >= 1
  );
}

/**
 * Full rubric-gate: checks required/not-allowed, validates shape if present.
 * rubricValue is the incoming patch.rubric or input.rubric (may be undefined =
 * "not supplied", null = "explicitly cleared").
 */
export function assertRubricGate(
  type: QuestionType,
  rubricValue: unknown,
  rubricSupplied: boolean,
): void {
  const required = rubricRequiredFor(type);
  if (required) {
    // rubric is required — null or absent is an error
    if (!rubricSupplied || rubricValue == null) {
      throw new ValidationError(
        `Rubric is required for question type '${type}'`,
        { details: { code: QB_ERROR_CODES.RUBRIC_REQUIRED, type } },
      );
    }
    assertValidRubric(rubricValue);
  } else {
    // rubric is NOT allowed — non-null value is an error
    if (rubricSupplied && rubricValue != null) {
      throw new ValidationError(
        `Rubric is not allowed for question type '${type}'`,
        { details: { code: QB_ERROR_CODES.RUBRIC_NOT_ALLOWED, type } },
      );
    }
  }
}

// ---------------------------------------------------------------------------
// generateDraft stub factory
// ---------------------------------------------------------------------------

export function _notImplemented(message: string, code: string): AppError {
  return new AppError(message, code, 501, { details: { code, httpStatus: 501 } });
}
