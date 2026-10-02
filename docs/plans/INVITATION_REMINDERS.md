# Automatic invitation reminders (2026-10-02)

## What changed
- `settings.reminders = { enabled, hours_before? }` per assessment (strict, 1-168 h, default 24 when enabled). **Default OFF.**
- Worker job `invitation.reminders`, every 30 min (apps/api `jobs/invitation-reminders.ts`, wired in `worker.ts`): sends ONE "closes soon" email per un-started invitation. Logic in `modules/05-assessment-lifecycle/src/reminders.ts`.
- Migration `0134_invitation_reminded_at.sql` (05): `assessment_invitations.reminded_at`. Migration `0135_seed_reminders_help.sql` (16): help key `admin.assessment.reminders`.
- Email template `invitation_reminder` (13), subject `Reminder: your <assessment> closes soon`, bulk lane.
- API: `PATCH /api/admin/assessments/:id/reminders` body `{ enabled: boolean, hours_before?: 1..168 }` (strict; any status; audited as `assessment.updated`; returns the assessment). `GET .../invitations` rows now include `reminded_at`.
- Admin UI: "Reminders" card on the assessment detail page; "Reminder sent <time>" on invitation rows.

## Why
- **Default OFF**: Brevo free plan is 300 emails/day shared with other products; a reminder is the lowest-value mail. Opt-in per assessment, plus a hard platform cap of 100 reminders per trailing 24 h and 25 per tick.
- **Link rotation, not reuse**: only sha256(token) is stored, so the original link cannot be re-sent. The claim rotates `token_hash` like a resend but never changes `expires_at`; the email says the link replaces the earlier one.
- **Claim by UPDATE ... WHERE reminded_at IS NULL**: two ticks / workers cannot double-send. An email failure clears the claim for retry.
- **6 h grace** after the last invite/resend email so a fresh invite is not followed by an instant reminder when the deadline is already near.

## Considered and rejected
- Reusing the invite token (impossible: hash only). A separate long-lived reminder token (more attack surface). Reminders at multiple offsets (one is enough; more mail against the cap). Per-tenant caps (YAGNI). A BullMQ delayed job per invitation (state in Redis, lost on edits; a sweep over the DB is idempotent and survives deploys).

## Not included
Revoked or lapsed links are never reminded (admin must resend). No reminder for started/submitted candidates. No per-tenant opt-out beyond the per-assessment toggle.

## Downstream
Resend / re-invite reset `reminded_at` (`repository.reissueInvitation`), so the fresh 7-day link may earn one new reminder. `email_log` records each reminder like any email.

## Verify / rollback
- Tests: `modules/05-assessment-lifecycle/src/__tests__/invitation-reminders.test.ts`, 13 template + delivery-class tests, `modules/10-admin-dashboard/src/__tests__/reminders-card.test.tsx`.
- Live: enable on a test assessment with `closes_at` within 24 h, wait one tick, check `reminded_at` and the email.
- Rollback: untick the toggle (sweep ignores the assessment); remove the job registration in `worker.ts`. The column is additive and harmless to leave.
