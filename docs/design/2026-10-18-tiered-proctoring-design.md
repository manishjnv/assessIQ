# Tiered webcam and ID checks (proctoring): design (Q9)

**Date:** 2026-10-19. **Status:** design only. No code. The owner approved the tiered plan on 2026-10-18 (Q9: "build it for all free and paid customers"). The build needs its own design review, a lawyer check of the notice text, and an adversarial gate.
**Source:** owner review sheet Q9; ROADMAP X5, OD5, FR11; `docs/design/2026-10-01-product-review-competitive-strategy.md` § 10 and § 11.
**Old task or feature checked:** integrity v1 (fullscreen gate, copy block, tab-switch and focus-loss events in `06-attempt-engine`, the behaviour archetype in `09-scoring`), the earlier rule "live proctoring is out of scope", Z-72 (DPA), Z-70 (Free plan), `20-data-rights` (erasure).

> [!IMPORTANT]
> This decision **reverses** the earlier rule "live proctoring is out of scope". Live human proctoring is still out. This design covers recorded checks that a person reviews later.

## Summary

- Three tiers of checks. The organisation picks a tier for each assessment.
- The tiers work on the Free plan and on paid plans. Limits differ by plan.
- Adults only. The candidate must consent first. No face recognition and no emotion analysis.
- A photo is a record for a human reviewer. The system never decides alone that a candidate cheated.
- Photos are kept for a short, fixed time and can be erased.

## Tiers

| Tier | What the system collects | Who sees it |
|---|---|---|
| 0: Signals (exists today) | Fullscreen exits, tab switches, focus loss, copy and paste events | Admin, as a flag count in the report |
| 1: Snapshots | Webcam photos at random times during the attempt (for example 1 every 3 to 5 minutes), and one photo at the start | Admin, in a review queue |
| 2: ID check | Tier 1, plus one photo of an ID card held to the camera at the start | Admin, in a review queue |

- Not in any tier: continuous video, audio recording, screen recording, face matching to the ID, face or emotion analysis, live watching by a person.
- Browser permission: today the edge sends `Permissions-Policy: camera=()`, which blocks the webcam. The build must send `camera=(self)` on the take pages only and keep `camera=()` everywhere else.
- The candidate sees a live preview of the camera while the check is on, so the candidate knows when the camera is active.

## Adults only: how age is known

- The system does not read age from the photo.
- The organisation states in the assessment settings that all candidates are adults (18 or more). The candidate confirms "I am 18 or older" on the consent screen.
- If the candidate says "no", the check is skipped, the attempt can go on without it, and the report shows "check not done: candidate not an adult". The organisation decides whether to allow this.
- The organisation warrants that it will not turn on tiers 1 or 2 for minors (DPA, Z-72). Owner decision 2026-10-19: self-declared age is enough, and the DPA keeps a clause that the organisation confirms its candidates are adults. Lawyer question: is that enough under DPDP (verifiable parent consent under 18)? No webcam for school tests until the lawyer agrees.

## Consent

- A consent screen comes before the camera starts. It says: what is taken, how often, who sees it, how long it is kept, and that the organisation decides on any outcome.
- The candidate must tick the box. A "no" does not block the test by default. The organisation can set "camera is required for this test"; then a "no" ends the attempt before it starts, and the candidate is told why.
- The system stores the consent: time, assessment, notice version, the answer. The record is append-only.
- A candidate on a device without a camera sees a clear message before the test day (the invitation email states the rule).

## Photo storage and retention

- Photos live in private object storage on the VPS, in a folder per tenant. They are encrypted at rest with the platform key. Nothing is public. Admins see them only through a signed, short-lived link.
- The database row holds: attempt id, tenant id, type (snapshot or id), time, storage key, review state. It never holds the image.
- Retention (owner decision 2026-10-19): **90 days** from capture, then an automatic deletion job removes the photo and the stored file. An erasure request deletes earlier. The lawyer must confirm 90 days. Build row: Z-74.
- Open point (recommended: yes): photos of a flagged attempt stay until an appeal about that flag is closed. The deletion job skips a photo only while an appeal is open, and it needs a hard upper limit that the lawyer sets.
- Photos are never used to train any model.

## Erasure

- The existing erasure flow (`20-data-rights`) must delete the photos and the rows for a candidate. The test for it is part of the build.
- Deleting a photo keeps the audit row that says a photo existed and was deleted.

## Review queue and appeals

- The admin opens a review queue for an assessment: flagged attempts first (many tab switches, a missing face, two faces, a blank photo).
- Flags come from simple counts: the photo is blank, dark, or a face detector (not a recogniser) finds zero or two or more faces. The detector runs in the candidate's browser or on the server and keeps no template.
- A reviewer marks each attempt "no concern", "concern" or "needs a second look" and may add a note. Every mark writes an audit row.
- Nothing changes a score automatically. A person at the organisation decides on any outcome.
- Appeal: the candidate can ask the organisation to review a flag. The report shows the flag, the photo and the note to the admin. The organisation owns the decision and answers the candidate. AssessIQ gives the data and the history.

## DPA and privacy page must say

- Photos and ID photos are personal data (an ID may hold sensitive data). The organisation is the fiduciary. AssessIQ is the processor.
- Purpose, tiers, retention period, storage place, sub-processors (storage is on the VPS; no new sub-processor if no cloud store is used).
- Consent and notice duties of the organisation, the adults-only warranty, and the appeal path.
- The lawyer approves the text before the feature goes live. No live page changes now.

## Cost

- Storage: a 100 KB photo every 4 minutes is about 1.5 MB for a one-hour test. For 1,000 candidates this is about 1.5 GB for 90 days.
- No per-image fee: no third-party vision service is used. Server detection, if chosen, is a small local library (cost: CPU only).
- Build effort: large (L). It touches attempt engine, candidate UI, storage, admin review, data rights, audit.

## Plan limits

| Plan | Proposed limit |
|---|---|
| Free | Tier 1 only, up to 5 candidates (the total limit already caps it) |
| Paid | Tier 1 and tier 2, no extra limit; a storage cap for each organisation |

## What stays out

- Live proctoring by a person.
- Continuous video or audio.
- Face recognition, match to the ID, emotion or attention analysis.
- Automatic fail or score change from any flag.
- Use of photos for any other purpose.

## Modules touched (when built)

`06-attempt-engine` (capture events), `11-candidate-ui` (consent, preview, capture), `10-admin-dashboard` (review queue), `14-audit-log` (new actions), `20-data-rights` (erasure), `19-billing` (plan limits), `16-help-system` (help ids), `infra` (storage folder, load-bearing). Design review and one adversarial gate are required.

## Owner decisions and open points (2026-10-19)

1. "Camera required" setting: allowed as proposed (organisation choice, per assessment).
2. Retention: 90 days, automatic deletion (decided). The lawyer confirms.
3. Age: self-declared age plus the DPA clause is enough (decided). The lawyer confirms.
4. Free plan uses tier 1 (approved with the tiered plan).
5. Open: keep photos of flagged attempts until an appeal closes? Recommended: yes, with a lawyer-set upper limit.

## Design review findings (S30, 2026-10-19)

**Verdict: REVISE.** Reviewer: Sonnet takeover (Codex is down), read-only, against the real code. Method: `docs/ai-playbook/gate-checklist.md` (areas 02-tenancy, 14-audit-log, infra, consent and privacy). The design stays a design. Nothing is built. Fix items 1 to 5 before any build.

| # | Severity | Finding | Required change |
|---|---|---|---|
| 1 | High | `Permissions-Policy` is set in the `(security-headers)` snippet in `infra/caddy/assessiq.caddy` (line 27). The reviewer says other apps on the VPS import that snippet, so an edit could break them. The orchestrator did not verify this claim; check it on the VPS (read-only) before the build. Also: `/take` and `/take/*` go to the app, and `/take/start` and `/verify/*` go to the API. | Do not edit the shared snippet. In the `assessiq.in` block only, add a matcher for the take-page path with its own header override. Show the Caddy diff. Embed iframes need an `allow="camera"` attribute and the embed route's own header. Caddy is shared infra: back up, enumerate, additive only, with the owner's yes. |
| 2 | High | "Signed, short-lived link" and "folder per tenant" are not specified. Storage is the local disk (`/var/assessiq/uploads`, `docs/01-architecture-overview.md`). | Serve photos only through an authenticated API route that checks the tenant (RLS on the photo table) and the attempt id. No static path, no user-supplied path segment, `Cache-Control: no-store`. |
| 3 | High | Erasure does not cover photos. `modules/20-data-rights/SKILL.md` lists the erasure targets and photos are not among them. | Add photos and ID photos to erasure. A test must prove that both the file and the row are deleted. |
| 4 | High | The 90-day job and the appeal hold are vague. | A non-AI worker job (`lint-no-ambient-claude` must pass), run per tenant, idempotent. Delete the file first, then the row. Retry on failure. The appeal hold has a hard cap set in code (for example 180 days), not by an admin. The lawyer confirms 90 days and the cap. |
| 5 | Medium | The upload endpoint is undefined. | Token scope tied to one attempt. JPEG only with a magic-byte check. Size cap, count cap per attempt, per-tenant storage quota, rate limit. There is no global Fastify body limit today (see RCA). |
| 6 | Medium | "Encrypted with the platform key" is vague. | Name the key, its rotation and the AES-GCM helper in `00-core`. One nonce per object. |
| 7 | Medium | The consent record needs more fields. | `notice_version`, append-only table, `tenant_id` with RLS. Store the age answer with the consent. |
| 8 | Medium | Audit rows could carry image data or names. | Audit rows hold ids only. Never image data, notes or names. |
| 9 | Low | A browser face detector needs `worker-src` and `wasm-unsafe-eval`, which the CSP does not have. | Host the model locally. No CDN. Add the CSP entries. |

**Not flagged (intentional):** recorded checks reviewed later by a person, no live proctoring, no face recognition, 90 days as the owner's decision (the lawyer confirms).

**Next step for Q9:** update this design for items 1 to 9, ask the owner to approve, get the lawyer's answers (liability proposal addendum B), then build, then run one adversarial gate on the diff.
