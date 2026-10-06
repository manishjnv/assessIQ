# Pricing tiers — definition (FU-A1, 2026-10-06)

Source: `docs/plans/RS6_FEATURE_REVIEW_A.md` § PT1 (c) and (d), as finalized by the
owner decisions recorded there on 2026-10-03. This file is the canonical copy
of the tier table referenced by `docs/PENDING_TASKS_2026-10-01.md` FU-A1 to
FU-A11 and `modules/19-billing/SKILL.md`. All prices are a proposal only and
are not published on the pricing page (owner decision PT1-4).

## Tier names and DB mapping

No schema change. Map the marketing names to the existing `tenant_plans.tier`
column: **Starter** = `free`, **Growth** = `pro`, **Enterprise** = `enterprise`.
`internal` stays for owner-operated tenants. Show the display name in the UI
(FU-A3's display-name map); rename the DB value only if the owner later wants to.

## Tier contents (decided 2026-10-03)

| Row | Starter | Growth | Enterprise | Existing mechanism | Missing (see FU-A2 to FU-A9) |
|---|---|---|---|---|---|
| Included credits | 100 per month (pilot: 25 total) | 1,000 per month | Custom | `included_credits` | **Monthly window live 2026-10-06 (FU-A2):** counts since `cycle_start` + whole months elapsed (derived, `cycle_start` not rolled) |
| Overage | Not allowed after 120% (soft warning before) | Billed per credit | Contract | status `over` | Hard cap option; CSV invoice export exists |
| Question types (MCQ, numeric, sections) | Yes | Yes | Yes | Always on | None |
| Licensed packs | 2 packs | All platform packs | All plus private pack | `tenant_entitlements` | Pack count limit |
| AI-evaluated answers included (per month) | 20 | 500 | Custom (no cap recorded) | **Live 2026-10-06 (FU-A4/FU-A9):** `billing_events` rows `ai_answer_evaluated`, one per accepted AI grading; constant `TIER_AI_ANSWERS_INCLUDED` in 19; plan card shows used / included | Per-tenant override of the included number (contract terms, FU-A7) |
| Bulk invite, reminders | 200 candidates per drive | Unlimited | Unlimited | Live | Per-drive cap |
| Results CSV | Yes | Yes | Yes | Live | None |
| Cohort analytics | Basic | Full | Full | Cohort page | Fix RV14 |
| Certificates | No | Yes | Yes | Module 18 | Tier gate (read `tier`) — FU-A5 |
| Webhooks | No | Yes | Yes | Module 13 | Screen (FR2), tier gate, real events — FU-A5 |
| API keys | No | No | Yes | Module 01 routes | Screen (FR3), tier gate — FU-A5 |
| Embed (iframe) | No | No | Yes | Module 12 | Fix RV43, tier gate (FR4) — FU-A5 |
| Audit viewer and export | No | No | Yes | Write side live | Register routes (FR1) — FU-B1/FU-A5 |
| Own email sender, white-label | No | No | Yes | FR15 pieces, parked | FU-A15 to FU-A18 |
| Support | Email | Priority email | Account manager | Ops | None |

Missing building blocks, in order: (1) monthly credit window (FU-A2); (2) one
`tierAllows(tenantId, feature)` helper in `19-billing` reading `tenant_plans.tier`
(FU-A3); (3) a second meter for AI-evaluated answers (FU-A4/FU-A9); (4) tier-gate
calls at the route of each gated feature (FU-A5); (5) display-name map (FU-A3);
(6) payment flow (FU-A7, Razorpay).

## Owner decisions (2026-10-03, final)

| # | Decision | Decided |
|---|---|---|
| 1 | Tier contents | Use the table above. |
| 2 | Credit meaning | One credit per graded attempt stays. A second meter counts AI evaluation. |
| 3 | Monthly or lifetime credits | Monthly for Growth/Enterprise. Per-drive pack for campus drives. |
| 4 | INR prices | Proposal only, NOT published. Pricing page keeps "contact sales" until the owner checks the market. |
| 5 | Payment provider | Razorpay. Manual invoices and payment links first, subscriptions later. |
| 6 | Terms section 7 | "Renew only by a new order or as your contract states" — done, live (`e11cb5b`). |
| 7 | Trial tier | Keep the 25-credit `free` trial. |

## Not included in this note

Pricing numbers (INR ranges) are intentionally omitted from this file — they
are a proposal in `docs/plans/RS6_FEATURE_REVIEW_A.md` § PT1 (d) #4 only, not
a decided fact, and must not be copied into a customer-facing doc.
