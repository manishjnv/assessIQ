# Email Kit Port — Phased Implementation Plan

> **Status: PLAN (not yet implemented).** Authored 2026-05-20 for review. No production code touched yet. Implementation gated on the open-decisions resolutions at the bottom of this doc.

**Goal:** Centralize AssessIQ's transactional + lifecycle email layer behind the visual contract shipped in `modules/17-ui-system/AssessIQ_UI_Template/AssessIQ-Email-Kit/`. Replace the 9 hand-written templates currently in `modules/13-notifications/src/email/templates/` with templates composed from a small, shared atom set so every email reads as the same product — same header, same footer, same CTA, same accent, same voice.

**Authored:** 2026-05-20 from inspection of the Email-Kit drop (`AssessIQ-Email-Kit/` untracked add), the existing template inventory, the Handlebars + Zod render pipeline at [`modules/13-notifications/src/email/render.ts`](../../modules/13-notifications/src/email/render.ts), and the production send flow at [`modules/13-notifications/src/email/index.ts`](../../modules/13-notifications/src/email/index.ts).

**Audience:** Each phase is designed to be executed in its own session by an Opus orchestrator + Sonnet subagents per the project [CLAUDE.md](../../CLAUDE.md) orchestration playbook. E0 must land first; E1 unblocks the per-template ports. **Phases are sequenced — do NOT batch into one session.**

**Phasing summary:** 6 phases, ~6–9 sessions of work. E0 (foundation: tokens reconciliation + email-safe atoms) and E1 (Handlebars partials + render refactor) deliver the biggest infrastructure win per byte. E2a (5 kit-mapped templates) and E2b (4 net-new derivations) are the actual port. E3 covers Litmus / in-app-webview testing before declaring done. E4 finalizes docs.

**Progress:** ☑ E0 (foundation — [docs/13-email-system.md](../13-email-system.md), 2026-05-21) · ☐ E1 (centralize) · ☐ E2a (5 kit-mapped templates) · ☐ E2b (4 net-new templates) · ☐ E3 (validation) · ☐ E4 (docs + handoff) — **1/6 complete**. **E1 blocked on open-decision #5 (physical mailing address).**

---

## North-star rule for this port

**Functionality drives UI; UI never drives functionality.** Mirrors the Mobile Kit Port rule (per memory `feedback-functionality-drives-ui.md`). The Email Kit is a *palette of idioms* — atoms (`EmailShell`, `EmailHeader`, `EmailBody`, `EmailLede`, `EmailCTA`, `EmailMetaCard`, `EmailFooter`), token contract, voice. It is **not a product spec**.

- The kit ships 5 templates (Pulse newsletter, Assessment invite, Team invitation, Result delivered, New submission). **The Pulse newsletter does NOT exist as a production send today.** This port does NOT add it. If you want a monthly newsletter, that's a separate product decision outside this plan — propose it, scope it, ship it on its own.
- Production currently sends 9 templates. 5 of those map directly to kit screens; 4 (admin_email_otp, attempt_submitted_candidate, candidate_login_link, totp_enrolled) have no kit counterpart and must be derived by composing kit atoms — same visual contract, no new product surface.
- If a future phase wants to introduce a template the kit hints at (Pulse, anything else), that is a **separate product decision** outside this plan — propose it, get approval, then add it. Don't fold it into an email-kit-port session.

---

## Why this port exists

**Inventory gap.** Today's 9 production templates were authored opportunistically — each one was written for its trigger (invitation, magic-link, OTP, submitted, graded, ready-for-review, weekly digest, TOTP enrolled, email-OTP). They share the same accent (`#1a73e8`) and the same general table-based shell, but the padding, footer copy, footer breadth, and meta-row treatment differ subtly across files. Adding a 10th template today would mean another opportunistic write.

**Brand consistency.** The kit's atoms ship a coherent footer (brand mark + reason copy + 4 nav links + physical address + copyright) that no production template has today. Production footers are 2 lines ("Thanks, / The AssessIQ team · © AssessIQ"). The kit's `EmailLede` ships an eyebrow → serif headline → muted body pattern that's editorial in tone. Production templates are functional but visually thinner.

**Compliance.** CAN-SPAM and DPDP both require a physical mailing address + an unsubscribe path on commercial emails. Production templates have neither today. Some templates (magic-link, OTP, TOTP enrolled, submitted, ready-for-review) are *transactional* — exempt from unsubscribe but still require the address. Others (weekly digest, invitation) are *commercial* — require both unsubscribe and address.

**Email-client gotchas.** The kit's React mocks (`<EmailShell>` etc.) are flex-based — they won't render in Outlook on Windows, which ignores CSS `display: flex`. Today's production templates already use nested `<table>` tags + inline styles + cells-as-padding — that's the right runtime shape and must be preserved. The kit's atoms must be ported to email-safe HTML, not used directly.

---

## Source-of-truth + target inventory

### Kit assets (`modules/17-ui-system/AssessIQ_UI_Template/AssessIQ-Email-Kit/`)

```
AssessIQ-Email-Kit/
├── README.md                          ← reference + shipping notes
├── AssessIQ-Emails-standalone.html    ← preview mock (1.8 MB; open in any browser)
├── Email System.html                  ← editable canvas (loads sibling JSX)
├── styles.css                         ← CSS source-of-truth (kit-only)
├── design-canvas.jsx                  ← canvas shell
├── screens/atoms.jsx                  ← Logo, Icon primitives
├── emails/
│   ├── email-atoms.jsx                ← EmailShell, EmailHeader, EmailBody, EmailLede, EmailCTA,
│   │                                     EmailGhostLink, EmailRule, EmailMetaCard, EmailFooter
│   ├── brand-guide.jsx                ← brand-guide artboard
│   ├── templates-1.jsx                ← Newsletter, Invite, Team invite
│   └── templates-2.jsx                ← Result, New submission
└── design-system/                     ← upstream AssessIQ design system docs
    ├── README.md
    ├── tokens.md
    ├── components.md
    ├── patterns.md
    └── copy-and-voice.md
```

Per kit README: these are **design mocks** — pixel-faithful to what customers should see, but rendered with the web app's React + CSS stack. The "Shipping to production" section in the kit's README explicitly says: rebuild as nested `<table>` tags, inline every style, add MSO/VML for buttons, send a preheader, test in Litmus or Email on Acid.

### Target — current production templates (`modules/13-notifications/src/email/templates/`)

| # | File | Audience | Type | Kit map |
| --- | --- | --- | --- | --- |
| 1 | `invitation_admin.html` | Admin / Reviewer | Commercial | Team invitation |
| 2 | `invitation_candidate.html` | Candidate | Commercial | Assessment invite |
| 3 | `candidate_login_link.html` | Candidate | Transactional | *(derive)* |
| 4 | `admin_email_otp.html` | Admin / Reviewer | Transactional | *(derive)* |
| 5 | `totp_enrolled.html` | Admin / Reviewer | Transactional | *(derive)* |
| 6 | `attempt_submitted_candidate.html` | Candidate | Transactional | *(derive)* |
| 7 | `attempt_graded_candidate.html` | Candidate | Lifecycle | Result delivered |
| 8 | `attempt_ready_for_review_admin.html` | Admin / Reviewer | Lifecycle | New submission |
| 9 | `weekly_digest_admin.html` | Admin / Reviewer | Commercial | Pulse newsletter |

Each has a sibling `.txt` variant. The Handlebars-compiled HTML + plain-text pair is rendered by [`render.ts`](../../modules/13-notifications/src/email/render.ts) with per-template Zod var-schema validation + i18n string injection via `_t_<key>` vars.

**Out of port scope (no kit counterpart, no port needed):** none — all 9 templates are in scope.

---

## Anti-pattern guards (apply to EVERY phase)

These are bounce conditions for every diff. Cite the source when a Phase 3 critique flags one.

1. **No new templates, no new send triggers.** This port applies kit visuals to the **existing** 9 templates only. Adding a "Pulse" monthly newsletter, a "Retry your attempt" nudge, or any other template that doesn't already exist is a bounce.
2. **No backend changes.** The Handlebars + Zod var-schema + i18n + BullMQ + email_log pipeline is the contract. Templates compose against the existing var schemas. Adding a new var to an existing template's Zod schema is allowed only if the var is purely cosmetic (e.g. an eyebrow kicker) and has a sensible default.
3. **No flex / grid in template HTML.** Outlook on Windows ignores them. Kit atoms must be re-implemented as nested `<table>` cells. The cells-as-padding pattern in today's `invitation_candidate.html` is the right shape — port the kit's visual contract on top, don't replace the table layout.
4. **All styles inline.** No `<style>` blocks, no external stylesheets. Email clients (Gmail in particular) strip or modify `<style>` content unpredictably. Every CSS property goes in `style=""` on its element. This is non-negotiable.
5. **Font-family fallback chain mandatory.** Web fonts don't render in email clients. The kit's Newsreader (serif) + Geist (sans) must map to:
   - Serif: `Georgia, 'Times New Roman', serif` (production already uses this).
   - Sans: `'Helvetica Neue', Helvetica, Arial, sans-serif` (production already uses this).
   - Mono (where used): `'SF Mono', Menlo, Consolas, monospace`.
   The kit's web fonts are documentation-only — they describe the editorial *intent*, not the production rendering.
6. **MSO/VML wrap on every pill CTA button.** Outlook 2007–2019 (still ~15% of B2B inboxes) renders `border-radius: 999px` as a sharp rectangle unless wrapped in conditional `<!--[if mso]><v:roundrect>...<![endif]-->`. Each kit `EmailCTA` becomes a HTML+VML pair at port time.
7. **Preheader on every template.** The hidden white-on-white text immediately after `<body>` becomes the email-client preview line. Today's templates don't have this. E2a + E2b will add one preheader per template — the copy is authored as part of the per-template port.
8. **i18n preserved.** Existing `{{_t_*}}` variables stay intact across the port. New variables added during the port must have a corresponding `i18n.ts` entry; never inline literal strings in HTML when they're shown to candidates.
9. **HTML escaping mandatory.** All `{{var}}` substitutions use double-stash (HTML-escape on). NO `{{{triple-stash}}}` allowed — Handlebars is configured at the compile step with `noEscape: false` in [`render.ts`](../../modules/13-notifications/src/email/render.ts); the port must not introduce triple-stash.
10. **HTML + TXT parity.** Every template ships both a `.html` and a `.txt` variant. The TXT first line is `Subject: <subject>` followed by a blank line then the plain-text body (the render pipeline parses this convention). Both variants must render the same SEMANTIC content — text variant is for screen-readers, accessibility, and clients that prefer plain text.
11. **Audit log invariant unchanged.** `email_log` row is inserted with `status='queued'` BEFORE BullMQ enqueue, transitioned to `sending` → `sent` (or `failed`) by the worker job. No port change touches this — templates are content, not pipeline.
12. **Document deliberate kit divergence in a per-template header comment** — `<!-- Diverges from kit/emails/templates-1.jsx <Name> because: <reason> -->`. Future readers can grep for these to find drift between kit and production.

---

## Dependency graph

```
E0 (foundation: tokens reconciliation + email-safe atoms in /partials/)
 │
 ├──> E1 (centralize: Handlebars partials wired, existing 9 templates use shared header/footer/CTA)
 │     │
 │     ├──> E2a (port 5 kit-mapped templates: invitation_admin, invitation_candidate,
 │     │        attempt_graded_candidate, attempt_ready_for_review_admin, weekly_digest_admin)
 │     │
 │     └──> E2b (port 4 net-new derived templates: candidate_login_link, admin_email_otp,
 │              totp_enrolled, attempt_submitted_candidate)
 │
 ├──> E3 (validation: Litmus or Email on Acid render sweep + in-app webview smoke)
 │
 └──> E4 (docs + handoff)
```

E0 must land before everything. E1 must land before E2a / E2b. E2a and E2b can land in either order (or in parallel sessions if subagent capacity exists — both depend only on E1's partial library). E3 gates declaring the port done. E4 is last.

---

## Phase E0 — Foundation (1 session)

**Why first:** Resolve the kit-vs-production token deltas + define the email-safe atom set that E1 wires into Handlebars partials. Until E0 lands, every per-template port is improvising the same visual contract independently.

### Tokens reconciliation

Surface the deltas between the kit's [`design-system/tokens.md`](../../modules/17-ui-system/AssessIQ_UI_Template/AssessIQ-Email-Kit/design-system/tokens.md) + [`styles.css`](../../modules/17-ui-system/AssessIQ_UI_Template/AssessIQ-Email-Kit/styles.css) and what production templates ship today. **Email tokens are independent from the SPA's [`modules/17-ui-system/src/styles/tokens.css`](../../modules/17-ui-system/src/styles/tokens.css)** — email clients can't read CSS custom properties, so the email "token" layer is a Handlebars-resolved constant table.

| Property | Kit | Production | Recommendation | Rationale |
| --- | --- | --- | --- | --- |
| Canvas background | `#f1efea` (warm off-white) | `#f5f5f5` (neutral gray) | **Pick: kit `#f1efea`** — warmer brand-aligned background; matches the editorial tone in the kit's brand-guide artboard. | Production was a quick default; kit is the authored choice. |
| Card background | `#ffffff` | `#ffffff` | Aligned ✓ | n/a |
| Card border | `#e4e4e7` | `#e8e8e8` | **Pick: kit `#e4e4e7`** — matches the rest of the AssessIQ visual identity (the SPA's `--aiq-color-border` is also `#e4e4e7`). | Cross-surface consistency. |
| Card width | 640px | 600px | **Pick: kit 640px** — the standard width emerging across modern transactional emails; 600px is a 2010-era convention. | Both fit Gmail desktop and iOS Mail; 640 gives 6.6% more horizontal real estate. |
| Card radius | 14px | 16px | **Pick: 14px** (kit). | Marginal; defer to the authored choice. |
| Card inner padding | 36px × 40px | 40px (single-axis) | **Pick: 36px vertical × 40px horizontal** (kit). | More generous breathing room; matches the SPA's `--aiq-page-padding-x/y`. |
| Header padding | 22px × 36px | 24px × 40px | **Pick: 22px × 36px** (kit). | Subtle reduction; pairs with the new card padding. |
| Footer band background | `#fafafa` (`--surface`) | `#f5f5f5` | **Pick: kit `#fafafa`** — distinct from the canvas. | Production currently has footer = canvas color (no visual band). |
| Accent | `#1a73e8` | `#1a73e8` | Aligned ✓ | n/a |
| Body color | `#0a0a0b` (`--text`) | `#1a1a1a` | **Pick: kit `#0a0a0b`** — true black. | Subtle contrast bump. |
| Body-muted color | `#3f3f46` (`--text-muted`) | `#5f6368` (Google's gray) | **Pick: kit `#3f3f46`**. | Brand-consistent gray. |
| Body-faint color | `#71717a` (`--text-faint`) | `#9aa0a6` | **Pick: kit `#71717a`**. | Brand-consistent gray. |
| Serif font | Newsreader (web) | Georgia, 'Times New Roman' | **Production wins (email-safe).** Document Newsreader as the editorial *intent*; render with Georgia stack. | Web fonts don't load in email clients. |
| Sans font | Geist (web) | Helvetica Neue, Arial | **Production wins (email-safe).** | Same. |
| Body font size | 15px | 15px | Aligned ✓ | n/a |
| Body-large size | 17px | 15–22px (varies per template) | **Pick: 17px** when lede needs a body-large; otherwise stay 15px. | Avoid the per-template drift. |
| Headline H1 size | 30px | 22px | **Pick: kit 30px** for editorial lede; allow 22px for short-form transactional templates (OTP code, magic-link). | Per-template-class budget — see E2a/E2b. |
| Pill button radius | 999px | 999px | Aligned ✓ | n/a |
| Pill button padding | 14px × 28px | 12px × 28px | **Pick: kit 14px × 28px** — slightly larger tap target. | Mobile webview ergonomics. |

**Output of E0 tokens work:** a documented "Email Tokens" table in `docs/13-email-system.md` (new file) listing the final resolved values for every property. The values are inlined into Handlebars partials in E1; this doc is the single source-of-truth for "what does an AssessIQ email look like."

### Email-safe atom set

E0 designs (no implementation yet — that's E1) the email-safe table-based equivalent for each kit React atom. Each atom's design lives in `docs/13-email-system.md` as an inline HTML block with the production-target shape. Atoms to design:

1. **`{{> email-shell}}`** — outer `<table width="100%">` with canvas color + a centered 640px `<table>` for the card. Inputs: `preheader` (preview-line text), `body` content slot.
2. **`{{> email-header}}`** — single-row table with logo wordmark on the left and an optional `eyebrow` mono uppercase label on the right.
3. **`{{> email-lede}}`** — eyebrow (optional, mono uppercase) + serif h1 + muted body paragraph. Inputs: `eyebrow`, `title`, `body`.
4. **`{{> email-cta}}`** — pill button with MSO/VML wrap. Inputs: `label`, `href`. Always pairs the visible HTML link with a `<v:roundrect>` for Outlook.
5. **`{{> email-meta-card}}`** — bordered rounded-radius `<table>` with rows of `key:value` pairs. Inputs: `rows` array.
6. **`{{> email-rule}}`** — full-width hairline divider, vertical padding.
7. **`{{> email-footer}}`** — recessed surface band with brand mark + reason copy + 4-link row (Unsubscribe / Preferences / Help / Privacy) + physical address + copyright. Inputs: `reason` (override per template), `unsubscribe_href` (per template; transactional templates pass `null` and the row collapses).
8. **`{{> email-preheader}}`** — hidden white-on-white text immediately after `<body>` (the email-client preview line). Input: `text` (≤90 chars per kit convention).

**Output of E0 atoms work:** for each atom, a Handlebars-partial design (file path it will live at in E1) + the inline-styled table HTML inline in the doc. No production code yet.

### Anti-pattern guards (this phase)

- Don't write any template HTML yet — E0 is design + token-reconciliation only.
- Don't pull `AssessIQ-Email-Kit/styles.css` into the production runtime. Email clients can't read external stylesheets and the kit uses CSS custom properties (`var(--accent)`) that won't resolve in emails. All email "tokens" live as Handlebars constants in the partial files, baked in at compile time.
- Don't change `render.ts` or `index.ts` in E0. The render pipeline is correct; only the content layer (templates + partials) changes across the port.

### Docs to update (same commit)

- New: `docs/13-email-system.md` — full E0 output (resolved token table, atom designs in HTML, kit-vs-production divergence catalog).
- Cross-link to it from `docs/13-notifications/SKILL.md` (current notifications module skill doc).

### Estimated diff

- 1 new doc (~500 lines).
- No code changes.
- Total: ~500 lines (docs only).

---

## Phase E1 — Centralize (1 session)

**Why now:** With E0's atom designs in hand, materialize them as Handlebars partials + refactor the existing 9 templates to compose against the new partials. **Visual output should be IDENTICAL** to today after E1 — this phase moves duplicated HTML into shared partials without changing the rendered emails. Visual changes land in E2.

### What to implement

1. **Partials directory.** New: `modules/13-notifications/src/email/partials/`. One file per atom (`email-shell.html`, `email-header.html`, `email-cta.html`, `email-footer.html`, etc.). Each partial is a Handlebars file that takes context via inputs (`{{> email-cta label="Sign in" href=link_url}}`).
2. **Partial registration.** Extend [`render.ts`](../../modules/13-notifications/src/email/render.ts) to register every partial at module init (before any `Handlebars.compile` call). Module-load failure if any partial is missing — fail-loud at boot, not on first send.
3. **Refactor existing 9 templates.** Each template's top-of-table boilerplate (logo header, footer two-liner) becomes `{{> email-header}}` + `{{> email-footer}}`. The body content stays inline. **Bit-for-bit visual parity with the pre-E1 templates is the acceptance test** — there's no excuse for a candidate to see a different email after E1 lands.
4. **Per-template Zod var schemas extended** if and only if needed — most schemas stay unchanged; a few may add an optional `preheader` field (used by E2 but supplied with `null` default in E1).
5. **Render unit tests.** For each of the 9 templates, snapshot the rendered HTML pre-E1 and assert post-E1 HTML is structurally equivalent. Snapshots live in `modules/13-notifications/src/email/__snapshots__/` (or wherever the existing test pattern dictates).

### Anti-pattern guards (this phase)

- No VISUAL changes. If a candidate / admin sees a different email after this PR, it's a bounce.
- No new template additions. E1 refactors only.
- Don't break the per-template Zod var schemas. If a template currently takes `{ display_name, link_url, expires_minutes }`, it still takes exactly that after E1 — the partials read from the same context.

### Docs to update

- `modules/13-notifications/SKILL.md` — add a "Partials" section documenting each partial's input contract.
- `docs/13-email-system.md` — flip the atom-design section from "designed in E0" to "implemented in `modules/13-notifications/src/email/partials/`".

### Estimated diff

- 8 new partial files: ~50 lines each.
- 9 template files modified: ~30 lines net removed per file (header + footer extracted; body content stays).
- `render.ts`: ~30 lines added for partial registration.
- Tests: 9 snapshot tests + their snapshots.
- Total: ~700 lines.

---

## Phase E2a — Port 5 kit-mapped templates (1–2 sessions)

**Why now:** With partials in place, port the 5 templates that have a direct kit equivalent to the kit's visual contract. Visual change is intentional + reviewable per template.

### Templates touched

| File | Kit screen | Notes |
| --- | --- | --- |
| `invitation_candidate.html` + `.txt` | Assessment invite | Candidate-facing — eyebrow `INVITATION`, serif headline, assessment-meta card (assessment name, tenant, expiry date), primary CTA. Preheader: "You've been invited to take an AssessIQ assessment." |
| `invitation_admin.html` + `.txt` | Team invitation | Admin-facing — same shell, eyebrow `TEAM INVITATION`, body explains the role being granted (admin / reviewer / candidate). Preheader: "An AssessIQ teammate invited you to join." |
| `attempt_graded_candidate.html` + `.txt` | Result delivered | Candidate-facing — eyebrow `RESULT`, serif headline, meta card with attempt name + score band (no raw %, per `feedback-functionality-drives-ui` band-scoring rule), primary CTA "View certificate" or "View results" depending on whether a cert was issued. Preheader: "Your AssessIQ result for <assessment> is ready." |
| `attempt_ready_for_review_admin.html` + `.txt` | New submission | Admin-facing — eyebrow `READY FOR REVIEW`, meta card with attempt id + candidate (name OR anonymized — surface decision in open questions), primary CTA "Open in admin dashboard". Preheader: "An attempt is ready for your grading review." |
| `weekly_digest_admin.html` + `.txt` | Pulse newsletter | Admin-facing — eyebrow `WEEKLY DIGEST`, serif headline that varies per week (one of N rotating phrasings — copy authored in E2a), 2–3 stacked meta cards (this week's attempts, top tenants, anomalies). Preheader: rotates with the headline. |

### What to implement (per template)

- Replace existing body block with a composition of E0/E1 atoms via the partials wired in E1.
- Add `preheader` field to the Zod var schema for this template; render via `{{> email-preheader}}`.
- Add `eyebrow` field if not already present (typically a constant per template, not a runtime var).
- For Result and Submission emails, replace the legacy footer two-liner with the full `{{> email-footer}}` (commercial-template footer breadth — unsubscribe + preferences + help + privacy + address).
- TXT variant rewritten to mirror the new content order. Preserve the `Subject: <subject>\n\n<body>` convention.

### Anti-pattern guards (this phase)

- Per-template diff — review one template at a time, not all 5 in one PR. Each is its own deploy-worthy unit.
- Don't change var-schema semantics. If `attempt_graded_candidate` currently takes `{ candidate_name, assessment_name, score_band, cert_url }`, the port preserves those exact inputs (adds `preheader` / `eyebrow` only).
- Litmus / Email-on-Acid validation deferred to E3 — E2a ships the templates; E3 gates them on real-client rendering.

### Docs to update

- `docs/13-email-system.md` — per-template entries showing source + rendered HTML excerpt + the kit-divergence header comment.

### Estimated diff

- 5 templates × 2 variants × ~100 lines = ~1000 lines net change.
- Test snapshots updated.
- Docs: 5 per-template entries.
- Total: ~1100 lines.

---

## Phase E2b — Port 4 net-new derivations (1 session)

**Why now:** The remaining 4 production templates (`candidate_login_link`, `admin_email_otp`, `totp_enrolled`, `attempt_submitted_candidate`) have no kit screen but must compose from the same atoms to look consistent. E2b designs the visual mapping for each + ports.

### Templates touched

| File | Type | Mapping decision |
| --- | --- | --- |
| `candidate_login_link.html` + `.txt` | Transactional (magic-link) | Eyebrow `SIGN-IN`, serif headline "Your AssessIQ sign-in link.", body, primary CTA "Sign in", expiry caveat in a meta card, transactional footer (no unsubscribe row). Preheader: "Your AssessIQ sign-in link — expires in {{expires_minutes}} minutes." |
| `admin_email_otp.html` + `.txt` | Transactional (OTP code) | Eyebrow `SIGN-IN CODE`, serif headline "Your sign-in code.", body, **meta card with a large 6-digit code rendered as `.num` serif tabular-nums** (~32px) — the kit's "Number-stat" idiom from `design-system/tokens.md`, expiry caveat below. Preheader: "Your AssessIQ sign-in code is {{otp_code}}." (note: leaking the code in the preheader is the standard pattern for OTP emails — confirm in open questions). |
| `totp_enrolled.html` + `.txt` | Transactional (security confirmation) | Eyebrow `SECURITY`, serif headline "Two-factor authentication is on.", body explains what changed + a recovery-code reminder, no CTA (no action required). Transactional footer. Preheader: "Two-factor authentication is now on for your AssessIQ account." |
| `attempt_submitted_candidate.html` + `.txt` | Transactional (confirmation) | Eyebrow `SUBMITTED`, serif headline "We received your responses.", body explains grading is pending, attempt-id meta card, no CTA. Preheader: "Your AssessIQ submission has been received." |

### What to implement (per template)

Same shape as E2a — compose from atoms via partials, add preheader, add eyebrow constant, rewrite TXT variant, keep var-schema semantics.

### Anti-pattern guards (this phase)

- For `admin_email_otp`: confirm with security team whether the OTP code can appear in the preheader. **This is a real decision** — leaking the code in the preview line means anyone who can glance at the lock-screen notification sees the code. Some products do this (lower friction); some don't (security-strict). Surface as open question — default recommendation: **leak it** because (a) the code is already in plaintext in the email body which arrives at the same destination, (b) NoteApp / iMessage / Gmail iOS all show the code in their auto-fill suggestion sourced from preheader, which is a meaningful UX win.
- For `totp_enrolled`: NEVER include any token, code, or recovery key in the email or preheader. The "what changed" body must describe the event without re-leaking the secret.
- For `candidate_login_link`: the magic-link URL in the CTA is single-use and email-crawler-prefetch-safe per `docs/04-auth-flows.md` Flow 6 — that contract must not change.

### Docs to update

- `docs/13-email-system.md` — per-template entries; flag the 4 templates as "derived" with rationale + the kit-divergence header comment.

### Estimated diff

- 4 templates × 2 variants × ~100 lines = ~800 lines net change.
- Total: ~800 lines.

---

## Phase E3 — Validation (1 session)

**Why now:** Every template has shipped via E2a + E2b. E3 confirms they actually render correctly in real email clients before declaring the port done.

### What to validate

1. **Litmus or Email on Acid** render sweep across the matrix (per kit README "test in Litmus or Email on Acid before shipping"):
   - Gmail web (Chrome desktop + Chrome iOS in-app browser when tapped from notification)
   - Outlook 2016+ for Windows
   - Outlook 365 web
   - Apple Mail iOS (with and without dark mode)
   - Gmail iOS in-app browser
2. **In-app webview smoke** on a real iPhone for the magic-link CTA — `candidate_login_link` must complete the round trip from Gmail iOS tap → SPA verify → certificate portal. Same for `admin_email_otp` if MFA is enabled in production.
3. **Plain-text variant smoke** — set Gmail web to "Plain text only" view mode; confirm every TXT variant renders sensibly (no Handlebars artifacts, subject line correctly parsed).
4. **i18n smoke** — for each template, render with a non-English locale (if E2 has produced any) and confirm the `_t_*` strings resolve.
5. **email_log audit** — send each template through the production pipeline (or a staging mirror) and confirm an `email_log` row lands with the right tenant_id, status transitions queued → sending → sent, and the provider_message_id is populated.

### Anti-pattern guards (this phase)

- E3 surfaces bugs but does NOT fix them in the same PR — bugs go to per-template fix commits referencing the E3 finding. Keeps the validation PR clean.
- Don't add new test infrastructure — Litmus / Email on Acid is a paid SaaS one-off; in-app webview smoke is manual. If we want automated visual-regression on emails as a project follow-up, that's a separate scope outside this port.

### Docs to update

- `docs/13-email-system.md` — new "Validation results" section + screenshots of the matrix.

### Estimated diff

- Docs only (no code changes from E3 itself; per-bug fix commits land separately if any).
- Total: ~100 lines.

---

## Phase E4 — Documentation + handoff (1 session)

**Why last:** Consolidate the per-phase docs into a coherent email chapter, update the index, mark this plan SHIPPED.

### What to implement (docs only)

1. `docs/13-email-system.md` — final consolidated chapter:
   - Resolved token table (E0 output).
   - Atom catalog with per-atom input contract + rendered HTML excerpt.
   - Per-template catalog with audience, type (transactional / commercial / lifecycle), preheader, eyebrow, var schema, kit-divergence note.
   - Validation results from E3.
   - The "functionality drives UI" rule, restated in production-doc form.
   - CAN-SPAM / DPDP compliance note: which templates carry which footer breadth and why.
2. `PROJECT_BRAIN.md` decision log — one row: `2026-MM-DD | Email Kit Port shipped (E0–E4) | Centralized 9 production email templates against the kit visual contract via Handlebars partials. No new templates added; no backend changes; CAN-SPAM-compliant footer with physical address + unsubscribe on commercial templates only. | docs/plans/EMAIL_KIT_PORT.md`.
3. `docs/RCA_LOG.md` — only entries for bugs actually surfaced during the port (typically Outlook rendering regressions, dark-mode invert breaks). Empty if clean.
4. Mark this plan doc's "Progress" line all ✅ and add a "**Status: SHIPPED** (E0–E4 complete, YYYY-MM-DD)" header.

### Anti-pattern guards (this phase)

- No code changes. Docs only.
- Don't backdate decision-log entries; use the actual session date.

### Estimated diff

- 1 new doc consolidating + 3 doc updates = ~600 lines.
- Total: ~600 lines.

---

## Open decisions to surface before E0 starts

These need a user call before implementation.

### Tokens

1. **Canvas background:** kit `#f1efea` warmer off-white vs production `#f5f5f5` neutral gray. **Default recommendation: kit.** Adopts the authored design choice.
2. **Card width:** kit 640px vs production 600px. **Default recommendation: kit 640px.** Modern standard.
3. **Headline H1 size per template class:** 30px (editorial templates: Result, Newsletter, Invite) vs 22px (short-form transactional: OTP code, magic-link, Submitted). **Default recommendation: this split.** Avoids a single one-size-fits-all that makes OTP emails feel heavy.

### Footer scope

4. **Unsubscribe row scope:** which templates show "Unsubscribe / Preferences / Help / Privacy" vs the minimal transactional footer (brand + reason + privacy only)?
   - **Transactional** (no unsubscribe, no marketing preferences):
     - `candidate_login_link`, `admin_email_otp`, `totp_enrolled`, `attempt_submitted_candidate`, `attempt_ready_for_review_admin`
   - **Commercial / Lifecycle** (full unsubscribe + preferences row):
     - `invitation_admin`, `invitation_candidate`, `attempt_graded_candidate` (gradable as either — leans lifecycle), `weekly_digest_admin`
   - **Default recommendation:** the split above. CAN-SPAM exempts transactional emails from the unsubscribe requirement; commercial / lifecycle must include it.
5. **Physical mailing address:** CAN-SPAM-required + DPDP-recommended on commercial templates. **What address?** Kit example uses "548 Market St · San Francisco, CA 94104". Production must use a real, monitored address — likely the AssessIQ legal-entity address or the tenant's provisioning-org address. **Surface to user — there is no good default.**
6. **Unsubscribe + preferences mechanics:** does an unsubscribe page exist today? If not, E0/E1 need to also stub a `/unsubscribe?token=<jwt>` endpoint OR the port must omit the Unsubscribe link until that endpoint is built. **Default recommendation: omit Unsubscribe link until the endpoint is built; track as deferred.** Don't ship a link that 404s.

### OTP preheader

7. **OTP code in preheader for `admin_email_otp`:** leak the code into the email preview line (lower friction; matches iOS Mail and Gmail auto-fill) vs. hide it (security-strict). **Default recommendation: leak it.** Same plaintext reaches the same destination anyway; auto-fill UX is meaningful.

### Net-new product surface

8. **Pulse monthly newsletter:** the kit ships this as Template #1 but **no production send exists today**. M0 of the port covers it via `weekly_digest_admin` (which IS a production send). Should we also build a candidate-facing monthly digest? **Default recommendation: out of scope.** It's a product addition, not a port. Track as a separate proposal if wanted.

### Anonymization

9. **`attempt_ready_for_review_admin` candidate identity:** the email currently includes the candidate's name. Some tenants want graders to review anonymously (debiasing). **Default recommendation: keep candidate name** (it's the existing production behavior) but add a tenant-level `anonymize_attempts_in_email` flag as a separate proposal. Don't fold it into this port.

### Localization

10. **Locale matrix:** today `_t_*` substitution works but only `en` strings exist in [`i18n.ts`](../../modules/13-notifications/src/email/i18n.ts). Should E2 author additional locales as part of the port, or is locale matrix out of scope? **Default recommendation: out of scope** — E2 authors all new copy in `en` only; the `_t_*` machinery is preserved for future locale work.

### Validation

11. **Litmus / Email on Acid budget:** these are paid SaaS at ~$80–$150/month. Is the port authorized to use one? **Default recommendation: yes for E3 (one-month flat fee to validate the full matrix); cancel after the port ships.** Alternative is manual validation across the matrix from real accounts (Gmail, Outlook web, etc.) which is more work but free.

---

## Out of scope (explicitly)

The following are NOT part of this port. If they become wanted later they are separate scopes:

- **New email templates** (Pulse candidate newsletter, attempt-abandoned nudge, password-reset, account-deletion confirmation, etc.). Add them as separate product proposals + ship them post-port.
- **Backend send-pipeline changes** — no changes to `render.ts`, `index.ts`, `transport.ts`, BullMQ wiring, `email_log` schema, dev-emails.log fallback. Port is content-layer only (templates + partials).
- **Locale matrix beyond `en`** — see open decision #10.
- **Email preference center UI** — see open decision #6.
- **Automated visual-regression CI for emails** — manual / paid-SaaS validation in E3 only; CI gating is a separate infrastructure proposal.
- **SMS / Push notification** — port is email-only. Other notification channels are separate modules with their own design contracts.
- **Tenant-level branding overrides** (per-tenant logo, accent color in emails) — defer until multi-tenant white-label is a real product requirement, then port to the existing `tenant.branding` JSONB column.
- **Plain-text-only mode toggle per tenant** — every template ships HTML + TXT today; an admin toggle to send TXT-only is a product addition outside this port.
- **Re-introducing the kit's `<canvas>` color outside the email card** — the kit shows `#f1efea` as an outer wrapper outside the white card, but production emails today ship with a transparent / client-default outer wrapper. This is a kit-mock-only treatment; production stays client-default per the kit README's "Shipping to production" guidance.

---

## Summary

A 6-phase, ~6–9 session port that consolidates the 9 production email templates against the Email-Kit visual contract via Handlebars partials. **Zero backend changes, zero new templates, zero new sends.** Resolves open token deltas, adopts the kit's editorial footer breadth (with CAN-SPAM-aware split), adds preheader text to every template, mandates email-safe table-based layout + inline styles + MSO/VML throughout. Litmus / EmailOnAcid validation gates the final declaration of DONE.

**Read this plan + the open decisions before kicking off E0.** Several decisions (canvas color, physical address, OTP preheader, unsubscribe-link-vs-stub) need an explicit call before partials can be authored.
