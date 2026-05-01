import { ValidationError } from '@assessiq/core';

/**
 * Bulk CSV import stub.
 *
 * Per addendum § 1: Window 5 ships only this stub; the route returns HTTP 501.
 * Phase 1 implementation lands here with Zod schema + per-row try/catch.
 * The CSV contract (columns, validation, dedupe behavior, ImportReport shape)
 * is fully pinned in modules/03-users/SKILL.md § 1.
 *
 * TODO(phase-1): implement bulk CSV import per modules/03-users/SKILL.md § 1.
 */
export async function bulkImport(_csv: Buffer): Promise<never> {
  throw new ValidationError(
    'bulkImport is not implemented in Phase 0 — see modules/03-users/SKILL.md § 1',
    { details: { code: 'BULK_IMPORT_PHASE_1', httpStatus: 501 } },
  );
}
