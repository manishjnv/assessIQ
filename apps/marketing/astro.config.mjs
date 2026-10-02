import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';
import { writeFile, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Inline sitemap integration — generates sitemap-index.xml + sitemap-0.xml
// into dist/ at build time. Replaces @astrojs/sitemap to avoid a known bug in
// @astrojs/sitemap@3.x where trailingSlash:'never' leaves _routes undefined
// (astro:routes:resolved fires but _routes.reduce() is called before assignment
// in some Astro 4.16 builds, crashing with "Cannot read properties of undefined").
function inlineSitemap() {
  const SITE = 'https://assessiq.in';
  // lastmod comes from src/data/page-dates.json (git-derived; see scripts/page-dates.mjs)
  const pageDates = JSON.parse(readFileSync(new URL('./src/data/page-dates.json', import.meta.url), 'utf8'));
  const paths = [
    '/',
    '/about',
    '/contact',
    '/pricing',
    '/security',
    '/privacy',
    '/terms',
    '/solutions/it-hiring',
    '/solutions/campus-recruitment',
    '/solutions/educational-institutions',
    '/solutions/team-skill-gap',
    '/solutions',
    '/alternatives',
    '/alternatives/mettl',
    '/alternatives/hackerearth',
    '/alternatives/imocha',
    '/alternatives/hackerrank',
    '/alternatives/amcat',
    '/compare',
    '/compare/assessiq-vs-mettl',
    '/compare/assessiq-vs-hackerearth',
    '/compare/assessiq-vs-imocha',
    '/glossary',
    '/glossary/adverse-impact',
    '/glossary/criterion-validity',
    '/glossary/construct-validity',
    '/glossary/reliability-coefficient',
    '/glossary/item-response-theory',
    '/glossary/computer-adaptive-testing',
    '/glossary/percentile-rank',
    '/glossary/norm-referenced-scoring',
    '/glossary/cut-score',
    '/glossary/proctoring',
    '/tests',
    '/tests/python',
    '/tests/java',
    '/tests/sql',
    '/tests/javascript',
    '/tests/react',
    '/tests/aptitude',
    '/tests/logical-reasoning',
    '/tests/english',
    '/methodology',
    '/resources',
    '/resources/technical-hiring-india-guide',
    '/resources/reducing-bias-technical-hiring',
    '/resources/remote-proctoring-integrity',
    '/tests/role/frontend-developer',
    '/tests/role/backend-developer',
    '/tests/role/full-stack-developer',
    '/tests/role/data-analyst',
    '/tests/role/software-engineer',
    '/tools',
    '/tools/cost-of-a-bad-hire',
  ];

  const pages = paths.map((p) => {
    const d = pageDates[p];
    if (!d) throw new Error(`sitemap: no page-dates.json entry for ${p} - run scripts/page-dates.mjs`);
    return { loc: `${SITE}${p}`, lastmod: d.modified.slice(0, 10) };
  });
  const latest = pages.reduce((m, p) => (p.lastmod > m ? p.lastmod : m), '');

  function urlsetXml(urls) {
    const entries = urls.map(
      ({ loc, lastmod }) =>
        `  <url>\n    <loc>${loc}</loc>\n    <lastmod>${lastmod}</lastmod>\n  </url>`
    ).join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</urlset>\n`;
  }

  function indexXml(sitemaps) {
    const entries = sitemaps.map(
      ({ loc, lastmod }) =>
        `  <sitemap>\n    <loc>${loc}</loc>\n    <lastmod>${lastmod}</lastmod>\n  </sitemap>`
    ).join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</sitemapindex>\n`;
  }

  return {
    name: 'assessiq-inline-sitemap',
    hooks: {
      'astro:build:done': async ({ dir, logger }) => {
        const outDir = fileURLToPath(dir);
        await mkdir(outDir, { recursive: true });

        // sitemap-0.xml (pages child)
        const child = `${SITE}/sitemap-0.xml`;
        await writeFile(join(outDir, 'sitemap-0.xml'), urlsetXml(pages), 'utf8');

        // sitemap-index.xml (required by robots.txt Sitemap: directive)
        await writeFile(
          join(outDir, 'sitemap-index.xml'),
          indexXml([{ loc: child, lastmod: latest }]),
          'utf8'
        );

        logger.info('Sitemap generated: sitemap-index.xml + sitemap-0.xml');
      },
    },
  };
}

export default defineConfig({
  site: 'https://assessiq.in',
  trailingSlash: 'never',
  // format:'file' emits /about.html (not /about/index.html), so nginx serves
  // /about WITHOUT a trailing-slash 301 — matching trailingSlash:'never' and the
  // no-slash canonical. Directory format would 301 /about → /about/ (redirect
  // chain + canonical mismatch). See infra/docker/assessiq-marketing/nginx.conf.
  build: { format: 'file' },
  integrations: [
    tailwind(),
    inlineSitemap(),
  ],
  output: 'static',
});
