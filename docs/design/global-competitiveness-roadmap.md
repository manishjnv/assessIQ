# Path to Best-in-Class Global Assessment Provider — prioritized roadmap

**Saved:** 2026-05-27. **Status:** strategy / not started.
**Origin:** competitor + 2026-trend research (HackerRank, Mercer Mettl, iMocha, Codility, TestGorilla, SHL, Korn Ferry, Criteria) mapped against AssessIQ's current state (AI grading moat, multi-tenant, certification module, question-difficulty L1/L2/L3, strong marketing SEO, **pre-launch — no real candidate data yet**).

## Legend

**Build automatability** — can Claude Code ship the *substance* without manual/external dependency?
- 🟢 **Claude-buildable** — code / content / docs / SEO. Claude ships a PR end-to-end (still follows commit→deploy→doc→handoff; no external human dependency on the substance).
- 🟡 **Hybrid** — Claude builds the feature, but it only becomes *real* with external input: API keys, partner approval, infra provisioning, SME-validated content, or **real candidate data** (blocked while pre-launch).
- 🔴 **Manual / external** — fundamentally not code: legal, third-party certification audits, PR, community building, analyst relations, pricing/business decisions.

**Priority** — P0 = table-stakes / moat foundation (do first) · P1 = differentiators + reach · P2 = scale, data-dependent, business/external.

---

## P0 — Foundation & table stakes (do first)

| Topic | Auto | Note |
|---|:--:|---|
| AI/LLM-assisted-cheating detection | 🟢 | builds on existing AI pipeline; critical in AI era |
| Plagiarism / code-similarity detection | 🟢 | algorithmic |
| Adaptive testing engine (IRT / CAT) | 🟢 | major differentiator + competitor parity; high effort |
| Competency framework & skill taxonomy | 🟢 | foundation for analytics + skills intelligence; aligns with pack/domain model |
| AI scoring transparency & explainability | 🟢 | extends current answer-guidance / band-anchor moat |
| Open API + webhooks | 🟢 | ecosystem foundation |
| SSO / SCIM provisioning | 🟢 | enterprise table stakes; already have OIDC |
| Accessibility (WCAG 2.2 AA) | 🟢 | global compliance; audit + fix |

## P1 — Differentiators & reach

| Topic | Auto | Note |
|---|:--:|---|
| Conversational / AI-interview assessment | 🟢 | architecture doc already exists (`ai_interview_question_generator_architecture.md`) |
| Novel AI question types + auto-generation at scale | 🟢 | extends typed renderers + question-gen |
| Competency heatmaps / cohort analytics | 🟢 | reporting feature |
| Skills-gap & internal-mobility intelligence | 🟢 | hire→develop→retain (iMocha's positioning) |
| Fairness / adverse-impact reporting | 🟢 | feature buildable; needs data to run live |
| Verifiable digital credentials / Open Badges | 🟢 | extends certification module |
| Multilingual / i18n + hreflang | 🟢 | content + framework work |
| AI-citation-optimized content + comparison depth (GEO) | 🟢 | content (truthful, reviewed) |
| Mobile-first / low-bandwidth assessment UX | 🟢 | responsive optimization |
| White-label / partner-reseller theming | 🟢 | aligns with tenancy model |
| Coding sandbox breadth (40+ langs, IDE) | 🟡 | needs execution infra (Judge0/containers) |
| Live coding / pair-programming | 🟡 | realtime infra (WebRTC/websockets) |
| Multimodal AI proctoring (gaze/audio/screen/ID) | 🟡 | browser monitoring 🟢; biometric ID may need vendor SDK |
| AI bias-audit tooling | 🟡 | tooling 🟢; the independent audit + legal attestation 🔴 |

## P2 — Scale, data-dependent & business/external

| Topic | Auto | Note |
|---|:--:|---|
| Norm groups & percentile benchmarking | 🟡 | engine 🟢; needs real candidate data |
| Predictive hiring-quality correlation | 🟡 | pipeline 🟢; needs real outcome data |
| Validity / reliability studies (criterion + construct) | 🔴 | needs real data + psychometric research |
| Psychometric instrument breadth (validated) | 🟡 | Claude drafts; licensed/SME-validated content required |
| ATS / HRIS marketplace connectors + listings | 🟡 | connectors 🟢; partner API keys + marketplace approval 🔴 |
| LMS integrations | 🟡 | same pattern as ATS |
| High-concurrency bulk/campus delivery | 🟡 | code 🟢; load test + infra provisioning manual |
| SOC 2 / ISO 27001 / DPDP / GDPR certification | 🔴 | controls + docs 🟢; the audit/cert is external |
| Data-residency (multi-region) infra | 🟡 | code 🟢; infra procurement + cost decision 🔴 |
| Brand-mention strategy (Reddit/YouTube/Wikipedia/LinkedIn) | 🔴 | real community/PR; Claude drafts only |
| Third-party reviews (G2/Capterra) + analyst relations | 🔴 | needs real customers + business dev |
| Outcome / usage-based pricing + SLAs | 🔴 | business decision; Claude builds billing mechanics 🟢 |

---

## Quick read

- **Claude can ship most of P0 + the bulk of P1 autonomously** — 8 of 8 P0 items are 🟢, and 11 of 15 P1 items are 🟢 or 🟢-core 🟡. This is the highest-leverage near-term work.
- **The 🔴 / data-dependent items cluster in P2** and are mostly gated by *being pre-launch* (no real data for norms/validity/predictive) or by *external dependency* (certs, reviews, partnerships, PR). Revisit after launch + first real cohorts.
- **Biggest moat plays already partly built:** AI grading transparency, adaptive testing, conversational AI-interview, skills intelligence — all 🟢 and all extend existing strengths rather than starting cold.

## NOT in scope here

Pricing/positioning decisions, legal/cert procurement, hiring psychometricians, and real-world brand/PR execution — flagged 🔴 above; this doc plans the *buildable* path, not the business plan.
