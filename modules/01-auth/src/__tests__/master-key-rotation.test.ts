/**
 * E8 master-key rotation: dual-key decrypt (crypto-util) + tools/rotate-master-key.ts
 * against a real Postgres testcontainer (RLS + assessiq_system role exercised).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import { randomUUID, randomBytes } from "node:crypto";
import { config } from "@assessiq/core";
import { applyAllMigrations } from "../../../../tools/test-support/apply-all-migrations.js";
import { rotateAll, TARGETS, type MinimalClient } from "../../../../tools/rotate-master-key.js";
import { encryptEnvelope, decryptEnvelope } from "../crypto-util.js";
// Real app encryptor for the webhook_endpoints layout (iv||tag||ct).
import { encrypt as webhookEncrypt, decrypt as webhookDecrypt } from "../../../13-notifications/src/webhooks/crypto.js";

const mutable = config as unknown as Record<string, string | undefined>;
const ORIGINAL_KEY = mutable["ASSESSIQ_MASTER_KEY"]!;
const b64 = () => randomBytes(32).toString("base64");

function setKeys(current: string, previous?: string): void {
  mutable["ASSESSIQ_MASTER_KEY"] = current;
  mutable["ASSESSIQ_MASTER_KEY_PREVIOUS"] = previous;
}
afterEach(() => setKeys(ORIGINAL_KEY, undefined));

describe("decryptEnvelope dual-key", () => {
  const OLD = b64();
  const NEW = b64();

  it("decrypts old-key ciphertext when MASTER_KEY=new and PREVIOUS=old", () => {
    setKeys(OLD);
    const env = encryptEnvelope("s3cret");
    setKeys(NEW, OLD);
    expect(decryptEnvelope(env).toString("utf8")).toBe("s3cret");
  });

  it("encrypt always uses the current key (new ciphertext opens with new key alone)", () => {
    setKeys(NEW, OLD);
    const env = encryptEnvelope("fresh");
    setKeys(NEW);
    expect(decryptEnvelope(env).toString("utf8")).toBe("fresh");
  });

  it("old-key ciphertext fails when no previous key is set (behaviour unchanged)", () => {
    setKeys(OLD);
    const env = encryptEnvelope("x");
    setKeys(NEW);
    expect(() => decryptEnvelope(env)).toThrow();
  });

  it("tampered ciphertext fails under both keys", () => {
    setKeys(OLD);
    const env = encryptEnvelope("x");
    env[14] = env[14]! ^ 0xff;
    setKeys(NEW, OLD);
    expect(() => decryptEnvelope(env)).toThrow();
  });
});

describe("tools/rotate-master-key.ts", () => {
  let pg: StartedTestContainer;
  let url: string;
  const OLD = b64();
  const NEW = b64();
  const keys = { current: Buffer.from(NEW, "base64"), previous: Buffer.from(OLD, "base64") };

  async function db<T>(fn: (c: Client) => Promise<T>): Promise<T> {
    const c = new Client({ connectionString: url });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }
  const run = (apply: boolean, batch?: number) =>
    db((c) => rotateAll(c as unknown as MinimalClient, keys, { apply, batch }));

  beforeAll(async () => {
    pg = await new GenericContainer("postgres:16-alpine")
      .withEnvironment({ POSTGRES_USER: "test", POSTGRES_PASSWORD: "test", POSTGRES_DB: "aiq_test" })
      .withExposedPorts(5432)
      .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
      .withStartupTimeout(60_000)
      .start();
    url = `postgres://test:test@${pg.getHost()}:${pg.getMappedPort(5432)}/aiq_test`;
    await db((c) => applyAllMigrations(c));
  }, 120_000);
  afterAll(async () => {
    await pg?.stop();
  });

  it("dry-run verifies and changes nothing; apply rotates; re-run is a no-op", async () => {
    const tenant = randomUUID();
    const user = randomUUID();
    const embedId = randomUUID();
    const hookId = randomUUID();
    // Encrypt everything under the OLD key with the app's own encryptors.
    setKeys(OLD);
    const totp = encryptEnvelope(Buffer.from("totp-secret-bytes"));
    const embed = encryptEnvelope("embed-secret");
    const hook = webhookEncrypt("hook-secret");
    const settings = encryptEnvelope("tenant-webhook-secret").toString("base64");
    setKeys(ORIGINAL_KEY);

    await db(async (c) => {
      await c.query("INSERT INTO tenants (id, slug, name) VALUES ($1,$2,'T')", [tenant, `t-${tenant.slice(0, 8)}`]);
      await c.query("INSERT INTO users (id, tenant_id, email, name, role) VALUES ($1,$2,$3,'U','admin')", [user, tenant, `${user}@x.test`]);
      await c.query("INSERT INTO user_credentials (user_id, tenant_id, totp_secret_enc) VALUES ($1,$2,$3)", [user, tenant, totp]);
      await c.query("INSERT INTO embed_secrets (id, tenant_id, name, secret_enc) VALUES ($1,$2,'k',$3)", [embedId, tenant, embed]);
      await c.query("INSERT INTO webhook_endpoints (id, tenant_id, url, secret_enc, events) VALUES ($1,$2,'https://e.test/h',$3,ARRAY['x'])", [hookId, tenant, hook]);
      await c.query(
        "INSERT INTO tenant_settings (tenant_id, webhook_secret) VALUES ($1,$2) ON CONFLICT (tenant_id) DO UPDATE SET webhook_secret = EXCLUDED.webhook_secret",
        [tenant, settings],
      );
    });

    const snapshot = () =>
      db((c) =>
        c
          .query(
            "SELECT (SELECT totp_secret_enc FROM user_credentials WHERE user_id=$1) a, (SELECT secret_enc FROM embed_secrets WHERE id=$2) b, (SELECT secret_enc FROM webhook_endpoints WHERE id=$3) h, (SELECT webhook_secret FROM tenant_settings WHERE tenant_id=$4) s",
            [user, embedId, hookId, tenant],
          )
          .then((r) => r.rows[0]),
      );
    const before = await snapshot();

    const dry = await run(false, 1);
    expect(dry).toHaveLength(TARGETS.length);
    expect(dry.every((x) => x.undecryptable === 0 && x.already_new === 0 && x.rotated === x.total && x.total >= 1)).toBe(true);
    expect(await snapshot()).toEqual(before); // dry-run wrote nothing

    const applied = await run(true, 1);
    expect(applied.map((x) => x.rotated)).toEqual(dry.map((x) => x.rotated));
    const after = await snapshot();
    expect(after).not.toEqual(before);

    // The app, running with ONLY the new key (no PREVIOUS), reads every row.
    setKeys(NEW);
    expect(decryptEnvelope(after.a).toString("utf8")).toBe("totp-secret-bytes");
    expect(decryptEnvelope(after.b).toString("utf8")).toBe("embed-secret");
    expect(webhookDecrypt(after.h)).toBe("hook-secret");
    expect(decryptEnvelope(Buffer.from(after.s, "base64")).toString("utf8")).toBe("tenant-webhook-secret");
    setKeys(ORIGINAL_KEY);

    const again = await run(true);
    expect(again.every((x) => x.rotated === 0 && x.already_new === x.total)).toBe(true);
  });

  it("refuses to write anything when a row decrypts under neither key", async () => {
    const tenant = randomUUID();
    const bad = randomUUID();
    const good = randomUUID();
    setKeys(OLD);
    const goodEnv = encryptEnvelope("ok");
    setKeys(ORIGINAL_KEY);
    await db(async (c) => {
      await c.query("INSERT INTO tenants (id, slug, name) VALUES ($1,$2,'T2')", [tenant, `t-${tenant.slice(0, 8)}`]);
      await c.query("INSERT INTO embed_secrets (id, tenant_id, name, secret_enc) VALUES ($1,$2,'bad',$3),($4,$2,'good',$5)", [bad, tenant, randomBytes(48), good, goodEnv]);
    });
    const res = await run(true);
    expect(res.some((x) => x.undecryptable >= 1)).toBe(true);
    const row = await db((c) => c.query("SELECT secret_enc FROM embed_secrets WHERE id=$1", [good]));
    expect(Buffer.compare(row.rows[0].secret_enc, goodEnv)).toBe(0); // untouched
  });
});
