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
    { loc: `${SITE}/`,        lastmod: today },
    { loc: `${SITE}/about`,   lastmod: today },
    { loc: `${SITE}/contact`, lastmod: today },
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
  integrations: [
    tailwind(),
    inlineSitemap(),
  ],
  output: 'static',
});
