# 07 — Help System

> Tooltip + inline help is a **first-class module**, not a bolt-on. Every UI element with non-obvious meaning carries a `help_id`. Centralized authoring means we change copy in one place; localization comes for free.

## Goals

1. Tooltip on every non-obvious UI control.
2. Contextual help drawer (fuller markdown content) accessible from the page header on every page.
3. Different audience tracks: `admin`, `reviewer`, `candidate` see different help content for the same screen.
4. Authoring without redeploy — admin edits help content via admin UI; changes are versioned.
5. i18n-ready from day one (single locale `en` ships first; structure supports adding `hi-IN`, `kn-IN`, etc.).

## Three layers of help

| Layer | Trigger | Display | Content length |
|---|---|---|---|
| **Tooltip** | Hover/focus on element with `help_id` | Floating popover, 200ms delay, dismisses on blur | ≤ 120 chars |
| **Inline note** | Always visible next to the control | Subtle muted text below input, with `?` icon link to drawer | 1–2 sentences |
| **Help drawer** | `?` icon in page header or `Cmd/Ctrl+/` | Right-side drawer with full markdown, links, screenshots | Unbounded |

The drawer is keyed by *page*, not by element. From any element's tooltip, an "Open full help →" link opens the drawer scrolled to the relevant section.

## Help ID convention

Hierarchical, dot-separated, audience-prefixed:

```
<audience>.<area>.<page>.<element>
```

Examples:
- `admin.assessments.create.duration` — tooltip on the duration input on the assessment-create page
- `admin.assessments.create.page` — full drawer for that page
- `candidate.attempt.kql.editor` — tooltip on the KQL editor when taking an assessment
- `candidate.attempt.flag` — tooltip on the flag-for-review button
- `admin.grading.override.button` — tooltip on the "Override AI score" button (also documents the MFA step-up)

Audience-agnostic content uses `all.*`. Tenant-overridable content can be authored per tenant; without override the global default is used.

## Content schema

Stored in `help_content` table (see `docs/02-data-model.md`):

```typescript
type HelpEntry = {
  key: string;             // 'admin.assessments.create.duration'
  audience: 'admin' | 'reviewer' | 'candidate' | 'all';
  locale: string;          // 'en'
  short_text: string;      // tooltip / inline; <= 120 chars
  long_md?: string;        // drawer content (markdown)
  related_keys?: string[]; // sibling links surfaced in drawer
  version: number;
  status: 'active' | 'archived';
};
```

Storage rules:
- One row per `(tenant_id NULL OR tenant_id, key, locale, version)`
- `tenant_id NULL` = global default; tenant-specific row overrides
- New version on any content edit; old versions retained for audit

## Frontend integration

### `<HelpTip>` component

Wraps any element with a tooltip and optional drawer link.

```tsx
<HelpTip helpId="admin.assessments.create.duration">
  <label>Duration (minutes)</label>
  <input type="number" name="duration" />
</HelpTip>
```

Renders:
- The wrapped children unchanged
- A `(?)` icon adjacent that on hover/focus shows a popover with `short_text`
- Click on the icon opens the drawer at the matching key
- Keyboard: Tab to icon, Enter/Space opens drawer, Escape closes

### `<HelpProvider>`

Top-level context that loads help content for the current page on mount:

```tsx
<HelpProvider page="admin.assessments.create" audience="admin" locale="en">
  <AssessmentCreatePage />
</HelpProvider>
```

Behavior:
- Fetches `/api/help?page=admin.assessments.create&audience=admin&locale=en` once
- Caches in memory + localStorage (TTL 1 hour)
- Subscribes to SSE for live updates if admin edits help in another tab

### Help drawer

Triggered from page header `(?)` button or `Cmd/Ctrl + /`:

- Right-side panel, 480px wide
- Markdown rendered with safe HTML, anchored links, code blocks, embedded screenshots
- "Was this helpful? 👍 / 👎" feedback recorded for analytics
- Search within page-level help

### Help authoring (admin UI)

Admins go to *Settings → Help Content*:
- Tree view by area (admin / reviewer / candidate)
- Click a key → markdown editor (preview side-by-side)
- Save → creates new version
- Diff view between versions
- Bulk export/import as JSON for translation workflows

Permission: only admin role can edit. Audit-logged.

## Default content shipped with v1

Curated catalog of ~120 help entries covering every screen. Examples:

```yaml
# admin.assessments.create.duration
short_text: "How long candidates have to complete the assessment. Timer starts when they click Begin."
long_md: |
  ## Duration

  This is the total time a candidate has from clicking **Begin Assessment** to
  the auto-submit. Once started, it cannot be paused.

  **Recommendations:**
  - L1 / triage-style: 30–45 min
  - L2 / investigation: 45–60 min
  - L3 / detection engineering: 60–90 min

  Candidates can navigate freely between questions during this window.
  Auto-submit fires the moment the timer hits zero — partial answers are saved.

  > **Note:** Time-based behavioral signals (per-question time spent, edits)
  > are captured regardless of duration. Don't compress duration to "force
  > speed"; the platform measures speed separately.
related_keys:
  - admin.assessments.create.question_count
  - admin.attempts.timing_signals
```

```yaml
# candidate.attempt.flag
short_text: "Mark this question for review. You can come back to it before submitting."
long_md: |
  ## Flag for review

  Use this when you want to come back to a question before final submission —
  for instance, if you're not sure of your answer or want to verify a query.

  Flagged questions appear with a star in the navigation panel. You can flag
  multiple questions; the **Review** screen lists all flagged + unanswered
  items together so you don't miss anything.

  Flagging has no scoring impact. It's just a personal bookmark.
```

```yaml
# admin.grading.override.button
short_text: "Override the AI score with manager judgement. Requires fresh MFA."
long_md: |
  ## Override AI grading

  When you disagree with the AI grading on a subjective question, you can
  override the score. The AI's verdict is **kept on record beside your
  override** — your override does not erase it. This protects you in audit
  if questioned later.

  **What's required:**
  - Fresh TOTP verification within the last 15 minutes
  - A written reason (free text, stored in `gradings.override_reason`)
  - Optional: change the band (0–4) and the score; both are recorded

  **What happens after:**
  - The candidate sees the final (override) score
  - The audit log records actor, before/after, IP
  - If the AI confidence was already < 0.7, the override is also flagged for
    AI prompt-tuning review (helps us improve the rubric)
```

## API

### Read

```http
GET /api/help?page=admin.assessments.create&audience=admin&locale=en
→ 200 [
  { "key":"admin.assessments.create.duration", "short_text":"...", "long_md":"...", "related_keys":[...] },
  { "key":"admin.assessments.create.question_count", ... },
  ...
]

GET /api/help/admin.assessments.create.duration?locale=en
→ 200 { ... }
```

Public (anonymous) variant for embedded help drawer in candidate UI:
```http
GET /help/candidate.attempt.flag?locale=en
→ 200 { ... }
```

### Write (admin only)

```http
PATCH /api/admin/help/admin.assessments.create.duration
{ "short_text": "...", "long_md": "...", "locale": "en" }
→ 200 { "key":"...", "version": 4 }
```

## Telemetry

Track in `attempt_events` (for candidate side) and a separate `help_usage` table (for admin side) — though MVP can just log to `audit_log`:
- `help.tooltip.shown` — which keys are hovered most (priority for refinement)
- `help.drawer.opened` — which pages need most explanation
- `help.feedback` — 👍 / 👎 per key

Output: a "Help health" admin report identifying screens where users open the drawer often (= UI is unclear, refine), or where 👎 dominates (= content is unhelpful, rewrite).

## i18n hooks

All help content carries a `locale`. Frontend reads from `<HelpProvider locale="en">` (eventually wired to user preference). Missing translation falls back to `en`. Translation workflow:
1. Export all `en` rows: `GET /api/admin/help/export?locale=en` → JSON
2. Translator returns JSON with new locale rows
3. `POST /api/admin/help/import?locale=hi-IN` → bulk upsert

## What lives where

```
modules/16-help-system/
├── SKILL.md
├── components/
│   ├── HelpTip.tsx              # tooltip + (?) icon
│   ├── HelpDrawer.tsx           # right-side panel
│   ├── HelpProvider.tsx         # context + fetcher
│   └── HelpAuthor.tsx           # admin authoring UI
├── content/
│   ├── en/
│   │   ├── admin.yml            # default content shipped with v1
│   │   ├── reviewer.yml
│   │   └── candidate.yml
│   └── seed.ts                  # loads YAML → DB on first migration
├── api/
│   ├── routes.public.ts         # GET /help/:key
│   ├── routes.admin.ts          # CRUD
│   └── service.ts               # caching, version mgmt
└── docs/
    └── authoring-guide.md       # how to write good help (style, length, examples)
```
