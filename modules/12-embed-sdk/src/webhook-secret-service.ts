// modules/12-embed-sdk/src/webhook-secret-service.ts
//
// Rotate the webhook signing secret for a tenant.
//
// Spec: modules/12-embed-sdk/SKILL.md § Decisions captured D9.
//
// CRITICAL: webhook_secret is DISTINCT from embed_secret.
//   - embed_secret (in embed_secrets table) signs INBOUND embed JWTs from the host app.
//   - webhook_secret (in tenant_settings JSONB) signs OUTBOUND webhook deliveries.
//   - Rotation of one NEVER touches the other. Rotation independence is a hard invariant.
//
// The 13-notifications module already loads the webhook signing secret from
// tenant_settings.webhook_secret_enc for delivery. This service just manages rotation.
//
// Storage: tenant_settings JSONB field 'webhook_secret_enc' (AES-256-GCM envelope,
// encrypted under ASSESSIQ_MASTER_KEY via @assessiq/auth crypto-util).
// The plaintext is returned ONCE on creation/rotation; subsequent reads return null.
//
// INVARIANT: this file MUST NOT import from @anthropic-ai, claude, or any AI SDK.

import { randomBytes } from "node:crypto";
import { sealTagLast } from "@assessiq/core/aes-gcm";
import { withTenant } from "@assessiq/tenancy";
import { auditInTx } from "@assessiq/audit-log";
import type { PoolClient } from "pg";

export interface RotateWebhookSecretResult {
  /** Plaintext secret — shown ONCE. Caller must deliver to admin immediately. */
  plaintextSecret: string;
}

// Same tag-last envelope as 01-auth encryptEnvelope (shared impl in @assessiq/core), base64-encoded.
function encryptSecret(plaintext: string): string {
  return sealTagLast(plaintext).toString("base64");
}

function generateSecret(byteLen = 32): string {
  return randomBytes(byteLen).toString("base64url");
}

/**
 * Rotate the tenant's webhook signing secret.
 *
 * Generates a new random secret, encrypts it under ASSESSIQ_MASTER_KEY,
 * stores the encrypted envelope in tenant_settings.webhook_secret (the
 * existing column added by 0001_tenants.sql), and writes an audit row.
 *
 * Returns the plaintext once. After this call the plaintext is unrecoverable
 * from the server (only the encrypted form is stored).
 *
 * NOTE: tenant_settings.webhook_secret is DISTINCT from embed_secrets.secret_enc.
 * Rotating one NEVER touches the other.
 */
export async function rotateWebhookSecret(
  tenantId: string,
  actorUserId: string,
): Promise<RotateWebhookSecretResult> {
  const plaintextSecret = generateSecret(32);
  const encryptedB64 = encryptSecret(plaintextSecret);

  await withTenant(tenantId, async (client: PoolClient) => {
    // tenant_settings row is created at tenant-creation time; UPSERT for safety.
    await client.query(
      `INSERT INTO tenant_settings (tenant_id, webhook_secret)
       VALUES ($1, $2)
       ON CONFLICT (tenant_id) DO UPDATE
         SET webhook_secret = EXCLUDED.webhook_secret`,
      [tenantId, encryptedB64],
    );
    await auditInTx(client, {
      tenantId,
      actorKind: "user",
      actorUserId,
      action: "webhook_secret.rotated",
      entityType: "tenant",
      entityId: tenantId,
    });
  });

  return { plaintextSecret };
}
