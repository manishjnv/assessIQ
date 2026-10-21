# Camera for real exams: change record (2026-10-20, S39)

Rows: Z-74 (photo retention, review), Z-82 (school mode). Design: `docs/design/2026-10-20-camera-consent-flow-draft.md` (now as-built). Runbook: `docs/runbooks/camera-school-test.md`.

## 1. What changed

Three pushes, each deployed with a clean sweep.

| Batch | Commit | Content |
| --- | --- | --- |
| A | `737ccb13` | Data layer, storage, routes, `/take/start` consent gate, daily delete job, erasure. Migrations 0229, 0230. |
| B and C | `6dbabbd4`, `b1426b66` | Candidate screens, staff screens, "Did not consent" label, 10 help entries (migration 0231), fix for the nav probe. |
| D | close-out docs commit | Caddy edge change (applied, section 6.1), local smoke spec `apps/web/e2e/camera-smoke.spec.ts`, runbook, edge reference copies, this record. |

### 1.1 Server (module 06 unless noted)

- `modules/06-attempt-engine/migrations/0229_camera.sql`: tables `camera_consents` (immutable; only `attempt_id` NULL to value), `camera_files`, `camera_attempt_reviews`, `camera_reviewers`. RLS on all four.
- `modules/02-tenancy/migrations/0230_camera_tenancy.sql`: `tenants.is_school`; `tenant_settings.camera_enabled`, `camera_photos_enabled`, `camera_notice_confirmed_*`.
- `modules/02-tenancy/src/camera.ts`: `getCameraTenantSettings`, `setTenantIsSchool`, `updateCameraSettings`, `confirmCameraNotice` (each writes one audit row in the same transaction).
- `modules/06-attempt-engine/src/camera/`: `policy.ts` (pure rules), `gate.ts` (loads policy, records consent), `storage.ts` (disk write, disk guard), `retention.ts` (delete job), `repository.ts`, `constants.ts`, `hash.ts`.
- `modules/00-core/src/camera-storage.ts`: shared path helpers (traversal and symlink checks, unlink, tenant folder removal). It lives in core because erasure (20) and tenant purge (02) cannot import module 06.
- `routes.camera.candidate.ts`: status, photo upload, video upload. `routes.camera.admin.ts`: access probe, flagged list, file list, file content, reviewed, appeal, reviewers, settings, confirm notice, school flag (super admin only).
- `routes.take.ts`: `POST /take/camera-consent`; the preview carries `camera_required` and `camera_notice_version`.
- `service.ts` `startAttempt` step c4: the server refuses a new real attempt that needs a camera without a fresh, unlinked, current-version agreed consent. The consent is linked to the attempt in the same transaction.
- `modules/20-data-rights/src/erasure.ts`: deletes the user's camera files (disk first, a failure rethrows so the job retries), consents, reviews and reviewer row. `modules/02-tenancy/src/purge.ts` removes the tenant folder.
- `apps/api/src/worker.ts`: job `camera-retention-cron`, daily 03:00 UTC, 1 attempt. No AI call.
- `infra/docker-compose.yml`: one bind mount line on api and worker (host folder under the assessiq namespace).
- `modules/05-assessment-lifecycle`: the invitation list gets `camera_consent: 'declined' | null` through an injected enricher wired in `apps/api/src/server.ts` (module 05 cannot join a module 06 table).

### 1.2 Screens

- Candidate, in `apps/web/src/pages/take/`:
  - `ReadinessPanel.tsx`: camera row with a live picture.
  - `CameraConsent.tsx`: text from design section 5, two buttons.
  - `useCameraCapture.ts`: photo every 60 s, rolling 5 s video segment uploaded only when the camera stops or is blocked.
  - `CameraIndicator.tsx`: "Camera on" mark and the "Your camera stopped" overlay with Retry.
  - Wiring in `TokenLanding.tsx` and `Attempt.tsx`.
- Staff, in `modules/10-admin-dashboard`: School switch on the Platform page, Camera card and Camera reviewers card on the Data privacy tab of Settings, reviewer page `/admin/camera-review`, "Did not consent" chip on invitation rows, nav probe in `AdminShell.tsx`.
- Help: migration `0231_camera_help.sql`, 10 ids (4 candidate, 6 admin). Help count 575 to 585.

## 2. Why

- The owner decided the camera is mandatory for real exams of normal organisations, off by default for schools until the school admin turns it on, never used for mock tests, and used only for exam purposes. No AI touches the images.
- The server must enforce consent. The screen alone is not trusted (design section 4).
- Files stay private: no public URL, one authenticated tenant-checked route, one audit row per view.

## 3. Options considered and rejected

- Store files in the database: rejected, the bytes would bloat backups.
- Serve files through Caddy static or a signed URL: rejected, a leaked URL would expose an image. The API route checks the session and the tenant on every view.
- Slice one long MediaRecorder stream: rejected, a webm piece is not playable without its header. The recorder restarts every 5 seconds.
- A per-tenant byte quota: not built now. One global cap exists (section 5).
- Block self-grant of reviewer access: rejected. The organisation names its own reviewers and every grant writes an audit row. A single-admin school must be able to review.
- Probe the reviewer role with the flagged list: rejected after it failed CI (section 8). An always-200 access route replaced it.
- Embed starts: decided and recorded. Embed attempts take no camera (the host app asserts the candidate and owns consent). It is an accepted gap, like Z-87.

## 4. Rules in force

| Rule | Value |
| --- | --- |
| Camera required | real exam, not embed, not mock; normal organisation always; school only when its camera switch is on |
| Photos | every 60 s when photos are on (school photo switch); kept 90 days (school 7 days) |
| Video | only when the camera stops or is blocked; kept 7 days |
| Flagged attempt | all its files held while not reviewed since the newest flag, or while the appeal is open; maximum 365 days (school 90) |
| Upload limits | photo 400 KB, video 3 MB, 12 uploads per minute per attempt, 400 photos and 40 videos per attempt, magic-byte check, only while the attempt is in progress |
| Disk guard | warning at 80 percent of the cap (default 5 GB); upload refused above it or when free disk is under 256 MB; the attempt is flagged for the organiser |
| Switch | `CAMERA_ENFORCED` (default false) turns the whole rule on |

## 5. What is not included

- Face matching, any AI on images, sound, live proctoring, ID card checks, screen recording, Hindi consent text.
- Super admin viewing another tenant's files (support access stays deferred, Z-100). A super admin sees only the platform tenant's own files today.
- A per-tenant storage quota. One tenant can fill the global cap and cause refusals for all (gate finding 2, accepted for now).
- A sweep of orphan files and leftover `.tmp` files on disk (gate finding 5). There is no attempt delete path today.
- A video for a camera that dies between two 5 second segments (no recorder is running to stop).
- (Moved to Follow-up below: the camera line in the invitation email is built.)

Follow-up (2026-10-21): `camera-routes.test.ts` now has the retake case (refused without a new consent, agree again links only the new attempt) and tests for the consent limits. `/take/camera-consent` has its own bucket `aiq:rl:camera-consent:<token hash>` at 10 per minute (it replaces the shared take-token call for this route, so consent then start does not use two calls of the 30 per minute start budget). The same open decision is not written twice.

Follow-up (S39, camera line in the invitation email, design step 1). The real-exam invitation email and its reminder show one block: "This test uses your camera. Check your camera early on the readiness page: [take link]. You will be asked to agree before the test starts." Only a boolean `cameraRequired` triggers it. Module 05 computes it in `email.ts` with the same rule as the take flow (`isCameraRequired` from module 06, injected at boot through `setCameraRequiredResolver` in `apps/api/src/server.ts` and `worker.ts`). Mock invitations never show it (mode read from the invitation row). A missing resolver or a resolver error gives false and the email still goes out. Not included: a privacy notice link in the email; Hindi text. Tests: `email-camera-line.test.ts` (13), `invite-camera-flag.test.ts` (05).

## 6. Migrations, flags, jobs

- Migrations 0229, 0230, 0231 applied on the server. Next free migration: 0232.
- Flag `CAMERA_ENFORCED`: **true in production since 2026-10-21** (owner decision). One line added to the server `.env` after a name-only listing (31 variables, no CAMERA line), backup `env.pre-camera-enforced-2026-10-21` (mode 600), `assessiq-api` recreated only (healthy, container reads true), sweep 21 PASS and 0 FAIL, `/api/health` and `/api/ready` 200, error log unchanged. `assessiq-worker` was not recreated (only the reminder email camera line differs). Effect: a normal organisation must confirm the camera notice (Settings, Data privacy, Camera card) before any candidate can start a real exam, else 422 CAMERA_SETUP_REQUIRED. Undo: set false and recreate `assessiq-api`.
- Env: `CAMERA_STORAGE_DIR` (default `/var/lib/assessiq/camera`), `CAMERA_STORAGE_MAX_BYTES` (default 5 GB).
- Job: `camera-retention-cron`, daily 03:00 UTC.
- Server folder `/var/lib/assessiq/camera` created (mode 0700, new, assessiq namespace). Both containers see it.

### 6.1 Caddy edge change (APPLIED 2026-10-21 with the owner's go)

Shared Caddyfile, `assessiq.in` block only. Final lines:

```
+    @take_pages path /take /take/*
+    header @take_pages >Permissions-Policy "camera=(self), microphone=(), geolocation=()"
-    header Content-Security-Policy-Report-Only "...img-src 'self' data: blob: https:; connect-src ..."
+    header Content-Security-Policy-Report-Only "...img-src 'self' data: blob: https:; media-src 'self' blob:; connect-src ..."
-    @api path /api/* /embed* /help/* /take/start /verify/*
+    @api path /api/* /embed* /help/* /take/start /take/camera-consent /verify/*
```

- The shared `security-headers` snippet stays `camera=()` for every other site. `connect-src 'self'` already covers the uploads.
- The header must be the deferred (`>`) form at site level. The first try (plain header) and the second try (inside the app handler) both lost to the shared snippet. Caddy applies deferred writes from the outer handler last, and sorts the matcher form before the snippet's handler.
- Steps used: hash check of the live file, copy to the assessiq backups folder on the server, write in place (same inode), `caddy validate` (full output read), `caddy reload`, then `curl` checks. One false "invalid" from my own check restored the old file once; Caddy kept running the loaded config and no request failed.
- Checked after the final reload: `/take/abc` and `/take/attempt/abc` send `camera=(self)`; `/admin`, `/candidate/login` and `/` send `camera=()`; the health route returns 200; the neighbouring site returns 200; the legacy host still returns 301; `POST /take/camera-consent` returns JSON (404 for a fake token), not HTML.
- Not re-run: the direct-origin spoof check. The TLS client-certificate lines were not touched.
- Repo reference copies `infra/caddy/assessiq.caddy` and `infra/caddyfile/assessiq.snippet` carry the same lines. `apps/web/e2e/csp-policies.json` and the CSP enforce plan carry `media-src 'self' blob:`.
- Rollback of the edge: write the saved copy back in place, validate, reload.

## 7. How to verify

1. `pnpm verify`. Then `pnpm exec vitest run` in modules 06, 02-tenancy, 20-data-rights, 10-admin-dashboard, 05 and 16 (one at a time). Also run `modules/20-data-rights/src/__tests__/erasure-coverage.test.ts` and `modules/16-help-system/src/__tests__/help-id-page-prefix.test.ts`.
2. Local smoke: `apps/web/e2e/camera-smoke.spec.ts` (fake camera, mocked network, 3 tests).
3. Follow `docs/runbooks/camera-school-test.md` on the school test organisation.
4. After the Caddy go: `curl -sI` on a take page shows `camera=(self)`; `/admin` still shows `camera=()`; `POST /take/camera-consent` returns JSON, not HTML.

## 8. Bugs found (also in RCA_LOG)

- The `modules/06-attempt-engine/src/camera/` folder was hidden by a local exclude rule. The first commit would have shipped without the camera module. Fix: a named `git add -f` of 8 files. Prevention: run `git check-ignore -v` on new folders.
- A retake reused the consent linked to the first attempt, so every upload of the second attempt failed. Fix: the gate needs a consent with no attempt linked (`service.ts` step c4). Prevention: retake case added (see Follow-up).
- The general consent checkbox was hidden for camera tests, so a candidate never saw the general statement. Fix: the checkbox stays and "Allow camera and start" waits for it.
- The nav probe called the reviewer-only list and logged a 403 console error on every admin page for every non-reviewer. All signed-in e2e smoke specs failed in CI. Fix: `GET /api/admin/camera/access` answers 200.
- Three admin help ids sat on the tenant settings page with a prefix that never matches. Renamed to `admin.tenant_settings.camera*`.

## 9. Effect on other modules and docs

- 02-tenancy: new columns, `is_school` in the super admin tenant list, purge removes the camera folder.
- 20-data-rights: erasure scope grows by camera tables and files (erasure-coverage test updated).
- 14-audit-log: 7 new action names.
- 05-assessment-lifecycle: the invitation list accepts an optional enricher.
- 11-candidate-ui: `takeCameraConsent`, camera fields on the preview type.
- 16-help-system: 10 entries.
- Docs updated: 02-data-model, 03-api-contract, 04-auth-flows, 06-deployment, SKILL.md of 02, 05, 06 and 20; the design doc moved from draft to as-built.

## 10. Rollback

- Fast: set `CAMERA_ENFORCED=false` and recreate api and worker. No camera step is asked and no upload is accepted as required.
- Code: revert `b1426b66`, `6dbabbd4`, `737ccb13`. Migrations only add things and stay.
- Caddy: restore the saved copy of the Caddyfile, validate, reload.
- Files: the daily job and erasure delete them; or remove the camera folder after the tables are empty.

## 11. Review gate

One Sonnet-takeover gate on Batch A (upload, file access, consent, delete job, tenant isolation, erasure). Verdict revise.

- Fixed: photo body limit 400 KB (finding 2), suspended tenants swept (finding 3), re-flag after review holds files again (finding 4).
- Accepted and recorded: reviewer self-grant (1), orphan files (5), consent rows unbounded (6).
- Trailer `Adversarial-Review: sonnet-takeover revise-addressed` on `737ccb13`.
- The staff and candidate screens were reviewed by the orchestrator. No second gate was run.

## 12. Follow-up gate (2026-10-21)

One Sonnet-takeover gate on the follow-up commit `e1d4ed50` (consent route limit and idempotence, retake test, camera line in the invitation and reminder emails). Verdict revise.

- Fixed (medium): the bulk invite called the camera resolver inside the open invite transaction. The resolver opens its own tenant connection, so each invitee held one pooled connection and waited for a second (pool deadlock under load). `inviteUsers` in `modules/05-assessment-lifecycle/src/service/invitations.ts` now resolves the rule once per batch before the transaction. `email.ts` accepts a ready `cameraRequired`. Single resend and the reminder job send outside a transaction and were already safe. Two other test files that mock `../email.js` needed the new export.
- Accepted, low: no per-IP cap on `/take/camera-consent` (same exposure as the old shared bucket; the per-token cap is tighter, 10 against 30); a concurrent identical double submit can write two rows (the start gate reads the newest row, so it is harmless); an unlinked agreed row never expires (not new).
- Checked, no issue: delivery mode and tenant come from the invitation row and the call, a resolver error gives false and the email still goes out, templates add no user-controlled variable.
