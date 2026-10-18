#!/usr/bin/env node
// Z-66: routing report. Reads routing telemetry from docs/SESSION_STATE.md and docs/sessions/*.md
// and prints runs, reworked count and rate per model route, plus the Haiku 5.5 trial stop rule.
// TOK-6/7: --since YYYY-MM-DD sets the date for the Haiku trial section (default TRIAL_START).
// Runs take the date of the "# Session — YYYY-MM-DD" header above them. Undated runs are excluded from the trial.
// Usage: node tools/routing-report.mjs [--json] [--since YYYY-MM-DD]
// Exit 0 always, exit 1 only when no session file exists, exit 2 on a bad --since value.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STATE_FILE = join(ROOT, "docs", "SESSION_STATE.md");
const SESSIONS_DIR = join(ROOT, "docs", "sessions");

export const ROUTE_NAMES = ["Opus", "Sonnet", "Haiku", "Codex", "Gemini"];
export const STOP_MIN_RUNS = 8;
export const STOP_RATE = 0.25;
// The Haiku 5.5 trial counts only runs dated on or after this day (TOK-6).
export const TRIAL_START = "2026-10-18";
// Session header with a date, e.g. "# Session — 2026-10-18 — S26" or "# Session S22 (2026-10-18): ...".
const SESSION_HEADER = /^#{1,6}\s+Session\b.*?(\d{4}-\d{2}-\d{2})/;
const GATE_RE = /gate|review|takeover/i;

// Route word, optional "5.5" (Haiku 5.5), optional "(exec)" or "(agy)" suffix.
const ROUTE = "(Opus|Sonnet|Haiku|Codex|Gemini)(?:\\s+5\\.5)?(?:\\s*\\([^)]*\\))?";
// Footer form: "- Sonnet · task · reworked: Y (why)". Global, so packed lines give several runs.
const TELEMETRY = new RegExp(`${ROUTE}\\s*·\\s*(.+?)\\s*·\\s*reworked:\\s*([YyNn])\\b`, "gi");
// Prose form: "- Sonnet: task 117k tokens (reworked: N)".
const PROSE = new RegExp(`^\\s*(?:[-*]\\s+)?${ROUTE}\\s*:\\s*(.*)$`, "i");
const REWORKED_ANY = /reworked:\s*[YyNn]\b/gi;
const TOKENS_RAW = /(?:subagent_)?tokens:\s*(\d[\d,]*(?:\.\d+)?)\s*(k)?/i;
const TOKENS_K = /(\d+(?:\.\d+)?)\s*k\s+tokens/i;

function normRoute(word) {
  const m = /^(Opus|Sonnet|Haiku|Codex|Gemini)/i.exec(word.trim());
  const w = m[1].toLowerCase();
  return w.charAt(0).toUpperCase() + w.slice(1);
}

function tokensOf(text) {
  const raw = TOKENS_RAW.exec(text);
  if (raw) {
    const n = Number(raw[1].replace(/,/g, ""));
    return Math.round(raw[2] ? n * 1000 : n);
  }
  const k = TOKENS_K.exec(text);
  return k ? Math.round(Number(k[1]) * 1000) : null;
}

function makeRun(route, task, reworked, text) {
  const cleanTask = task.replace(/\(\s*$/, "").replace(/[\s·,;(]+$/, "").trim();
  return {
    route,
    task: cleanTask,
    reworked: reworked.toUpperCase() === "Y",
    gate: GATE_RE.test(cleanTask),
    tokens: tokensOf(text),
  };
}

/** Parse one line of a session file. Returns zero or more runs. */
export function parseLine(line) {
  const prose = PROSE.exec(line);
  if (prose) {
    const route = normRoute(prose[1]);
    const body = prose[2];
    if (route === "Codex" && /^rescue\b/i.test(body)) return []; // "codex:rescue:" is a status line
    const count = (body.match(REWORKED_ANY) || []).length;
    if (count === 0) return [];
    // One reworked label: the whole body is one run. Several: split on ";" (one run per part).
    const parts = count === 1 ? [body] : body.split(";");
    return parts
      .filter((p) => /reworked:/i.test(p))
      .map((p) => makeRun(route, p.split(/reworked:/i)[0], /reworked:\s*([YyNn])/i.exec(p)[1], p));
  }
  const matches = [...line.matchAll(TELEMETRY)];
  return matches.map((m, i) => {
    const end = i + 1 < matches.length ? matches[i + 1].index : line.length;
    return makeRun(normRoute(m[1]), m[2], m[3], line.slice(m.index, end));
  });
}

/** Parse a whole file body. Handles CRLF and LF. Each run gets the date of the session header above it (or null). */
export function parseText(text) {
  let date = null;
  const runs = [];
  for (const line of text.split(/\r?\n/)) {
    const header = SESSION_HEADER.exec(line);
    if (header) {
      date = header[1];
      continue;
    }
    for (const run of parseLine(line)) runs.push({ ...run, date });
  }
  return runs;
}

/** Per-route totals and the Haiku 5.5 trial verdict. The trial uses runs dated on or after `since`. */
export function summarize(runs, since = TRIAL_START) {
  const routes = ROUTE_NAMES.map((name) => {
    const rs = runs.filter((r) => r.route === name);
    const reworked = rs.filter((r) => r.reworked).length;
    const known = rs.filter((r) => r.tokens !== null);
    return {
      route: name,
      runs: rs.length,
      reworked,
      rate: rs.length ? reworked / rs.length : null,
      tokens: known.length ? known.reduce((sum, r) => sum + r.tokens, 0) : null,
      tokenRuns: known.length,
    };
  });
  const allHaiku = runs.filter((r) => r.route === "Haiku");
  const haiku = allHaiku.filter((r) => r.date && r.date >= since);
  const files = {};
  for (const r of haiku) files[r.file ?? "(unknown)"] = (files[r.file ?? "(unknown)"] ?? 0) + 1;
  const undated = allHaiku.filter((r) => !r.date).length;
  const before = allHaiku.filter((r) => r.date && r.date < since).length;
  const nonGate = haiku.filter((r) => !r.gate);
  const nonGateReworked = nonGate.filter((r) => r.reworked).length;
  const nonGateRate = nonGate.length ? nonGateReworked / nonGate.length : null;
  let result;
  if (haiku.length < STOP_MIN_RUNS) result = `TOO FEW RUNS (${haiku.length} of ${STOP_MIN_RUNS})`;
  else if (nonGate.length === 0) result = `TOO FEW RUNS (0 of ${STOP_MIN_RUNS} non-gate)`;
  else result = nonGateRate > STOP_RATE ? "STOP" : "CONTINUE";
  return {
    routes,
    haikuTrial: {
      since,
      runs: haiku.length,
      files,
      undated,
      before,
      nonGateRuns: nonGate.length,
      nonGateReworked,
      nonGateRate,
      result,
    },
  };
}

function sourceFiles() {
  const files = [];
  if (existsSync(STATE_FILE)) files.push(STATE_FILE);
  if (existsSync(SESSIONS_DIR)) {
    for (const f of readdirSync(SESSIONS_DIR).filter((n) => n.endsWith(".md")).sort()) {
      files.push(join(SESSIONS_DIR, f));
    }
  }
  return files;
}

const pct = (x) => (x === null ? "-" : `${Math.round(x * 100)}%`);

function printTable(files, summary) {
  const { routes, haikuTrial: h } = summary;
  const lines = [`Routing report (Z-66). Sources: ${files.map((f) => relative(ROOT, f).replace(/\\/g, "/")).join(", ")}`, ""];
  lines.push("Route    Runs  Reworked Y  Rate  Tokens (known)");
  for (const r of routes) {
    const tok = r.tokens === null ? "n/a" : `${r.tokens} (${r.tokenRuns} of ${r.runs} runs)`;
    lines.push(
      `${r.route.padEnd(8)} ${String(r.runs).padStart(4)}  ${String(r.reworked).padStart(10)}  ${pct(r.rate).padStart(4)}  ${tok}`,
    );
  }
  lines.push("");
  lines.push(`Haiku 5.5 trial start: ${h.since} (TRIAL_START; --since overrides)`);
  lines.push(
    `Haiku 5.5 trial: runs ${h.runs}, non-gate runs ${h.nonGateRuns}, non-gate reworked ${h.nonGateReworked}, non-gate rework rate ${pct(h.nonGateRate)}`,
  );
  const fileList = Object.entries(h.files).map(([f, n]) => `${f} ${n}`).join(", ") || "none";
  lines.push(`Trial runs by file: ${fileList}`);
  lines.push(`Haiku runs excluded: ${h.before} dated before ${h.since}, ${h.undated} with no session date`);
  lines.push(`Stop rule (STOP if non-gate rework > 25% after ${STOP_MIN_RUNS} runs): ${h.result}`);
  return lines.join("\n");
}

function sinceArg(argv) {
  const i = argv.findIndex((a) => a === "--since" || a.startsWith("--since="));
  if (i < 0) return TRIAL_START;
  const raw = argv[i].includes("=") ? argv[i].split("=")[1] : argv[i + 1];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw ?? "")) throw new Error("--since needs a date as YYYY-MM-DD");
  return raw;
}

function main() {
  const asJson = process.argv.includes("--json");
  let since;
  try {
    since = sinceArg(process.argv);
  } catch (err) {
    process.stderr.write(`routing-report: ${err.message}\n`);
    process.exit(2);
  }
  const files = sourceFiles();
  if (files.length === 0) {
    process.stderr.write("routing-report: no session files found (docs/SESSION_STATE.md, docs/sessions/*.md)\n");
    process.exit(1);
  }
  const runs = files.flatMap((f) =>
    parseText(readFileSync(f, "utf8")).map((r) => ({ ...r, file: relative(ROOT, f).replace(/\\/g, "/") })),
  );
  const summary = summarize(runs, since);
  if (asJson) {
    const out = { files: files.map((f) => relative(ROOT, f).replace(/\\/g, "/")), ...summary };
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  } else {
    process.stdout.write(`${printTable(files, summary)}\n`);
  }
}

if (!process.env.VITEST) main();
