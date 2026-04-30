# Session — 2026-05-01 (03-users pre-flight for Window 5)

**Headline:** `modules/03-users/SKILL.md` § "Decisions captured (2026-05-01)" appended — 13-section addendum freezes every implementation ambiguity for Window 5 (G0.C-5: `03-users` + admin login screen) so the implementation session moves on a frozen contract. Mirrors the structure of the 01-auth pre-flight (commit `1cf5066`).

**Commits:**

- HEAD on push — `docs(users): pin 03-users decisions before window 5` (run `git log` for the SHA)

**Tests:** skipped — pure docs append; no code/migration changes. Pre-commit hook (`.claude/hooks/precommit-gate.sh`) runs the secrets-scan over the diff; the addendum contains no real secrets, only example token-format strings already documented in the 01-auth pre-flight (`crypto.randomBytes(32).toString('base64url')`). The 102-test vitest suite from G0.B-2 remains green and was not re-run since no source code changed. Markdownlint warnings on the appended section follow the same heading-pattern convention as the 01-auth addendum and are deferred per the established convention.

**Next:** Window 4 (G0.C-4 `01-auth`) and Window 5 (G0.C-5 `03-users` + admin login) are now both fully pre-flighted with frozen decisions — the orchestrator can dispatch either as a parallel session without further user input. Recommended order: open Window 4 first (01-auth ships `sessions.create` + middleware, on which Window 5 depends for the `acceptInvitation` boundary). Both pre-flights are docs-only landed; the next implementation session must read the relevant SKILL § Decisions captured before writing code.

**Open questions:**

- **Window 4 carry-forwards from this addendum (must be absorbed when 01-auth opens):**
  - `sessions.create` adds `SADD aiq:user:sessions:<userId>` + `EXPIRE 32400` after the existing Redis SET (per § 7 — required for 03-users sweep-on-disable).
  - sessionLoader rejects on `users.status != 'active'` and on `users.deleted_at IS NOT NULL` (per § 7 — defense-in-depth backing the Redis sweep).
  - Google SSO callback runs `normalizeEmail()` on the IdP-supplied email before `(tenant_id, email)` lookup (per § 10 — guarantees match with 03-users' lowercase-at-write rule).
- **PHASE_1_KICKOFF decision #4 (CSV vs JSON for bulk import):** addendum § 1 pins the CSV column shape per the existing SKILL surface (`bulkImport(csv: Buffer)`) and notes the JSON-pivot option still open per Phase 1 plan. Window 5 ships only a `// TODO(phase-1)` 501 stub, so the format choice does not bind Window 5.
- **`inviteUser({ role: 'candidate' })` 501 vs Phase-1 wiring** (addendum § 13): Phase 0 throws 501 because `assessment_invitations` lives in 05-assessment-lifecycle (Phase 1). Phase 1 may either extend `inviteUser` to call into 05's API or keep it admin/reviewer-only; deferred to Phase 1 UX call.
- All other Phase 1 G1.A blocking items remain as listed in commit `51ccc7d` SESSION_STATE history (reachable via `git show 51ccc7d:docs/SESSION_STATE.md`): G0.B-2 02-tenancy is shipped; G0.C is now both pre-flighted; `tools/migrate.ts` not yet shipped (Window 4 may inherit the docker-compose-exec ad-hoc apply pattern from 02-tenancy).

---

## Agent utilization

- **Opus:** orchestrator throughout — Phase 0 warm-start parallel reads (5 files: PROJECT_BRAIN, 01-architecture-overview, SESSION_STATE, RCA_LOG, PHASE_0_KICKOFF), 03-users-specific deep-read parallel burst (5 files: 03-users SKILL, 02-data-model, 03-api-contract, 04-auth-flows, 01-auth SKILL), 13-section addendum authorship to `modules/03-users/SKILL.md` (sections: bulkImport CSV deferral, invitation token shape, createUser-vs-inviteUser distinction, last-admin invariant, soft-delete cascade, role transitions, user-status state machine + Redis sweep, email-stub JSONL format, listUsers query semantics, per-tenant uniqueness with normalizeEmail, RLS-only scoping reaffirmation, acceptInvitation cross-module boundary, candidate-role 501 punt — plus a Window-4 carry-forward block). SESSION_STATE handoff overwrite per last-writer-wins. Wrote the addendum directly (no Sonnet handoff) because the work was judgment-heavy: cross-module boundary calls (acceptInvitation contract mirroring 01-AUTH-DEC § 10), error-class selection (ConflictError vs ValidationError vs NotFoundError per case), Redis sweep-vs-tombstone trade-off (user explicitly pinned sweep "more aggressive"), state-machine pinning (which transitions are reachable), and the carry-forward decisions for Window 4 sessionLoader.
- **Sonnet:** n/a — single-file docs append; mechanical handoff would lose the cross-module judgment this addendum required.
- **Haiku:** n/a — no multi-file sweep needed; the 5-file deep-read was direct Opus reads to avoid lossy summary on a contract-pinning task.
- **codex:rescue:** n/a — pure docs append; no code changes touching `01-auth` / `02-tenancy` / `07-ai-grading` / `14-audit-log` / infra. The carry-forward bullets to Window 4 are documentation only and will be reviewed when 01-auth implementation opens (Window 4 itself is auth code → mandatory codex:rescue gate at that point).

---

## Files shipped (1)

- `modules/03-users/SKILL.md` — appended `## Decisions captured (2026-05-01)` (~13 numbered decision sections + Window-4 carry-forward block, ~580 lines added). Pre-existing content (Purpose, Scope, Roles, Dependencies, Public surface, Data model touchpoints, Help/tooltip surface, Open questions) untouched.

No source-code changes, no migrations, no deploy. VPS untouched. `02-data-model.md` and `03-api-contract.md` were read but did NOT require same-PR edits — the deep-read confirmed the current `users` and `user_invitations` schemas match the SKILL surface, and the per-endpoint pageSize cap of 100 (vs the global 200 in `03-API:10`) is a stricter implementation override that doesn't contradict the global contract.

---

## Previous-session pointers

The Phase 1 kickoff plan + decisions-pinned follow-up handoffs are preserved in git history at commit `51ccc7d` — `git show 51ccc7d:docs/SESSION_STATE.md` retrieves the full prior state. Key carry-forward state for Window 4 / 5:

- **01-auth pre-flight** at commit `1cf5066`: 10 decisions pinned in `modules/01-auth/SKILL.md` § Decisions captured (2026-05-01). Window 4 reads that BEFORE writing code.
- **03-users pre-flight** at THIS commit: 13 decisions pinned in `modules/03-users/SKILL.md` § Decisions captured (2026-05-01). Window 5 reads this BEFORE writing code; Window 4 reads the carry-forward block to absorb the three sessionLoader / sessions.create additions.
- **02-tenancy shipped** at commit `7923492` (parent of `1cf5066`): tenants table + RLS + middleware live; testcontainer integration tests green; `tools/lint-rls-policies.ts` exemption convention in place.
- **17-ui-system shipped** at commit `f21ac4d`: design tokens + base components + Storybook + Vite SPA scaffold live.
- **00-core shipped** at commit history G0.A: monorepo scaffold + Zod-validated config + AppError hierarchy + AsyncLocalStorage request context + uuidv7/shortId/nowIso utilities.
- **Phase 1 plan + all decisions defaulted** at commit `51ccc7d`: `docs/plans/PHASE_1_KICKOFF.md` v1.1 with all 4 user-blocking decisions resolved at orchestrator defaults; G1.A unblocked once G0.C lands.
- **VPS state:** `assessiq-postgres` healthy on VPS at `/srv/assessiq/`; three roles + rotated passwords in `/srv/assessiq/secrets/`; network `assessiq-net`; volume `assessiq_assessiq_pgdata`. No new VPS state added by this session.
- **`tools/migrate.ts`:** not yet shipped (G0.C-4 acceptance criterion). Window 4 either ships it first or inherits the `docker compose exec` ad-hoc apply pattern from G0.B-2 02-tenancy.
