#!/usr/bin/env node
// Usage: node tools/next-brief.mjs
// Writes docs/NEXT.md (generated, never hand-edited). Node 20+, built-ins only.
// Sections: last SESSION_STATE block, ROADMAP status board, open Z/EXP rows,
// 5 newest RCA entries, next free migration number, reading reminder.
// Output is capped at ~30k tokens (bytes / 4). Lowest-priority sections shrink first.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN_LIMIT = 30000;
const SRC = {
  session: 'docs/SESSION_STATE.md',
  roadmap: 'docs/ROADMAP.md',
  rca: 'docs/RCA_LOG.md',
};
const OUT = join(ROOT, 'docs/NEXT.md');

export const splitLines = (text) => text.split(/\r?\n/);
export const estTokens = (text) => Math.ceil(Buffer.byteLength(text, 'utf8') / 4);

/** First session block: from the first "# Session" line up to the first "---" line. */
export function firstSessionBlock(lines) {
  const start = lines.findIndex((l) => l.startsWith('# Session'));
  if (start < 0) throw new Error('no "# Session" heading in SESSION_STATE');
  const end = lines.findIndex((l, i) => i > start && l.trim() === '---');
  if (end < 0) throw new Error('no "---" line after the newest session block');
  return lines.slice(start, end).map((l) => (l.startsWith('#') ? `#${l}` : l));
}

/** Body of the "## Status board" section (heading excluded), trailing blanks removed. */
export function statusBoard(lines) {
  const start = lines.findIndex((l) => /^## Status board/.test(l));
  if (start < 0) throw new Error('no "## Status board" section in ROADMAP');
  let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  if (end < 0) end = lines.length;
  const body = lines.slice(start + 1, end);
  while (body.length && body[body.length - 1].trim() === '') body.pop();
  return body;
}

/** Open Z/EXP rows: 7 cells, status (cell 5) begins "pending" or "partly". */
export function openRows(lines) {
  const out = [];
  for (const line of lines) {
    if (!/^\| (Z-|EXP-)/.test(line)) continue;
    const cells = line.split(' | ');
    if (cells.length !== 7) continue;
    const id = cells[0].replace(/^\|\s*/, '').trim();
    const idMatch = id.match(/^(Z-\d+|EXP-\d+)/);
    const title = (cells[2].match(/\*\*(.+?)\*\*/) || [, cells[2].slice(0, 80)])[1];
    const status = cells[4].replace(/\*\*/g, '').trim();
    if (!/^(pending|partly|partial|part )/i.test(status)) continue;
    out.push(`- \`${idMatch ? idMatch[1] : id}\` (${id}) — ${title} — ${status.slice(0, 120)}`);
  }
  return out;
}

/** RCA entries as {date, heading, symptom, prevention}; newest first by date. */
export function newestRca(lines, n) {
  const entries = [];
  lines.forEach((l, i) => {
    const m = l.match(/^## (\d{4}-\d{2}-\d{2}) — (.*)$/);
    if (!m) return;
    let end = lines.findIndex((x, j) => j > i && /^## /.test(x));
    if (end < 0) end = lines.length;
    const body = lines.slice(i + 1, end);
    const pick = (label) => {
      const hit = body.find((x) => x.startsWith(`**${label}:**`));
      return hit ? hit.slice(0, 300) : `**${label}:** (missing)`;
    };
    entries.push({ date: m[1], heading: l, symptom: pick('Symptom'), prevention: pick('Prevention'), pos: entries.length });
  });
  const dates = entries.map((e) => e.date);
  const desc = dates.every((d, i) => i === 0 || dates[i - 1] >= d);
  const asc = dates.every((d, i) => i === 0 || dates[i - 1] <= d);
  const order = desc ? 'newest at top' : asc ? 'newest at bottom' : 'mixed (sorted by date; same-day ties keep file order)';
  const sorted = [...entries].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.pos - b.pos));
  return { order, total: entries.length, items: sorted.slice(0, n) };
}

/** Highest 4-digit migration prefix + 1, zero-padded. */
export function nextMigration(fileNames) {
  let max = 0;
  for (const f of fileNames) {
    const m = f.match(/^(\d{4})_/);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return String(max + 1).padStart(4, '0');
}

function migrationFiles() {
  const modulesDir = join(ROOT, 'modules');
  const names = [];
  for (const mod of readdirSync(modulesDir)) {
    const dir = join(modulesDir, mod, 'migrations');
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) if (f.endsWith('.sql')) names.push(f);
  }
  return names;
}

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

function readSource(rel) {
  const p = join(ROOT, rel);
  if (!existsSync(p)) {
    console.error(`next-brief: missing source file ${rel}`);
    process.exit(1);
  }
  return splitLines(readFileSync(p, 'utf8'));
}

function ist(date) {
  const d = new Date(date.getTime() + 5.5 * 3600 * 1000).toISOString();
  return `${d.slice(0, 19).replace('T', ' ')} IST`;
}

function main() {
  const now = new Date();
  const session = firstSessionBlock(readSource(SRC.session));
  const board = statusBoard(readSource(SRC.roadmap));
  const zRowsAll = openRows(readSource(SRC.roadmap));
  const rca = newestRca(readSource(SRC.rca), 5);
  const sha = git(['rev-parse', '--short', 'HEAD']);
  const dirty = git(['status', '--short']).split('\n').filter(Boolean).length;
  const migNext = nextMigration(migrationFiles());
  const sessionText = session.join('\n');
  const sessionNext = (sessionText.match(/next free[^\n]*?(\d{4})/i) || [])[1];
  const migNote = sessionNext && sessionNext !== migNext
    ? `SESSION_STATE names next free ${sessionNext}; check before use.`
    : sessionNext ? 'Matches the newest SESSION_STATE block.' : 'SESSION_STATE block names no next number; computed from files.';

  let zCap = zRowsAll.length;
  let rcaN = rca.items.length;
  let sbCap = board.length;
  let notes = [];

  const render = () => {
    const out = [];
    out.push('# Next brief (generated)', '');
    out.push('GENERATED FILE - do not edit. Run: node tools/next-brief.mjs', '');
    out.push(`- Generated: ${now.toISOString()} (${ist(now)})`);
    out.push(`- HEAD: \`${sha}\`. If HEAD differs from \`git rev-parse --short HEAD\`, regenerate.`);
    out.push(`- Dirty files (\`git status --short\` lines): ${dirty}`, '');
    out.push('## 1. Last session (SESSION_STATE, first block)', '', ...session, '');
    out.push('## 2. ROADMAP status board', '', ...board.slice(0, sbCap), '');
    out.push(`## 3. Open Z and EXP rows (${zRowsAll.length} total)`, '');
    out.push(...zRowsAll.slice(0, zCap));
    if (zCap < zRowsAll.length) out.push(`- ... ${zRowsAll.length - zCap} more rows: see docs/ROADMAP.md`);
    out.push('');
    out.push(`## 4. Newest RCA entries (5 newest of ${rca.total}; file order: ${rca.order})`, '');
    for (const e of rca.items.slice(0, rcaN)) out.push(`### ${e.heading.slice(3)}`, e.symptom, e.prevention, '');
    out.push('## 5. Next free migration', '', `- Next free: \`${migNext}\` (highest \`modules/*/migrations\` prefix + 1)`, `- ${migNote}`, '');
    out.push('## 6. Reading list reminder', '', 'Still read PROJECT_BRAIN.md and docs/RCA_LOG.md (CLAUDE.md Phase 0).', '');
    if (notes.length) out.push('## Truncation', '', ...notes.map((n) => `- ${n}`), '');
    return out.join('\n');
  };

  let text = render();
  while (estTokens(text) > TOKEN_LIMIT) {
    if (zCap > 0) zCap = Math.floor(zCap / 2);
    else if (rcaN > 1) rcaN -= 1;
    else if (sbCap > 10) sbCap = Math.floor(sbCap / 2);
    else break;
    notes = [`Truncated to stay under ~${TOKEN_LIMIT} tokens: open rows ${zCap}, RCA ${rcaN}, board lines ${sbCap}.`];
    text = render();
  }
  if (notes.length) console.log(`next-brief: ${notes[0]}`);

  writeFileSync(OUT, text.endsWith('\n') ? text : `${text}\n`, 'utf8');
  const bytes = Buffer.byteLength(text, 'utf8');
  console.log(`next-brief: wrote ${OUT}`);
  console.log(`output size: ${bytes} bytes, ~${estTokens(text)} tokens (estimate: bytes / 4)`);
}

main();
