/**
 * tools/rotate-master-key.ts   (E8)
 *
 * Re-encrypt every AES-256-GCM secret at rest from the PREVIOUS master key to the
 * CURRENT one. Operator procedure: docs/06-deployment.md § "MASTER_KEY rotation (E8)".
 *
 * Env (read directly; this file does not import @assessiq/core for the keys):
 *   ASSESSIQ_MASTER_KEY            new key, base64, 32 bytes
 *   ASSESSIQ_MASTER_KEY_PREVIOUS   old key, base64, 32 bytes (required)
 *   DATABASE_URL
 *
 * Usage (inside the assessiq-api container, like the other tools/):
 *   pnpm exec tsx /app/tools/rotate-master-key.ts              # dry-run (default): counts + verifies, writes nothing
 *   pnpm exec tsx /app/tools/rotate-master-key.ts --apply      # re-encrypt
 *   [--batch <n>]                                         # rows per transaction, default 200
 *
 * Per row: decrypts under the NEW key -> already rotated, skipped. Else decrypts under the
 * OLD key -> rotated. Else UNDECRYPTABLE -> the run refuses to write anything and exits 1.
 * Re-running is safe (idempotent). Output is counts only; plaintext is never printed.
 *
 * RLS: like tools/cleanup-stale-drafts.ts, each transaction does `SET LOCAL ROLE
 * assessiq_system` (BYPASSRLS, NOLOGIN, transaction-scoped) because this is a cross-tenant
 * ops sweep with no request context. Run only from trusted operator shell access.
 *
 * Exit: 0 ok | 1 undecryptable rows found | 2 usage / env / DB error.
 */

/* eslint-disable no-console */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

// "A" = nonce(12)||ct||tag(16)  (modules/01-auth/src/crypto-util.ts)
// "B" = iv(12)||tag(16)||ct     (modules/13-notifications/src/webhooks/crypto.ts)
type Layout = "A" | "B";
type Encoding = "bytea" | "b64text";

export interface Target {
  table: string;
  pk: string;
  col: string;
  layout: Layout;
  encoding: Encoding;
}

// Every encrypted-at-rest column in the schema. Adding a new one without listing it here
// means rotation would strand it: keep in sync (docs/06-deployment.md lists the same four).
export const TARGETS: readonly Target[] = [
  { table: "user_credentials", pk: "user_id", col: "totp_secret_enc", layout: "A", encoding: "bytea" },
  { table: "embed_secrets", pk: "id", col: "secret_enc", layout: "A", encoding: "bytea" },
  { table: "webhook_endpoints", pk: "id", col: "secret_enc", layout: "B", encoding: "bytea" },
  { table: "tenant_settings", pk: "tenant_id", col: "webhook_secret", layout: "A", encoding: "b64text" },
];

const N = 12;
const T = 16;

function open(env: Buffer, key: Buffer, layout: Layout): Buffer {
  if (env.length < N + T) throw new Error("envelope too short");
  const nonce = env.subarray(0, N);
  const tag = layout === "A" ? env.subarray(env.length - T) : env.subarray(N, N + T);
  const ct = layout === "A" ? env.subarray(N, env.length - T) : env.subarray(N + T);
  const d = createDecipheriv("aes-256-gcm", key, nonce);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}

function seal(plain: Buffer, key: Buffer, layout: Layout): Buffer {
  const nonce = randomBytes(N);
  const c = createCipheriv("aes-256-gcm", key, nonce);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  const tag = c.getAuthTag();
  return layout === "A" ? Buffer.concat([nonce, ct, tag]) : Buffer.concat([nonce, tag, ct]);
}

const tryOpen = (env: Buffer, key: Buffer, layout: Layout): Buffer | null => {
  try {
    return open(env, key, layout);
  } catch {
    return null;
  }
};

export interface Counts {
  table: string;
  total: number;
  already_new: number;
  rotated: number; // dry-run: "would rotate"
  undecryptable: number;
}

export interface MinimalClient {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query<R = Record<string, any>>(text: string, values?: unknown[]): Promise<{ rows: R[] }>;
}

interface Row {
  pk: string;
  v: Buffer | string;
}

const toBuf = (v: Buffer | string, enc: Encoding): Buffer =>
  enc === "bytea" ? (v as Buffer) : Buffer.from(v as string, "base64");
const fromBuf = (b: Buffer, enc: Encoding): Buffer | string => (enc === "bytea" ? b : b.toString("base64"));

/**
 * Pass 1 (always, read-only): classify every row. Pass 2 (apply, only if nothing is
 * undecryptable): rewrite rows batch by batch, one transaction per batch.
 * `client` must be a dedicated connection (not pooled-and-shared) because it runs BEGIN/COMMIT.
 */
export async function rotateAll(
  client: MinimalClient,
  keys: { current: Buffer; previous: Buffer },
  opts: { apply: boolean; batch?: number | undefined },
): Promise<Counts[]> {
  const batch = opts.batch ?? 200;
  const results: Counts[] = [];

  for (const t of TARGETS) {
    const counts: Counts = { table: `${t.table}.${t.col}`, total: 0, already_new: 0, rotated: 0, undecryptable: 0 };

    // Pass 1 - read-only classification, keyset-paginated.
    await client.query("BEGIN READ ONLY");
    try {
      await client.query("SET LOCAL ROLE assessiq_system");
      let last: string | null = null;
      for (;;) {
        const { rows }: { rows: Row[] } = await client.query<Row>(
          `SELECT ${t.pk}::text AS pk, ${t.col} AS v FROM ${t.table}
            WHERE ${t.col} IS NOT NULL AND ($1::text IS NULL OR ${t.pk}::text > $1)
            ORDER BY ${t.pk}::text LIMIT $2`,
          [last, batch],
        );
        if (rows.length === 0) break;
        for (const r of rows) {
          counts.total++;
          const env = toBuf(r.v, t.encoding);
          if (tryOpen(env, keys.current, t.layout)) counts.already_new++;
          else if (tryOpen(env, keys.previous, t.layout)) counts.rotated++;
          else counts.undecryptable++;
        }
        last = rows[rows.length - 1]!.pk;
      }
    } finally {
      await client.query("ROLLBACK");
    }
    results.push(counts);
  }

  if (!opts.apply || results.some((c) => c.undecryptable > 0)) return results;

  // Pass 2 - write. Re-verifies under the row lock, so a row changed since pass 1 is handled correctly.
  for (const t of TARGETS) {
    let last: string | null = null;
    for (;;) {
      await client.query("BEGIN");
      try {
        await client.query("SET LOCAL ROLE assessiq_system");
        const { rows }: { rows: Row[] } = await client.query<Row>(
          `SELECT ${t.pk}::text AS pk, ${t.col} AS v FROM ${t.table}
            WHERE ${t.col} IS NOT NULL AND ($1::text IS NULL OR ${t.pk}::text > $1)
            ORDER BY ${t.pk}::text LIMIT $2 FOR UPDATE`,
          [last, batch],
        );
        for (const r of rows) {
          const env = toBuf(r.v, t.encoding);
          if (tryOpen(env, keys.current, t.layout)) continue; // already new
          const plain = tryOpen(env, keys.previous, t.layout);
          if (!plain) throw new Error(`${t.table}: row became undecryptable mid-run`);
          await client.query(`UPDATE ${t.table} SET ${t.col} = $1 WHERE ${t.pk}::text = $2`, [
            fromBuf(seal(plain, keys.current, t.layout), t.encoding),
            r.pk,
          ]);
        }
        await client.query("COMMIT");
        if (rows.length === 0) break;
        last = rows[rows.length - 1]!.pk;
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw err;
      }
    }
  }
  return results;
}

function loadKey(name: string): Buffer {
  const raw = process.env[name];
  const b = raw ? Buffer.from(raw, "base64") : Buffer.alloc(0);
  if (b.length !== 32) {
    process.stderr.write(`${name} must be set to a base64 string that decodes to exactly 32 bytes.\n`);
    process.exit(2);
  }
  return b;
}

async function main(): Promise<void> {
  let values: { apply?: boolean; batch?: string };
  try {
    ({ values } = parseArgs({
      args: process.argv.slice(2),
      options: { apply: { type: "boolean", default: false }, "dry-run": { type: "boolean" }, batch: { type: "string", default: "200" } },
      strict: true,
    }) as unknown as { values: { apply?: boolean; batch?: string } });
  } catch (err) {
    process.stderr.write(`Usage error: ${err instanceof Error ? err.message : String(err)}\nUsage: rotate-master-key.ts [--dry-run | --apply] [--batch <n>]\n`);
    process.exit(2);
  }
  const batch = parseInt(values.batch ?? "200", 10);
  if (!Number.isFinite(batch) || batch < 1) {
    process.stderr.write("--batch must be a positive integer.\n");
    process.exit(2);
  }
  const apply = values.apply === true;
  const keys = { current: loadKey("ASSESSIQ_MASTER_KEY"), previous: loadKey("ASSESSIQ_MASTER_KEY_PREVIOUS") };
  if (keys.current.equals(keys.previous)) {
    process.stderr.write("ASSESSIQ_MASTER_KEY and ASSESSIQ_MASTER_KEY_PREVIOUS are identical; nothing to rotate.\n");
    process.exit(2);
  }
  if (!process.env["DATABASE_URL"]) {
    process.stderr.write("DATABASE_URL not set - run from inside the api container.\n");
    process.exit(2);
  }

  const { getPool, closePool } = await import("@assessiq/tenancy");
  const client = await getPool().connect();
  let code = 0;
  try {
    const results = await rotateAll(client as unknown as MinimalClient, keys, { apply, batch });
    for (const c of results) {
      console.log(`${c.table.padEnd(40)} total=${c.total} already_new=${c.already_new} ${apply ? "rotated" : "would_rotate"}=${c.rotated} undecryptable=${c.undecryptable}`);
    }
    if (results.some((c) => c.undecryptable > 0)) {
      console.log("ABORTED: undecryptable rows exist under both keys; nothing was written.");
      code = 1;
    } else console.log(apply ? "Applied." : "Dry-run only; re-run with --apply to write.");
  } catch (err) {
    process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
    code = 2;
  } finally {
    client.release();
    await closePool().catch(() => undefined);
  }
  process.exit(code);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
