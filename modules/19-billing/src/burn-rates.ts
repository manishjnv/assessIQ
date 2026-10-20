// AssessIQ — modules/19-billing/src/burn-rates.ts
//
// Z-93: the ONLY place the credit-ledger constants live. These are credit
// counts (owner decisions 2026-10-19), not prices. Change here, nowhere else.

export type TestType = 'mock' | 'real' | 'real_camera';

/** Credits burned when one attempt is graded, by test type. */
// Z-95 scale: 10x of the first ledger (2026-10-20)
export const BURN: Record<TestType, number> = { mock: 10, real: 20, real_camera: 30 };

/** Old billing_events meter counts 1 per graded attempt; reported x this so it matches the x10 credit scale. */
export const LEGACY_METER_UNITS_PER_ATTEMPT = 10;

/** Free plan: the balance is SET to this number on the 1st of every month (no rollover). */
export const FREE_MONTHLY_CREDITS = 200;

/** A grant expires this many months after it is granted. */
export const GRANT_VALIDITY_MONTHS = 12;

/** Low-balance warning when balance / granted credits falls to this ratio. */
export const LOW_BALANCE_THRESHOLD_RATIO = 0.2;
