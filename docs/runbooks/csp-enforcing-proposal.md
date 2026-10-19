# CSP: measured violations and enforcing proposal (Z-46)

Status: advisory. This work changes no Caddy file, no VPS and no DNS.

## What was measured

- Spec: `apps/web/e2e/csp-report-only.spec.ts`. It reads the `Content-Security-Policy-Report-Only` value from `infra/caddy/assessiq.caddy` at run time. It adds the header to every document response and records `securitypolicyviolation` events.
- Date: 2026-10-19. Browser: Chromium (Playwright). Local stack: `local-stack.sh` (Vite dev server, local API, dev-minted sessions). Marketing: `astro preview` of the existing `apps/marketing/dist`.
- The spec skips unless `CSP_REPORT=1`. Default CI runs do not execute it.

### Run 1: the live report-only policy

All 9 pages: 0 violations. The current policy would block nothing.

| Page | Result |
|---|---|
| marketing home, /pricing, /contact (Turnstile) | 0 |
| SPA /try, sign-in (/admin/login) | 0 |
| SPA admin dashboard, admin assessments | 0 |
| SPA candidate home, take shell (/take/expired) | 0 |

### Run 2: strict variant (same policy without `'unsafe-inline'`)

This run shows which inline code an enforcing policy must replace. Set `CSP_VARIANT=strict`.

| Page | Directive | Blocked | Count | Source (measured) |
|---|---|---|---|---|
| marketing home, /pricing | style-src-attr | inline | 1 | `style="..."` attribute in the layout |
| marketing home, /pricing | script-src-attr | inline | 1 | `onload="this.onload=null;this.rel='stylesheet'"` on the font preload link |
| marketing /contact | style-src-attr | inline | 3 | `style` attributes |
| marketing /contact | script-src-elem | inline | 1 | inline form script (page line 101) |
| marketing /contact | script-src-attr | inline | 1 | font preload `onload` |
| SPA (all 7 pages) | script-src-elem | inline | 2 | `index.html` viewport script; the second is the Vite dev preamble (dev only) |
| SPA (all 7 pages) | script-src-attr | inline | 1 | font preload `onload` in `index.html` |
| SPA (all 7 pages) | style-src-elem | inline | 2 to 3 | `@vite/client` and dev style injection (dev only) |

Cautions about this data:

- The SPA ran on the Vite dev server. The `@vite/client`, React refresh and style injections are dev only. A production build does not have them. Re-run against `pnpm --filter @assessiq/web preview` before you rely on the SPA rows.
- Run 1 shows no host was blocked. It does not prove the Turnstile iframe and the insights beacon load on localhost (no site key, no Cloudflare edge).
- The real attempt page `/take/attempt/:id` is NOT MEASURED: it needs a seeded attempt (up to 60 s wait). `/take/expired` uses the same SPA shell. Re-measure after a seeded `take-happy-path` run.
- Console messages that mention CSP are in the JSON (`console` field). None changed the result.

## Sources that load today (from files)

| Source | Where | Directive |
|---|---|---|
| `fonts.googleapis.com` (CSS), `fonts.gstatic.com` (files) | `apps/marketing/src/layouts/BaseLayout.astro`, `apps/web/index.html` | style-src, font-src |
| `challenges.cloudflare.com` (script and iframe) | `apps/marketing/src/pages/contact.astro` line 221 | script-src, frame-src |
| `static.cloudflareinsights.com`, `cloudflareinsights.com` | Cloudflare Web Analytics beacon, added at the Cloudflare edge (not in repo source) | script-src, connect-src |
| `https:` images, `data:`, `blob:` | content and avatars | img-src |

## Proposed enforcing policy

Two policies, because the two apps have different inline needs.

| Directive | Marketing (Astro, static nginx) | SPA (Vite) |
|---|---|---|
| default-src | `'self'` | `'self'` |
| script-src | `'self' 'sha256-<hash per inline script>' https://challenges.cloudflare.com https://static.cloudflareinsights.com` | `'self' 'sha256-<viewport script>' https://static.cloudflareinsights.com` |
| style-src | `'self' https://fonts.googleapis.com`, plus `'unsafe-inline'` until `style=` attributes are removed | `'self' https://fonts.googleapis.com` |
| img-src | `'self' data: blob: https:` | `'self' data: blob: https:` |
| font-src | `'self' data: https://fonts.gstatic.com` | `'self' data: https://fonts.gstatic.com` |
| connect-src | `'self' https://cloudflareinsights.com` | `'self' https://cloudflareinsights.com` |
| frame-src | `https://challenges.cloudflare.com` | `'none'` (add Turnstile only if the SPA adds it) |
| frame-ancestors | `'none'` (already sent by the security-headers block) | `'none'` |
| base-uri | `'self'` | `'self'` |
| form-action | `'self'` | `'self'` |
| object-src | `'none'` | `'none'` |

### Inline code: what must change before you enforce

1. Font preload `onload="..."` (both apps) is an inline event handler. A hash does not cover it unless you add `'unsafe-hashes'`. Replace it with a plain `<link rel="stylesheet">` or a small external script from `'self'`.
2. SPA `index.html` viewport script: move it to a file in `public/` (`'self'` only, no hash upkeep), or use a `sha256` hash.
3. Marketing inline scripts (the `contact.astro` form script and any other page script): Astro inlines small bundled scripts. Options: set `build.inlineStylesheets: 'never'` and keep scripts external; use the Astro experimental CSP support (`security.csp`, emits hashes); or add a post-build step that hashes every inline `<script>` in `dist/*.html` and writes the `script-src` line. `application/ld+json` blocks are data. They raised no violation.
4. `style=` attributes (marketing): move to classes. Until then keep `'unsafe-inline'` in style-src only. That is a much smaller risk than in script-src.
5. Nonces do not fit. Both apps are static files, so a per-request nonce needs Caddy to rewrite the HTML. Use hashes or external files.

### What Caddy can do

- Caddy can send a different `Content-Security-Policy` for marketing paths and SPA paths. The report-only header sits in the `assessiq.in` site block only. Do not use the shared `(security-headers)` snippet: 8 sites import it.
- Keep `Content-Security-Policy-Report-Only` while you enforce. The browser applies both. You get reports for the next stricter step.
- Caddy is NOT changed by this work. Edit the live Caddy file only with a truncate-write after a backup (copy to a dated backup, then write with `>`). Never use `sed -i` (bind-mount inode trap, see RCA log).

## Rollout order and rollback

1. Re-run the spec with `CSP_VARIANT=strict` against a production SPA build and the real marketing build. Fix the "Inline code" items until marketing shows 0.
2. Keep report-only live for one release. Check the browser console on a real signed-in sweep (Z-47 smoke).
3. Enforce on marketing paths first (static, lowest risk). Header name: `Content-Security-Policy`.
4. Watch for 48 hours: contact form submit with Turnstile, fonts, analytics beacon.
5. Enforce on the SPA (admin, candidate, /take, /try) after the strict run is clean on a production build and the take runner is measured.
6. Rollback: rename the header back to `Content-Security-Policy-Report-Only` (one-line edit; backup first; `caddy validate`; then reload). No data is affected.

## How to repeat the measurement

```
# terminal 1: bash apps/web/e2e/local-stack.sh
# terminal 2: cd apps/marketing && npx astro preview --port 4321
cd apps/web
CSP_REPORT=1 CSP_MARKETING_URL=http://localhost:4321 PLAYWRIGHT_BASE_URL=http://localhost:5173 \
  E2E_API_BASE_URL=http://127.0.0.1:3000 \
  pnpm exec playwright test csp-report-only --project=chromium --workers=1
# add CSP_VARIANT=strict for run 2
# output: apps/web/csp-report/csp-report-only[-strict].json and a table on stdout
```

The output folder is `csp-report/`, not `test-results/`, because Playwright empties `test-results/` at the start of each run.
