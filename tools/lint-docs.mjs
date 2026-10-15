#!/usr/bin/env node
/**
 * Docs lint (RW-85). Plain Node, no dependencies. See docs/STYLE.md.
 *
 * Mapping so Vale can read non-Markdown copy (written to a temp dir):
 *   modules/16-help-system/content/en/*.yml  -> one .md per file; each entry becomes
 *       a "## <help_id>" heading, its short_text a paragraph, its long_md body as is.
 *   modules/13-notifications/src/email/templates/*.txt -> one .md per template;
 *       "{{placeholder}}" becomes "X" so Vale does not trip on braces.
 *
 * Checks: (1) page type line under the H1 of docs/*.md and README.md;
 *         (2) vale and markdownlint-cli2 when installed.
 * Advisory (exit 0) until REQUIRED_FROM; strict after that, or with --strict.
 */
import { readdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const REQUIRED_FROM = '2026-10-29';
const strict = process.argv.includes('--strict') || new Date().toISOString().slice(0, 10) >= REQUIRED_FROM;
const TYPE_RE = /^\*Type: (tutorial|how-to|reference|explanation)\*/;
let findings = 0;

// 1. Type line
const skip = /^docs\/(plans\/archive\/|SESSION_STATE\.md|RCA_LOG\.md)/;
const pages = ['README.md', ...readdirSync('docs').filter((f) => f.endsWith('.md')).map((f) => `docs/${f}`)].filter((p) => !skip.test(p));
const missing = [];
for (const p of pages) {
  const lines = readFileSync(p, 'utf8').split(/\r?\n/);
  const h1 = lines.findIndex((l) => /^# /.test(l));
  const next = h1 < 0 ? undefined : lines.slice(h1 + 1).find((l) => l.trim() !== '');
  if (!next || !TYPE_RE.test(next)) missing.push(p);
}
console.log(`type line: ${missing.length} of ${pages.length} pages missing`);
if (missing.length) console.log(missing.map((p) => `  - ${p}`).join('\n'));
findings += missing.length;

// 2. Map YAML and email copy to Markdown
const tmp = mkdtempSync(join(tmpdir(), 'lint-docs-'));
const helpDir = 'modules/16-help-system/content/en';
let mapped = 0;
if (existsSync(helpDir)) {
  for (const f of readdirSync(helpDir).filter((x) => x.endsWith('.yml'))) {
    const out = [];
    let key = null;
    let inLong = false;
    for (const line of readFileSync(join(helpDir, f), 'utf8').split(/\r?\n/)) {
      let m;
      if ((m = /^([\w.-]+):\s*$/.exec(line))) { key = m[1]; inLong = false; out.push(`\n## ${key}\n`); }
      else if (key && (m = /^ {2}short_text:\s*"?(.*?)"?\s*$/.exec(line))) { inLong = false; out.push(m[1] + '\n'); }
      else if (key && /^ {2}long_md:\s*[|>]/.test(line)) inLong = true;
      else if (inLong && (line.startsWith('    ') || line.trim() === '')) out.push(line.slice(4));
      else if (/^ {2}\w+:/.test(line)) inLong = false;
    }
    writeFileSync(join(tmp, `help-${f}.md`), `# ${f}\n${out.join('\n')}\n`);
    mapped++;
  }
}
const emailDir = 'modules/13-notifications/src/email/templates';
if (existsSync(emailDir)) {
  for (const f of readdirSync(emailDir).filter((x) => x.endsWith('.txt'))) {
    const body = readFileSync(join(emailDir, f), 'utf8').replace(/\{\{[^}]*\}\}/g, 'X').replace(/^Subject:\s*/, '');
    writeFileSync(join(tmp, `email-${f}.md`), `# ${f}\n\n${body}\n`);
    mapped++;
  }
}
console.log(`mapped ${mapped} copy files to ${tmp}`);

// 3. External tools
const run = (name, cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', shell: process.platform === 'win32' });
  const out = (r.stdout || '') + (r.stderr || '');
  if (r.error || r.status === 127 || (r.status !== 0 && /not recognized|not found|command not found|could not determine executable|missing packages/i.test(out) && !r.stdout)) {
    console.log(`${name}: not installed, skipped`);
    return;
  }
  console.log(`${name}: exit ${r.status}`);
  console.log(out.trim().split('\n').slice(-8).join('\n'));
  if (r.status) findings += 1;
};
run('vale', 'vale', ['--config=.vale.ini', '--minAlertLevel=warning', ...pages.filter((p) => !skip.test(p)), tmp]);
run('markdownlint-cli2', 'npx', ['--no-install', 'markdownlint-cli2', 'README.md', 'docs/*.md']);

rmSync(tmp, { recursive: true, force: true });
console.log(`\n${findings} finding group(s); mode: ${strict ? 'strict' : `advisory until ${REQUIRED_FROM}`}`);
process.exit(strict && findings ? 1 : 0);
