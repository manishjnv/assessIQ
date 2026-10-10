import { ValidationError } from "./errors.js";

export const DEFAULT_PAGE_SIZE = 20;
export const DEFAULT_MAX_PAGE_SIZE = 100;

/**
 * Parse `page` / `pageSize` from a query object. Throws ValidationError
 * (INVALID_PARAM) on a bad value. Callers needing a larger cap pass `{ max }`.
 */
export function parsePagination(
  q: Record<string, string | undefined>,
  opts: { max?: number } = {},
): { page: number; pageSize: number } {
  const max = opts.max ?? DEFAULT_MAX_PAGE_SIZE;
  const page = parseInt(q["page"] ?? "1", 10);
  const pageSize = parseInt(q["pageSize"] ?? String(DEFAULT_PAGE_SIZE), 10);

  if (isNaN(page) || page < 1) {
    throw new ValidationError("page must be a positive integer", {
      details: { code: "INVALID_PARAM", param: "page" },
    });
  }
  if (isNaN(pageSize) || pageSize < 1 || pageSize > max) {
    throw new ValidationError(`pageSize must be between 1 and ${max}`, {
      details: { code: "INVALID_PARAM", param: "pageSize" },
    });
  }
  return { page, pageSize };
}
