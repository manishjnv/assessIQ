# 04. Model routing

The global playbook (`~/.claude/CLAUDE.md`, private to one account) defines tiers. The project `CLAUDE.md` overrides it. This page is the project view, so another account does not need the private file.

## Models seen on this project (2026-10-18)

| Delegation setting | Resolves to | Verified |
| --- | --- | --- |
| `model: "haiku"` | Haiku 5.5, `claude-haiku-5-5` | A Haiku agent reported its own name |
| `model: "sonnet"` | Sonnet 5.5, `claude-sonnet-5-5` | Settings default |
| main session | Sonnet 5.5 by default in `settings.json`; session footers say "Opus" by habit | Unconfirmed: check the model name in the session header |

## Who does what

| Work | Use |
| --- | --- |
| Plan, diff review, security judgment, anything touching secrets | Main model |
| Load-bearing builds (scoring, auth, tenancy, credentials, migrations with RLS) | Sonnet agent, then main-model diff review; gate if on the security list |
| Specified, non-load-bearing builds (display and copy, help text, wiring, docs, tests of existing behaviour) | Haiku 5.5 first; escalate to Sonnet on a failed `pnpm verify` or a second revision; log `reworked: Y/N` |
| Digests of 5 or more files, call-site lists, log triage | `bash tools/gemini.sh "<prompt>"` (Gemini, read-only wrapper); run it in the background |
| Text-only second opinion on a diff | `codex exec` with stdin closed (`</dev/null`); Codex cannot run commands here |
| Checks of 1 to 3 tool calls, sweeps, counts | Do it inline or with a script. Never an agent: each run costs about 70k tokens |

## Gemini (`agy`)

- `agy` is on the Git Bash PATH (`~/.gemini/bin/agy.exe`, version 1.4.2). Models: `gemini-3.8-flash-high` (default), `-medium`, `-low`, plus Claude and GPT-OSS options (`agy models`).
- Headless mode needs `--dangerously-skip-permissions`, so Gemini could edit files. The wrapper adds a read-only instruction, closes stdin and exits 3 if `git status` changed.
- Runs take 25 seconds to 2 minutes. No secrets or `.env` contents in the prompt.

## Review gate

Codex companion and `codex exec` sandbox have been unable to run processes since 2026-10-11. The owner accepted a Sonnet takeover as the adversarial gate. The push hook needs an `Adversarial-Review:` trailer commit as its own command before the push (see `.claude/hooks/push-adversarial-gate.sh`).

## Footer

Every handoff ends with lines for Opus, Sonnet, Haiku, codex:rescue, Gemini (agy), Codex (exec), then one telemetry line per delegation: `<model> · <task> · reworked: Y/N (<why>)`. A revision found by a security gate is not counted as rework.
