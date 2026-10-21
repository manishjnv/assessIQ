// Camera policy loader. One tenant read, then the pure policy. Takes the client of an OPEN withTenant tx.
// No AI, no I/O beyond the one SELECT.

import type { PoolClient } from "pg";
import { AppError, config } from "@assessiq/core";
import { withTenant } from "@assessiq/tenancy";
import { auditInTx } from "@assessiq/audit-log";
import { CAMERA_NOTICE_VERSION } from "./constants.js";
import { insertConsent, latestConsentForInvitation } from "./repository.js";
import { resolveCameraPolicy, type CameraPolicy, type CameraTenantPolicyInput } from "./policy.js";

export async function loadTenantCameraInput(client: PoolClient, tenantId: string): Promise<CameraTenantPolicyInput> {
  const r = await client.query<{
    is_school: boolean;
    camera_enabled: boolean | null;
    camera_photos_enabled: boolean | null;
    camera_notice_confirmed_version: string | null;
  }>(
    `SELECT t.is_school, s.camera_enabled, s.camera_photos_enabled, s.camera_notice_confirmed_version
       FROM tenants t LEFT JOIN tenant_settings s ON s.tenant_id = t.id
      WHERE t.id = $1`,
    [tenantId],
  );
  const row = r.rows[0];
  return {
    isSchool: row?.is_school ?? false,
    cameraEnabled: row?.camera_enabled ?? false,
    photosEnabled: row?.camera_photos_enabled ?? false,
    noticeConfirmedVersion: row?.camera_notice_confirmed_version ?? null,
  };
}

/** Policy for one attempt or invitation. `enforced` defaults to the CAMERA_ENFORCED switch. */
export async function resolvePolicyInTx(
  client: PoolClient,
  tenantId: string,
  deliveryMode: "mock" | "real",
  isEmbed: boolean,
): Promise<{ policy: CameraPolicy; tenantCamera: CameraTenantPolicyInput }> {
  const tenantCamera = await loadTenantCameraInput(client, tenantId);
  const policy = resolveCameraPolicy({ deliveryMode, isEmbed, tenantCamera, enforced: config.CAMERA_ENFORCED });
  return { policy, tenantCamera };
}

/** Is the camera required for a NEW attempt of this test type? Plain read for the take page. */
export async function isCameraRequired(tenantId: string, deliveryMode: "mock" | "real"): Promise<boolean> {
  return withTenant(tenantId, async (client) => (await resolvePolicyInTx(client, tenantId, deliveryMode, false)).policy.required);
}

/**
 * Record the candidate's camera decision for an invitation (attempt not known yet). One audit row in the same tx.
 * Repeating the same open decision (newest row unlinked, same notice version) writes nothing.
 * 409 CAMERA_NOT_REQUIRED when the policy does not need a camera for this invitation.
 */
export async function recordCameraConsent(
  tenantId: string,
  i: {
    invitationId: string;
    userId: string;
    deliveryMode: "mock" | "real";
    decision: "agreed" | "declined";
    ipHash: string;
    deviceType: "desktop" | "mobile";
  },
): Promise<void> {
  await withTenant(tenantId, async (client) => {
    const { policy } = await resolvePolicyInTx(client, tenantId, i.deliveryMode, false);
    if (!policy.required) {
      throw new AppError("The camera is not required for this test.", "CAMERA_NOT_REQUIRED", 409, {
        details: { code: "CAMERA_NOT_REQUIRED" },
      });
    }
    // Idempotent: the same open (unlinked) decision on the same notice version is already on file.
    const last = await latestConsentForInvitation(client, i.invitationId);
    if (last !== null && last.attemptId === null && last.decision === i.decision && last.noticeVersion === CAMERA_NOTICE_VERSION) return;
    const row = await insertConsent(client, {
      tenantId,
      invitationId: i.invitationId,
      userId: i.userId,
      decision: i.decision,
      noticeVersion: CAMERA_NOTICE_VERSION,
      ipHash: i.ipHash,
      deviceType: i.deviceType,
    });
    await auditInTx(client, {
      tenantId,
      actorKind: "user",
      actorUserId: i.userId,
      action: "camera.consent.recorded",
      entityType: "camera_consent",
      entityId: row.id,
      after: { decision: i.decision, noticeVersion: CAMERA_NOTICE_VERSION, invitationId: i.invitationId },
    });
  });
}
