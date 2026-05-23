import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Inline sitemap integration — generates sitemap-index.xml + sitemap-0.xml
// into dist/ at build time. Replaces @astrojs/sitemap to avoid a known bug in
// @astrojs/sitemap@3.x where trailingSlash:'never' leaves _routes undefined
// (astro:routes:resolved fires but _routes.reduce() is called before assignment
// in some Astro 4.16 builds, crashing with "Cannot read properties of undefined").
function inlineSitemap() {
  const SITE = 'https://assessiq.in';
  const today = new Date().toISOString().slice(0, 10);
  const pages = [
    { loc: `${SITE}/`,                                      lastmod: today },
    { loc: `${SITE}/about`,                                 lastmod: today },
    { loc: `${SITE}/contact`,                               lastmod: today },
    { loc: `${SITE}/pricing`,                               lastmod: today },
    { loc: `${SITE}/security`,                              lastmod: today },
    { loc: `${SITE}/solutions/it-hiring`,                   lastmod: today },
    { loc: `${SITE}/solutions/campus-recruitment`,          lastmod: today },
    { loc: `${SITE}/solutions/educational-institutions`,    lastmod: today },
    { loc: `${SITE}/solutions/team-skill-gap`,              lastmod: today },
    { loc: `${SITE}/solutions`,                             lastmod: today },
    { loc: `${SITE}/alternatives`,                          lastmod: today },
    { loc: `${SITE}/alternatives/mettl`,                    lastmod: today },
    { loc: `${SITE}/alternatives/hackerearth`,              lastmod: today },
    { loc: `${SITE}/alternatives/imocha`,                   lastmod: today },
    { loc: `${SITE}/alternatives/hackerrank`,               lastmod: today },
    { loc: `${SITE}/alternatives/amcat`,                    lastmod: today },
    { loc: `${SITE}/compare`,                               lastmod: today },
    { loc: `${SITE}/compare/assessiq-vs-mettl`,             lastmod: today },
    { loc: `${SITE}/compare/assessiq-vs-hackerearth`,       lastmod: today },
    { loc: `${SITE}/compare/assessiq-vs-imocha`,            lastmod: today },
    { loc: `${SITE}/glossary`,                             lastmod: today },
    { loc: `${SITE}/glossary/adverse-impact`,              lastmod: today },
    { loc: `${SITE}/glossary/criterion-validity`,          lastmod: today },
    { loc: `${SITE}/glossary/construct-validity`,          lastmod: today },
    { loc: `${SITE}/glossary/reliability-coefficient`,     lastmod: today },
    { loc: `${SITE}/glossary/item-response-theory`,        lastmod: today },
    { loc: `${SITE}/glossary/computer-adaptive-testing`,   lastmod: today },
    { loc: `${SITE}/glossary/percentile-rank`,             lastmod: today },
    { loc: `${SITE}/glossary/norm-referenced-scoring`,     lastmod: today },
    { loc: `${SITE}/glossary/cut-score`,                   lastmod: today },
    { loc: `${SITE}/glossary/proctoring`,                  lastmod: today },
    { loc: `${SITE}/tests`,                                lastmod: today },
    { loc: `${SITE}/tests/python`,                         lastmod: today },
    { loc: `${SITE}/tests/java`,                           lastmod: today },
    { loc: `${SITE}/tests/sql`,                            lastmod: today },
    { loc: `${SITE}/tests/javascript`,                     lastmod: today },
    { loc: `${SITE}/tests/react`,                          lastmod: today },
    { loc: `${SITE}/tests/aptitude`,                       lastmod: today },
    { loc: `${SITE}/tests/logical-reasoning`,              lastmod: today },
    { loc: `${SITE}/tests/english`,                        lastmod: today },
    { loc: `${SITE}/methodology`,                          lastmod: today },
    { loc: `${SITE}/resources`,                            lastmod: today },
    { loc: `${SITE}/resources/technical-hiring-india-guide`,       lastmod: today },
    { loc: `${SITE}/resources/reducing-bias-technical-hiring`,     lastmod: today },
    { loc: `${SITE}/resources/remote-proctoring-integrity`,        lastmod: today },
  ];

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
          indexXml([{ loc: child, lastmod: today }]),
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
