# AssessIQ — Architecture & Module Documentation

> Scenario-driven, tier-based, hybrid-graded role-readiness assessment platform. SOC team is the launch customer; designed multi-tenant and embeddable from day one.

## How to use this repo with Claude Code

1. **Always start with** `PROJECT_BRAIN.md` — it gives Claude (and you) the orientation needed to navigate everything else.
2. **For cross-cutting questions** (auth, deployment, data model, etc.), point Claude at the matching `docs/` file.
3. **For implementing a feature**, point Claude at the relevant `modules/<n>-<name>/SKILL.md` plus the docs files it lists as related. Each module's SKILL.md tells Claude what's in scope, what's out, what its dependencies are, and what help text it owns.
4. **When schema changes**, update both the migration AND `docs/02-data-model.md` in the same change.
5. **When API surface changes**, update `docs/03-api-contract.md` in the same change.

## Map

```
PROJECT_BRAIN.md             ← READ FIRST in every session
README.md                    ← this file

docs/
├── 01-architecture-overview.md
├── 02-data-model.md           ← Postgres schema + RLS
├── 03-api-contract.md          ← REST endpoint catalog
├── 04-auth-flows.md            ← Google SSO + TOTP + embed JWT + API keys
├── 05-ai-pipeline.md           ← Claude Code on VPS (Phase 1) + multi-stage grading
├── 06-deployment.md            ← VPS, Docker Compose, nginx, ACME
├── 07-help-system.md           ← Tooltip + drawer architecture
├── 08-ui-system.md             ← Tokens, components, theming
├── 09-integration-guide.md     ← Host-app embed + REST + webhook integration
└── 10-branding-guideline.md    ← Visual identity: typography, palette, layouts, idioms

modules/
├── 00-core/SKILL.md          ← Foundation utilities
├── 01-auth/                  ← Identity, sessions, MFA, JWT, API keys
├── 02-tenancy/                ← Multi-tenant isolation
├── 03-users/                  ← User records, roles, invitations
├── 04-question-bank/          ← Packs, levels, questions
├── 05-assessment-lifecycle/   ← Cycles, invitations, state machine
├── 06-attempt-engine/         ← Taking the assessment
├── 07-ai-grading/             ← Claude Agent SDK pipeline
├── 08-rubric-engine/          ← Anchors, bands, scoring DSL
├── 09-scoring/                ← Aggregation, archetype, leaderboard
├── 10-admin-dashboard/        ← Admin UI
├── 11-candidate-ui/           ← Candidate UI
├── 12-embed-sdk/              ← Iframe embed + JS snippet
├── 13-notifications/          ← Email, webhooks, in-app
├── 14-audit-log/              ← Append-only audit trail
├── 15-analytics/              ← Reports, exports
├── 16-help-system/            ← Tooltip framework + help content
└── 17-ui-system/              ← Design tokens + components

infra/                          ← (populated as you build) docker-compose, nginx, scripts
```

## Phase 0 — what to build first

Recommended order to get a thin slice working end-to-end:

1. **00-core** — env, logger, errors, request context. Foundation.
2. **17-ui-system** — token CSS + a handful of primitives (Button, Input, Card, Stack). You'll need these for every screen.
3. **02-tenancy** + **03-users** — minimal CRUD; one tenant + one admin user seeded.
4. **01-auth** — Google SSO + TOTP. This is the gate; everything else lives behind it.
5. **16-help-system** — get the framework wired (HelpTip, HelpProvider, public read API). Even with stub content. Then content fills in as you build screens.
6. Smoke test: admin can log in via Google + TOTP, see an empty dashboard with help tooltips. **Phase 0 done.**

Then Phase 1 (author + take), then Phase 2 (grade + report), as laid out in `PROJECT_BRAIN.md`.

## What's next from the user

- Provide the **UI template**. Drop it under `modules/17-ui-system/templates/<vendor-name>/` and follow the integration plan in `docs/08-ui-system.md`.
- Provision the **VPS subdomain DNS** for `assessiq.automateedge.cloud` (A record to VPS IP).
- Create a **Google Cloud OAuth client** and capture client_id + client_secret for `.env`.
- Get an **Anthropic API key** for production AI grading (separate from your Max subscription).
