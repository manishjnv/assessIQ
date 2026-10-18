# Free plan pack (Z-70)

**Date:** 2026-10-18, updated 2026-10-19. **Status:** approved by the owner with changes (Q3, review sheet). Proposal text only. This file has no code. Nothing here is built.
**Source:** owner review sheet Q3, Q5, Q7, Q8 and the owner replies of 2026-10-19: the plan has no end date, there is no auto-delete, the public name is "Free".
**Old task or feature checked:** PRICING_TIERS 2026-10-06 (Starter tier, 25-credit trial), module 19-billing (`TIER_LIMITS`, `tierAllows`), `PLAN_TIERS_ENFORCED`, ROADMAP X2, Z-18, Z-71, Z-72.

## Summary

- A new organisation signs up alone and gets the **Free** plan. The plan has no end date.
- The organisation can test **5 candidates in total**.
- The plan includes sample question sets for the subjects that the organisation picks. The number of subjects is an open question (question 1).
- All features work. Each has a limit.
- Result release works. Certificates work and carry **no** "Trial" mark.
- Data export is off.
- AI grading is on, for a few attempts only. A kill switch can turn it off at once.
- Upgrade is by "Contact us".

## What changed from the first draft

| First draft (S28) | Now (owner) |
|---|---|
| Public name "Trial" | Public name **Free** |
| 14 days, then read-only, then delete | **No end date.** No auto-delete. |
| Certificate says "Trial" | **No mark** on the certificate |
| AI grading off | AI grading **on**, for a few attempts, with a kill switch |
| One trial for each email domain | **Dropped.** The owner did not keep it. |
| One sample set, one subject | Sample sets for chosen subjects (count open) |

## What the old decisions say (kept)

- The Starter tier is stored as `free` in the database. The new public name **Free** fits this value.
- The owner decided on 2026-10-03: keep the 25-credit `free` plan. One credit pays for one graded attempt.
- Plan limits only act when `PLAN_TIERS_ENFORCED=true`. It is `false` on the VPS today (ROADMAP Z-18). The Free plan needs the flag ON, or the limits do nothing.
- Tenants never write questions. Platform staff own the question sets. The Free plan uses copies of platform sets (the existing set entitlement).
- The old memory rule "never call it free" is replaced by this owner decision.

## Limits

| Item | Free limit | Why |
|---|---|---|
| Length | No end date | Owner reply 2026-10-19. |
| Organisations for each sign-up | 1 | Stops the same person from making many. |
| Admins | up to 3 | Enough for a small team. |
| Candidates in total | 5 | Owner wish (Q3). Counts every invited candidate, for ever. |
| Attempts for each candidate | 1 | 5 candidates use 5 credits. |
| Credits | 25, hard stop | Same as the 2026-10-03 decision. |
| Question sets | Sample sets for the chosen subjects. Count to confirm. | Owner wish (Q3). |
| AI grading | A few attempts only. Proposed: 5 in total. Kill switch. | Owner wish. Q7: the business API is for paid contracts only. |
| Result release | Yes, manual or auto | Full try of the flow. |
| Certificates | Yes, no "Trial" mark | Owner decision. |
| Cohort report | Basic report | Same as Starter. |
| Data export (CSV, API) | No | Owner decision. |
| Webhooks, API keys, embed, audit viewer, own email sender | Visible but locked, with a "Contact us" note (proposed) | Growth and Enterprise features. |
| Support | Email | Same as Starter. |
| Upgrade | "Contact us" | Q1 and Q2: no public prices, manual invoices. |

## Abuse controls

1. **Email check.** The first admin must confirm the email address with the sign-in code.
2. **Bot check.** A bot check (for example Cloudflare Turnstile) sits on the sign-up form.
3. **Rate limit.** Sign-up has an IP rate limit. It uses the same rule as other public routes.
4. **Invite limit.** The Free plan can invite 5 candidates in total, so it cannot send a mail blast.
5. **AI kill switch.** Platform staff can turn off AI grading for all Free organisations, or for one. This needs a platform setting and an audit row.
6. **Block list.** Super admin can block a domain.
7. **Terms tick-box.** The sign-up asks the admin to accept the terms and the data processing addendum (see Z-72).
8. **Manual removal.** There is no auto-delete. Platform staff remove an abusive organisation by hand, through the existing tenant lifecycle. This needs no new code.

Dropped by the owner: one trial for each email domain, and auto-delete after expiry.

## What stays out

- Your own questions (tenants never write questions).
- AI question generation and AI reports.
- Payments. Upgrade is by "Contact us" until the owner picks a provider (Q2).
- Single-person (B2C) sign-up. Q3 covers organisations only.
- Public prices (Q1: keep "Contact us").
- API-mode AI grading. It is for paying customers only, later (Q8).

## Entitlement keys and settings needed

These are names for the build (Z-71). The new keys do not exist yet. Credits, the AI override column and the set entitlement exist today.

| Key | Type | Value for Free |
|---|---|---|
| `plan.name` | text | `free` (exists; shown as "Free") |
| `max_admins` | number | 3 |
| `max_candidates_total` | number | 5 |
| `max_attempts_per_candidate` | number | 1 |
| `included_credits` | number | 25 (exists) |
| `ai_answers_included_override` | number | 5 proposed (column exists) |
| `ai_grading_allowed` | yes/no | yes, limited by the override |
| `ai_grading_kill_switch` | platform yes/no | off by default; staff turn it on to stop AI grading |
| `export_allowed` | yes/no | no |
| `certificate_label` | text | none (no mark) |
| `question_set_entitlement` | set list | the chosen sample sets (exists as a set entitlement) |

There is no `trial_ends_at` and no `delete_after`. The database tier `free` already exists, so this plan needs no new tier value.

## Risks

| Risk | Effect | Answer |
|---|---|---|
| Sign-up creates tenants and first admins (load-bearing, security) | A bug can leak data across tenants | Design review, then one adversarial gate before the push (Z-71). |
| Limits do nothing while `PLAN_TIERS_ENFORCED=false` | Free users get all features without limits | Flip the flag first (Z-18), or enforce Free limits separately. |
| Fake organisations send mail | Brevo reputation, spam | Email check, 5 invites in total, bot check, rate limit. |
| Personal data held for ever with no contract | DPDP duties without a signed order | Tick-box addendum (Z-72). The lawyer sets the retention period (Q22). Platform staff can remove an organisation by hand. |
| Real students enter the Free plan | Liability moves to AssessIQ | The organisation is the controller (Z-72). The sign-up page names it. |
| AI grading on a free plan while the legal opinion is open | Legal and cost risk | Few attempts, kill switch. Owner Q7: free use has no legal issue; confirm with the lawyer. |
| Unused Free organisations pile up | Storage grows | Owner chose no auto-delete. Watch the count. Revisit if it grows. |

## Owner questions

1. **Subjects.** What does "5 chosen subjects" mean? Option A: the organisation picks 5 subjects at sign-up. Option B: AssessIQ offers 5 fixed sample sets and the organisation uses them all. Proposed default: B, starting with aptitude (Q4).
2. **AI attempts.** How many AI-graded attempts in total? Proposed: 5.
3. **Locked features.** Should webhooks, API keys, embed and audit show as locked with "Contact us" (proposed), or be hidden?

## Not decided here

- Z-71 (the build) needs a design review and an adversarial gate. See `docs/design/2026-10-18-self-serve-signup-design.md`.
- Prices and payment (Q1, Q2) are separate.
- The retention period for consent records (Q22) is for the lawyer.

## Downstream docs when built

`docs/02-data-model.md` (new columns and the platform setting), `docs/03-api-contract.md` (sign-up route), `docs/04-auth-flows.md` (first admin), `modules/19-billing/SKILL.md`, `docs/06-deployment.md` (flag), and help ids for each new screen.
