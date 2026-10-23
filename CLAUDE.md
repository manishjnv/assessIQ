# AssessIQ — project overlay (Claude Code)

This file overrides the global `~/.claude/CLAUDE.md` orchestration playbook where they conflict (per the global "project overlay wins" rule). Inherit everything from global *unless* this file says otherwise.

**Portable playbook for any Claude account or model:** `docs/ai-playbook/README.md` (speed rules, time and token optimizations, model routing, tools, traps, new-account checklist). Private memory does not travel between accounts; this folder does. Update it when you learn a durable rule.

## Phase 0 — warm-start reading list

In ONE parallel-tool-call message, read:

1. `docs/PROJECT_BRAIN.md` — orientation (mandatory every session)
2. `docs/01-architecture-overview.md` — system context (read only when the task needs it; not mandatory)
3. `docs/NEXT.md` — generated start brief (Z-64): last handoff, ROADMAP status board, open Z-rows, newest 5 RCA entries, next migration number. Run `node tools/next-brief.mjs` first if its HEAD sha differs from `git rev-parse --short HEAD` or the file is absent. Replaces the full reads of `docs/SESSION_STATE.md` and `docs/ROADMAP.md`; open those only for a specific row or section
4. `docs/ROADMAP.md` — read only the row you work on (plans index in `docs/plans/README.md`)
5. `docs/RCA_LOG.md` — do NOT read in full (about 116k tokens, 2850 lines). `docs/NEXT.md` holds the newest 5 entries. Before you plan or review a change in an area, run `grep -n -i "<module or keyword>" docs/RCA_LOG.md` and read only the matching entries (owner decision 2026-10-18, token saving). Skip silently if absent
6. `claude-mem:mem-search "<goal phrase>"` — only if the goal sounds like something you may have worked on before

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
| Bulk reads and digests (5+ files for one fact, call-site lists, doc summaries, log triage) | `bash tools/gemini.sh "<prompt>"` (Gemini via `agy`) | Use it BEFORE a Haiku or Sonnet digest agent (global Tier 6). Read-only wrapper: closes stdin, prefixes a read-only instruction, fails with exit 3 if `git status` changed. A run takes 0.5 to 2 minutes: start it with `run_in_background` and keep working. No secrets or `.env` contents in the prompt. Opus reviews the answer; log it in the footer as `Gemini (agy)`. Fall back to Haiku only if it fails. |
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

5. **Same-PR documentation rules** (from docs/PROJECT_BRAIN.md working agreements):
   - Schema changes update `docs/02-data-model.md` in the same PR
   - API changes update `docs/03-api-contract.md` in the same PR
   - New UI elements get a `help_id` and a content entry in `modules/16-help-system`

6. **AI prompts are skills on the VPS, not code.** They live at `~/.claude/skills/grade-{anchors,band,escalate}/SKILL.md` on the production VPS. Their sha256 is recorded on every grading row. Editing prompts is a deploy event with eval-harness re-baselining (`modules/07-ai-grading/eval/`), not a normal code change.

7. **Branding base.** UI work inherits from `modules/17-ui-system/AssessIQ_UI_Template/`. See `docs/10-branding-guideline.md`. (Kit-internal files still use "AccessIQ" naming — a vendor-side typo carried over from the previous kit drop; do not mass-rewrite, only update consumers.)

8. **Shared VPS — deploys are additive only.** Production runs on a Hostinger VPS (host name and IP are in the owner's private SSH config), SSH alias `assessiq-vps`. **Other apps already run on this box** (A11yOS / AccessBridge confirmed; the broader `automateedge.cloud` umbrella likely too). Treat the VPS as shared infra:
   - All AssessIQ artifacts live under an `assessiq` namespace: `/srv/assessiq/`, `/var/log/assessiq/`, Docker containers prefixed `assessiq-`, Caddy is the global edge (site snippet `infra/caddyfile/assessiq.snippet`; nginx runs only inside the frontend and marketing containers), systemd units prefixed `assessiq-*`.
   - **`/srv/assessiq` is a git clone** of `manishjnv/assessIQ` (converted 2026-05-03 — see RCA 2026-05-03 "Architectural debt"). The standard deploy is: `ssh assessiq-vps 'cd /srv/assessiq && git pull'`, then `docker compose -f infra/docker-compose.yml build <svc>`, then `up -d --no-deps --force-recreate <svc>`. See `docs/06-deployment.md` § "Deploy procedure (steady-state, post-2026-05-03)". Pre-deploy health check: `test -d /srv/assessiq/.git || echo "WARNING: not a git clone"`.
   - Before any `apt`, `docker`, `systemctl`, Caddy reload, or shared-config edit, **enumerate first** (`docker ps`, `systemctl list-units --state=running --no-pager`, the Caddy config on the VPS, `crontab -l`) and confirm the change is purely additive.
   - **Never** run blanket cleanup: no `docker system prune -a`, no `apt autoremove`, no mass `systemctl daemon-reload` after touching unknown units, no `certbot renew --force-renewal`. These are Phase 3 bounce conditions.
   - **Bypass-permissions does NOT authorize destructive ops on this VPS.** Local bypass skips local prompts; it does not excuse touching shared infra. STOP and ask the user before any `rm`, `docker rm/stop` of non-`assessiq-*` containers, `systemctl stop` of non-`assessiq-*` units, or rewrites of shared nginx/cron/systemd configs.
   - Any deploy diff or shell sequence that fails the additive-only check gets bounced in Phase 3 (or routed through `codex:rescue` for shared-infra-touching changes).

   _Rules A and B_ (docs/PROJECT_BRAIN.md): never delete a dormant feature without review and owner approval (Rule A). Find the older similar task first and fill the `**Old task or feature checked:**` handoff line (Rule B).

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
       | Logging / observability | `docs/11-observability.md` |
       | Module-internal | that module's `SKILL.md` |
       | Bug fix | append to `docs/RCA_LOG.md` |

       "Detail" means the doc update lets a future session resume the change **without reading the diff.** Cover all five: (a) what changed, (b) **why** it changed, (c) what was considered and rejected, (d) what is explicitly NOT included, (e) downstream impact on other modules/docs. Bare "added endpoint X" lines fail the requirement.
    4. **Handoff** via `docs/SESSION_STATE.md` per global Phase 6 — headline, commits, tests, next, open questions, plus the agent-utilization footer (global rule; 4 model lines plus routing lines).

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
**Old task or feature checked:** <ids or "none"> (Rule B, docs/PROJECT_BRAIN.md)

---

## Agent utilization
- Opus: <what Opus did, or `n/a — <reason>`>
- Sonnet: <subagent calls + outputs, or `n/a — <reason>`>
- Haiku: <bulk sweeps, or `n/a — <reason>`>
- codex:rescue: <accepted / revised / rejected, or `n/a — <reason>`>
```

The agent-utilization footer is mandatory (global rule). Missing footer = incomplete session.

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

## Speed rules (owner, 2026-10-18; memory `feedback-session-speed-rules`)

Functionality first. Test enough to prove the feature works (happy path and main failure case). No broad audits unless the row is security-related. Never cut code quality.

- **Verify before push:** run `pnpm verify` (lint and typecheck) before every push. Agents run it for the packages they touch before they report. Module tests: only touched modules, one at a time.
- **Gate only security paths:** the adversarial gate (`codex:rescue`, or Sonnet takeover while Codex is down) is for `01-auth`, `02-tenancy`, `07-ai-grading`, `14-audit-log`, `infra/**`, and anything that decides who may sit a test or gets marks or time. UI, docs and display-only rows skip the gate.
- **One gate per batch (owner, 2026-10-18; Z-65):** run ONE adversarial gate for the whole batch, with at most 3 security rows in it. Use `docs/ai-playbook/gate-checklist.md` (attack list per area, prompt shape, findings log line that names the row). Which paths are gated does not change.
- **AI credit rule (owner, 2026-10-23):** before any AI use (API, app grading, eval) find the cheapest way that keeps quality and write it down first: reuse old results, smallest paired sample, smoke of about 9 cases, cheapest model that holds quality, cache and Batch API for big runs, `--budget-tokens` cap on every API eval run. Checklist: `docs/ai-playbook/01-speed-rules.md`.
- **Latest models rule (owner, 2026-10-23):** all AI use (API runtime, Max-plan CLI, evals, generation, grading) runs on the latest Haiku, Sonnet or Opus as the task requires: now `claude-haiku-5-5`, `claude-sonnet-5-5`, `claude-opus-5-5`. VPS skill frontmatter `model:` is the source for grading and generation. Never leave an old model id pinned.
- **Smoke, not full e2e:** for a changed screen run one local smoke spec. CI runs the rest.
- **Batches:** 3 to 4 rows, then push, watch CI, deploy, sweep (`bash tools/post-deploy-sweep.sh`). Never stack new work on a red CI. Give an ETA for the next push only.
- **Agent brief (every build agent):** `git merge main` first in a worktree; own migration number and own help-id and seed-count range from the orchestrator; run `pnpm verify` before reporting; do not commit; report the worktree path. Take patches with `git add -N` and `git diff --binary`, apply with `git apply --3way` only when the worktree base equals `main`.
- **Template:** `docs/agent-brief.md` is the standard brief for every build agent. Fill every field.
- **Haiku 5.5 first (owner, 2026-10-18; `model: "haiku"` resolves to `claude-haiku-5-5`):** for fully specified, non-load-bearing rows (display or copy changes, help ids and YAML, tab strips and page wiring, docs, tests for existing behaviour, digests, sweeps) fire a Haiku 5.5 build agent first. Escalate to Sonnet only if the Haiku diff fails `pnpm verify` or needs a second revision, and log `reworked: Y/N` in the footer so the routing can be tuned. Sonnet stays the default for load-bearing paths (scoring, auth, tenancy, credentials, migrations with RLS). One agent run costs about 70k tokens of fixed context, so give each agent several rows of the same file area instead of one small row each.
- **Optimization register (owner, 2026-10-18):** time, token and gate ideas are kept in `docs/ai-playbook/09-optimization-register.md`. At Phase 6, update the rows you touched (status, date, measured evidence) and list the changed IDs in the handoff.
- **Phase 6 close-out (Z-109):** run `node tools/close-session.mjs` (next-brief, routing report, recount, archive, plans index, lint, link and privacy checks, file-count line, decisions into `docs/DECISIONS.md`; it never commits). Never edit NEXT.md by hand. Footer routing lines use `- <Opus|Sonnet|Haiku> · <task> · reworked: Y/N (<why>) · tokens: <subagent_tokens>`; `node tools/routing-report.mjs` prints rework rate per route. Stop the Haiku 5.5 trial if non-gate rework is above 25% after 8 runs.
- **Docs writes:** build the string first, then write the file (`python -X utf8`). Docs are local only (gitignored, not in git): never `git add` docs. `node tools/close-session.mjs` runs the close-out checks.
- **Push hook:** the trailer commit (`Adversarial-Review:`) must be its own command before the push.
- **Two sessions at once = two worktrees.** Run `bash tools/wt-setup.sh <name>` for each extra code session. Remove it with `bash tools/wt-clean.sh <name>` when done.
- **Worktree how-to:** `docs/ai-playbook/07-new-account-checklist.md` (memory link step included).
- **Agent workflow rules (Z-57):** the orchestrator owns shared generated files; no worktree for non-load-bearing UI rows; fewer, larger briefs; ETAs include gate, merge and CI; agents run `pnpm verify`. Full text: `docs/ai-playbook/01-speed-rules.md`.

## Caveats / sharp edges

- **Agent worktrees pile up under `.claude/worktrees/` (31 GB, 91 folders on 2026-10-15).** Every session that used `isolation: "worktree"` or `superpowers:using-git-worktrees` must remove its worktrees at Phase 6. On Windows `git worktree remove --force` fails with "Directory not empty" (pnpm links, long paths): delete the folder with `cmd /c rmdir /s /q <path>` from PowerShell, then `git worktree prune`. Before deleting, check `git -C <wt> status --porcelain`; a file whose blob is not in `git log main --find-object=<hash>` is unmerged work. Never touch `docs/`, `.git`, `apps`, `modules`, `tools`, `.agent`.
- The Phase 1 architecture is *intentional* — the temptation to "fix" sync-on-click grading by adding a worker means you're solving the wrong problem. Re-read `docs/05-ai-pipeline.md` § Compliance frame before suggesting any async grading.
- Three plugins (Superpowers, claude-mem, your global playbook) all want to drive workflow. Skills are namespaced — `superpowers:*`, `claude-mem:*`, `codex:*`; the global playbook has none. The table above is the tiebreaker. If two skills auto-fire on the same trigger, the table wins; otherwise prefer the global playbook over Superpowers.

## Autopilot (autonomous sessions)
This repo is driven by Autopilot. Project context lives in `.agent/`:
- `.agent/BRAIN.md` — architecture, conventions, invariants (read first)
- `.agent/DECISIONS.md` — decision log (stay consistent with it)
- `.agent/HANDOFF.md` — what the previous session did
Do not edit `.agent/plan.yaml`, `.agent/project.yaml` or anything under `.agent/state*` during a task session.
Do not commit, push, or switch branches; the orchestrator owns git.
Commands: `ap status` (where the project is), `ap next` (next task), `ap start` (run the plan).
Do not make plan files. The plan is `.agent/plan.yaml`; change it with `ap change`.
