/**
 * Shared test helper: apply EVERY modules/star/migrations/*.sql to a fresh
 * Postgres, so DB-backed tests never have to hand-pick migration files (which
 * rots every time a migration lands).
 *
 * Ordering (fresh-DB dependency order; plain lexical order — what tools/migrate.ts
 * uses against an already-bootstrapped DB — would run 0010 before `users` exists):
 *   group 0: numeric prefix <= 4   (02-tenancy 0001-0004)
 *   group 1: 3-digit prefix >= 20  (03-users 020-021)
 *   group 2: other 3-digit prefix  (01-auth 010-016)
 *   group 3: 4-digit prefix        (everything else, numerically)
 * then by numeric prefix, then by basename. Same rule as aptitude-seed-migration.test.ts.
 *
 * Also creates the roles the migrations GRANT to (assessiq_app, assessiq_system)
 * and grants them to the connected user, as every hand-rolled setup did.
 */
import { readdir, readFile } from "node:fs/promises";
import { basename, join, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "pg";

const MODULES = join(dirname(fileURLToPath(import.meta.url)) + sep, "..", "..", "modules");

function key(f: string): [number, number, string] {
  const name = basename(f);
  const prefix = name.split("_")[0]!;
  const n = parseInt(prefix, 10);
  return [n <= 4 ? 0 : prefix.length === 3 ? (n >= 20 ? 1 : 2) : 3, n, name];
}

export async function allMigrationFiles(): Promise<string[]> {
  const files: string[] = [];
  for (const m of await readdir(MODULES, { withFileTypes: true })) {
    if (!m.isDirectory() || m.name === "node_modules") continue;
    const dir = join(MODULES, m.name, "migrations");
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      continue;
    }
    for (const e of entries) if (e.endsWith(".sql")) files.push(join(dir, e));
  }
  return files.sort((a, b) => {
    const [ga, na, sa] = key(a);
    const [gb, nb, sb] = key(b);
    return ga - gb || na - nb || sa.localeCompare(sb);
  });
}

export async function createAppRoles(client: Client): Promise<void> {
  await client.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'assessiq_app') THEN CREATE ROLE assessiq_app; END IF; END $$;`);
  await client.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'assessiq_system') THEN CREATE ROLE assessiq_system BYPASSRLS; END IF; END $$;`);
  await client.query(`GRANT assessiq_app TO CURRENT_USER`);
  await client.query(`GRANT assessiq_system TO CURRENT_USER`);
}

/** `client` must be a superuser connection to an empty database. */
export async function applyAllMigrations(client: Client): Promise<void> {
  // The postgres image logs "ready" twice (init server, then final); on a loaded host the
  // first connection can land while it is still "starting up" — retry that one error.
  for (let i = 0; ; i++) {
    try {
      await createAppRoles(client);
      break;
    } catch (e) {
      if (i >= 40 || !/starting up/.test((e as Error).message)) throw e;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  for (const f of await allMigrationFiles()) {
    try {
      await client.query(await readFile(f, "utf8"));
    } catch (e) {
      throw new Error(`migration ${basename(f)} failed: ${(e as Error).message}`);
    }
  }
}
