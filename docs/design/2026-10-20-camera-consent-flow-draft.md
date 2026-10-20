# Camera consent flow (as built, 2026-10-20)

Status: AS-BUILT on 2026-10-20 (S39). The build follows this design. The change record is `docs/plans/2026-10-20-camera-change-record.md`. Rows: Z-74, Z-82 (Wave 2). Related: `docs/design/2026-10-19-legal-texts-v1.md`.

## 1. Owner decisions that shape this design

- School tests: school staff decide if the camera is on or off.
- All other organisations: the camera is mandatory for a real exam. Mock tests never use the camera.
- The photos and videos are used only for exam purposes, and only AssessIQ staff and the organisation's named reviewers can see them.
- Earlier decisions kept: photos 90 days, short low-size video 7 days; schools 7 days; flagged attempts keep their files until the appeal closes (schools at most 90 days, others at most 1 year); no face recognition, no emotion analysis; adults only.

## 2. Roles

- The organisation decides why the camera is used. It is the data fiduciary (controller).
- AssessIQ runs the service for the organisation. It is the processor, under the DPA that the organisation accepted at sign-up.
- The candidate is the data principal.

## 3. What the system records

| Item | Rule |
| --- | --- |
| Photos | Taken at set intervals during a real exam. Kept 90 days. |
| Short video | Low size, flagged moments only. Kept 7 days. |
| Flagged attempts | Files stay until the appeal closes. Maximum 1 year (schools 90 days). |
| School mode | Files kept 7 days. The school admin turns photos on or off. No photos when the school staff run the test on school premises. |
| Not recorded | Sound, screen content outside the test, face matching, emotion or behaviour scores. |

## 4. Flow, step by step

1. **Invitation email (NOT BUILT in S39, open row).** The real-exam email should say that this test uses the camera, links to the privacy notice and links to the readiness check. A school test without a camera does not say this.
2. **Readiness check.** The page asks for camera permission and shows a live picture, so the candidate can fix the angle and light before test day. A failed camera check shows plain steps and a Retry button.
3. **Consent screen** (shown before Start, after the readiness check passes). Text in section 5. The general test consent checkbox stays on the page. The "Allow camera and start" button waits until that checkbox is ticked. The screen has two buttons:
   - "Allow camera and start".
   - "I do not agree, do not start".
4. **If the candidate agrees.** The server stores the consent record first, with no attempt. The record holds the notice version, time, hashed IP and device type. The start links the consent to the new attempt in the same step. A retake needs a fresh consent. The test starts and a "Camera on" mark stays on screen.
5. **If the candidate does not agree.** The test does not start. The invitation stays valid. The screen says: "You did not start the test. Contact your test organiser if you want to take it in another way." AssessIQ takes no action against the candidate. The organiser sees "Did not consent" on the invitation row.
6. **During the test.** The camera takes a photo every 60 seconds when photos are on. A short video is recorded only when the camera stops or is blocked. If the camera stops, the screen shows "Your camera stopped" with a Retry button. The event is flagged. The test is never paused or failed by the system. The organiser decides what happens next. AssessIQ does not auto-fail anyone.
7. **After the test.** Files follow the keep times in section 3. A flagged event goes to a named person for review. Every view of a file writes an audit row.
8. **Rights.** The candidate asks the organisation to see, correct or erase the files. Erasure covers photos and video (erasure registry). An appeal is made to the organisation.

The server enforces steps 3 and 4. `/take/start` refuses a real attempt that needs a camera without a fresh, agreed consent for the current notice version. The UI alone is not enough.

## 5. Consent screen text (simple English)

> **This test uses your camera**
>
> - **Why:** [Organisation name] asks for the camera to check that you take this test yourself and without help.
> - **What we record:** photos during the test, and short low-size video when something looks wrong. We do not record sound. We do not match your face to other pictures. We do not score your face or your mood.
> - **Who sees it:** only people at [Organisation name] who review test problems, and AssessIQ staff who support them. Every view is logged.
> - **How long we keep it:** photos 90 days and video 7 days. If a problem is raised about your test, the files stay until it is closed, and for no more than one year.
> - **Your choices:** you can say no. Then the test does not start, and you can talk to your test organiser. You can ask [Organisation name] to show you or erase your files at any time.
> - By choosing "Allow camera and start" you agree to this use for this test only.
>
> [Allow camera and start] [I do not agree, do not start]
>
> Read the [privacy notice] and the [AssessIQ DPA summary].

## 6. Organisation setup

- The organisation confirms: "I have the consent and notice my candidates need for camera use." The confirmed notice version is stored.
- The super admin sets the school flag on a tenant. Only the super admin can set it.
- For a school, the school admin sets two switches: camera on or off, and photos on or off. Both default to off.
- The organisation names its reviewers on the Camera reviewers card. Named reviewers see the flagged list and the files.
- Embed starts are exempt. They take no camera, because the host app asserts the candidate and owns consent. This is an accepted gap.

## 7. Build checklist (Wave 2): done

- **Done.** Caddy edge change applied: camera allowed on take pages only, `media-src 'self' blob:` in the report-only CSP, and the consent route sent to the API.
- **Done.** Storage with a disk guard: 80 percent warning, 5 GB default cap.
- **Done.** Daily delete job (no AI call), 03:00 UTC.
- **Done.** Erasure covers the file tables. RLS and `tenant_id` on every new table (migrations 0229 and 0230).
- **Done.** Consent table, flag table, review queue, and audit rows for view and delete.
- **Done.** Help ids and entries: consent screen, readiness camera step, school settings, reviewer page (migration 0231).
- **Partly done.** Tests: the smoke spec has 3 tests (`apps/web/e2e/camera-smoke.spec.ts`). Route and erasure tests exist. A retake test is still missing.
- **Open.** Camera credit burn in the credit constants file. Not in the S39 change record. Check before the pilot.
- **Open.** `CAMERA_ENFORCED` stays false until the owner decides to turn it on.

## 8. Legal matters

The owner handles legal matters offline. They are not a build task and not a gate for this feature.

## 9. What this design does not cover

Live human proctoring, identity card checks, screen recording, and any AI analysis of the pictures. These stay out of scope.
