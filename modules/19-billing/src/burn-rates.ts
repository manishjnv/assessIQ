// AssessIQ — modules/19-billing/src/burn-rates.ts
//
// Z-93: the ONLY place the credit-ledger constants live. These are credit
// counts (owner decisions 2026-10-19), not prices. Change here, nowhere else.

export type TestType = 'mock' | 'real' | 'real_camera';

/** Credits burned when one attempt is graded, by test type. */
export const BURN: Record<TestType, number> = { mock: 1, real: 2, real_camera: 3 };

/** Free plan: the balance is SET to this number on the 1st of every month (no rollover). */
export const FREE_MONTHLY_CREDITS = 20;

/** A grant expires this many months after it is granted. */
export const GRANT_VALIDITY_MONTHS = 12;

/** Low-balance warning when balance / granted credits falls to this ratio. */
export const LOW_BALANCE_THRESHOLD_RATIO = 0.2;
