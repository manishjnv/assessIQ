# How to switch the Content-Security-Policy from report-only to enforcing (Z-46)

Type: how-to. Status: ready for the owner. **Caddy is NOT changed by this work.** The switch needs the owner's go.

Measured data and the earlier report-only run: `docs/runbooks/csp-enforcing-proposal.md`.

## What changed in code, and why

The enforcing policy has no `'unsafe-inline'` in `script-src`. Inline code was the blocker. These changes remove it.

- **Font stylesheet (both apps).** The `onload="this.onload=null;this.rel='stylesheet'"` handler is gone. The link is now `<link rel="stylesheet" media="print" data-font-swap ...>`. A small external script sets `media="all"`. The font load is still off the render path. The `<noscript>` fallback stays.
  - SPA: `apps/web/index.html`, `apps/web/public/brand/js/font-swap.js`.
  - Marketing: `apps/marketing/src/layouts/BaseLayout.astro`, `apps/marketing/public/font-swap.js`.
- **SPA viewport script.** Moved to `apps/web/public/brand/js/viewport.js`. It stays a blocking script in `<head>`, so there is no first-paint flicker. It sits under `/brand/`, which Caddy already sends to the SPA. A root path such as `/viewport.js` would reach marketing, so do not use one.
- **Marketing inline scripts.**
  - The contact form script is a bundled Astro script. `vite.build.assetsInlineLimit: 0` in `apps/marketing/astro.config.mjs` stops Astro from inlining it. It is now `/_astro/contact.astro_astro_type_script_index_0_lang.*.js`.
  - The `/search` prefill script moved to `apps/marketing/public/search-prefill.js`.
  - The cost calculator moved to `apps/marketing/public/cost-calculator.js`.
  - JSON-LD (`application/ld+json`) is data. It needs nothing.
  - A scan of all `dist/**/*.html` finds 0 inline scripts, 0 `<style>` tags, 0 `style=` attributes and 0 `on*=` handlers.
- **Marketing `style=` attributes.** All 3 became Tailwind classes: the logo halo (`Header.astro`), the honeypot input and the status line (`contact.astro`). The marketing `style-src` has no `'unsafe-inline'`.
- **Sweep.** `apps/web/e2e/csp-report-only.spec.ts` has a new `CSP_VARIANT=enforce` mode. It injects the policy from `apps/web/e2e/csp-policies.json` as a real `Content-Security-Policy` header. That JSON file is the single source: the spec and this page both use it.

## Final enforcing policies

Source of truth: `apps/web/e2e/csp-policies.json`. Copy from there if this page and the file ever differ.

Marketing:

```
default-src 'self'; script-src 'self' https://challenges.cloudflare.com https://static.cloudflareinsights.com; style-src 'self' https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; img-src 'self' data: blob: https:; connect-src 'self' https://cloudflareinsights.com; frame-src https://challenges.cloudflare.com; frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'
```

SPA:

```
default-src 'self'; script-src 'self' https://static.cloudflareinsights.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; img-src 'self' data: blob: https:; connect-src 'self' https://cloudflareinsights.com; frame-src 'none'; frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'
```

- No new third-party host. Fonts stay on Google (not self-hosted: not trivial).
- `frame-ancestors 'none'` matches what the shared `(security-headers)` snippet already sends. The embed routes (`/embed*`) go to the API, not to these two handlers, so embed behaviour is untouched.

### Why the SPA keeps `'unsafe-inline'` in `style-src`

React renders inline `<style>` elements. The sweep blocked them (`style-src-elem`) on the admin pages and the take runner. Each one is a JSX `<style>` block. `style=` attributes set from React props use the CSSSOM and raise no violation.

| File | Line | Reason |
|---|---|---|
| `apps/web/src/pages/candidate/CandidateLogin.tsx` | 181 | page CSS in a `<style>` block |
| `apps/web/src/pages/take/Attempt.tsx` | 673 | hides the keyboard hint on mobile |
| `modules/10-admin-dashboard/src/components/AdminShell.tsx` | 329 | shell CSS |
| `modules/10-admin-dashboard/src/components/AttemptGradingPanel.tsx` | 1035 | panel CSS |
| `modules/10-admin-dashboard/src/pages/generation-attempts.tsx` | 523 | spinner keyframes |
| `modules/10-admin-dashboard/src/pages/question-editor.tsx` | 153 | editor CSS |
| `modules/11-candidate-ui` (components) | - | more inline styles, not itemised |

Most of these are in `modules/`, outside this work's scope. Moving them to CSS files is a separate row. The risk of `'unsafe-inline'` in `style-src` is much smaller than in `script-src`.

## Measured result

Run on 2026-10-19 in Chromium. Browser applied the policy as an enforcing header (`headerSeen` true on every page).

- Marketing: production build (`astro build` + `pagefind`) served by `astro preview` on port 4321.
- SPA: production build (`vite build`) served by `vite preview` on port 4173, with the API from `local-stack.sh` proxied at `/api`.

| Page | App | Violations |
|---|---|---|
| marketing home | marketing | 0 |
| marketing /pricing | marketing | 0 |
| marketing /contact | marketing | 0 |
| marketing /search?q=test (Pagefind) | marketing | 0 |
| marketing /tools/cost-of-a-bad-hire | marketing | 0 |
| SPA /try | SPA | 0 |
| SPA /admin/login | SPA | 0 |
| SPA /admin (admin dashboard) | SPA | 0 |
| SPA /admin/assessments | SPA | 0 |
| SPA /candidate/results | SPA | 0 |
| SPA /take/expired | SPA | 0 |
| SPA /take/attempt/:id (seeded, question 1 rendered) | SPA | 0 |

Before `'unsafe-inline'` was added to the SPA `style-src`, the admin pages showed 1 and the take attempt page showed 3 `style-src-elem` violations.

What the run does NOT prove:

- The Turnstile iframe cannot be proven on localhost. The script request is allowed by the policy, but the widget needs the real domain. A real submit of the contact form is not measured.
- The Cloudflare Web Analytics beacon is injected at the Cloudflare edge. It does not exist on localhost, so it is not measured.
- Anything else Cloudflare injects into HTML at the edge (for example email obfuscation) is not measured. This is why report-only stays live (below).
- Signed-in pages used dev-minted sessions, not a real login.

Repeat the run:

```
bash apps/web/e2e/local-stack.sh
cd apps/web && pnpm exec vite build && E2E_API_PROXY=http://127.0.0.1:3000 pnpm exec vite preview --port 4173 &
cd apps/marketing && npx astro build && npx pagefind --site dist && npx astro preview --port 4321 &
cd apps/web
CSP_REPORT=1 CSP_VARIANT=enforce CSP_MARKETING_URL=http://localhost:4321 PLAYWRIGHT_BASE_URL=http://localhost:4173 \
  E2E_API_BASE_URL=http://127.0.0.1:3000 pnpm exec playwright test csp-report-only --project=chromium --workers=1
bash e2e/local-stack.sh --down
```

The seeded attempt takes up to about 90 seconds (worker activation).

## Caddy change to propose

Edit `infra/caddy/assessiq.caddy`, site block `assessiq.in` only. Never edit the shared `(security-headers)` snippet: 8 sites import it.

Keep the existing `header Content-Security-Policy-Report-Only ...` line. Add one `header` line inside each existing handler. The SPA handler is `@app`. The marketing handler is the default `handle`.

```
    handle @app {
        header Content-Security-Policy "<SPA policy from above>"
        reverse_proxy 172.17.0.1:9091 {
            header_up X-Forwarded-Proto https
        }
    }
    handle {
        header Content-Security-Policy "<marketing policy from above>"
        reverse_proxy 172.17.0.1:9093 {
            header_up X-Forwarded-Proto https
        }
    }
```

Notes:

- The report-only header sits at site level for all paths. These two lines use the existing path split: `@app` is `/admin /candidate /take /try /assets/* /brand/*`. Everything else is marketing. `@api` paths are not changed.
- `(security-headers)` already sends `Content-Security-Policy "frame-ancestors 'none'"`. If Caddy sends both headers, the browser enforces both. The result is the same because both contain `frame-ancestors 'none'`. Check with `curl -I` (step 5).

## Steps for the owner

1. Read the diff. Confirm CI is green and the code in this change is deployed first (SPA with `tools/deploy.sh`; marketing with the manual steps in `docs/06-deployment.md`). The policy breaks the old pages if the old inline code is still live.
2. Back up the live Caddyfile to a dated file:
   `cp /opt/ti-platform/caddy/Caddyfile /opt/ti-platform/caddy/Caddyfile.bak.$(date -u +%Y%m%dT%H%M%SZ)`
3. Build the new file in a scratch path. Run `caddy validate` on it.
4. Write it in place with a truncate-write: `cat new.caddy > /opt/ti-platform/caddy/Caddyfile`. Never use `sed -i` or `mv` (bind-mount inode trap, see RCA log). Reload Caddy.
5. Verify:
   - `curl -sI https://assessiq.in/ | grep -i content-security-policy` shows the marketing policy.
   - `curl -sI https://assessiq.in/admin/login | grep -i content-security-policy` shows the SPA policy.
   - Open `/contact` (submit with Turnstile), `/search`, `/admin`, and a `/take` attempt. The browser console must show no CSP errors.
6. Watch for 48 hours: contact form with Turnstile, fonts, analytics beacon.

**Rollback (one line):** rename the two new headers back to `Content-Security-Policy-Report-Only`, or restore the dated backup. Back up first, run `caddy validate`, truncate-write, reload. No data is affected.

Stage option: apply the marketing line first (lowest risk), watch, then the SPA line.

## Deploy notes

- Marketing deploys with the manual steps in `docs/06-deployment.md` (not `tools/deploy.sh`). New public files: `font-swap.js`, `search-prefill.js`, `cost-calculator.js`. They fall to the default route, so they need no Caddy change.
- SPA deploys with `tools/deploy.sh`. New public files are under `/brand/js/`, already routed to the SPA.
- Nothing is deployed by this work.

## Considered and rejected

- **Nonces.** Both apps are static files. A per-request nonce needs Caddy to rewrite the HTML.
- **Hashes of inline scripts with a post-build script.** No inline script is left, so there is nothing to hash. Hashes would need upkeep on every edit.
- **Astro experimental `security.csp`.** Not needed: all scripts are external.
- **`'unsafe-hashes'`** for the font `onload`. Replaced the handler instead.
- **Self-hosted fonts.** Not trivial. The Google hosts stay in the allow-list.

## Not included

- No Caddy, VPS, Cloudflare or DNS change.
- No move of the JSX `<style>` blocks in `modules/` to CSS files, so the SPA `style-src` keeps `'unsafe-inline'`.
- No real Turnstile, beacon or signed-in (real login) measurement.
- No `report-uri` or `report-to` endpoint.
