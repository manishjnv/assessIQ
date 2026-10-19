# Wording drafts: SP11, Z-37 (b), Z-15 (a) design, Z-15 (c), Z-15 (d)

**Summary**

- This file holds draft copy for five items: an admin ETA notice (SP11), email wording fixes (Z-37 b), a one-time sign-in link design (Z-15 a), result email copy (Z-15 c) and the empty certificates text (Z-15 d).
- Every string has a stable key. Code is not changed. Owner approves each string before the builder uses it.
- Strings that depend on the pass-mark rule (ROADMAP Z-16) are marked **[pending Z-16]**.

**Old task or feature checked:** SP11 (ROADMAP, live 2026-10-01, admin ETA not yet shown), Z-37 (b) (email wording, C.2 table of `docs/design/2026-10-18-result-and-email-copy.md`), Z-15 (a) to (d) (ROADMAP row Z-15). The result copy draft (`docs/design/2026-10-18-result-and-email-copy.md`, sections B.4 and C.2) is the base for items 2 and 4.

**Status:** DRAFT. No file changed. Nothing goes live.

---

## 1. SP11: company ETA notice (admin)

**Need.** The ROADMAP SP11 row says the tenant-facing ETA is only in the candidate message. An organisation admin needs the same ETA while results are not released.

**Where it shows (proposed).** Admin assessment page, in the release block for an assessment that has submitted attempts and no released result. Builder confirms the exact place (`modules/10-admin-dashboard/src/pages/assessment-detail/ReleaseResendBlock.tsx`).

**Variable.** `{turnaround}` comes from `EVALUATION_TURNAROUND_TEXT` (`modules/00-core/src/config.ts:130`). Default: `within 72 hours`.

```text
key: admin.eta.notice.title
Results are not released yet.
```

```text
key: admin.eta.notice.body
Expect grading {turnaround}. Results stay hidden until you release them.
```

```text
key: admin.eta.notice.short
Grading: {turnaround}.
```

Use `short` in a narrow place such as a table row. Use `title` and `body` in the release block.

---

## 2. Z-37 (b): wording of the other templates

**Scope.** The ROADMAP row says "wording of the other templates from the C.2 review table is untouched". This section gives the new wording for rows 2, 7, 8, 9, 10 and 12. Files are in `modules/13-notifications/src/email/templates/`. Line numbers come from the C.2 table.

Every template has a `.txt` and an `.html`. Change both, then update the snapshot in `modules/13-notifications/src/__tests__/__snapshots__/notifications.test.ts.snap`.

### 2.1 invitation_reminder (C.2 row 2)

```text
key: email.invitation_reminder.subject
Reminder: start {{assessmentName}} before {{expiresAt}}
```

```text
key: email.invitation_reminder.line_started   (replaces line 5)
You have not started {{assessmentName}} yet.
```

```text
key: email.invitation_reminder.line_closes    (replaces line 10 "Deadline: ...")
It closes on {{expiresAt}}.
```

Line 11 stays: "This link replaces the one in your earlier invitation email."

### 2.2 invitation_admin (C.2 row 7)

```text
key: email.invitation_admin.subject
{{tenantName}} invites you to AssessIQ as {{roleLabel}}
```

```text
key: email.invitation_admin.line_invite   (replaces line 5)
{{tenantName}} invites you to join AssessIQ as {{roleLabel}}.
```

```text
key: email.invitation_admin.line_expiry   (replaces line 10)
Accept within {{expiresInDays}} days.
```

**Builder note.** `{{roleLabel}}` is a new variable. The sender must map the role code (for example `admin`) to a plain label. This is a code change in the sender, not only copy. The `expiresInDays` variable already exists, so no new date variable is needed.

### 2.3 admin_email_otp (C.2 row 8)

```text
key: email.admin_email_otp.line_ignore   (replaces line 7)
If you did not ask for this code, ignore this email.
```

### 2.4 totp_enrolled (C.2 row 9)

```text
key: email.totp_enrolled.subject
You turned on two-factor authentication
```

```text
key: email.totp_enrolled.line_turned_on   (replaces line 5)
You turned on two-factor authentication for your AssessIQ account{{#if tenantName}} at {{tenantName}}{{/if}} on {{enrolledAt}}.
```

```text
key: email.totp_enrolled.line_not_you   (replaces line 7)
If this was not you, contact your administrator now.
```

Also change `en.json` (around line 65) so it says "turned on", not "now on".

**Note.** The subject change is not in the C.2 draft. The draft asked for "turned on" everywhere, so the subject follows that rule.

### 2.5 totp_reset_notice (C.2 row 10)

```text
key: email.totp_reset_notice.line_reset   (replaces line 5)
{{resetBy}} reset your two-factor authentication on {{resetAt}}.
```

```text
key: email.totp_reset_notice.line_next   (replaces line 7)
Sign in as usual. AssessIQ will ask you to set up two-factor authentication again.
```

The security warning (`en.json:74`) stays as it is: "If you did not ask for this, contact your administrator now."

### 2.6 evaluation_queue_alert (C.2 row 12)

**Change from the C.2 draft.** The draft used "attempt(s)" and "1 attempt has". That needs a plural rule in the template. This draft avoids the plural. The count stays a number.

```text
key: email.evaluation_queue_alert.subject
Grading queue: {{count}} waiting over 24 hours
```

```text
key: email.evaluation_queue_alert.line_count   (replaces line 5)
Attempts waiting over 24 hours for grading: {{count}}. The oldest has waited {{oldestAgeHours}} hours.
```

---

## 3. Z-15 (a): one-time sign-in link in the result email (DESIGN NOTE, not code)

**Goal.** A student taps "View your result" and reaches the result in one step, with no second email and no second sign-in form.

**Existing pattern.** Candidate magic-link login (`docs/04-auth-flows.md` Flow 6; `PROJECT_BRAIN.md` decision of 2026-05-13). The verify step is a POST, sent from the app page after the page loads. A GET never changes state, because mail scanners open links before the student does.

**Facts from the code.**

- The login link lives 15 minutes (`modules/01-auth/src/candidate-login.ts:37`).
- The candidate session lives 30 days (`candidate-login.ts:38`).
- The result email link today points to `/candidate/login?tenant=<slug>` (`modules/13-notifications/src/email/result-released.ts`), which is why the student enters the email again.

### Flow (numbered)

1. The owner releases a result. The release sends `result_released`. The email holds a one-time link to the app page, with the token in the URL fragment (after `#`). The fragment is not sent to the server in the page request.
2. The student taps "View your result". The browser loads the app page. This load does not change any data.
3. The app page reads the token from the fragment. It sends one POST to the server with the token. It does not send the token in any other request.
4. The server computes a SHA-256 hash of the token. It finds the stored row by hash. It checks that the row is unused, not expired, and bound to a released attempt of this student.
5. In one transaction, the server marks the row as used and creates a candidate session (30 days, same as today).
6. The app page opens the result for that attempt.
7. If the student taps the link again, the server refuses the token. The app shows the "already used" screen.
8. If the token is older than 30 days, the app shows the "expired" screen.

### Security properties

- The token is random, at least 256 bits, from a secure random source.
- Only the SHA-256 hash of the token is stored. The plain token is never stored or logged.
- Single use: one atomic update sets `used_at` only where `used_at` is empty.
- Expiry: 30 days from release. The status of the attempt is checked again at POST time, so a withdrawn or unreleased result refuses the link.
- Bound to one attempt and one student. The link does not open other attempts.
- Rate limit on the POST, per IP and per email, fails closed (same idiom as the candidate login).
- No enumeration: an unknown, used and expired token get the same server response shape, with the same timing floor (200 ms).
- The page sends `Referrer-Policy: no-referrer` so the token does not leak to other sites.
- All reads and writes run inside tenant scope (RLS).

### Failure screens (student sees these words)

- **Expired**
  - Title: "This sign-in link has expired."
  - Body: "Sign-in links stop working after 30 days. Request a new link to see your result."
  - Button: "Request a new link"
- **Already used**
  - Title: "This sign-in link was already used."
  - Body: "Each sign-in link works once. Sign in with your email to open your result."
  - Button: "Sign in"
- **Not valid** (unknown or changed token)
  - Title: "This sign-in link is not valid."
  - Body: "Open the newest email from your organisation. Or sign in with your email."
  - Button: "Sign in"

Words that must not appear in any student screen: "magic link", "token".

### Open questions for the owner

1. Validity: 30 days (as drafted) or shorter, for example 7 days? A 30-day link opened from a forwarded email gives access for 30 days.
2. Fragment or path: the fragment keeps the token out of server logs. The invitation link uses a path. Confirm that the fragment is acceptable.
3. Should the link open all results of the student, or only the one in the email? Draft: only that attempt.
4. If the owner withdraws the result after the email, the link must stop working at once (the POST check covers it). Confirm.
5. Keep "pre-fill the email" as a fallback if the link is not built? The ROADMAP row allows either.

---

## 4. Z-15 (c): result email copy

### 4.1 Colour (brand tokens)

Source: `modules/17-ui-system/src/styles/tokens.css` (lines 34 and 35 show warning values). Email hex: `docs/13-email-system.md` § 1.1.

| State | Result row left bar | Soft fill | Text |
| --- | --- | --- | --- |
| Passed | `#007834` (`--aiq-color-success`) | `--aiq-color-success-soft`: builder resolves the hex from `tokens.css`; it is not yet in the `docs/13` table | `#0a0a0b` |
| Not passed | `#df911a` (`--aiq-color-warning`) | `#fff1d9` (`--aiq-color-warning-soft`) | `#0a0a0b` |

Rules:

- Never red. A fail is not an error.
- The state is in words and in a glyph too, not in colour alone.
- Some mail apps strip background colour. The 4 px left border carries the state on its own.

### 4.2 Pass variant

```text
key: email.result.pass.subject
Your result for {{assessmentName}}: passed
```

```text
key: email.result.pass.preheader
Well done. Open your result for {{assessmentName}}.
```

```text
key: email.result.pass.lede
Well done, {{candidateName}}. {{tenantName}} has released your result. You passed.
```

Without a name, use: `Well done. {{tenantName}} has released your result. You passed.`

```text
key: email.result.pass.result_value
Passed ✓
```

```text
key: email.result.pass.next_with_certificate
Your certificate is ready. Select View your certificate to open it.
```

```text
key: email.result.pass.next_without_certificate
Your result and details are on your Results page.
```

```text
key: email.result.pass.cta
View your result
```

```text
key: email.result.pass.cert_rule  (shown only when there is no certificate link)
You earn a certificate when you pass. [pending Z-16]
```

### 4.3 Not-passed variant

```text
key: email.result.notpassed.subject
Your result for {{assessmentName}}
```

```text
key: email.result.notpassed.preheader
Your result for {{assessmentName}} is ready.
```

```text
key: email.result.notpassed.lede
Hi {{candidateName}}. Your result for {{assessmentName}} is ready. You did not reach the pass mark this time.
```

Without a name, the greeting becomes `Hello,`.

```text
key: email.result.notpassed.result_value
Not passed –
```

```text
key: email.result.notpassed.next
Sign in to see where to improve.
```

```text
key: email.result.notpassed.cta
View your result
```

### 4.4 Shared result rows

Labels and order (the outcome row first):

- `Result` (value: `Passed ✓` or `Not passed –`)
- `Score` (value: `{{earned}} / {{max}}`)
- `Pass mark` (value: `{{passMarkPct}}%`) **[pending Z-16]**
- `Assessment` (value: `{{assessmentName}}`)
- `Organisation` (value: `{{tenantName}}`)

**Label change.** "Company" becomes "Organisation". The code change is already live (ROADMAP Z-37, S17, commit 67e5db5). Keep the label.

---

## 5. Z-15 (d): empty certificates text (candidate Certificates page)

**Where it shows.** The candidate Certificates page, when the student has no certificate. Current code: `modules/11-candidate-ui/src/components/MyCertificates.tsx:146`, text from `modules/11-candidate-ui/src/copy.ts` (`CERTIFICATES_EMPTY_TEXT`).

```text
key: candidate.certificates.empty.title
No certificates yet.
```

```text
key: candidate.certificates.empty.body
You earn one each time you pass an assessment. [pending Z-16]
```

```text
key: candidate.certificates.empty.button   (optional)
View your results
```

The button links to the Results page. It is optional. Remove it if the owner wants a text-only empty state.

**Finding.** The live text in `copy.ts` already reads "No certificates yet. Pass an assessment to earn one. The pass mark is set for each assessment." This differs from the ROADMAP Z-15 (d) row, which asks for the 70% rule. The 70% rule is now out of date: `copy.ts` has a Z-16 comment ("a certificate follows every pass"). Owner: confirm which rule the empty state should state, and whether Z-16 is built.

---

## Findings and owner decisions

- Item 1: the placement in the release block is a proposal. The builder confirms it.
- Item 2: `{{roleLabel}}` needs a sender change. Everything else is copy.
- Item 3: the design is not built. Five open questions in section 3.
- Item 4: the pass subject and the pass copy use the plain wording the owner chose on 2026-10-17 (ROADMAP Z-9, `docs/design/2026-10-18-result-and-email-copy.md` section 0).
- Item 5: the live text already changed. Owner confirms the rule (see the finding in section 5).
- No string in this file uses "magic link" or "token" for the student.
