#!/usr/bin/env node
// Z-106: the repo is public. Fail when tracked text holds a host name of the real server, a public IPv4,
// an amount with a currency, or when a private file is tracked. Rules print by name only, never the value.
// Usage: node tools/check-docs-privacy.mjs [--staged] [--warn]   (run from the repo root)
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// Owner approval pending, remove after: files that may hold these patterns on purpose.
const ALLOW = new Set([
  "CLAUDE.md",
  "infra/caddyfile/assessiq.snippet",
  "tools/check-docs-privacy.mjs",
  "tools/__tests__/docs-guards.test.ts",
]);
// Known debt, found when the guard was added (Z-106). Owner approval pending, remove after cleanup.
// Each entry is "path|rule"; the rule is skipped for that file only.
// docs/ entries were removed on 2026-10-21: docs/ is no longer tracked, so the scan does not see it.
const KNOWN = new Set([
]);
// Amounts and IPs only matter in prose/config files. In code they are SQL placeholders ($10), test fixtures and quiz content.
const PROSE = /\.(md|mdx|astro|html|txt|ya?ml|snippet|sh|conf)$|(^|\/)\.env/i;
const ALLOW_PATH_ONLY = new Set(["docs/moves.json"]); // exempt from rule (d) only

const SKIP_EXT = /\.(png|jpe?g|gif|webp|ico|pdf|docx?|xlsx?|pptx?|zip|gz|woff2?|ttf|eot|mp4|webm|lock|svg)$|(^|\/)pnpm-lock\.yaml$/i;
const OCTET = String.raw`(?:25[0-5]|2[0-4]\d|1?\d?\d)`;
const IP_RE = new RegExp(String.raw`(?<![\w./])(${OCTET})\.(${OCTET})\.(${OCTET})\.(${OCTET})(?![\w]|\.\d)`, "g");
const RULES = [
  ["host-name", /srv\d{6,}\.hstgr\.cloud/i],
  // `$` needs 2+ digits so `$1` placeholders do not fire; `$10` style regex/SQL is rare in docs.
  ["currency-amount", /₹\s?\d|(?<![\w/+=])Rs\.?\s?\d|\bINR\s?\d|\bUSD\s?\d|(?<![\w$])\$\s?\d{2,}/],
];

function privateIp(m) {
  const [a, b, c] = [+m[1], +m[2], +m[3]];
  return (
    a === 10 || a === 127 || a === 0 || a >= 255 ||
    (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254) ||
    (a === 192 && b === 0 && c === 2) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113)
  );
}

export function scanLine(line, file = "x.md") {
  const hits = RULES.filter(([n, re]) => (n === "host-name" || PROSE.test(file)) && re.test(line)).map(([n]) => n);
  if (PROSE.test(file)) for (const m of line.matchAll(IP_RE)) if (!privateIp(m)) { hits.push("public-ip"); break; }
  return hits.filter((r) => !KNOWN.has(`${file}|${r}`));
}

export const privatePath = (p) => p.startsWith("docs/private/") || /(^|\/)PRIVATE_[^/]*$/.test(p);

const git = (...a) => execFileSync("git", a, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });

export function scan(staged) {
  const out = [];
  const add = (f, l, r) => out.push(`${f}:${l}: ${r}`);
  if (staged) {
    for (const p of git("diff", "--cached", "--name-only", "--diff-filter=AR").split("\n").filter(Boolean)) {
      if (privatePath(p) && !ALLOW_PATH_ONLY.has(p) && !ALLOW.has(p)) add(p, 0, "private-path");
    }
    let file = null, n = 0;
    for (const l of git("diff", "--cached", "-U0", "--no-color").split("\n")) {
      let m;
      if (l.startsWith("+++ ")) file = l.startsWith("+++ b/") ? l.slice(6) : null;
      else if ((m = /^@@ -\S+ \+(\d+)/.exec(l))) n = +m[1];
      else if (l.startsWith("+") && file) {
        if (!ALLOW.has(file) && !SKIP_EXT.test(file)) for (const r of scanLine(l.slice(1), file)) add(file, n, r);
        n++;
      }
    }
    return out;
  }
  for (const p of git("ls-files").split("\n").filter(Boolean)) {
    if (privatePath(p) && !ALLOW_PATH_ONLY.has(p) && !ALLOW.has(p)) add(p, 0, "private-path");
    if (ALLOW.has(p) || SKIP_EXT.test(p)) continue;
    let buf;
    try { buf = readFileSync(p); } catch { continue; }
    if (buf.includes(0)) continue;
    buf.toString("utf8").split(/\r?\n/).forEach((l, i) => { for (const r of scanLine(l, p)) add(p, i + 1, r); });
  }
  return out;
}

if (process.argv[1]?.endsWith("check-docs-privacy.mjs")) {
  const findings = scan(process.argv.includes("--staged"));
  for (const f of findings) console.log(f);
  console.log(`docs-privacy: ${findings.length} finding(s)`);
  process.exit(findings.length && !process.argv.includes("--warn") ? 1 : 0);
}
