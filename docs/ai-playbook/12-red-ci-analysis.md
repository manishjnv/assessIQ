# Red CI runs: causes (Z-60 a)

Measured 2026-10-18 with `gh run list --workflow ci.yml --limit 60`: 33 of 60 runs were red. The earlier "15 of 40" figure used another window. The count is high because a few causes repeated across many commits.

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
- Plan: after 3 green CI runs on the Z-58 change, set Playwright `retries` to 0 in CI (Z-60 d). A failure then shows at once.
