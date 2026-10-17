// Build guards (Z-33, Z-34). Runs after the build against dist/*.html; a failure fails `astro build`.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Z-34: JSON-LD @type values that really exist and are intended (verified 2026-10-17).
// Home: Organization + WebSite + SoftwareApplication. Pricing: FAQPage + BreadcrumbList.
// Product/Offer are NOT expected: pricing is custom/on-request (no fabricated Offer);
// the only Offer is on /tools/cost-of-a-bad-hire (WebApplication).
const REQUIRED = {
  'index.html': ['Organization', 'WebSite', 'SoftwareApplication'],
  'pricing.html': ['FAQPage', 'BreadcrumbList'],
};
const MAX_DESC = 160; // Z-33

function types(html) {
  const out = new Set();
  for (const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/g)) {
    for (const t of m[1].matchAll(/"@type"\s*:\s*"([^"]+)"/g)) out.add(t[1]);
  }
  return out;
}

export function buildGuards() {
  return {
    name: 'assessiq-build-guards',
    hooks: {
      'astro:build:done': ({ dir }) => {
        const root = fileURLToPath(dir);
        const errors = [];
        for (const [file, want] of Object.entries(REQUIRED)) {
          const have = types(readFileSync(join(root, file), 'utf8'));
          const miss = want.filter((t) => !have.has(t));
          if (miss.length) errors.push(`json-ld: ${file} missing @type ${miss.join(', ')}`);
        }
        const files = readdirSync(root, { recursive: true }).map((f) => String(f).replaceAll('\\', '/'))
          .filter((f) => f.endsWith('.html') && !f.startsWith('pagefind/'));
        for (const f of files) {
          const m = readFileSync(join(root, f), 'utf8').match(/<meta\s+name=["']?description["']?\s+content=(?:"([^"]*)"|'([^']*)')/i);
          const d = (m?.[1] ?? m?.[2] ?? '').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"');
          if (d.length > MAX_DESC) errors.push(`meta description: ${f} is ${d.length} chars (max ${MAX_DESC})`);
        }
        if (errors.length) throw new Error('build guards failed:\n  ' + errors.join('\n  '));
      },
    },
  };
}
