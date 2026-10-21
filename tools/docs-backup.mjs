#!/usr/bin/env node
// Zips the whole docs/ folder (docs/private/ included) into a backup folder, then keeps only the newest N zips there.
// Usage: node tools/docs-backup.mjs [--root <dir>] [--dest <dir>] [--keep 5]
// Default dest: <home>\Backups (C:\Users\<user>\Backups on Windows). Only assessiq-docs-*.zip files in dest are pruned.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const a = process.argv.slice(2);
const opt = (n) => (a.includes(n) ? a[a.indexOf(n) + 1] : undefined);
const root = resolve(opt("--root") ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
const dest = resolve(opt("--dest") ?? join(homedir(), "Backups"));
const keep = Number(opt("--keep") ?? 5);
const fail = (m) => { console.error(`docs-backup: ${m}`); process.exit(1); };
if (!Number.isInteger(keep) || keep < 1) fail("--keep must be a whole number of 1 or more");

const docs = join(root, "docs");
if (!existsSync(docs)) {
  console.log("docs-backup: skipped, no docs/ folder");
  process.exit(0);
}

const p2 = (n) => String(n).padStart(2, "0");
const d = new Date();
const stamp = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}`;
const zip = join(dest, `assessiq-docs-${stamp}.zip`);

mkdirSync(dest, { recursive: true });
if (existsSync(zip)) rmSync(zip);
const quote = (s) => `'${s.replace(/'/g, "''")}'`;
const r = process.platform === "win32"
  ? spawnSync("powershell", ["-NoProfile", "-Command", `Compress-Archive -Path ${quote(docs)} -DestinationPath ${quote(zip)} -Force`], { encoding: "utf8" })
  : spawnSync("zip", ["-r", "-q", zip, "docs"], { cwd: root, encoding: "utf8" });
if (r.error || r.status !== 0 || !existsSync(zip)) {
  const why = r.error?.message ?? `${r.stderr ?? ""}`.trim().split(/\r?\n/).slice(-2).join(" ");
  fail(`zipping failed${why ? `: ${why}` : ""}`);
}

// Names carry a sortable timestamp, so a name sort is a time sort. Prune only our own zips.
const old = readdirSync(dest)
  .filter((f) => /^assessiq-docs-.*\.zip$/.test(f) && statSync(join(dest, f)).isFile())
  .sort()
  .reverse();
const pruned = old.slice(keep);
for (const f of pruned) rmSync(join(dest, f));

const mb = (statSync(zip).size / 1048576).toFixed(2);
console.log(`docs-backup: wrote ${zip} (${mb} MB)`);
console.log(`docs-backup: kept ${Math.min(old.length, keep)} zip(s), removed ${pruned.length} older zip(s)`);
