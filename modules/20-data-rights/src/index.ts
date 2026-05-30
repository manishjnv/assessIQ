// modules/20-data-rights/src/index.ts
// Module 20 S1 — public surface re-exports.
//
// S1 ships migrations + scaffold + type surface only. No services or
// routes yet — those land in S2 (export), S3 (erasure + DSR token),
// S4 (admin queue), S5 (retention cron), S6 (consent ledger UI).
//
// See modules/20-data-rights/SKILL.md for the multi-session plan and
// pinned architecture decisions D1–D9.

export * from './types.js';
export * from './erasure.js';
export * from './export.js';
export * from './retention.js';
export * from './erased-list.js';
