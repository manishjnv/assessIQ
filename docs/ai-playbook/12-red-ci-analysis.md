# Red CI runs: causes (Z-60 a)

## Red-CI rate (one figure)

Red-CI rate (method: last 30 runs of ci.yml, `gh run list --workflow ci.yml --limit 30 --json conclusion,createdAt,headSha`, measured 2026-10-18): 2 of 30 red (7%).

Older figures are superseded. They came from other samples and are not comparable:

- 15 of 40 (S24 review sample).
- 33 of 60 (`--limit 60`, 2026-10-18). This sample is used for the cause table below.
- 2 of the last 20 (earlier check).

Use only the 2 of 30 figure for the rate.

## Cause table (sample: last 60 runs, 2026-10-18, 33 red)

The count is high in that sample because a few causes repeated across many commits.

| Cause group | Runs | Class | Root cause | Status |
| --- | --- | --- | --- | --- |
| quality: Lint | 21 (2026-10-17 09:26 to 22:32) | deterministic, stacked | One lint failure stayed on main while docs and marketing commits kept landing on top of it. Each new push was red for the same reason. | Fixed later; prevention is the rule "never stack new work on a red CI". |
| e2e: Run E2E specs | 5 (2026-10-18 02:3x to 03:59) | deterministic | `ordering-admin` structured_case locator, and the blank admin page from two react-router copies (RCA 2026-10-18). Retries 2 ran the same failure 3 times and added about 2 min to each red. | Fixed. Z-47 and Z-59 guard the router case. |
| quality: Test | 4 | 3 deterministic, 1 flaky | `z22-flow-links` AdminApiError constructor; structured-case tests; `AttemptSubmitModal` key test (flaky: the act settle). | Fixed in `05193ac1` (flaky one). |
| quality: Typecheck | 2 | deterministic | React JSX return type and a type error after the Z-44 payload change. | Fixed. Typecheck is now its own job (Z-55). |
| queue / infrastructure | 0 seen in the red list | n/a | Slow runs (10 to 11 min) came from runner queueing, not red runs. | n/a |

Findings:
- Most red runs are deterministic, not flaky. Blind retries would not have helped; they only slowed the red e2e runs.
- The one proven flake (AttemptSubmitModal) is fixed. The `handleAuditFanout` WARN in notification tests is log output only, not a failure.
- Done in `8eb0a949` (Z-60 d): Playwright `retries` is 0 in CI. A failure shows at once. The count of green runs on this setting is still open.
