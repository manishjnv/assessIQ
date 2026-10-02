// Generates src/data/page-dates.json from git history (git is absent at Docker build time,
// so the JSON is committed). Re-run and commit whenever a marketing page changes.
import { execFileSync } from 'node:child_process';
import { readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pagesDir = join(root, 'src', 'pages');

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
}

const dates = {};
for (const file of walk(pagesDir).filter((f) => f.endsWith('.astro'))) {
  const rel = relative(pagesDir, file).split(sep).join('/');
  if (['404.astro', 'search.astro'].includes(rel) || rel.startsWith('og/') || rel.includes('[')) continue;
  const route = '/' + rel.replace(/\.astro$/, '').replace(/(^|\/)index$/, '');
  const lines = execFileSync('git', ['log', '--follow', '--format=%aI', '--', file], { cwd: root, encoding: 'utf8' })
    .split('\n').filter(Boolean);
  if (!lines.length) {
    console.error(`page-dates: no git history for ${rel} - commit the page first`);
    process.exit(1);
  }
  dates[route === '/' || route === '' ? '/' : route] = { published: lines.at(-1), modified: lines[0] };
}

const sorted = Object.fromEntries(Object.entries(dates).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
writeFileSync(join(root, 'src', 'data', 'page-dates.json'), JSON.stringify(sorted, null, 2) + '\n');
console.log(`page-dates: wrote ${Object.keys(sorted).length} entries`);
