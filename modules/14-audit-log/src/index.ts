// AssessIQ — modules/14-audit-log/src/index.ts
//
// Phase 3 G3.A — public barrel for @assessiq/audit-log.
//
// Load-bearing module: append-only audit trail.
// Per CLAUDE.md: any future session that wants to UPDATE or DELETE audit rows
// requires explicit user override + a new RCA + a new SKILL.md amendment.
//
// INVARIANT: this file MUST NOT import from @anthropic-ai, claude, or any AI SDK.

// ---------------------------------------------------------------------------
// Primary write API
// ---------------------------------------------------------------------------
export { audit } from './audit.js';

// ---------------------------------------------------------------------------
// Admin query / export API
// ---------------------------------------------------------------------------
export { list, exportCsv, exportJsonl } from './service.js';
export type { AuditListResult } from './service.js';

// ---------------------------------------------------------------------------
// Archive job (BullMQ — apps/worker registers this at startup)
// ---------------------------------------------------------------------------
export {
  registerAuditArchiveJob,
  startAuditArchiveWorker,
  archiveJobProcessor,
} from './archive-job.js';

// ---------------------------------------------------------------------------
// Route registrar
// ---------------------------------------------------------------------------
export { registerAuditRoutes } from './routes.js';
export type { RegisterAuditRoutesOptions } from './routes.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export type {
  ActorKind,
  ActionName,
  AuditInput,
  AuditRow,
  AuditListInput,
  AuditListFilters,
  AuditExportInput,
} from './types.js';
export { ACTION_CATALOG } from './types.js';
