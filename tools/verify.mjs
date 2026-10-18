// Usage: node tools/verify.mjs [--all] [--base=<ref>]   (default base origin/main)
// Lint (eslint, cached) + typecheck scoped to changed packages and their dependents,
// then writes the verify stamp. Root-level changes or --all run the full typecheck.
import { execFileSync, spawnSync } from 'node:child_process';

const all = process.argv.includes('--all');
const base = (process.argv.find((a) => a.startsWith('--base=')) ?? '--base=origin/main').slice(7);
const run = (cmd, args) => {
  console.log(`> ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: true });
  if (r.status !== 0) { console.error(`verify FAILED: ${cmd} ${args[0] ?? ''}`); process.exit(r.status || 1); }
};

const changed = execFileSync('git', ['diff', '--name-only', base], { encoding: 'utf8' }).split('\n').filter(Boolean);
const rootLevel = (f) => /^(package\.json|tsconfig[^/]*|tools\/|pnpm-lock\.yaml|pnpm-workspace\.yaml|\.npmrc)/.test(f);
const full = all || changed.some(rootLevel);

run('pnpm', ['exec', 'eslint', '.', '--cache', '--cache-location', 'node_modules/.cache/eslint']);
if (full) run('pnpm', ['-r', 'typecheck']);
else if (changed.length) run('pnpm', ['--filter', `"...[${base}]"`, '--filter', '"!assessiq"', 'typecheck']); // "..." = plus dependents
console.log(full ? 'typecheck: FULL' : 'typecheck: scoped');
run('node', ['tools/verify-stamp.mjs', 'write']);
