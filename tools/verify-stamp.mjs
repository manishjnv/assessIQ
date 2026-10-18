// Usage: node tools/verify-stamp.mjs write|check
// Stamp = HEAD tree hash + sha256 of `git diff HEAD`; any edit invalidates it.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const git = (c) => execFileSync('git', c.split(' '), { encoding: 'utf8', maxBuffer: 1 << 28 });
const root = git('rev-parse --show-toplevel').trim();
const file = `${root}/.claude/.verify-stamp`;
const now = `${git('rev-parse HEAD^{tree}').trim()}\n${createHash('sha256').update(git('diff HEAD')).digest('hex')}\n`;

if (process.argv[2] === 'write') {
  mkdirSync(`${root}/.claude`, { recursive: true });
  writeFileSync(file, now);
  console.log('verify stamp written');
} else {
  let old = '';
  try { old = readFileSync(file, 'utf8'); } catch {}
  process.exit(old === now ? 0 : 1);
}
