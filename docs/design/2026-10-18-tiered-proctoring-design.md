# Tiered webcam and ID checks (proctoring): design (Q9, Z-74)

**Date:** 2026-10-19 (revision 2, S31). **Status:** design only. No code. The owner approved the tiered plan on 2026-10-18 (Q9: "build it for all free and paid customers"). The build needs the owner's approval of this revision, a lawyer check of the notice text, the retention numbers and the age rule, and one adversarial gate on the diff.
**Source:** owner review sheet Q9; ROADMAP X5, OD5, FR11, Z-74; `docs/design/2026-10-01-product-review-competitive-strategy.md` § 10 and § 11; S30 design review (9 findings, all answered here).
**Old task or feature checked:** integrity v1 (fullscreen gate, copy block, tab-switch and focus-loss events in `06-attempt-engine`, the behaviour archetype in `09-scoring`), the earlier rule "live proctoring is out of scope", Z-72 (DPA), Z-70 (Free plan), `20-data-rights` (erasure, retention), `modules/00-core/src/aes-gcm.ts` (existing encryption helper), the worker scheduled jobs.

> [!IMPORTANT]
> This decision **reverses** the earlier rule "live proctoring is out of scope". Live human proctoring is still out. This design covers recorded checks that a person reviews later. The feature is **load-bearing**: it touches `06-attempt-engine`, `20-data-rights`, `14-audit-log`, storage and the Caddy edge.

> [!NOTE]
> The section "S31 review result and corrections" at the end of this file is binding. Where it differs from an earlier section, the end section wins.

## Summary

- Three tiers of checks. The organisation picks a tier for each assessment.
- The tiers work on the Free plan and on paid plans. Limits differ by plan.
- Adults only. The candidate must consent first. No face recognition and no emotion analysis.
- A photo is a record for a human reviewer. The system never decides alone that a candidate cheated.
- Photos are kept for 90 days, then deleted by a plain scheduled job. Erasure deletes them earlier.
- No webcam for school tests until the lawyer agrees.

## Tiers

| Tier | What the system collects | Who sees it |
|---|---|---|
| 0: Signals (exists today) | Fullscreen exits, tab switches, focus loss, copy and paste events | Admin, as a flag count in the report |
| 1: Snapshots | Webcam photos at random times during the attempt (for example 1 every 3 to 5 minutes), and one photo at the start | Admin, in a review queue |
| 2: ID check | Tier 1, plus one photo of an ID card held to the camera at the start | Admin, in a review queue |

- Not in any tier: continuous video, audio recording, screen recording, face matching to the ID, face or emotion analysis, live watching by a person.
- The candidate sees a live preview of the camera while the check is on, so the candidate knows when the camera is active.

## Browser permission and the Caddy edge (finding 1)

Today the edge sends `Permissions-Policy: camera=(), microphone=(), geolocation=()` from the shared `(security-headers)` snippet (`infra/caddy/assessiq.caddy` line 27). The snippet is imported by **8 sites** on the shared VPS (recorded in the Z-46 change on 2026-10-19). An edit to the snippet would reach other apps. So:

- **Do not edit the shared snippet.**
- In the `assessiq.in` block only, add a matcher for the take pages and a `header` override that sets `Permissions-Policy "camera=(self), microphone=(), geolocation=()"`. All other paths keep `camera=()`.
- Routes: `/take` and `/take/*` go to the app (`@app`). `/take/start` and `/verify/*` go to the API (`@api`). The capture page is `/take/attempt/<id>` (app). The override matcher is `path /take /take/*` and sits after `import security-headers`. A later `header` directive for the same name replaces the snippet value for that matcher; the build must show the live response header for both a take page and `/admin` in the Caddy diff, and the sweep must check both.
- Embed iframes need an `allow="camera"` attribute from the host page, and the embed route needs its own header. Embed capture is **out of the first build**. Candidates in an embed see "check not available in this view" and the organisation chooses whether to allow the attempt. (Reason: the host page controls the iframe, so consent and permission cannot be guaranteed.)
- Caddy is shared infra. The change needs the owner's yes, a backup, an enumeration of the live file, a truncate-write (never `sed -i`), `caddy validate`, then reload. It is additive. It goes through the infra gate.

## Adults only: how age is known

- The system does not read age from the photo.
- The organisation states in the assessment settings that all candidates are adults (18 or more). The candidate confirms "I am 18 or older" on the consent screen. The answer is stored with the consent record (finding 7).
- If the candidate says "no", the check is skipped, the attempt can go on without it, and the report shows "check not done: candidate not an adult". The organisation decides whether to allow this.
- Owner decision 2026-10-19: self-declared age is enough, and the DPA keeps a clause that the organisation confirms its candidates are adults and warrants that it will not turn on tiers 1 or 2 for minors. **The lawyer must confirm** this is enough under DPDP (verifiable parent consent under 18).
- **No webcam for school tests** until the lawyer agrees. The build adds a tenant setting `proctoring_allowed` (default false). Platform staff set it to true for a tenant after the lawyer's answer. Tier 1 and tier 2 cannot be turned on while it is false.

## Consent (finding 7)

- A consent screen comes before the camera starts. It says: what is taken, how often, who sees it, how long it is kept, and that the organisation decides on any outcome.
- The candidate must tick the box. A "no" does not block the test by default. The organisation can set "camera is required for this test"; then a "no" ends the attempt before it starts, and the candidate is told why.
- Table `proctoring_consents` (append-only): `id`, `tenant_id` (NOT NULL), `attempt_id`, `candidate_id`, `assessment_id`, `notice_version`, `answer` (`yes` or `no`), `adult_confirmed` (boolean), `tier`, `created_at`, `ip_hash`. RLS with one policy per verb (SELECT, INSERT, with `WITH CHECK`). UPDATE, DELETE and TRUNCATE are revoked for the app role.
- A consent row is erased with the candidate (see Erasure) by the tombstone rule: the row stays, `candidate_id` and `ip_hash` are cleared. The audit trail keeps the fact that a consent existed.
- A candidate on a device without a camera sees a clear message before the test day (the invitation email states the rule).

## Photo storage and access (findings 2 and 6)

- Photos are files on the VPS disk under `/var/assessiq/uploads/proctoring/<tenant_id>/<attempt_id>/<photo_id>.bin`. The API builds the path from database ids only. **No user-supplied path segment** exists.
- Files are encrypted at rest with the existing `modules/00-core/src/aes-gcm.ts` helper (AES-256-GCM), one random 12-byte nonce for each file, stored in the file header. The key is a new env name `PROCTORING_KEY` (32 bytes, base64), kept only in `/srv/assessiq/.env`, never in git. Rotation: a `key_id` column on the photo row. A new key gets a new id; old photos keep the old id until they expire (90 days), so rotation needs no re-encryption. Production boot refuses to start the feature without the key.
- Table `proctoring_photos`: `id`, `tenant_id` (NOT NULL), `attempt_id`, `kind` (`snapshot` or `id`), `captured_at`, `storage_key`, `key_id`, `review_state`, `delete_after` (date), `hold_reason` (null or `appeal`), `hold_until` (date, null), `deleted_at`. RLS: one policy per verb. The row never holds the image.
- **No static path and no signed URL.** The admin sees a photo only through an authenticated API route `GET /api/admin/proctoring/photos/:id`. The route: checks the admin role, runs under `withTenant`, loads the row by id (RLS limits it to the tenant), decrypts in memory, returns the bytes with `Content-Type: image/jpeg`, `Cache-Control: no-store` and `Content-Disposition: inline`. Each view writes an audit row (ids only).
- Storage cap for each organisation (paid plans) and a hard limit for Free are tenant plan values. The upload route refuses when the cap is reached.

## Upload endpoint (finding 5)

- `POST /api/take/attempts/:id/proctoring/photo`. It uses the candidate attempt session (the same auth as the answer autosave). The token scope is one attempt. The attempt must be `in_progress` and the tier must be on for its assessment.
- Body: a JPEG only. The server checks the magic bytes (`FF D8 FF`) and rejects anything else. Size cap: 300 KB per photo (route-level body limit; the app has no global Fastify body limit, see RCA). ID photo cap: 600 KB.
- Count cap per attempt: a number set from the tier (for example 1 start photo + 1 per 3 minutes up to 60, then refuse). Per-tenant storage quota. Rate limit: 1 request per 20 seconds per attempt and per IP (scope = attempt, then ip).
- Photo time comes from the server clock, not from the client.
- The server never runs a model on the photo and never sends it to a third party. Face counting (zero or many faces) runs in the candidate's browser with a model file hosted by AssessIQ (see CSP below). The result is a flag number sent with the photo. It is a hint. The reviewer decides.

## Retention: the 90-day deletion job (finding 4)

Owner decision 2026-10-19: **90 days**, then automatic deletion. The lawyer confirms.

- A plain scheduled worker job (BullMQ repeatable job, same pattern as the retention and email jobs). **It makes no AI call.** `pnpm lint:ambient-ai` (`lint-no-ambient-claude`) must pass: the job imports nothing from `07-ai-grading`.
- Run once a day. The job processes one tenant at a time (`withTenant`), in batches of 200 rows. It selects rows where `deleted_at IS NULL AND delete_after <= today AND (hold_until IS NULL OR hold_until < today)`.
- For each row: **delete the file first**, then set `deleted_at` and clear `storage_key` in the same transaction as an audit row. A missing file counts as deleted. If the file delete fails, the row stays and the next run retries. The job is idempotent.
- The job writes one summary audit row for each tenant run (counts only).
- Dry-run mode, like the retention purge (`?dryRun=true`), for the owner's first check.
- A test creates photos with old `delete_after`, runs the job, and proves both the file and the stored key are gone, and that a held photo stays.

### Appeal hold

- Open point (owner): keep photos of a flagged attempt until the appeal closes. **Recommendation: yes.**
- Design if yes: when a reviewer marks an attempt "concern" or a candidate files an appeal, the photo rows get `hold_reason='appeal'` and `hold_until = today + 90 days`. The reviewer can close the appeal, which clears the hold at once.
- **Hard maximum in code:** the hold can never run past `captured_at + 180 days` (constant `PROCTORING_HOLD_MAX_DAYS`, set by the lawyer; 180 is a placeholder). The job ignores `hold_until` after the maximum. An admin cannot change it.
- Without the owner's yes, the hold code is not built and the 90-day delete is absolute.

## Erasure (finding 3)

`modules/20-data-rights` lists the erasure targets in its SKILL.md (candidate answers, grading echoes, session IP). Photos are not in the list today. The build adds:

- `proctoring_photos` (every kind): delete the file first, then set `deleted_at`, `storage_key = NULL`, for every photo of the candidate's attempts. Holds do not stop an erasure request, unless the lawyer says a legal hold applies.
- `proctoring_consents`: clear `candidate_id` and `ip_hash` (tombstone, as the other tables).
- The erasure receipt gains `photosDeleted` and `consentsScrubbed` (counts only).
- The retention purge (`retention.ts`) calls the same erasure, so it covers photos too.
- Tests: extend `erasure-coverage.test.ts` and `data-rights.test.ts`. A test proves that after erasure the file is gone from disk and the row has no key.
- Deleting a photo keeps the audit row that says a photo existed and was deleted.

## Review queue and appeals

- The admin opens a review queue for an assessment: flagged attempts first (many tab switches, a missing face, two faces, a blank photo).
- Flags come from simple counts: the photo is blank, dark, or the browser face counter says zero or two or more faces. The face counter is a detector (not a recogniser). It keeps no template and no embedding.
- A reviewer marks each attempt "no concern", "concern" or "needs a second look" and may add a note. Every mark writes an audit row.
- Nothing changes a score automatically. A person at the organisation decides on any outcome.
- Appeal: the candidate can ask the organisation to review a flag. The report shows the flag, the photo and the note to the admin. The organisation owns the decision and answers the candidate. AssessIQ gives the data and the history.

## Audit rows (finding 8)

Audit rows hold ids and counts only. They never hold image data, a reviewer note, a candidate name or an email.

| Action | Data in `after` |
|---|---|
| `proctoring.consent_recorded` | consent id, attempt id, tier, answer |
| `proctoring.photo_stored` | photo id, attempt id, kind |
| `proctoring.photo_viewed` | photo id, viewer user id |
| `proctoring.review_marked` | attempt id, state (the note text stays in its own table, not in audit) |
| `proctoring.photo_deleted` | photo id, reason (`retention`, `erasure`) |
| `proctoring.retention_run` | tenant id, counts |
| `proctoring.hold_set` / `hold_cleared` | photo ids, hold_until |

Each admin-mutating function writes its row with `auditInTx` in the same transaction (project rule).

## CSP for the browser face counter (finding 9)

A browser face counter runs in a Web Worker and loads a WebAssembly model. The current CSP has no `worker-src` and no `wasm-unsafe-eval`. The build:

- hosts the model files on AssessIQ (`/assets/...`). **No CDN.**
- adds `worker-src 'self' blob:` and `'wasm-unsafe-eval'` to the script policy for the take pages.
- The CSP is report-only today (Z-46), so no block happens now. The enforcing policy must keep these entries.
- If the face counter proves hard, the first build ships with blank and dark checks only (server-side, simple pixel stats) and no face count.

## DPA and privacy page must say

- Photos and ID photos are personal data (an ID may hold sensitive data). The organisation is the fiduciary. AssessIQ is the processor.
- Purpose, tiers, retention period (90 days, and the appeal hold maximum), storage place (the VPS disk, encrypted), sub-processors (none new: no cloud store, no vision service), no model training on photos.
- Consent and notice duties of the organisation, the adults-only warranty, the school-test rule, and the appeal path.
- How a candidate asks for erasure (through the organisation).
- The lawyer approves the text before the feature goes live. **No live page changes now.**

## Cost

- Storage: a 100 KB photo every 4 minutes is about 1.5 MB for a one-hour test. For 1,000 candidates this is about 1.5 GB for 90 days.
- No per-image fee: no third-party vision service is used. CPU only.
- Build effort: large (L). Suggested split into three rows: (a) consent, storage, upload, deletion job, erasure (security core, gated); (b) admin review queue and appeal; (c) Caddy override, CSP, plan limits.

## Plan limits

| Plan | Proposed limit |
|---|---|
| Free | Tier 1 only, up to 5 candidates (the total limit already caps it); a hard storage cap |
| Paid | Tier 1 and tier 2, a storage cap for each organisation |

## What stays out

- Live proctoring by a person.
- Continuous video or audio.
- Face recognition, match to the ID, emotion or attention analysis.
- Automatic fail or score change from any flag.
- Use of photos for any other purpose.
- Capture inside embed iframes (first build).

## What was considered and rejected

- Signed short-lived links: rejected. An authenticated API route with RLS is simpler and has no link to leak.
- A cloud object store (S3): rejected for now. It adds a sub-processor and a DPA change.
- Editing the shared Caddy snippet for `camera=(self)`: rejected (8 sites import it).
- A server-side face detector: rejected for the first build. It costs CPU and adds an image-processing dependency. The browser counter is a hint only.
- An admin-set appeal hold length: rejected. The maximum is fixed in code.

## Modules touched (when built)

`06-attempt-engine` (capture events, upload route), `11-candidate-ui` (consent, preview, capture), `10-admin-dashboard` (review queue), `14-audit-log` (new actions), `20-data-rights` (erasure, retention), `19-billing` (plan limits), `02-tenancy` (`proctoring_allowed` setting), `16-help-system` (help ids), `00-core` (new env name, key check), `apps/worker` (deletion job), `infra` (Caddy override, storage folder; load-bearing). Design review and one adversarial gate per build row are required.

## Owner decisions and open points (2026-10-19)

1. "Camera required" setting: allowed as proposed (organisation choice, per assessment).
2. Retention: 90 days, automatic deletion (decided). The lawyer confirms.
3. Age: self-declared age plus the DPA clause is enough (decided). The lawyer confirms. No webcam for school tests until then.
4. Free plan uses tier 1 (approved with the tiered plan).
5. Open: keep photos of flagged attempts until an appeal closes? Recommended: yes, with a maximum in code that the lawyer sets (placeholder 180 days from capture).
6. Needed before the Caddy change: the owner's yes on the Caddy diff.

## Review history

| Review | Date | Verdict | Findings |
|---|---|---|---|
| S30 design review (Sonnet takeover) | 2026-10-19 | REVISE | 9. All are answered in this revision: 1 (Caddy block override, no snippet edit), 2 (authenticated route, no static path), 3 (erasure covers photos, tests), 4 (non-AI job, file first, hold cap in code), 5 (upload rules), 6 (AES-GCM helper, `PROCTORING_KEY`, `key_id`), 7 (consent table), 8 (audit ids only), 9 (local model, CSP entries). |
| S31 design review (Sonnet takeover) | 2026-10-19 | REVISE | See "S31 review result and corrections" at the end. All findings are answered. A third review is not run in S31; the build gate re-reads them. |

## S31 review result and corrections (binding)

**Verdict of the S31 design review (Sonnet takeover, read-only, against the code): REVISE.** 12 findings, mostly gaps in the S30 fixes. Every finding is answered below. Where this section differs from an earlier section, this section wins. The build gate re-reads these decisions against the real code.

| # | Sev. | Finding (code evidence) | Decision |
|---|---|---|---|
| 1 | High | Tenant purge (`02-tenancy/purge.ts`, about line 89) deletes every `tenant_id` row but never the files, so photos stay on disk. A crash between the file write and the row insert also leaves an orphan file. | Write order: (1) insert the photo row with `state='pending'`; (2) write the file; (3) set `state='stored'`. Tenant purge deletes the tenant folder `/var/assessiq/uploads/proctoring/<tenant_id>/` before the rows. A weekly **orphan sweep** (plain worker job, no AI call) lists files with no row, or a `pending` row older than 24 hours, and deletes them. Test: a crash after the file write leaves nothing after the sweep. |
| 2 | Med-High | Copying `listActiveTenantIds` (`retention.ts`, about line 234) skips suspended and archived tenants, so their photos outlive 90 days. | The deletion job lists **all non-purged tenants**, whatever the status. A test covers a suspended tenant. |
| 3 | Med-High | Erasure gaps: reviewer notes, flags and appeal records are not erased. `eraseCandidatePii` does not check for an in-progress attempt (`retention.ts`, about line 123, does), so uploads could continue after erasure. Erasure is candidate-only (`erasure.ts`, about line 82). A failed file delete inside the transaction needs a rule. | (a) Reviewer notes and appeal text live in `proctoring_reviews`; erasure sets the note text to NULL and keeps state and ids. (b) The upload route refuses when the candidate has `erased_at`; erasure of a candidate with an in-progress attempt is refused (same rule as `retention.ts`). (c) Scope stays candidate-only; organisation-level erasure is tenant purge (finding 1). (d) If a file delete fails, the erasure transaction **rolls back** and the receipt says "incomplete"; no partial erasure. |
| 4 | Med | The consent table is append-only with UPDATE revoked, but the design said erasure clears `candidate_id`. These contradict. Clearing `candidate_id` is also pointless: erasure keeps the `users` row as a tombstone and `attempt_id` still links it. | **Withdrawn.** Consent rows are immutable and never edited. The user row is already tombstoned by erasure, so the consent row holds no readable identity. `ip_hash` is an HMAC. `proctoring_photos` needs SELECT, INSERT and UPDATE policies (state, hold, `deleted_at` change) and no DELETE for the app role. `proctoring_reviews` the same. |
| 5 | Med | `aes-gcm.ts` (00-core, about lines 17 and 38) uses only `ASSESSIQ_MASTER_KEY` and `_PREVIOUS`. It has no key parameter and no AAD. A separate `PROCTORING_KEY` does not fit the helper. | Drop `PROCTORING_KEY`. Extend the 00-core helper with an optional `aad` input and a `context` string. A sub-key comes from the master key with HKDF (context `proctoring-v1`). `key_id` records `current` or `previous` master key. AAD = `tenant_id\|photo_id`, so a file moved to another row or tenant fails to decrypt. The 00-core change is load-bearing and goes through the gate. |
| 6 | Med | The upload route never checks for a `yes` consent with `adult_confirmed` for the attempt. A "no" or a modified client would still store photos. | The route loads the attempt's consent row and refuses unless `answer='yes'`, `adult_confirmed=true` and the tier matches. It also checks that `:id` equals the session's attempt id. The camera stops in the browser on a "no", but the server rule is the control. |
| 7 | Med | Backups and host snapshots keep the files and the key, so "90 days" is not real. | **Owner question:** are `/var/assessiq/uploads` and the `.env` key in a VPS backup, and for how long? Rule for the build: the proctoring folder is excluded from backups, or backups expire within a number of days that the DPA states (for example 90 + 30). The DPA says so. The sweep cannot reach a backup. |
| 8 | Med | No global disk guard on the shared VPS. The Free "hard cap" has no number. | Proposal: a global guard stops new uploads when the uploads volume is more than 80 percent full, and alerts the owner. Free: at most 60 photos for each attempt, 300 KB each, 5 candidates: about 90 MB. Paid default: 5 GB for each organisation, changeable by staff. The owner confirms the numbers. |
| 9 | Low-Med | The super-admin and `withSystemRole` read path is not covered. Any admin can extend retention to 180 days by marking "concern". | The photo route has no system-role path: a `super_admin` has no read of photos by default. A break-glass read needs a reason and writes a `proctoring.photo_viewed` row with `actor_kind=system`. The DPA states that an organisation reviewer who marks "concern" extends retention up to the code maximum. |
| 10 | Low | Caddy order: later `header` directives run in order and `set` replaces the earlier value, so the override probably works. `Permissions-Policy` applies for each document load. A client-side move from `/candidate` into `/take/attempt` keeps `camera=()`. `/take/start` is under `@api`. The uploads volume must be mounted in the api and worker containers. | The build proves the override with `caddy adapt` and a live header check of BOTH a take page and `/admin`. The invitation link opens `/take/...` as a full page load. The app must enter the capture page with a full navigation (`window.location`), not a router push, and a test covers it. The upload route is under `@api` (`/api/*`). The uploads volume is added to the api and worker services in `infra/docker-compose.yml` (additive, gated). |
| 11 | Low | The consent screen needs the controller name and a way to withdraw during the test. ID photos may show Aadhaar numbers. | The consent screen names the organisation. A "Stop camera" button ends capture; earlier photos stay until the 90 days. The ID step tells the candidate to cover the ID number. The DPA says the organisation handles ID data and must not ask for a government number to be visible. |
| 12 | Low | The upload route must check that `:id` equals the session attempt. | Done in decision 6. |

**Checked and fine (reviewer):** the Caddy block approach (no shared snippet edit), the authenticated photo route, the audit ids-only rule, the non-AI deletion job design.

**Owner questions added:** (1) backups (finding 7); (2) the numbers in finding 8.
