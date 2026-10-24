// Camera settings per organisation (Batch A). All writes: one UPDATE + one audit row in the same tx.
// Role checks stay with the caller (setTenantIsSchool is for the super admin only). No AI.

import type { PoolClient } from "pg";
import { AppError, NotFoundError, ValidationError, config } from "@assessiq/core";
import { auditInTx } from "@assessiq/audit-log";
import { withTenant } from "./with-tenant.js";

/** Version of the camera notice text. Lives here so module 05 can check it without importing module 06. */
export const CAMERA_NOTICE_VERSION = "2026-10-20.v1";

/**
 * Z-142/Z-144: a Real + camera test needs the camera allowed. Takes the client of an OPEN tx (one SELECT, no second connection).
 * 409 CAMERA_TEMPORARILY_OFF (switch off), 409 CAMERA_OFF_FOR_SCHOOL, and with `requireNotice` 409 CAMERA_NOTICE_REQUIRED.
 * `settingsPath` is the admin route of CameraSettingsCard (tenant-settings page).
 */
export async function assertCameraTestAllowed(client: PoolClient, tenantId: string, opts: { requireNotice: boolean }): Promise<void> {
  const fail = (message: string, code: string, details: Record<string, unknown> = {}): never => {
    throw new AppError(message, code, 409, { details: { code, ...details } });
  };
  if (!config.CAMERA_ENFORCED) fail("Camera tests are temporarily off. Choose Real.", "CAMERA_TEMPORARILY_OFF");
  const r = await client.query<{ is_school: boolean; camera_enabled: boolean | null; camera_notice_confirmed_version: string | null }>(
    `SELECT t.is_school, s.camera_enabled, s.camera_notice_confirmed_version
       FROM tenants t LEFT JOIN tenant_settings s ON s.tenant_id = t.id WHERE t.id = $1`,
    [tenantId],
  );
  const row = r.rows[0];
  if (row?.is_school === true && row.camera_enabled !== true) {
    fail("Turn the camera on in Settings before you create a camera test.", "CAMERA_OFF_FOR_SCHOOL");
  }
  if (opts.requireNotice && row?.camera_notice_confirmed_version !== CAMERA_NOTICE_VERSION) {
    fail("Confirm the camera notice in Settings before you publish a camera test.", "CAMERA_NOTICE_REQUIRED", { settingsPath: "/admin/tenant-settings" });
  }
}

export interface CameraTenantSettings {
  isSchool: boolean;
  cameraEnabled: boolean;
  photosEnabled: boolean;
  noticeConfirmedVersion: string | null;
}

export async function getCameraTenantSettings(tenantId: string): Promise<CameraTenantSettings> {
  return withTenant(tenantId, async (client) => {
    const r = await client.query<{
      is_school: boolean;
      camera_enabled: boolean;
      camera_photos_enabled: boolean;
      camera_notice_confirmed_version: string | null;
    }>(
      `SELECT t.is_school, s.camera_enabled, s.camera_photos_enabled, s.camera_notice_confirmed_version
         FROM tenants t JOIN tenant_settings s ON s.tenant_id = t.id
        WHERE t.id = $1`,
      [tenantId],
    );
    const row = r.rows[0];
    if (row === undefined) throw new NotFoundError(`tenant_settings not found for tenant ${tenantId}`);
    return {
      isSchool: row.is_school,
      cameraEnabled: row.camera_enabled,
      photosEnabled: row.camera_photos_enabled,
      noticeConfirmedVersion: row.camera_notice_confirmed_version,
    };
  });
}

/** Super admin only (the caller enforces it). Writes one audit row. */
export async function setTenantIsSchool(tenantId: string, isSchool: boolean, actorUserId: string): Promise<void> {
  if (typeof isSchool !== "boolean") {
    throw new ValidationError("isSchool must be true or false", { details: { code: "INVALID_IS_SCHOOL" } });
  }
  await withTenant(tenantId, async (client) => {
    const r = await client.query<{ previous: boolean }>(
      `UPDATE tenants t SET is_school = $2::boolean, updated_at = now()
         FROM (SELECT is_school AS previous FROM tenants WHERE id = $1 FOR UPDATE) old
        WHERE t.id = $1
        RETURNING old.previous`,
      [tenantId, isSchool],
    );
    const row = r.rows[0];
    if (row === undefined) throw new NotFoundError(`tenant ${tenantId} not found`);
    await auditInTx(client, {
      tenantId,
      actorKind: "user",
      actorUserId,
      action: "tenant.settings.updated",
      entityType: "tenant",
      entityId: tenantId,
      before: { is_school: row.previous },
      after: { is_school: isSchool },
    });
  });
}

/** Only meaningful for schools; the role check stays with the caller. Omitted fields do not change. */
export async function updateCameraSettings(
  tenantId: string,
  patch: { cameraEnabled?: boolean; photosEnabled?: boolean },
  actorUserId: string,
): Promise<void> {
  for (const v of [patch.cameraEnabled, patch.photosEnabled]) {
    if (v !== undefined && typeof v !== "boolean") {
      throw new ValidationError("camera settings must be true or false", { details: { code: "INVALID_CAMERA_SETTING" } });
    }
  }
  await withTenant(tenantId, async (client) => {
    const cur = await client.query<{ camera_enabled: boolean; camera_photos_enabled: boolean }>(
      `SELECT camera_enabled, camera_photos_enabled FROM tenant_settings LIMIT 1 FOR UPDATE`,
    );
    const before = cur.rows[0];
    if (before === undefined) throw new NotFoundError(`tenant_settings not found for tenant ${tenantId}`);
    const after = {
      camera_enabled: patch.cameraEnabled ?? before.camera_enabled,
      camera_photos_enabled: patch.photosEnabled ?? before.camera_photos_enabled,
    };
    await client.query(
      `UPDATE tenant_settings SET camera_enabled = $1::boolean, camera_photos_enabled = $2::boolean, updated_at = now()
        WHERE tenant_id = $3`,
      [after.camera_enabled, after.camera_photos_enabled, tenantId],
    );
    await auditInTx(client, {
      tenantId,
      actorKind: "user",
      actorUserId,
      action: "tenant.settings.updated",
      entityType: "tenant_settings",
      entityId: tenantId,
      before,
      after,
    });
  });
}

/** The school admin confirms they read the camera notice of this version. */
export async function confirmCameraNotice(tenantId: string, version: string, actorUserId: string): Promise<void> {
  if (typeof version !== "string" || version.trim() === "" || version.length > 40) {
    throw new ValidationError("notice version is required", { details: { code: "INVALID_NOTICE_VERSION" } });
  }
  await withTenant(tenantId, async (client) => {
    const cur = await client.query<{ camera_notice_confirmed_version: string | null }>(
      `SELECT camera_notice_confirmed_version FROM tenant_settings LIMIT 1 FOR UPDATE`,
    );
    const before = cur.rows[0];
    if (before === undefined) throw new NotFoundError(`tenant_settings not found for tenant ${tenantId}`);
    await client.query(
      `UPDATE tenant_settings
          SET camera_notice_confirmed_version = $1, camera_notice_confirmed_at = now(),
              camera_notice_confirmed_by = $2::uuid, updated_at = now()
        WHERE tenant_id = $3`,
      [version, actorUserId, tenantId],
    );
    await auditInTx(client, {
      tenantId,
      actorKind: "user",
      actorUserId,
      action: "tenant.settings.updated",
      entityType: "tenant_settings",
      entityId: tenantId,
      before,
      after: { camera_notice_confirmed_version: version },
    });
  });
}
