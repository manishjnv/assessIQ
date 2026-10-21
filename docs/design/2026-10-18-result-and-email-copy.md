# Result copy (Z-9) and email review (Z-10) - draft for owner review

Rows: Z-9, Z-10, Z-15, Z-16, Z-37

Status: DRAFT. Nothing here is built. No code or template changed.
Sources: ROADMAP rows Z-9, Z-10, Z-11, Z-15, Z-16; glossary `docs/10-branding-guideline.md` section 2.5; templates in `modules/13-notifications/src/email/templates/`; copy in `modules/11-candidate-ui/src/`.

Placeholders used below:

- `{passMark}` = the pass mark in percent. Pending Z-16 it is `levels.passing_score_pct` (default 60). After Z-16 it is `assessments.passing_score_pct`.
- `{certMin}` = the certificate floor. Today it is a fixed 70 (`modules/18-certification/src/service.ts:668`). After Z-16 the floor goes and a certificate follows every pass.
- Every line marked **[pending Z-16]** depends on that rule. Do not ship it before Z-16 is decided.

---

## 0. Owner decisions recorded 2026-10-17 (they settle section A and D below)

- **Tone:** option 2 (plain): 'You passed {assessmentName}.' and 'You did not reach the pass mark.' Support lines use option 2.
- **Fail colour:** amber, plus the words 'Not passed', plus an icon. Never red.
- **Percent:** keep it next to the score (for example 60%).
- **Retake line:** 'Ask your organisation if you can take it again' is accepted. A real retake rule comes later: organisation admin sets a maximum number of attempts (ROADMAP Z-39).
- **Certificate email:** one email that carries the result and, when a certificate exists, the certificate link and share-on-social links.
- **Sign-off:** one line 'The AssessIQ team' for all mail, as recommended.
- **Unsent templates:** none deleted (rule A). Allowlist stays.
- **Z-16:** Honors later. Distinction at 90%. Lines marked [pending Z-16] stay pending until Z-16 is built.
- **Not answered, so the draft's proposal stands:** organisation name in the invitation subject (yes), admin role labels, pass mark shown to students (yes).

---
## A. What the owner must approve

1. **Pass and fail wording** on three surfaces (section B). Pick option 1 or 2 where shown.
2. **Fail colour.** Proposal: amber (warning token) plus the words "Not passed" plus an icon. Never red alone.
3. **The certificate rule line.** Today it says 70%. The pass mark can be 60%. A student can pass and still get no certificate. This is confusing today. Z-16 removes the gap. [pending Z-16]
4. **Raw percent on the result.** The result page shows "(60%)" next to the total. Subjective bands never show a percent. Confirm the total percent may stay.
5. **Email review table** (section C). Approve the fixes row by row.
6. **Four emails have a template but no sender.** Decide: send them, or delete them. See section C and D.
7. **The word "Company"** in five email tables must become "Organisation" (glossary).
8. **Retake line.** The platform has no retake rule in the text. Decide whether to say anything. See D.

---

## B. Z-9 - pass and fail copy

### B.0 Facts the copy must respect

- Today the result page shows a score ring, "Your score", total / max, "(percent%)" and a chip "Passed" or "Not passed" (`modules/11-candidate-ui/src/components/ResultSummary.tsx:97-107`).
- The Results list reuses the same component in compact form (`MyResults.tsx:167-175`).
- The result email shows Score and Result rows only (`result-released.ts:122-123`, `render.ts:205-210`).
- The certificate rule line today: "You earn a certificate when your score is 70% or more. Your organisation releases the result first." (`copy.ts:7-8`). It shows only when the score is under 70 and there is no certificate.
- Candidates never see a score band. Bands (0/25/50/75/100) stay admin-only. Copy below never names a band and never prints a percent for a band.
- Words: "organisation", "assessment", "score", "certificate". Never "token", "magic link", "company", "test", "exam".

### B.1 Colour treatment (brand tokens)

| State | Surface | Fill | Accent bar and icon | Text | Non-colour signal |
| --- | --- | --- | --- | --- | --- |
| Passed | result card, list row | `--aiq-color-success-soft` | `--aiq-color-success` | `--aiq-color-fg-primary` | Chip text "Passed" + check icon |
| Not passed | result card, list row | `--aiq-color-warning-soft` | `--aiq-color-warning` | `--aiq-color-fg-primary` | Chip text "Not passed" + close icon (already in code) |

Rules:

- Do not use `--aiq-color-danger`. A fail is not an error. Red alone also fails for colour-blind readers.
- Body text stays dark on the soft fill. Check contrast 4.5:1 (WCAG AA) on both fills.
- The state is always in words and an icon, never in colour alone.
- Email: use table cells with inline hex. The email table in `docs/13-email-system.md` section 1.1 has no success or warning hex yet. Owner or builder must resolve the two oklch tokens to hex once and add them to that table. Use a 4 px left border on the result row plus a soft-fill cell. Do not rely on background colour only: some mail apps strip it.
- Dark mode (web): the soft tokens already have dark pairs. Check them. Email: keep light only.

### B.2 Candidate result page

**Passed - headline** (shown above the score block)

- Option 1 (warm): "Well done. You passed."
- Option 2 (plain): "You passed {assessmentName}."

**Passed - support line**

- Option 1: "You scored {earned} out of {max}. The pass mark is {passMark}%." [pending Z-16]
- Option 2: "Your score is {earned} out of {max}. You met the pass mark of {passMark}%." [pending Z-16]

**Passed - next step**

- If a certificate exists: "Your certificate is ready. Select View certificate to open, download or share it."
- If no certificate yet: "Your certificate will appear on the Certificates page." (Use only if issuing can lag. Today issuing is in the same transaction as release, so this case should not occur. Do not show it unless a real case exists.)

**Not passed - headline**

- Option 1 (warm): "You did not pass this time."
- Option 2 (plain): "You did not reach the pass mark."

**Not passed - support line**

- Option 1: "You scored {earned} out of {max}. The pass mark is {passMark}%." [pending Z-16]
- Option 2: "Your score is {earned} out of {max}. You need {passMark}% to pass." [pending Z-16]

**Not passed - next step**

- Option 1: "Look at the question feedback to see where to improve. Ask your organisation if you can take it again."
- Option 2: "Use the feedback on each question to prepare. Ask {tenantName} if you can try again."
- Show the feedback sentence only when feedback is on for this assessment (`feedbackLevel !== 'none'`, `MyResults.tsx:176`). Otherwise show only the "ask your organisation" sentence.
- No retake promise. The platform has no retake rule to quote. See D.

**Certificate rule line**

Today (live): "You earn a certificate when your score is 70% or more. Your organisation releases the result first."

- After Z-16, Option 1 (short): "You earn a certificate when you pass."
- After Z-16, Option 2 (full): "You earn a certificate every time you pass. The pass mark for this assessment is {passMark}%."
- Under today's rule, if the pass mark is under 70: "You passed, but a certificate needs a score of {certMin}% or more." [pending Z-16; drop this line when Z-16 ships]
- Where it shows: result page (fail case and the pass-without-certificate case), Certificates empty state (`MyCertificates.tsx:146`), result email.

**Certificates empty state** (Z-15d fixes "Complete an assessment to earn your first certificate.")

- Option 1: "You have no certificates yet. You earn one each time you pass an assessment." [pending Z-16]
- Option 2: "No certificates yet. Pass an assessment to earn one. The pass mark is set for each assessment." [pending Z-16]

### B.3 Results list row (compact card)

Space is small. One line under the chip. No next-step paragraph.

| State | Chip | One line (option 1) | One line (option 2) |
| --- | --- | --- | --- |
| Passed, certificate | Passed (success) | "Passed. Certificate ready." | "You passed. View your certificate." |
| Passed, no certificate | Passed (success) | "Passed." | "You passed." |
| Not passed | Not passed (warning) | "Not passed. Pass mark {passMark}%." | "Below the pass mark of {passMark}%." |

All three: [pending Z-16] for the `{passMark}` number and for the certificate wording.

The row keeps the left accent bar in the state colour. The existing "New" chip stays.

### B.4 Result-released email

**Subject**

- Passed, option 1: "You passed {assessmentName}"
- Passed, option 2: "Your result for {assessmentName}: passed"
- Not passed, option 1: "Your result for {assessmentName} is ready"
- Not passed, option 2: "Your result for {assessmentName}"
- Reason: a pass subject that says "passed" is fine. A fail subject stays neutral so the student reads it in private.

**Lede (replaces "{tenantName} has released your result for {assessmentName}.")**

- Passed, option 1: "Congratulations, {candidateName}. You passed {assessmentName}."
- Passed, option 2: "Well done, {candidateName}. {tenantName} has released your result. You passed."
- Not passed, option 1: "Hi {candidateName}. {tenantName} has released your result for {assessmentName}. You did not pass this time."
- Not passed, option 2: "Hi {candidateName}. Your result for {assessmentName} is ready. You did not reach the pass mark."

**Result block (table, colour per B.1)**

| Row | Passed | Not passed |
| --- | --- | --- |
| Result | "Passed" + check glyph | "Not passed" + dash glyph |
| Score | "{earned} / {max}" | "{earned} / {max}" |
| Pass mark | "{passMark}%" [pending Z-16] | "{passMark}%" [pending Z-16] |
| Assessment | name | name |
| Organisation | name (was "Company") | name |

Order: Result first, then Score. Today the order is Assessment, Company, Score, Result. The outcome must come first.

**Next step (one line under the button)**

- Passed with certificate: "Your certificate is ready. Select the second link to view it."
- Passed without certificate: "Your result and details are on your Results page."
- Not passed, option 1: "Sign in to see your feedback. Ask your organisation if you can take it again."
- Not passed, option 2: "Sign in to see where to improve."

**Certificate rule line (email footer of the block)**

- Option 1: "You earn a certificate when you pass." [pending Z-16]
- Option 2: "You earn a certificate when you pass. The pass mark is {passMark}%." [pending Z-16]
- Show it only when there is no certificate link.

**Button label**: keep "View your result". Z-15a (one-time sign-in link in the email) is a separate flow change and is not part of this copy row.

Raw-percent check: the email shows the total percent today (`scoreText` has "(60%)" at `result-released.ts:122`). Option: drop the percent and show "{earned} / {max}" only. See D.

---

## C. Z-10 - email review table

Scope: every template file (13) and the one email that does not exist (certificate). Quotes use the `.txt` file and line number. Subject is line 1 of each `.txt`.

Checks used:

- Glossary: organisation, assessment, attempt, submit, grade/score, release, key point. No company, test, exam, evaluate, token, magic link.
- STE: max 20 words per instruction, active voice, one word per meaning, no idiom.
- Sender: "has a caller" = a non-test `.ts` file outside `render.ts`/`types.ts` that sends the template.

### C.1 Findings that apply to many rows

- **F1 "Company" label** (Z-15c). `render.ts:194,200,207,212` builds a meta row `k: 'Company'` for invitation_candidate, invitation_reminder, invitation_admin, attempt_graded_candidate, result_released. The glossary bans "company". Change the label to "Organisation" in the one `buildMetaRows` function. Fix once, five emails change.
- **F2 Template with no sender.** Four templates have a `.txt`, `.html`, strings and a render case but no code that sends them: `attempt_submitted_candidate`, `attempt_graded_candidate`, `attempt_ready_for_review_admin`, `weekly_digest_admin`. This is the same pattern as the 2026-10 `totp_enrolled` incident (RCA_LOG, "had the template but no sender"). No lint catches it: `lint:ui-api-contract` covers routes, not emails. Proposed check: a test that every `EmailTemplateName` in `types.ts` has at least one call site, with a short allow-list for templates the owner chose to keep unsent.
- **F3 Sign-off differs.** All use "— The AssessIQ team". `candidate_login_link` uses "Thanks, / The AssessIQ team". Use one sign-off.
- **F4 Greeting differs.** Some use "Hi {name},", admin ones use "Hello,". Use "Hi {name}," when a name exists, else "Hello,".
- **F5 "link" for sign-in.** Allowed words: "sign-in link". Never "magic link" or "token". No violation found in the templates.
- **F6 Fallback name.** `result-released.ts:119` falls back to "there": "Hi there,". Acceptable. Keep.
- **F7 Footer.** All use the legal line. `result_released` footer reason: "You receive this because you completed an AssessIQ assessment." Fine. Check the footer reason on the unsent ones before they go live.

### C.2 Review table

| # | Email | Trigger | Current subject | Current key lines (file:line) | Issues vs glossary / STE | Proposed fix |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | invitation_candidate | Admin invites a candidate (`legacy-shims.ts`, invitation routes) | "You have been invited to take {{assessmentName}} on AssessIQ" | `invitation_candidate.txt:5` "You have been invited to take {{assessmentName}} on {{tenantName}}." `:10` "This invitation expires on {{expiresAt}}." | Passive voice (2 lines). Meta label "Company" (F1). "on {{tenantName}}" reads as a site. Subject has "on AssessIQ" and no organisation. | Subject: "{tenantName} invites you to take {assessmentName}". Line 5: "{tenantName} invites you to take {assessmentName}." Line 10: "Start before {expiresAt}. After that the invitation stops working." Label "Organisation". |
| 2 | invitation_reminder | Sweep, module 05 `sweepInvitationReminders` calls `invitation-reminder.ts:26` (no AI call) | "Reminder: your {{assessmentName}} closes soon" | `invitation_reminder.txt:5` "You have not started {{assessmentName}} on {{tenantName}} yet, and it closes soon." `:10` "Deadline: {{expiresAt}}." `:11` "This link replaces the one in your earlier invitation email." | Subject: "your X closes soon" lacks the noun "assessment". "closes soon" is vague: give the date. Line 5 joins two facts. "Company" label (F1). | Subject: "Reminder: start {assessmentName} before {expiresAt}". Line 5: "You have not started {assessmentName} yet." Next line: "It closes on {expiresAt}." Keep line 11. |
| 3 | attempt_submitted_candidate | NONE (no sender, F2) | "We received your submission for {{assessmentName}}" | `attempt_submitted_candidate.txt:5` "Your submission for {{assessmentName}} on {{tenantName}} was received at {{submittedAt}}." `:7` "You will receive another email when grading is complete." | No sender. Passive. "submission" (glossary: "submit" is the act; use "answers"). Promises a second email, but the real second email is result_released, sent only after release (manual release may take days). Clashes with `AFTER_SUBMIT_TEXT`. | Owner decision first (D1). If kept: Subject "We have your answers for {assessmentName}". Line 5: "We received your answers for {assessmentName} on {submittedAt}." Line 7: "{tenantName} will email you when your result is released." |
| 4 | attempt_graded_candidate | NONE (no sender, F2) | "Your results for {{assessmentName}} are ready" | `attempt_graded_candidate.txt:5` "Your results for {{assessmentName}} on {{tenantName}} are available." `:7` "Review your results:" | No sender. Duplicates result_released (FU-B19 compare doc). "results" plural vs "result" in the live email: two words for one thing. "graded" in the name, but a graded attempt is not yet released: sending it would reveal a result before the organisation releases it (breaks owner rule P1). "Company" label (F1). | Recommend delete (D2). If kept it must fire only on release and then it IS result_released. |
| 5 | result_released | Release (manual, release-all, worker sweep) via `result-released.ts:115` | "Your result for {{assessmentName}} is ready" | `result_released.txt:5` "{{tenantName}} has released your result for {{assessmentName}}." `:7` "Score: {{scoreText}}" `:8` "Result: {{resultText}}" `:10` "View your result:" `:14` "View your certificate:" `result_released.html:11` lede; `render.ts:205-210` rows | "Company" label (F1, Z-15c). No colour, no congratulation, no next step, no certificate rule (Z-9, Z-15c). `scoreText` prints a percent. Outcome row is last. Button opens the sign-in page (Z-15a). | Full text in section B.4. |
| 6 | candidate_login_link | Candidate asks for a sign-in link, `apps/api/src/routes/auth/candidate.ts:97` | "Your AssessIQ sign-in link" | `candidate_login_link.txt:5` "You asked for a sign-in link to your AssessIQ account. Select the link below to sign in. You do not need a password." `:9` "This link works for the next {{expires_minutes}} minutes. After that, it stops working and you must request a new one." `:11` "...Nobody can sign in to your account without clicking the link in this email." `:13` "Thanks," | Line 11 is 27 words. Sign-off differs (F3). Line 9 can be shorter. No policy violation on "link". | Line 9: "This link works for {expires_minutes} minutes. After that, request a new one." Line 11: "If you did not ask for this link, ignore this email. Nobody can sign in without it." Sign-off per F3. |
| 7 | invitation_admin | Admin or platform admin invites an admin (`legacy-shims.ts`; call site ~line 581) | "You have been invited to join AssessIQ as {{role}}" | `invitation_admin.txt:5` "You have been invited to join AssessIQ{{#if tenantName}} at {{tenantName}}{{/if}} as {{role}}." `:10` "This link expires in {{expiresInDays}} days." | Passive. "Company" label (F1). `{{role}}` may print a code value such as `admin`; show a plain label. Candidate invite shows a date, admin invite shows days: two styles. | Subject: "{tenantName} invites you to AssessIQ as {roleLabel}". Line 5: "{tenantName} invites you to join AssessIQ as {roleLabel}." Line 10: "Accept before {expiresAt}." Label "Organisation". Check `{role}` is mapped to a label. |
| 8 | admin_email_otp | Admin sign-in by email code, `modules/01-auth/src/email-otp.ts:305` | "Your AssessIQ sign-in code" | `admin_email_otp.txt:3` "Your AssessIQ sign-in code is: {{code}}" `:5` "This code expires in {{expires_minutes}} minutes." `:7` "If you did not request this code, you can ignore this email. No action is needed." | Line 7 says the same thing twice. Otherwise clean. Security-adjacent: copy only, no logic change. | Line 7: "If you did not ask for this code, ignore this email." |
| 9 | totp_enrolled | Admin confirms two-factor setup, `totp-enrolled.ts` (sent from `POST /api/auth/totp/enroll/confirm`) | "Two-factor authentication is now on for your AssessIQ account" | `totp_enrolled.txt:5` "Two-factor authentication was turned on for your AssessIQ account{{#if tenantName}} at {{tenantName}}{{/if}} on {{enrolledAt}}." `:7` "If you did not do this, contact your administrator at once." | Passive. "at once" is idiom; `totp_reset_notice` says "now": two phrases for one meaning. Page title says "enrolled", copy says "turned on": two words. Admins may have no other administrator to contact. | Line 5: "You turned on two-factor authentication for your AssessIQ account on {enrolledAt}." Line 7: "If this was not you, contact your administrator now." Use "turned on" everywhere (also `en.json:65`). |
| 10 | totp_reset_notice | Admin resets another admin's two-factor, `totp-reset-notice.ts` | "Your two-factor sign-in was reset" | `totp_reset_notice.txt:5` "Your two-factor sign-in for AssessIQ was reset by {{resetBy}} on {{resetAt}}." `:7` "Next step: sign in as usual. AssessIQ asks you to set up two-factor again." `:9` `{{_t_security_warning}}` = "If you did not ask for this, contact your administrator now." (`en.json:74`) | Passive in line 5. "two-factor sign-in" vs "two-factor authentication" in row 9: two names. Line 7 has two instructions. | Line 5: "{resetBy} reset your two-factor authentication on {resetAt}." Line 7: "Sign in as usual. AssessIQ will ask you to set up two-factor authentication again." |
| 11 | attempt_ready_for_review_admin | NONE (no sender, F2) | "{{candidateName}} completed {{assessmentName}} and is ready for review" | `attempt_ready_for_review_admin.txt:5` "{{candidateName}} completed {{assessmentName}} at {{tenantName}}." `:7` "Reference: {{attemptId}}" `:9` "Review the attempt:" | No sender. "completed" vs "submitted" (glossary). "review" vs "grading": the reviewer role was removed (RV60); the admin grades, then releases. Raw attempt UUID shown. | Owner decision (D1). If kept: Subject "{candidateName} submitted {assessmentName}". Line 5: "{candidateName} submitted {assessmentName}. It is ready for grading." Button "Open attempt". Drop the UUID or move it to small print. |
| 12 | evaluation_queue_alert | Sweep finds attempts waiting over 24 h, `evaluation-queue-alert.ts:42` | "Grading queue: {{count}} waiting more than 24 hours" | `evaluation_queue_alert.txt:5` "{{count}} attempt(s) have waited more than 24 hours for grading. The oldest has waited {{oldestAgeHours}} hours." `:7` "Open the grading queue:" | "attempt(s)" is not plain. "have waited ... has waited" repeats. Table row "Waiting ... over 24 hours" is clipped English. Check that this alert is an email only and never starts a grade (Rule #1). | Subject: "{count} attempts wait for grading for over 24 hours". Line 5: "{count} attempts have waited over 24 hours for grading. The oldest waited {oldestAgeHours} hours." Handle count = 1 ("1 attempt has"). |
| 13 | weekly_digest_admin | NONE (no sender, F2) | "Your weekly AssessIQ summary for {{tenantName}}, week ending {{weekEnding}}" | `weekly_digest_admin.txt:8` "Total attempts: {{totalAttempts}}" `:9` "Completed:" `:11` "Pending review:" `:13` "View dashboard:" | No sender. "Completed" and "Pending review" do not match the glossary (use "Submitted" and "Awaiting grading"). Subject is long (over 60 chars before the name). | Owner decision (D1). If kept: Subject "Weekly summary for {tenantName}". Rows: "Attempts", "Submitted", "Graded this week", "Awaiting grading". Button "Open dashboard". |
| 14 | certificate (does not exist) | n/a | n/a | No template. Z-10 lists a certificate email. The certificate link only appears inside result_released (`result_released.txt:14`). | Gap, not a defect. | Owner decision (D3): keep the link in the result email (proposed; one email per release), or add a separate certificate email. |

### C.3 Flow check (right mail at the right time)

| Step | Mail today | Gap |
| --- | --- | --- |
| Admin invites candidate | invitation_candidate | none |
| Candidate has not started, deadline near | invitation_reminder (sweep) | subject wording (row 2) |
| Candidate asks to sign in | candidate_login_link | none |
| Candidate submits | none (page says "Your result will be emailed...") | row 3: confirm that no mail is wanted |
| Admin has attempts to grade | none; evaluation_queue_alert after 24 h only | row 11: no immediate notice |
| Admin releases result | result_released (+ update email when a result changes) | Z-9 copy; Z-15a two-step sign-in |
| Weekly admin summary | none | row 13 |

---

## D. Open questions for the owner

1. **Unsent templates.** Send or delete `attempt_submitted_candidate`, `attempt_ready_for_review_admin`, `weekly_digest_admin`? Proposed: delete `attempt_graded_candidate` (it duplicates result_released and risks an early result). Keep the others only if you want those mails. Add the "every template has a sender" test either way.
2. **attempt_graded_candidate.** Delete, or keep as the "result updated" mail? ROADMAP Z-9 says a "result updated" email is live. Confirm which template that is.
3. **Certificate email.** One email (result plus certificate link, proposed) or two?
4. **Raw percent.** Keep "(60%)" beside the total on the result page and in the email, or show "{earned} / {max}" only? Bands never show a percent either way.
5. **Fail tone and retake.** Is "Ask your organisation if you can take it again" acceptable? The platform has no stated retake rule to quote. Do you want a per-assessment retake line later?
6. **Fail colour.** Approve amber plus icon plus words (no red). Approve the two hex values for the email.
7. **Z-16.** Pass mark source and the certificate rule decide every line marked pending Z-16. Also open from Z-16: the Honors rule, and Distinction at 90% or at pass mark + 20. No certificate-tier wording is drafted here for that reason.
8. **Pass mark shown to students.** Show "{passMark}%" on the result and in the email (Z-16 item 3)? Proposed: yes.
9. **Organisation name in subjects.** Put `{tenantName}` in the invitation subject? Proposed: yes. A tenant name could be long or misleading; the name is set by the platform admin.
10. **Admin role label.** What plain label should `invitation_admin` print for each role?
11. **Sign-off.** One sign-off "— The AssessIQ team" for all mail, including the sign-in link mail?
