// GATE-8 A2-3: boot-time check that the app DB login cannot reach the BYPASSRLS role.
// In production the tenant pool login must NOT be a member of assessiq_system: with
// membership, one SQL injection or bug could `SET ROLE assessiq_system` and skip RLS.
// Logs an ERROR and never crashes the boot.

import { config, streamLogger } from '@assessiq/core';
import { getPool } from '@assessiq/tenancy';

const log = streamLogger('app');

/** Pure decision: true when the boot check must log an error. */
export function shouldWarnAppRoleMembership(nodeEnv: string, isMember: boolean): boolean {
  return nodeEnv === 'production' && isMember;
}

export async function checkAppDbRoleMembership(): Promise<void> {
  if (config.NODE_ENV !== 'production') return;
  try {
    const r = await getPool().query<{ member: boolean }>(
      `SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'assessiq_system')
              THEN pg_has_role(current_user, 'assessiq_system', 'member') ELSE false END AS member`,
    );
    if (shouldWarnAppRoleMembership(config.NODE_ENV, r.rows[0]?.member === true)) {
      log.error({}, 'SECURITY: the app database login is a member of assessiq_system (BYPASSRLS); revoke the membership (GATE-8 A2-3)');
    }
  } catch (err) {
    log.error({ err }, 'startup check: could not read app DB role membership');
  }
}
