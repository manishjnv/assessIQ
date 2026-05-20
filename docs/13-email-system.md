# 13 — Email System

> **Phase E0 output** (foundation: tokens reconciliation + email-safe atom designs).
> Authored 2026-05-21 against [`docs/plans/EMAIL_KIT_PORT.md`](plans/EMAIL_KIT_PORT.md).
>
> **Scope of this doc.** Single source-of-truth for "what does an AssessIQ email look like." Resolves the kit-vs-production token deltas, designs the 8 email-safe atoms as table-based HTML, and surfaces the open product decisions still required before Phase E1 starts materializing Handlebars partials. **No production code lands as part of E0** — the atom HTML below is the *contract* E1 implements.
>
> **What this doc is NOT.** It is not the email send pipeline reference — that lives in [`modules/13-notifications/SKILL.md`](../modules/13-notifications/SKILL.md). It is not a marketing-content style guide — voice / copy conventions live in the kit's [`copy-and-voice.md`](../modules/17-ui-system/AssessIQ_UI_Template/AssessIQ-Email-Kit/design-system/copy-and-voice.md).

---

## §0 North-star rule (read first — non-negotiable)

**The Email Kit is a design-philosophy reference, NOT a per-email mockup catalog.**

The scope of this port is: **make every existing AssessIQ email follow the kit's design philosophy.** Tokens, atoms, type rhythm, footer breadth, voice — applied uniformly across the 9 production templates that we ALREADY send. The kit happens to draw explicit screens for 5 of those 9; that is a *work-order* convenience (those are faster to author because the kit gives more reference), not a *categorical* distinction. The other 4 (`candidate_login_link`, `admin_email_otp`, `totp_enrolled`, `attempt_submitted_candidate`) compose from the same atoms and follow the same philosophy.

Concrete implications, in case anyone is tempted to interpret the kit as a catalog:

1. **Pulse newsletter is NOT a product addition.** The kit ships a "Pulse" mockup; production sends `weekly_digest_admin` and only that. The port applies the Pulse *philosophy* (editorial eyebrow, serif headline, stacked meta cards, footer breadth) to the existing weekly digest. It does NOT introduce a candidate-facing monthly newsletter.
2. **Don't skip a template because the kit didn't draw a screen for it.** `admin_email_otp`, `candidate_login_link`, `totp_enrolled`, `attempt_submitted_candidate` all get the same atom set + token contract + voice treatment as the kit-mapped ones. The plan's E2a / E2b split is sequencing, not a permission gate.
3. **Don't add a new template because the kit hints at it.** If something feels missing (password reset, attempt-abandoned nudge, account-deletion confirmation, …) that is a separate product decision, surfaced and approved outside this port. The kit's atoms remain available for it when/if it ships.
4. **Don't lose existing content.** Every var, every i18n string, every condition in the 9 production templates today is load-bearing. E1 ports the wrapper; E2 reapplies the kit's *visual* contract to the *same* content surface. If a candidate or admin gets a noticeably different *message* after the port, that's a bounce.

This rule mirrors `feedback-functionality-drives-ui.md` ("UI kits are palettes of idioms, not product specs") applied to the email surface. It is the same rule the Mobile Kit Port and the AccessIQ UI Template port followed.

---

---

## Source-of-truth chain

```text
modules/17-ui-system/AssessIQ_UI_Template/AssessIQ-Email-Kit/   ← visual contract (mocks)
  ├── emails/email-atoms.jsx                                     ← kit atom shapes (React + flex)
  ├── design-system/tokens.md                                    ← kit token values
  └── styles.css                                                 ← kit CSS source-of-truth (CSS vars)
                                  │
                                  ▼ port (this doc)
docs/13-email-system.md                                          ← resolved tokens + email-safe HTML
                                  │
                                  ▼ implementation (E1)
modules/13-notifications/src/email/partials/                     ← Handlebars partials
modules/13-notifications/src/email/templates/*.{html,txt}        ← per-trigger templates
modules/13-notifications/src/email/render.ts                     ← compile + Zod var validation
```

Email "tokens" are NOT CSS custom properties — email clients can't resolve `var(--accent)`. They are Handlebars-resolved constants, baked in as literal hex / px values at compile time. The table below is the canonical list.

---

## §1 Resolved token table

Reconciles the kit's [`tokens.md`](../modules/17-ui-system/AssessIQ_UI_Template/AssessIQ-Email-Kit/design-system/tokens.md) + [`styles.css`](../modules/17-ui-system/AssessIQ_UI_Template/AssessIQ-Email-Kit/styles.css) against the current production templates in [`modules/13-notifications/src/email/templates/`](../modules/13-notifications/src/email/templates). Resolution column = the value E1 inlines into partials.

### 1.1 Color

| Token name | Kit value | Production value | **Resolved (E1 inlines this)** | Notes |
| --- | --- | --- | --- | --- |
| `--canvas` | `#f1efea` | `#f5f5f5` | **`#f1efea`** | Warmer brand-aligned off-white. Per plan open-decision #1. |
| `--bg` (card) | `#ffffff` | `#ffffff` | **`#ffffff`** | Aligned. |
| `--surface` (footer band) | `#fafafa` | `#f5f5f5` | **`#fafafa`** | Distinct from canvas so the footer reads as recessed. |
| `--border` | `#e4e4e7` | `#e8e8e8` | **`#e4e4e7`** | Matches SPA's `--aiq-color-border`. |
| `--accent` | `#1a73e8` | `#1a73e8` | **`#1a73e8`** | Aligned. Primary CTA fill, accent links, footer brand dot. |
| `--text` | `#0a0a0b` | `#1a1a1a` | **`#0a0a0b`** | True black. |
| `--text-muted` | `#3f3f46` | `#5f6368` | **`#3f3f46`** | Body / lede secondary. |
| `--text-faint` | `#71717a` | `#9aa0a6` | **`#71717a`** | Mono metadata, footer microcopy. |
| Preheader hidden-text fill | n/a | n/a | **`#fefefe`** | White-on-white with the parent canvas; invisible but indexable. |

### 1.2 Layout

| Token | Kit | Prod | **Resolved** | Notes |
| --- | --- | --- | --- | --- |
| Card width | 640 px | 600 px | **640 px** | Standard for modern transactional; safe in Gmail desktop + iOS Mail. |
| Card radius | 14 px | 16 px | **14 px** | Subtle; defer to authored choice. |
| Card border | 1 px solid `--border` | 1 px solid `#e8e8e8` | **1 px solid `#e4e4e7`** | |
| Card inner padding (body cell) | 36 × 40 px | 40 × 40 px | **36 × 40 px** (`vertical × horizontal`) | |
| Header cell padding | 22 × 36 px | 24 × 40 px | **22 × 36 px** | |
| Footer cell padding | 28 / 40 / 32 (top / x / bottom) | 20 × 40 | **28 × 40 × 32** | Roomier — footer is editorial. |
| Outer wrapper padding around card | 32 × 24 × 40 (top / x / bottom) | 40 × 0 | **32 × 24 × 40** | Phone-edge breathing room. |

### 1.3 Type

| Token | Kit (web) | Email-safe fallback (production wins) | **Resolved** | Notes |
| --- | --- | --- | --- | --- |
| Serif (display) | Newsreader | `Georgia, 'Times New Roman', serif` | **`Georgia, 'Times New Roman', serif`** | Newsreader is the editorial *intent*; not loadable in email clients. |
| Sans (body) | Geist | `'Helvetica Neue', Helvetica, Arial, sans-serif` | **`'Helvetica Neue', Helvetica, Arial, sans-serif`** | |
| Mono (metadata) | Geist Mono | `'SF Mono', Menlo, Consolas, monospace` | **`'SF Mono', Menlo, Consolas, monospace`** | |
| Body size | 15 px | 15 px | **15 px** | |
| Body-large size (lede paragraph) | 17 px | 15–22 px (varies) | **17 px** | Authored once; avoids per-template drift. |
| H1 size — editorial templates | 30 px | 22 px | **30 px** | Used by Result, Newsletter, Invite. |
| H1 size — short-form transactional | n/a | 22 px | **22 px** | Used by OTP code, magic-link, Submitted. |
| Eyebrow microcopy (mono) | 10–11 px, uppercase, letter-spacing `0.08em` | n/a (production has no eyebrow) | **11 px, uppercase, letter-spacing `0.08em`** | New across the board. |
| Body line-height | 1.55 | 1.6 | **1.55** | |
| Letter-spacing on serif H1 | `-0.02em` | `-0.01em` | **`-0.02em`** | Tighter optical pairing. |

### 1.4 Buttons

| Token | Kit | Prod | **Resolved** | Notes |
| --- | --- | --- | --- | --- |
| Pill button radius | 999 px | 999 px | **999 px** | Aligned. MSO/VML `arcsize="50%"` for Outlook. |
| Pill button padding | 14 × 28 px | 12 × 28 px | **14 × 28 px** | Slightly larger tap target. |
| Pill button font | 14 px, weight 500, sans, letter-spacing `-0.005em` | 14 px, weight 500 | **14 px, weight 500, sans, letter-spacing `-0.005em`** | |
| Pill button fill | `--accent` | `--accent` | **`#1a73e8`** | |
| Pill button text | white | white | **`#ffffff`** | |

### 1.5 Misc

| Token | Resolved | Notes |
| --- | --- | --- |
| Meta-card border | 1 px solid `#e4e4e7` | |
| Meta-card row inner padding | 14 × 20 px | |
| Meta-card row border-top (rows 2+) | 1 px solid `#e4e4e7` | |
| Meta-card outer radius | 12 px | Slightly tighter than the card. Inlined on the outermost `<table>`. |
| `<hr>` rule | 1 px solid `#e4e4e7`, default 28 px vertical pad | |
| Preheader char budget | ≤ 90 chars | Per kit convention. |
| Footer brand-dot | 8 × 8 px, `border-radius: 50%`, fill `#1a73e8` | |

---

## §2 Atom catalog — email-safe HTML designs

Each atom below specifies (a) the kit React shape it ports, (b) the inputs Handlebars passes, (c) the table-based HTML E1 materializes as a partial. **All atoms are inline-styled. No `<style>` blocks. No CSS classes. No flex / grid.** Outlook on Windows ignores both, and Gmail strips `<style>`.

A `{{ var }}` placeholder is a Handlebars context input (HTML-escaped via `noEscape: false`). A `<!-- … -->` block is documentation, retained in the partial.

### A1 — `{{> email-shell }}`

**Kit equivalent:** `EmailShell` ([emails/email-atoms.jsx:13-43](../modules/17-ui-system/AssessIQ_UI_Template/AssessIQ-Email-Kit/emails/email-atoms.jsx#L13-L43)).

**Inputs:**

| Name | Type | Required | Notes |
| --- | --- | --- | --- |
| `preheader` | string ≤ 90 chars | yes | Hidden preview-line text. Composes via `{{> email-preheader }}`. |
| *block content* | template HTML (rendered via `{{> @partial-block}}`) | yes | The card contents — passed as a Handlebars **block partial** call (see §3 composition pattern). |

**HTML:**

```html
<!DOCTYPE html>
<html lang="{{lang}}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="x-apple-disable-message-reformatting">
  <meta name="color-scheme" content="light only">
  <meta name="supported-color-schemes" content="light only">
  <title>{{_t_page_title}}</title>
</head>
<body style="margin:0;padding:0;background:#f1efea;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;color:#0a0a0b;font-size:15px;line-height:1.55;letter-spacing:-0.005em;-webkit-font-smoothing:antialiased">
  {{> email-preheader text=preheader }}
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f1efea">
    <tr>
      <td align="center" style="padding:32px 24px 40px">
        <table role="presentation" width="640" cellpadding="0" cellspacing="0" border="0" style="width:640px;max-width:640px;background:#ffffff;border:1px solid #e4e4e7;border-radius:14px;overflow:hidden">
          {{> @partial-block}}
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
```

**Why.** Outer 100 % table = client width; inner fixed-640 table = card. `role="presentation"` tells screen-readers it's layout. `meta` tags suppress Outlook-Mobile reformatting and lock the email to light mode (we have not designed dark variants yet — see §4 open question).

**Composition mechanism — block partials, not subexpressions.** `email-shell` is invoked as a Handlebars **block partial** (`{{#> email-shell preheader=...}}...{{/email-shell}}`). The block content is exposed inside the partial as `{{> @partial-block}}` — this is built-in Handlebars syntax requiring no custom helper. See §3 for the canonical composition shape. Do NOT attempt to pass body content via a `{{{body}}}` slot var or a `(partial 'name')` subexpression — both require either pre-rendering or a custom helper, both more fragile than the built-in block-partial pattern.

### A2 — `{{> email-preheader }}`

**Kit equivalent:** the kit shows the preheader on-canvas as visible mono microcopy. In production it is the *hidden* preview text — the kit's on-canvas treatment is documentation-only.

**Inputs:** `text` — the ≤ 90 char preview line.

**HTML:**

```html
<div style="display:none;font-size:1px;line-height:1px;color:#fefefe;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all">
  {{text}}&#8199;&#65279;&#8199;&#65279;&#8199;&#65279;&#8199;&#65279;&#8199;&#65279;&#8199;&#65279;&#8199;&#65279;&#8199;&#65279;&#8199;&#65279;&#8199;&#65279;&#8199;&#65279;&#8199;&#65279;&#8199;&#65279;&#8199;&#65279;&#8199;&#65279;&#8199;&#65279;&#8199;&#65279;&#8199;&#65279;&#8199;&#65279;&#8199;&#65279;
</div>
```

**Why.** The `&#8199;&#65279;` (figure-space + zero-width no-break-space) pairs pad the preview line past the body's first chars so the client doesn't display "Set up your account · You're receiving this because…" mash-up. `mso-hide:all` hides from Outlook explicitly. `display:none` is respected by every modern client.

### A3 — `{{> email-header }}`

**Kit equivalent:** `EmailHeader` (kit:49-64).

**Inputs:**

| Name | Type | Required | Notes |
| --- | --- | --- | --- |
| `eyebrow` | string (mono uppercase) | no | E.g. `INVITATION`, `RESULT`, `READY FOR REVIEW`. |

**HTML:**

```html
<!-- A3 email-header — wordmark left, optional eyebrow right -->
<tr>
  <td style="padding:22px 36px;border-bottom:1px solid #e4e4e7;background:#ffffff">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr>
        <td style="font-family:Georgia,'Times New Roman',serif;font-size:18px;font-weight:400;color:#0a0a0b;letter-spacing:-0.01em">
          {{_t_brand_wordmark}}
        </td>
        {{#if eyebrow}}
        <td align="right" style="font-family:'SF Mono',Menlo,Consolas,monospace;font-size:10px;color:#71717a;text-transform:uppercase;letter-spacing:0.1em">
          {{eyebrow}}
        </td>
        {{/if}}
      </tr>
    </table>
  </td>
</tr>
```

**Why.** Flex → inner 2-cell table. `align="right"` keeps the eyebrow trailing. Serif wordmark is the editorial signature.

### A4 — `{{> email-body }}` (container)

**Kit equivalent:** `EmailBody` (kit:69-73).

**Inputs:**

| Name | Type | Required | Notes |
| --- | --- | --- | --- |
| `pad` | CSS shorthand (e.g. `36px 40px`) | no | Pre-resolved by the per-template Zod schema with `.default('36px 40px')` — partial reads `{{pad}}` unconditionally. |
| *block content* | template HTML (`{{> @partial-block}}`) | yes | Inner body content. Invoke as a block partial: `{{#> email-body}}…{{/email-body}}`. |

**HTML:**

```html
<!-- A4 email-body — generous side padding -->
<tr>
  <td style="padding:{{pad}};background:#ffffff">
    {{> @partial-block}}
  </td>
</tr>
```

**Note.** `pad` defaults via Zod (`.default('36px 40px')`) so the partial doesn't carry an `{{#if}}` branch. Templates that need custom padding pass `pad="28px 32px"` etc. on the block-partial invocation.

### A5 — `{{> email-lede }}` (two partials — editorial / short)

**Kit equivalent:** `EmailLede` (kit:76-97).

**Inputs (both variants):**

| Name | Type | Required | Notes |
| --- | --- | --- | --- |
| `eyebrow` | string | no | Mono uppercase, accent color. |
| `title` | string | yes | Serif H1. |
| `body` | string | no | Muted paragraph. |

**Variant selection.** Editorial (30 px H1) is the default for Result, Newsletter, Invite. Short (22 px H1) is for OTP-code, magic-link, Submitted. Pick by partial name (`{{> email-lede-editorial …}}` vs `{{> email-lede-short …}}`) — not by a `size` input — so no Handlebars helper is needed. The two partials are 95 % identical; the only delta is the H1 font-size.

**HTML — `email-lede-editorial` (30 px H1):**

```html
<!-- A5 email-lede-editorial -->
{{#if eyebrow}}
<p style="margin:0 0 14px;font-family:'SF Mono',Menlo,Consolas,monospace;font-size:11px;font-weight:500;color:#1a73e8;text-transform:uppercase;letter-spacing:0.08em">{{eyebrow}}</p>
{{/if}}
<h1 style="margin:0 0 14px;font-family:Georgia,'Times New Roman',serif;font-size:30px;font-weight:500;color:#0a0a0b;letter-spacing:-0.02em;line-height:1.15">{{title}}</h1>
{{#if body}}
<p style="margin:0;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:17px;color:#3f3f46;line-height:1.55">{{body}}</p>
{{/if}}
```

**HTML — `email-lede-short` (22 px H1):**

```html
<!-- A5 email-lede-short -->
{{#if eyebrow}}
<p style="margin:0 0 14px;font-family:'SF Mono',Menlo,Consolas,monospace;font-size:11px;font-weight:500;color:#1a73e8;text-transform:uppercase;letter-spacing:0.08em">{{eyebrow}}</p>
{{/if}}
<h1 style="margin:0 0 14px;font-family:Georgia,'Times New Roman',serif;font-size:22px;font-weight:500;color:#0a0a0b;letter-spacing:-0.02em;line-height:1.15">{{title}}</h1>
{{#if body}}
<p style="margin:0;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:17px;color:#3f3f46;line-height:1.55">{{body}}</p>
{{/if}}
```

**Note.** Two partial files instead of one + an `ifEquals` helper. Net: +1 file, -1 runtime helper, zero template-engine surface area added. If a third H1 size emerges later (it shouldn't), revisit then.

### A6 — `{{> email-cta }}` (pill button + MSO/VML wrap)

**Kit equivalent:** `EmailCTA` (kit:103-119).

**Inputs:**

| Name | Type | Required | Notes |
| --- | --- | --- | --- |
| `label` | string | yes | Imperative verb phrase. |
| `href` | URL | yes | Fully qualified; never relative. |
| `width_px` | integer | no | Approx label width for VML container (defaults to 220). |

**HTML:**

```html
<!-- A6 email-cta — pill button with MSO/VML Outlook fallback -->
<!--[if mso]>
<v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word"
  href="{{href}}"
  style="height:46px;v-text-anchor:middle;width:{{#if width_px}}{{width_px}}{{else}}220{{/if}}px;"
  arcsize="50%" stroke="f" fillcolor="#1a73e8">
  <w:anchorlock/>
  <center style="color:#ffffff;font-family:'Helvetica Neue',Arial,sans-serif;font-size:14px;font-weight:500;letter-spacing:-0.005em">
    {{label}}
  </center>
</v:roundrect>
<![endif]-->
<!--[if !mso]><!-->
<a href="{{href}}"
  style="display:inline-block;background:#1a73e8;color:#ffffff;padding:14px 28px;border-radius:999px;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:14px;font-weight:500;letter-spacing:-0.005em;text-decoration:none;mso-hide:all">
  {{label}}
</a>
<!--<![endif]-->
```

**Why two parallel renderings.** Outlook 2007–2019 (still ~15 % of B2B inboxes) ignores `border-radius` on `<a>`, rendering pill buttons as sharp rectangles. The `<v:roundrect>` is the VML equivalent, rendered only inside Outlook (`<!--[if mso]>`). `<!--[if !mso]><!-->` is a documented "everything-except-Outlook" comment trick that hides the HTML `<a>` from MSO and shows it everywhere else. The two never render together.

**Note on `width_px`.** VML requires an explicit width; HTML `<a>` does not. For variable labels, per-template `width_px` is a best-effort approximation that wraps the label without clipping (rule of thumb: 8 px per ASCII character + 56 px button padding). E2a/E2b authors set this per template.

### A7 — `{{> email-meta-card }}`

**Kit equivalent:** `EmailMetaCard` (kit:138-161).

**Inputs:** `rows` — array of `{ k, v }`. `k` is the mono uppercase label (left, 110 px column); `v` is the sans content (right, flexes).

**HTML:**

```html
<!-- A7 email-meta-card — bordered key/value pair list -->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid #e4e4e7;border-radius:12px;border-collapse:separate">
  {{#each rows}}
  <tr>
    <td style="padding:14px 20px;{{#unless @first}}border-top:1px solid #e4e4e7;{{/unless}}font-family:'SF Mono',Menlo,Consolas,monospace;font-size:10px;color:#71717a;text-transform:uppercase;letter-spacing:0.08em;width:110px;vertical-align:middle;white-space:nowrap">
      {{k}}
    </td>
    <td style="padding:14px 20px 14px 0;{{#unless @first}}border-top:1px solid #e4e4e7;{{/unless}}font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:14px;color:#0a0a0b;vertical-align:middle">
      {{{v}}}
    </td>
  </tr>
  {{/each}}
</table>
```

**Why.** `border-collapse:separate` is required for the outer `border-radius` to render in WebKit clients (otherwise the inner `<td>` borders punch through). `@first` / `@last` are Handlebars built-ins; no helper needed.

**Why `{{{v}}}` (triple-stash exception).** The value cell may contain inline emphasis (`<strong>`) or a short link. Triple-stash is otherwise forbidden — this is the **sole allowed exception**, reconciled with [`EMAIL_KIT_PORT.md`](plans/EMAIL_KIT_PORT.md) anti-pattern guard #9 (amended to document this exception). `v` is authored at the *template* level (e.g. `{ k: "Score", v: '<strong>Distinguished</strong>' }`), never substituted from candidate-supplied data.

**Enforcement (mandatory in E1):**

1. **Per-template comment.** Every template that builds a `meta_rows` array must carry a comment immediately above the row construction:

   ```ts
   // SAFETY: meta_rows[*].v is rendered via {{{v}}} (triple-stash, HTML-unescaped).
   // Every v MUST be a literal or a server-controlled value — NEVER a user / tenant /
   // candidate string. See docs/13-email-system.md §2 A7.
   const meta_rows = [
     { k: "Assessment", v: `<strong>${escape(assessmentName)}</strong>` },
     ...
   ];
   ```

2. **Render-time invariant — `assertSafeMetaRows()`.** E1 adds a helper in `render.ts` invoked by every template that consumes `email-meta-card`:

   ```ts
   function assertSafeMetaRows(rows: Array<{ k: string; v: string }>): void {
     for (const row of rows) {
       // v must be either: (a) plain text with no '<' / '>', OR
       //                   (b) HTML containing ONLY allow-listed tags from a fixed set.
       if (!isSafeMetaValue(row.v)) {
         throw new Error(`unsafe meta_rows.v: ${row.v.slice(0, 60)}`);
       }
     }
   }
   ```

   Allow-list (initial): `<strong>`, `</strong>`, `<em>`, `</em>`, `<br>`, and `<a href="…">…</a>` with `href` matching `^https://[a-z0-9.-]+/` (no `javascript:`, no relative). Anything else → throw. The exception is enforced as a runtime invariant — failing loudly during local rendering is cheaper than a Litmus surprise or a candidate-name-injection report.

3. **CI lint.** E1 adds an AST-level scan in `modules/13-notifications/test/lint-meta-rows.test.ts` that grep-walks every `templates/*.html` consumer file and flags any `meta_rows` literal whose `v:` value contains a Handlebars var reference not preceded by `escape(`. Patterns to bounce:

   ```ts
   v: `...${candidateName}...`       // raw candidate name → reject
   v: `...${tenant.name}...`         // raw tenant name → reject
   v: `...${user.email}...`          // raw user input → reject
   v: someUntypedVar                 // unknown provenance → reject
   ```

Together, the per-template comment, the runtime assert, and the CI lint mean every triple-stash use is intentional, documented, and prevented from silently widening over time.

### A8 — `{{> email-rule }}` (divider)

**Kit equivalent:** `EmailRule` (kit:130-135).

**Inputs:** `pad` (integer px, default `28`).

**HTML:**

```html
<!-- A8 email-rule — hairline divider -->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
  <tr>
    <td style="padding:{{#if pad}}{{pad}}{{else}}28{{/if}}px 0;font-size:0;line-height:0">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr><td style="border-top:1px solid #e4e4e7;font-size:0;line-height:0">&nbsp;</td></tr>
      </table>
    </td>
  </tr>
</table>
```

**Why.** `<hr>` is unstyleable in Outlook. The 1-px `border-top` on a nested `<td>` with `font-size:0;line-height:0` and a single `&nbsp;` is the bulletproof equivalent.

### A9 — `{{> email-footer }}` (TWO variants)

The plan's open decision #4 splits production templates into **transactional** (no unsubscribe row) and **commercial / lifecycle** (full unsubscribe + preferences row, physical address, copyright). Two partial variants:

#### A9a — `{{> email-footer-transactional }}`

For: `candidate_login_link`, `admin_email_otp`, `totp_enrolled`, `attempt_submitted_candidate`, `attempt_ready_for_review_admin`.

**Inputs:** `reason` (override per template, defaults to a generic "you're receiving this because…" line).

**HTML:**

```html
<!-- A9a email-footer-transactional — brand mark + reason + address + © -->
<tr>
  <td style="padding:28px 40px 32px;background:#fafafa;border-top:1px solid #e4e4e7">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr>
        <td style="padding-bottom:14px;font-family:Georgia,'Times New Roman',serif;font-size:14px;font-weight:500;color:#0a0a0b;letter-spacing:-0.01em">
          <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#1a73e8;vertical-align:middle;margin-right:10px"></span>
          AssessIQ
        </td>
      </tr>
      <tr>
        <td style="padding-bottom:18px;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:12px;color:#3f3f46;line-height:1.55;max-width:460px">
          {{#if reason}}{{reason}}{{else}}You're receiving this because you have an active AssessIQ account. This is a transactional message that does not include marketing.{{/if}}
        </td>
      </tr>
      <tr>
        <td style="border-top:1px solid #e4e4e7;padding-top:16px;font-family:'SF Mono',Menlo,Consolas,monospace;font-size:10px;color:#71717a;text-transform:uppercase;letter-spacing:0.08em">
          {{_t_legal_entity}} &middot; {{_t_legal_address}} &middot; &copy; {{copyright_year}}
        </td>
      </tr>
    </table>
  </td>
</tr>
```

#### A9b — `{{> email-footer-commercial }}`

For: `invitation_admin`, `invitation_candidate`, `attempt_graded_candidate`, `weekly_digest_admin`.

**Inputs:** `reason`, `unsubscribe_href` (per-recipient signed URL).

**HTML:**

```html
<!-- A9b email-footer-commercial — adds unsubscribe / preferences / help / privacy row -->
<tr>
  <td style="padding:28px 40px 32px;background:#fafafa;border-top:1px solid #e4e4e7">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr>
        <td style="padding-bottom:14px;font-family:Georgia,'Times New Roman',serif;font-size:14px;font-weight:500;color:#0a0a0b;letter-spacing:-0.01em">
          <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#1a73e8;vertical-align:middle;margin-right:10px"></span>
          AssessIQ
        </td>
      </tr>
      <tr>
        <td style="padding-bottom:18px;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:12px;color:#3f3f46;line-height:1.55;max-width:460px">
          {{reason}}
        </td>
      </tr>
      <tr>
        <td style="padding-bottom:20px;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:12px">
          {{#if unsubscribe_href}}<a href="{{unsubscribe_href}}" style="color:#3f3f46;text-decoration:none;margin-right:18px">{{_t_unsubscribe}}</a>{{/if}}
          <a href="{{preferences_href}}" style="color:#3f3f46;text-decoration:none;margin-right:18px">{{_t_preferences}}</a>
          <a href="{{help_href}}" style="color:#3f3f46;text-decoration:none;margin-right:18px">{{_t_help}}</a>
          <a href="{{privacy_href}}" style="color:#3f3f46;text-decoration:none">{{_t_privacy}}</a>
        </td>
      </tr>
      <tr>
        <td style="border-top:1px solid #e4e4e7;padding-top:16px;font-family:'SF Mono',Menlo,Consolas,monospace;font-size:10px;color:#71717a;text-transform:uppercase;letter-spacing:0.08em">
          {{_t_legal_entity}} &middot; {{_t_legal_address}} &middot; &copy; {{copyright_year}}
        </td>
      </tr>
    </table>
  </td>
</tr>
```

**`{{#if unsubscribe_href}}` rationale.** Per open decision #6 (still unresolved), the `/unsubscribe?token=<jwt>` endpoint may not exist when E1 ships. The conditional collapses the link gracefully — never ship a row that 404s. E2a author passes `unsubscribe_href=null` until the endpoint is ready.

### A10 — `{{> email-ghost-link }}`

**Kit equivalent:** `EmailGhostLink` (kit:121-127).

**Inputs:** `label`, `href`.

**HTML:**

```html
<!-- A10 email-ghost-link — secondary accent link (no MSO wrap) -->
<a href="{{href}}" style="color:#1a73e8;text-decoration:none;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:13px;font-weight:500">
  {{label}} &rarr;
</a>
```

**Why no MSO wrap.** Ghost links are text-styled (no fill, no pill). Outlook renders the text+arrow correctly without VML.

---

## §3 Composition example

Templates compose atoms via **Handlebars block partials** (`{{#> name args}}body{{/name}}`). The block content is rendered inside the partial via `{{> @partial-block}}` (a Handlebars built-in — no custom helper needed). This is the only composition pattern E1 must support.

A full template (`invitation_candidate` after E2a) reads:

```handlebars
{{#> email-shell preheader=preheader}}

  {{> email-header eyebrow="INVITATION"}}

  {{#> email-body}}

    {{> email-lede-editorial
      eyebrow="ASSESSMENT INVITE"
      title=(concat "You've been invited to " assessmentName ".")
      body="Take the assessment at your own pace. You'll be asked to complete it before the expiry date below."}}

    {{> email-meta-card rows=meta_rows}}

    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:32px">
      <tr><td>{{> email-cta label=_t_cta href=invitationLink width_px=200}}</td></tr>
    </table>

    <p style="margin:32px 0 0;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:13px;color:#71717a;line-height:1.55">
      This invitation expires on <strong style="color:#3f3f46">{{expiresAt}}</strong>. If you did not expect this email, you can safely ignore it.
    </p>

  {{/email-body}}

  {{> email-footer-commercial reason=reason unsubscribe_href=unsubscribe_href}}

{{/email-shell}}
```

**Why block partials, not slot vars or subexpression partials.** Two patterns were considered and rejected:

- `{{> email-shell body=(partial 'foo')}}` (subexpression): `(partial 'name')` is **not built-in Handlebars** — it requires a custom helper to look up `Handlebars.partials[name]`, compile-if-string, render with context, and mark the output as safe. Surface area + failure modes E1 doesn't need.
- `{{> email-shell body=preRenderedHtml}}` (pre-rendered string in context): forces every template to pre-render its body string in `render.ts` before calling the shell — pushes composition logic out of templates into TS code and breaks the "partials compose; render.ts is content-agnostic" boundary.

Block partials (`{{#> name}}…{{/name}}` + `{{> @partial-block}}`) ship with Handlebars 4.x. Zero helper code, composition stays in templates.

Where `meta_rows` is built in the Zod-validated context (E2a):

```ts
{
  preheader: "You've been invited to take an AssessIQ assessment.",
  meta_rows: [
    { k: "Assessment", v: `<strong>${assessmentName}</strong>` },
    { k: "Tenant",     v: tenantName },
    { k: "Expires",    v: expiresAt },
  ],
  unsubscribe_href: null,           // open decision #6
  preferences_href: PROD_URLS.prefs,
  help_href:        PROD_URLS.help,
  privacy_href:     PROD_URLS.privacy,
  reason:           "You're receiving this because an AssessIQ admin invited you to take an assessment.",
  copyright_year:   "2026",
}
```

E2a authors one such composition per kit-mapped template; E2b for the four derived templates.

---

## §4 Kit-vs-production divergence catalog

Per anti-pattern guard #12 in the plan, every deliberate divergence from the kit is documented here so future readers know it's intentional.

| # | Where | Kit | Production | Rationale |
| --- | --- | --- | --- | --- |
| 1 | Outer wrapper backdrop | `#f1efea` canvas color *outside* the white card | Client-default (transparent / off-white per the client's mail-list backdrop) | Per kit README "Shipping to production" — the outer canvas is a kit-mock-only treatment. Email clients impose their own list backdrop and we don't get to colour it consistently. The wrapper `<table>` in A1 carries `#f1efea` only inside the rendered area between the card and the email viewport edges; clients that fully background-fill (Gmail web) will render it, clients that don't (most webviews) fall back to their own backdrop. Acceptable per plan open-decision #1 default. |
| 2 | Web fonts (Newsreader, Geist) | Loaded via `@font-face` | Stack fallback only (Georgia / Helvetica Neue / SF Mono) | Mandatory — email clients don't load web fonts. Kit's font choice is documentation-only. |
| 3 | Flex / grid layouts | `display: flex`, `display: grid` | Nested `<table>` cells, `align="…"`, `width="…"` | Outlook on Windows ignores both. |
| 4 | CSS custom properties (`var(--accent)`) | Used everywhere in kit CSS | Literal hex/px values inlined per element | Email clients (Gmail in particular) strip or modify `<style>` blocks and most don't support custom-property inheritance through them. |
| 5 | Pill CTA button | Single `<a>` with `border-radius: 999px` | `<a>` PLUS `<v:roundrect>` MSO/VML twin | Outlook 2007–2019 renders the `<a>` as a sharp rectangle. The VML twin is the equivalent rendering only Outlook sees. |
| 6 | Preheader treatment | On-canvas mono microcopy ("Preview · …") | Hidden white-on-white `<div>` with figure-space padding | Kit shows the preheader for design review; production hides it so it only appears in the inbox preview line. |
| 7 | Footer breadth | Single editorial footer (unsubscribe + preferences + help + privacy + address + ©) | TWO variants — transactional drops the link row | CAN-SPAM exempts transactional emails from unsubscribe; commercial / lifecycle must include it. Per open decision #4. |
| 8 | Footer linkable surface | All footer links present on every template | Conditional collapse on `unsubscribe_href=null` | The `/unsubscribe?token=<jwt>` endpoint does not exist yet (open decision #6). Until it ships, the link collapses to avoid a 404. |
| 9 | Dark-mode rendering | Not designed | Locked to light via `<meta name="color-scheme" content="light only">` and `supported-color-schemes` | Apple Mail / Gmail iOS auto-invert dark mode breaks pill buttons + accent links. Designing a dark variant is out of scope for the port; light-only is the safe default. |

---

## §5 Open decisions still pending (must resolve before E1)

E0 has applied the plan's default recommendations where the call is low-risk. The following remain unresolved and **must be answered before E1 implements the partials**:

| # | Decision | Default applied in E0 | Why still open |
| --- | --- | --- | --- |
| 5 | **Physical mailing address** for the footer (`{{_t_legal_address}}`). | None — placeholder `{{_t_legal_address}}` documented; not resolved. | CAN-SPAM-required on commercial templates and DPDP-recommended overall. Must be a real, monitored address — likely the AssessIQ legal entity address (or whatever appears on incorporation docs). Surface to user; no good default. |
| 6 | **Unsubscribe + preferences endpoint.** Does `/unsubscribe?token=<jwt>` and `/account/preferences` exist? If not, ship the conditional collapse (A9b's `{{#if unsubscribe_href}}`) and track the endpoints as a follow-up. | Conditional collapse pattern adopted in A9b. | The collapse is correct regardless; the open question is *when* the endpoint lands and which scope owns it (`01-auth` for the token, `13-notifications` for the page, or a new module). |
| 7 | **OTP code in preheader** for `admin_email_otp`. Leak the 6-digit code in the inbox preview line (matches iOS Mail / Gmail auto-fill UX) or hide it (security-strict). | None applied in E0 — affects E2b only. | Decision recommended in plan: leak it (same plaintext reaches the same destination either way, auto-fill UX is meaningful). Confirm with user before E2b. |
| 11 | **Litmus / Email on Acid budget** for E3. | None applied in E0 — affects E3 only. | $80-$150/month paid SaaS for one-month flat-fee validation. Alternative is manual matrix testing from real accounts. Confirm with user before E3. |

Open decisions 1, 2, 3, 4, 8, 9, 10 from the plan are **resolved here** with their default recommendations:

- #1 canvas color → kit `#f1efea` (applied in §1.1).
- #2 card width → kit 640 px (applied in §1.2).
- #3 H1 size split → 30 px editorial / 22 px short-form (applied in §1.3).
- #4 footer breadth split → A9a transactional / A9b commercial (applied in §2 A9).
- #8 Pulse newsletter as new product → **OUT OF SCOPE** (port covers existing `weekly_digest_admin` only).
- #9 `attempt_ready_for_review_admin` anonymization → **keep candidate name** (existing prod behaviour); tenant-level flag tracked as a separate proposal.
- #10 locale matrix beyond `en` → **OUT OF SCOPE** (i18n machinery preserved; no new locales authored).

---

## §6 What E1 implements (the contract)

E1 takes the 10 atom designs in §2 and materializes them as Handlebars partials in `modules/13-notifications/src/email/partials/`:

```text
partials/
├── email-shell.html
├── email-preheader.html
├── email-header.html
├── email-body.html
├── email-lede-editorial.html
├── email-lede-short.html
├── email-cta.html
├── email-meta-card.html
├── email-rule.html
├── email-footer-transactional.html
├── email-footer-commercial.html
└── email-ghost-link.html
```

`render.ts` registers each partial at module init via `Handlebars.registerPartial`. Module-load failure if any partial is missing (fail-loud at boot, not on first send).

The 9 existing templates in `modules/13-notifications/src/email/templates/` are refactored to compose against the partials via the **block-partial composition pattern** documented in §3 (`{{#> name}}…{{/name}}` + `{{> @partial-block}}` inside the partial). **Structural-equivalence parity with the pre-E1 production templates is the E1 acceptance test** — visual changes land in E2. Parity is asserted via a DOM-tree comparison, not raw-string snapshot equality (see plan E1 testing notes for the comparator shape).

Helpers E1 must register: `concat` (~5 lines, string join for serif H1 composition in templates). **No `partial` helper** — block partials are built-in Handlebars and need no helper. **No `ifEquals` helper** either — A5's `size` variant is implemented by splitting `email-lede` into two partials (see §6.1) instead of a runtime conditional.

### §6.1 i18n keys E1 must add before partials register

A1, A3, A9a, A9b reference i18n keys that do not exist in [`modules/13-notifications/src/email/strings/en.json`](../modules/13-notifications/src/email/strings/en.json) today. E1 must add them as part of the same commit that registers the partials, or the first render will produce empty interpolations:

| Key | Used by | Suggested `en` value |
| --- | --- | --- |
| `page_title` | A1 `<title>` | (per-template — falls back to `subject` if not set) |
| `brand_wordmark` | A3 header | `AssessIQ` |
| `legal_entity` | A9a, A9b footer | (resolved via open decision #5) |
| `legal_address` | A9a, A9b footer | (resolved via open decision #5) |
| `unsubscribe` | A9b footer | `Unsubscribe` |
| `preferences` | A9b footer | `Preferences` |
| `help` | A9b footer | `Help` |
| `privacy` | A9b footer | `Privacy` |
| `cta` | per-template overrides | (per-template — `Sign in`, `View results`, etc.) |

---

## §7 Cross-references

- Plan: [`docs/plans/EMAIL_KIT_PORT.md`](plans/EMAIL_KIT_PORT.md) — phases E0–E4, anti-pattern guards, open decisions.
- Kit source: [`modules/17-ui-system/AssessIQ_UI_Template/AssessIQ-Email-Kit/`](../modules/17-ui-system/AssessIQ_UI_Template/AssessIQ-Email-Kit/) — atoms, tokens, kit-readme.
- Production templates: [`modules/13-notifications/src/email/templates/`](../modules/13-notifications/src/email/templates/) — current 9 templates (HTML + TXT pairs).
- Render pipeline: [`modules/13-notifications/src/email/render.ts`](../modules/13-notifications/src/email/render.ts) — Handlebars compile, Zod var validation, i18n substitution.
- Module reference: [`modules/13-notifications/SKILL.md`](../modules/13-notifications/SKILL.md) — send pipeline contract, BullMQ + email_log invariants.
- Token base (SPA, NOT email): [`modules/17-ui-system/src/styles/tokens.css`](../modules/17-ui-system/src/styles/tokens.css) — separate visual layer; not loadable by email clients.

---

## §8 Acceptance — E0 is DONE when

- [x] Resolved token table covers every property kit-or-production touched (§1).
- [x] 11 atoms designed as inline-styled table HTML with documented inputs (§2 A1–A10, A5 split into editorial + short).
- [x] Kit-vs-production divergences catalogued with rationale (§4).
- [x] Open decisions explicitly listed; defaults vs unresolved separated (§5).
- [x] Cross-references to plan, kit, templates, render pipeline, module skill (§7).
- [x] **Blocker 1 (composition syntax):** §3 rewritten against built-in Handlebars block partials (`{{#> name}}…{{> @partial-block}}…{{/name}}`); slot-var + subexpression-partial patterns explicitly rejected with rationale. A1 + A4 atoms updated.
- [x] **Blocker 2 (triple-stash policy):** [`EMAIL_KIT_PORT.md`](plans/EMAIL_KIT_PORT.md) anti-pattern guard #9 amended to document A7's sole exception; A7 strengthened with three enforcement layers (per-template SAFETY comment, runtime `assertSafeMetaRows()` invariant, CI lint against candidate/tenant/user var-name patterns).
- [x] **Blocker 3 (snapshot strategy):** [`EMAIL_KIT_PORT.md`](plans/EMAIL_KIT_PORT.md) E1 "Render unit tests" rewritten — frozen `.pre-e1.html` fixtures + `node-html-parser` DOM-tree canonical-form comparison, NOT raw-string snapshots. Pre-E1 fixture-capture commit lands first, on its own.
- [x] **i18n prerequisite (§6.1):** 9 new `en` keys listed as E1 prerequisite so first render doesn't produce empty interpolations.
- [ ] User has resolved open decision #5 (physical address) — **blocks E1**.

E1 cannot start until decision #5 is resolved (the footer partial needs the literal address baked in). Decisions #7 (OTP preheader) and #11 (Litmus budget) can be deferred — they affect E2b and E3 respectively, both downstream of E1.

— *AssessIQ · E0 foundation · 2026-05-21*
