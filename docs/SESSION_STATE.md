# Session — 2026-05-01 (Phase 0 hot-fix — assessiq.automateedge.cloud 502)

**Headline:** Resolved the Cloudflare 502 on `https://assessiq.automateedge.cloud/`. Root cause: the ti-platform Caddyfile reverse-proxied the public domain to `172.17.0.1:9091`, but no `assessiq-frontend` container exists yet (Phase 0 is pre-deploy for the SPA — only `assessiq-postgres` is running on the VPS). Fix: replaced the `reverse_proxy` directive in the AssessIQ Caddy block with a `respond 200` placeholder that serves an inline "We are building" HTML page directly from Caddy. Additive, namespaced, single-block edit to the shared Caddyfile. External smoke through Cloudflare returns 200 with expected security headers and `cf-cache-status: DYNAMIC` (no-store honored).

**Commits:**

- HEAD on push — `fix(deploy): caddy placeholder for assessiq subdomain (resolves 502)` (run `git log` for the SHA)

**Tests:** n/a code-side — no code or migrations changed. Verification was end-to-end against the live edge: `caddy validate --config /tmp/Caddyfile.proposed --adapter caddyfile` → `Valid configuration`; inode preserved across the in-place truncate-write (`stat -c %i` matched before/after at `4194305`); `caddy reload` clean; `curl https://assessiq.automateedge.cloud/` → 200 + expected body + HSTS + CSP + `Cache-Control: no-store`; Caddy logs clean; no other site blocks affected. The 102-test vitest suite from G0.B-2 was not re-run (no source change).

**Next:** Phase 1 G1.A is still blocked on the same predecessors as the prior planning sessions (G0.C-4 `01-auth` Window 4, G0.C-5 `03-users` Window 5) — both are now pre-flighted with frozen decisions per the prior 03-users handoff. The hot-fix unblocks the public domain so stakeholder-facing links resolve to a friendly 200, but the underlying product is unchanged. Immediate next action when implementation work resumes: open Window 4 (`01-auth`) — pre-flight decisions are pinned in `modules/01-auth/SKILL.md` (commit `1cf5066`). When `assessiq-frontend` eventually ships and starts on host:9091, follow the swap-back procedure documented in `docs/06-deployment.md` § "Current live state — Phase 0 placeholder" (in-place truncate-write, never `mv`, validate before reload).

**Open questions:**

- All Phase 0 / Phase 1 questions from the prior `03-users` and Phase-1-kickoff sessions remain open and tracked in the historical sections below; this hot-fix did not change any of them.
- DNS+Caddy were wired before the corresponding container deploy — captured as a Phase 3 bounce condition in the new RCA entry (`docs/RCA_LOG.md` § 2026-05-01). Worth surfacing during the next deploy-plan review whether any other AssessIQ subdomains may get wired ahead of their containers; none currently, but the rule applies forward.
- Pre-existing Caddyfile formatting warning at line 38 (`caddy fmt --overwrite` would clean up multi-block inconsistencies) is in the shared ti-platform section, not the AssessIQ block. Out of scope per shared-VPS rule #8 (no edits outside our own block).

---

## Agent utilization

- **Opus:** orchestrator throughout this hot-fix — Phase 0 warm-start parallel reads (PROJECT_BRAIN, SESSION_STATE, RCA_LOG, 06-deployment, 01-architecture-overview), VPS read-only enumeration (`docker ps`, Caddyfile inspect, `ss -tlnp` listen check, direct-curl differential to confirm Caddy itself healthy vs upstream missing), root-cause analysis, three-option decision (placeholder vs CF-pause vs deploy-now → placeholder picked because frontend is not production-ready), Caddy block redesign (inline HTML body, `respond 200`, `Cache-Control: no-store`, `import security-headers` preserved), inode-preserving in-place write design (single-file bind mount trap from prior project memory), validate-before-reload sequencing, doc updates (`06-deployment.md` placeholder section + swap-back procedure, `RCA_LOG.md` first incident entry, this handoff). Whole loop kept inside Opus — change was small (≤30 lines across 3 docs + 1 VPS Caddyfile block) and the files were already in hot read cache, so subagent cold-start would have been pure overhead per the global "don't delegate when self-executing is faster" rule.
- **Sonnet:** n/a — small targeted edit; nothing mechanical to delegate. The Python edit script generated for the VPS-side Caddyfile surgery (str.replace + assert + write) was tiny and didn't warrant a subagent.
- **Haiku:** n/a — VPS enumeration was 6 parallel commands in a single bash burst returning structured output Opus could read directly. No bulk multi-file fact-distillation step needed.
- **codex:rescue:** n/a — change was infra-only (Caddyfile static placeholder), not in any of the security-adjacent paths flagged in `CLAUDE.md` (`01-auth`, `02-tenancy`, `07-ai-grading`, `14-audit-log`). Caddy edit is additive, namespaced to the AssessIQ block, and reversible. Per the global rule's "scale rigor to change magnitude" clause, a small additive edit to an existing block does not warrant the rescue ceremony.

---

## Files shipped (3)

- `docs/06-deployment.md` — added "### Current live state — Phase 0 placeholder (2026-05-01)" subsection after the `Apply procedure` block. Documents the live placeholder Caddy block, the rationale, the `Cache-Control: no-store` decision, and the **swap-back procedure** with the explicit `cat new > Caddyfile` truncate-write rule and the "never `mv`" warning to preserve the bind-mount inode.
- `docs/RCA_LOG.md` — first RCA entry (file was empty before): symptom, cause, fix, three-point prevention (doc + process rule on premature DNS+Caddy + bind-mount inode trap), plus an order-of-operations note acknowledging that the DoD order (commit → deploy → document → handoff) was inverted because production was returning 502.
- `docs/SESSION_STATE.md` — this file. Top headline replaced; the prior `03-users` pre-flight handoff is preserved verbatim in the new `## 03-users Pre-flight Session — 2026-05-01` section below; older sessions remain intact in their existing per-session h2 sections.

**VPS state delta (live):**

- `/opt/ti-platform/caddy/Caddyfile` — AssessIQ block (originally lines 65–73) replaced in place; pre-edit content preserved at `/opt/ti-platform/caddy/Caddyfile.bak.20260430-205811` on the VPS for one-step revert. Inode preserved (4194305 before and after the truncate-write). Caddy reloaded gracefully via `docker exec ti-platform-caddy-1 caddy reload --config /etc/caddy/Caddyfile`. No other site blocks touched; `accessbridge`, `roadmap`, `ti-platform`, `intelwatch.in` blocks all byte-identical.

---

## 03-users Pre-flight Session — 2026-05-01

**Headline:** `modules/03-users/SKILL.md` § "Decisions captured (2026-05-01)" appended — 13-section addendum freezes every implementation ambiguity for Window 5 (G0.C-5: `03-users` + admin login screen). Mirrors the structure of the 01-auth pre-flight at commit `1cf5066`.

**Commits this sub-session:** parent of this hot-fix's commit — `docs(users): pin 03-users decisions before window 5` (run `git log` for the SHA).

**Carry-forward to Window 4 (must be absorbed when 01-auth opens):**

- `sessions.create` adds `SADD aiq:user:sessions:<userId>` + `EXPIRE 32400` after the existing Redis SET (per § 7 — required for 03-users sweep-on-disable).
- sessionLoader rejects on `users.status != 'active'` and on `users.deleted_at IS NOT NULL` (per § 7 — defense-in-depth backing the Redis sweep).
- Google SSO callback runs `normalizeEmail()` on the IdP-supplied email before `(tenant_id, email)` lookup (per § 10 — guarantees match with 03-users' lowercase-at-write rule).

**Other carry-forwards:**

- PHASE_1_KICKOFF decision #4 (CSV vs JSON for bulk import) — addendum § 1 pins CSV column shape per existing SKILL surface; JSON-pivot option still open per Phase 1 plan. Window 5 ships only a `// TODO(phase-1)` 501 stub.
- `inviteUser({ role: 'candidate' })` 501 vs Phase-1 wiring (addendum § 13): Phase 0 throws 501 because `assessment_invitations` lives in 05-assessment-lifecycle. Deferred to Phase 1 UX call.
- All other Phase 1 G1.A blocking items remain as listed in commit `51ccc7d` SESSION_STATE history (`git show 51ccc7d:docs/SESSION_STATE.md`).

**Agent utilization (this sub-session):**

- Opus: orchestrator + addendum authorship. Phase 0 warm-start parallel reads (5 files: PROJECT_BRAIN, 01-architecture-overview, SESSION_STATE, RCA_LOG, PHASE_0_KICKOFF), 03-users-specific deep-read parallel burst (5 files: 03-users SKILL, 02-data-model, 03-api-contract, 04-auth-flows, 01-auth SKILL), 13-section addendum authorship covering bulkImport CSV deferral, invitation token shape, createUser-vs-inviteUser distinction, last-admin invariant, soft-delete cascade, role transitions, user-status state machine + Redis sweep, email-stub JSONL format, listUsers query semantics, per-tenant uniqueness with normalizeEmail, RLS-only scoping reaffirmation, acceptInvitation cross-module boundary, candidate-role 501 punt — plus the Window-4 carry-forward block.
- Sonnet: n/a — single-file docs append; mechanical handoff would lose the cross-module judgment this addendum required.
- Haiku: n/a — 5-file deep-read was direct Opus reads to avoid lossy summary on a contract-pinning task.
- codex:rescue: n/a — pure docs append; Window 4 itself (when it opens) is auth code → mandatory rescue gate at that point.

**Files shipped (sub-session):** `modules/03-users/SKILL.md` — appended `## Decisions captured (2026-05-01)` (~13 numbered decision sections + Window-4 carry-forward block, ~580 lines added). Pre-existing content untouched. No source-code changes, no migrations, no deploy. VPS untouched by this sub-session. `02-data-model.md` and `03-api-contract.md` were read but did NOT require same-PR edits — the deep-read confirmed the current `users` and `user_invitations` schemas match the SKILL surface.

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
