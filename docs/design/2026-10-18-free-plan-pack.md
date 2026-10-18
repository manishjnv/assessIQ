# Free trial plan pack (Z-70)

**Date:** 2026-10-18. **Status:** proposal for owner approval. This file has no code. Nothing here is built.
**Source:** owner review sheet, Q3 (organisations sign up alone, free sample quiz, 5 students, all features with limits).
**Old task or feature checked:** PRICING_TIERS 2026-10-06 (Starter tier, 25-credit trial), module 19-billing (`TIER_LIMITS`, `tierAllows`), `PLAN_TIERS_ENFORCED`, ROADMAP X2, Z-18, Z-71.

## Summary

- A new organisation signs up alone and gets a **Trial** plan for 14 days.
- The Trial has one sample question set, for one subject that the organisation picks.
- The organisation can test **5 candidates in total**.
- Almost all features work. Each has a limit.
- AI grading is OFF. The sample set uses only questions that the system can mark by itself.
- When the trial ends, the organisation chooses: contact us to upgrade, or the data is deleted.

## What the old decisions say (kept)

- The Starter tier is stored as `free` in the database. The public name is **Starter**.
- The owner decided on 2026-10-03: keep the 25-credit `free` trial. One credit pays for one graded attempt.
- The owner rule says: do not call the product "free". This proposal uses the public name **Trial**.
- Plan limits only act when `PLAN_TIERS_ENFORCED=true`. It is `false` on the VPS today (ROADMAP Z-18). The Trial plan needs the flag ON, or the limits do nothing.
- Tenants never write questions. Platform staff own the question sets. The Trial uses a copy of a platform set (the existing single-set entitlement).

## Limits

| Item | Trial limit | Why |
|---|---|---|
| Length | 14 days from the first sign-in | Short, so that unused accounts end. |
| Organisations for each sign-up | 1 | Stops the same person from making many. |
| Admins | up to 3 | Enough for a small team to try it. |
| Candidates in total | 5 | Owner wish (Q3). Counts every invited candidate. |
| Attempts for each candidate | 1 | 5 candidates then use 5 of the 25 credits. |
| Credits | 25, hard stop | Same as the 2026-10-03 decision. |
| Question set | 1 sample set, 1 subject, fixed after sign-up | Owner wish (Q3). The subject can change once, by support. |
| Question types | Only types that the system marks by itself (choice, number, ordering) | AI grading stays OFF. |
| AI grading | 0 answers. OFF | The AI legal question (Q7) has no answer yet. |
| Result release | Yes, manual or auto | The owner wants a full try. |
| Certificates | Yes, with the word "Trial" on the certificate | Owner draft. A pass still shows the full flow. |
| Cohort report | Basic report | Same as Starter. |
| Data export (CSV, API) | No | Stops copying of data. The trial has 5 people only. |
| Webhooks, API keys, embed, audit viewer, own email sender | Visible but locked, with a "Contact us" note | These are Growth and Enterprise features in the tier table. |
| Support | Email | Same as Starter. |
| After the trial ends | Read-only for 7 days, then all data is deleted | Short data life under DPDP. |

## Abuse controls

1. **Email check.** The first admin must confirm the email address with the sign-in code.
2. **One trial for each email domain.** Public mail domains (for example gmail.com) get one trial for each address instead.
3. **Bot check.** A bot check (for example Cloudflare Turnstile) sits on the sign-up form.
4. **Rate limit.** Sign-up has an IP rate limit. It uses the same rule as other public routes.
5. **No email blast.** The trial can send invites to 5 addresses only.
6. **Auto-delete.** A job ends the trial on the expiry day and deletes the data after 7 days. The job must write an audit row.
7. **Block list.** Super admin can block a domain.
8. **Terms tick-box.** The sign-up asks the admin to accept the terms and the data processing addendum (see Z-72).

## What stays out

- Real candidate data from a school or company is not the aim of the trial. The sign-up page says: use test people.
- Your own questions (tenants never write questions).
- AI grading, AI question generation, AI reports.
- Payments. Upgrade is by "Contact us" until the owner picks a provider (Q2).
- Single-person (B2C) sign-up. Q3 covers organisations only.
- Public prices (Q1: keep "Contact us").

## Entitlement keys and settings needed

These are names for the build (Z-71). The new keys do not exist yet. Credits, the AI override column and the single-set entitlement exist today.

| Key | Type | Value for Trial |
|---|---|---|
| `plan.name` | text | `trial` (new value or a flag on `free`; the build decides) |
| `trial_ends_at` | date | sign-up date + 14 days |
| `max_admins` | number | 3 |
| `max_candidates_total` | number | 5 |
| `max_attempts_per_candidate` | number | 1 |
| `included_credits` | number | 25 (exists) |
| `ai_answers_included_override` | number | 0 (column exists) |
| `ai_grading_allowed` | yes/no | no |
| `export_allowed` | yes/no | no |
| `certificate_label` | text | `Trial` |
| `question_set_entitlement` | one set | the chosen sample set (exists as a single-set entitlement) |
| `delete_after` | date | trial end + 7 days |

The database allows the tier values `free`, `pro`, `enterprise` and `internal`. A new `trial` value needs a migration. A flag on `free` does not. The build design decides.

## Risks

| Risk | Effect | Answer |
|---|---|---|
| Sign-up creates tenants and first admins (load-bearing, security) | A bug can leak data across tenants | Design review, then one adversarial gate before the push (Z-71). |
| Limits do nothing while `PLAN_TIERS_ENFORCED=false` | Trial users get all features without limits | Flip the flag first (Z-18), or enforce trial limits separately. |
| Fake organisations send mail | Brevo reputation, spam | Email check, 5 invites, bot check, rate limit. |
| Personal data in a free trial with no contract | DPDP duties without a signed order | Tick-box addendum (Z-72); test people only; auto-delete. |
| Real students enter the trial | Liability | The start screen names the organisation. The sign-up page says: test people only. |
| Auto-delete removes data too early or too late | Complaints or DPDP breach | Show the date in the admin screen; send two warning emails. |
| Trial users expect AI grading | Disappointment | Say clearly: AI grading is a paid, staff-run service. |

## Owner questions

1. **Name.** The database calls this tier `free`; your rule is "never call it free". Is **Trial** the public name? (Proposed: yes.)
2. **After the trial.** Is "read-only for 7 days, then delete" right? Or keep the data for 30 days if the organisation asks to upgrade?
3. **Locked features.** Should webhooks, API keys, embed and audit show as locked with "Contact us" (proposed), or be hidden?

Also noted: Q4 says aptitude first, so the proposal offers **aptitude** only as the sample subject at launch.

## Not decided here

- Z-71 (the build) waits for your approval of this file.
- Prices and payment (Q1, Q2) are separate.
- AI grading in the trial waits for Q7.

## Downstream docs when built

`docs/02-data-model.md` (new columns), `docs/03-api-contract.md` (sign-up route), `docs/04-auth-flows.md` (first admin), `modules/19-billing/SKILL.md`, `docs/06-deployment.md` (flag and cleanup job), and help ids for each new screen.
