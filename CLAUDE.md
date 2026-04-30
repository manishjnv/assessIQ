# AssessIQ — project overlay (Claude Code)

This file overrides the global `~/.claude/CLAUDE.md` orchestration playbook where they conflict (per the global "project overlay wins" rule). Inherit everything from global *unless* this file says otherwise.

## Phase 0 — warm-start reading list

In ONE parallel-tool-call message, read:

1. `PROJECT_BRAIN.md` — orientation (mandatory every session)
2. `docs/01-architecture-overview.md` — system context
3. `docs/SESSION_STATE.md` — last-session handoff (skip silently if absent)
4. `docs/RCA_LOG.md` — incident patterns to honor (skip silently if absent)
5. `claude-mem:mem-search "<goal phrase>"` — only if the goal sounds like something you may have worked on before

Then state the goal in one sentence, the relevant prior decisions / RCA entries you will honor, the plan, and what will be delegated. **Wait for user approval before touching code.**

For module work, ALSO read `modules/<n>-<name>/SKILL.md` plus its declared dependencies.
For AI-grading work, ALWAYS read `docs/05-ai-pipeline.md` first — the Phase 1 vs Phase 2 distinction is non-obvious and load-bearing.
For UI work, ALWAYS read `docs/10-branding-guideline.md` first.

## Load-bearing paths

Subagents can write to these only with Opus line-by-line diff review in Phase 3. No exceptions.

- `modules/00-core/**` — config, env, base types
- `modules/01-auth/**` — sessions, JWT, MFA, OIDC
- `modules/02-tenancy/**` — RLS policies, tenant context
- `modules/07-ai-grading/**` — entire grading pipeline (this is a *classifier* — security-adjacent)
- `modules/07-ai-grading/ci/lint-no-ambient-claude.ts` — invariant guard; touching this requires `codex:rescue`
- `modules/14-audit-log/**` — append-only invariants
- `infra/**`, any `Dockerfile`, `docker-compose.yml`, nginx configs, `.env*` templates

Per global rule, security/auth/AI-classifier diffs require `codex:rescue` adversarial sign-off **before push**. Anything in `modules/07-ai-grading/` qualifies.

## Tool routing (project specifics — overrides global where they conflict)

| Task | Tool | Notes |
| --- | --- | --- |
| "Have we solved this before?" | `claude-mem:mem-search` | Run *before* Phase 0 reads if the goal sounds familiar |
| "Where is X defined?" / structural exploration | `claude-mem:smart-explore` | AST-based; cheaper than multi-file Read sweeps |
| Planning a non-trivial feature | `claude-mem:make-plan` | Pick this OR `/superpowers:write-plan` — never both. `make-plan` wins because it's project-aware via the memory DB |
| Brainstorm a fuzzy idea (no contract yet) | `/superpowers:brainstorm` | Skip when the contract is already specified |
| Implementation with contract | Global Phase 1 → Sonnet subagent | Do NOT use `claude-mem:do` here — it bypasses the Opus/Sonnet/Haiku routing matrix |
| Code review of a diff | Global Phase 3 (Opus diff critique) | If `superpowers:requesting-code-review` auto-fires, treat as advisory; the final review is Opus |
| Architecture audit before refactor | `claude-mem:pathfinder` | Run before any cross-module refactor |
| Worktrees | Global rule (load-bearing *writes* only) | Override `superpowers:using-git-worktrees`' worktree-by-default tendency |
| Adversarial review of security/auth/classifier diffs | `codex:rescue` | Required before push for any change in `01-auth`, `02-tenancy`, `07-ai-grading`, `14-audit-log`, infra |
| Bulk live-prod verification (curl grids, header sweeps) | Global Phase 5 → Haiku subagent | Returns checkmark table; Opus approves |

## AssessIQ-specific hard rules

1. **No ambient AI calls.** Phase 1 grading runs *only* on admin click, sync, single-flight. Never wire `claude` invocation into:
   - Cron jobs / scheduled tasks
   - BullMQ processors (BullMQ is for non-AI work only — email, webhooks, exports)
   - Webhook handlers
   - Candidate-triggered code paths
   - Any background worker

   `modules/07-ai-grading/ci/lint-no-ambient-claude.ts` enforces this in CI. Touching that lint = `codex:rescue` gate.

2. **No Agent SDK in Phase 1 runtime.** `@anthropic-ai/claude-agent-sdk` is allowed in `modules/07-ai-grading/runtimes/anthropic-api.ts` only and is gated behind `AI_PIPELINE_MODE=anthropic-api`. Never import it from anywhere else.

3. **`superpowers:dispatching-parallel-agents` and `superpowers:subagent-driven-development` are dev-workflow only.** Their patterns assume Agent SDK at runtime — do not let them shape the grading runtime architecture. If a Superpowers skill suggests a parallel-agents pattern for grading, ignore it.

4. **Multi-tenancy guard (Phase 3 bounce conditions).** Diffs that:
   - Add a domain table without `tenant_id` and an RLS policy → bounce
   - Add an endpoint without tenant-context middleware → bounce
   - Add `if (domain === "soc")` anywhere → bounce (domain lives in question packs, not code)
   - Replace `0/25/50/75/100` band scoring with raw percentages → bounce

5. **Same-PR documentation rules** (from PROJECT_BRAIN.md working agreements):
   - Schema changes update `docs/02-data-model.md` in the same PR
   - API changes update `docs/03-api-contract.md` in the same PR
   - New UI elements get a `help_id` and a content entry in `modules/16-help-system`

6. **AI prompts are skills on the VPS, not code.** They live at `~/.claude/skills/grade-{anchors,band,escalate}/SKILL.md` on the production VPS. Their sha256 is recorded on every grading row. Editing prompts is a deploy event with eval-harness re-baselining (`modules/07-ai-grading/eval/`), not a normal code change.

7. **Branding base.** UI work inherits from `modules/17-ui-system/AccessIQ_UI_Template/` — the folder name is a typo; the product is AssessIQ. See `docs/10-branding-guideline.md`.

8. **Shared VPS — deploys are additive only.** Production runs on Hostinger VPS `srv1150121.hstgr.cloud` (72.61.227.64), SSH alias `assessiq-vps`. **Other apps already run on this box** (A11yOS / AccessBridge confirmed; the broader `automateedge.cloud` umbrella likely too). Treat the VPS as shared infra:
   - All AssessIQ artifacts live under an `assessiq` namespace: `/srv/assessiq/`, `/var/log/assessiq/`, Docker containers prefixed `assessiq-`, single nginx site file `assessiq.automateedge.cloud.conf`, systemd units prefixed `assessiq-*`.
   - Before any `apt`, `docker`, `systemctl`, `nginx -s reload`, or shared-config edit, **enumerate first** (`docker ps`, `systemctl list-units --state=running --no-pager`, `ls /etc/nginx/sites-enabled/`, `crontab -l`) and confirm the change is purely additive.
   - **Never** run blanket cleanup: no `docker system prune -a`, no `apt autoremove`, no mass `systemctl daemon-reload` after touching unknown units, no `certbot renew --force-renewal`. These are Phase 3 bounce conditions.
   - **Bypass-permissions does NOT authorize destructive ops on this VPS.** Local bypass skips local prompts; it does not excuse touching shared infra. STOP and ask the user before any `rm`, `docker rm/stop` of non-`assessiq-*` containers, `systemctl stop` of non-`assessiq-*` units, or rewrites of shared nginx/cron/systemd configs.
   - Any deploy diff or shell sequence that fails the additive-only check gets bounced in Phase 3 (or routed through `codex:rescue` for shared-infra-touching changes).

9. **Definition of Done — commit, deploy, document, handoff.** No implementation is complete until all four steps are done. Treat each as a Phase 5 verification gate; do not claim success to the user if any step is missing.

    1. **Commit** to `manishjnv/assessIQ`. Conventional message; references the relevant module/doc; uses the noreply env-var pattern from global CLAUDE.md.
    2. **Deploy** to `assessiq-vps` per rule #8 (additive-only, namespaced, enumerate-before-touch). Skip *only* for genuinely deploy-irrelevant edits (docs-only, IDE config).
    3. **Document in detail** in the right doc:

       | Change type | Doc to update |
       | --- | --- |
       | Schema | `docs/02-data-model.md` |
       | API | `docs/03-api-contract.md` |
       | Auth | `docs/04-auth-flows.md` |
       | AI grading | `docs/05-ai-pipeline.md` |
       | Deployment | `docs/06-deployment.md` |
       | Help text | `modules/16-help-system` |
       | UI / theme | `docs/08-ui-system.md` and/or `docs/10-branding-guideline.md` |
       | Module-internal | that module's `SKILL.md` |
       | Bug fix | append to `docs/RCA_LOG.md` |

       "Detail" means the doc update lets a future session resume the change **without reading the diff.** Cover all five: (a) what changed, (b) **why** it changed, (c) what was considered and rejected, (d) what is explicitly NOT included, (e) downstream impact on other modules/docs. Bare "added endpoint X" lines fail the requirement.
    4. **Handoff** via `docs/SESSION_STATE.md` per global Phase 6 — headline, commits, tests, next, open questions, plus the 4-line agent-utilization footer.

    Order matters: **commit → deploy → document → handoff.** Commit before deploy so the deploy is reproducible from a known SHA; deploy before final docs so docs reflect what's actually live; handoff last so it summarizes a completed loop. For multi-session features, each session produces its own commit / deploy / doc / handoff — never batch four sessions of work into one mega-handoff.

## Session-state doc — `docs/SESSION_STATE.md`

Top section ≤ 30 lines, detail sections below as long as needed.

```markdown
# Session — YYYY-MM-DD

**Headline:** one sentence — what shipped or what blocked.
**Commits:** one line per commit (`<sha> — <subject>`)
**Tests:** pass / fail / skipped
**Next:** one line — first thing the next session should do
**Open questions:** bullets

---

## Agent utilization
- Opus: <what Opus did, or `n/a — <reason>`>
- Sonnet: <subagent calls + outputs, or `n/a — <reason>`>
- Haiku: <bulk sweeps, or `n/a — <reason>`>
- codex:rescue: <accepted / revised / rejected, or `n/a — <reason>`>
```

The 4-line agent-utilization footer is mandatory (global rule). Missing footer = incomplete session.

## RCA / incident log — `docs/RCA_LOG.md`

Append on every bug fix. Entry shape:

```markdown
## YYYY-MM-DD — <one-line title>

**Symptom:** what the user / monitor saw.
**Cause:** root cause (file + line).
**Fix:** what changed (file + line).
**Prevention:** lint / test / hook added, or "manual discipline" if none.
```

Phase 0 reads this. Phase 3 critique uses recurring patterns as guardrails.

## Caveats / sharp edges

- A literal directory named `{docs,modules,infra}/` exists at the repo root — almost certainly a brace-expansion accident from a `mkdir` shell quoting bug. **Confirm with the user before removing it** in case it shadows real work.
- The Phase 1 architecture is *intentional* — the temptation to "fix" sync-on-click grading by adding a worker means you're solving the wrong problem. Re-read `docs/05-ai-pipeline.md` § Compliance frame before suggesting any async grading.
- Three plugins (Superpowers, claude-mem, your global playbook) all want to drive workflow. Skills are namespaced — `superpowers:*`, `claude-mem:*`, `codex:*`; the global playbook has none. The table above is the tiebreaker. If two skills auto-fire on the same trigger, the table wins; otherwise prefer the global playbook over Superpowers.
