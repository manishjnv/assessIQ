# AssessIQ — Full product review, competitor research, and the path to "default assessment platform"

**Status:** superseded 2026-10-16 — open items are tracked in docs/ROADMAP.md § P0-Z (rows kept here for history).

**Date:** 2026-10-01 · **Scope:** whole product (no code changes) · **Basis:** HEAD `0c4f75c` + uncommitted work in tree
**Method:** 2 codebase audits (backend/DB/pipelines; UI/UX + marketing-claims check) + 3 *independent* market
research streams, collated. A market finding is marked **HIGH** only when ≥2 independent streams agree.
- Stream A — vendor-centric competitor matrix, trends, virality cases, compliance, pricing (70 sources)
- Stream B — buyer-centric "what the industry needs" (analysts, surveys, RFPs, reviews; 68 sources)
- Stream C — hands-on product/UX teardown from help centers + cyber and India-campus niches (103 sources)
- Not done: live prod DB counts (read blocked by permission classifier; doc figures used instead).

## Context
You asked for a no-code review of everything (architecture, concept, backend, DB, question bank, user
management, UI, pipelines, modules) plus detailed competitor and industry research: what we have, lack and
must have to be ahead of competitors and become the viral, default platform (trust, question bank, usability,
dashboards, results, certificate sharing). This builds on — and supersedes — the 2026-05-27
`docs/design/global-competitiveness-roadmap.md` and extends `docs/PENDING_TASKS_2026-10-01.md`.

---

## 0. Stop-the-line items (found during this review — act before the pilot)

| # | Issue | Why it matters | Evidence |
|---|---|---|---|
| S1 | **Aptitude answer key IS public.** Commit `0c4f75c` (60-question aptitude pack with all 60 correct answers) was pushed by a parallel session to the **PUBLIC** GitHub repo at 04:04 IST on 2026-10-01 (re-checked after the review: 0 forks, 0 stars, 0 watchers). **Update:** owner keeps the repo public; the file was untracked and moved to `docs/exam-content/` in `3fc8a34` — the copy in git history remains, so the 60 items must still be replaced. The grading + generation prompts (`grade-anchors/band/escalate`, `generate-*`) are already public. | Any student who searches GitHub can look up the answers; competitors can copy our grading prompts; candidates can study how answers are scored. | `git log origin/main` contains `0c4f75c`; `migrations/0109_…aptitude_pack.sql` 60× `"correct"`; `gh repo view` → PUBLIC; `prompts/skills/*` tracked |
| S2 | **A college lab will hit "too many requests" mid-test.** Candidate rate limit is 30 req/min per IP (60/user, 600/tenant, hardcoded). A lab of students behind one college IP shares one bucket. | The pilot is a campus drive — this fails exactly there. | `modules/01-auth/src/middleware/rate-limit.ts:217-230` |
| S3 | **Candidates never see a result.** `/result` always returns 202 "pending"; the results-released email is a silent no-op (function never exported); certificates page isn't linked from anywhere. | The product's promise ends at "Thank you". Kills trust + every sharing loop. | `06-attempt-engine/src/routes.candidate.ts:315-325`; `07-ai-grading/src/handlers/admin-claim-release.ts:445-455` |
| S4 | **Timer starts when the link is opened, not at "Begin".** No consent, system check or practice question; "Phase 1" chip and "backend not yet live… Session 4b" copy visible to candidates. | Unfair to students; looks unfinished. | `06-attempt-engine/src/service.ts:306-308`; `TakeRightPane.tsx:27`; `TokenLanding.tsx:187,296` |
| S5 | **Marketing and privacy pages promise features that don't exist:** webcam/lockdown proctoring, copy-paste block, MCQ option shuffle, coding tests, Python/Java/SQL/React packs, free trial, shareable test link, SSO/SAML, branding, reviewer scoping, multi-section papers, India-only processing (grading actually goes to Claude; AI vendor missing from sub-processor list). | Legal exposure (misleading claims; an inaccurate privacy notice under DPDP) and the fastest way to lose trust. | UI audit claims table; `apps/marketing/src/pages/{security,pricing,privacy,index}.astro` |
| S6 | **AI grading runs on your personal Max subscription for any company's admin.** The project's own compliance frame (`docs/05-ai-pipeline.md` decision D8) is valid only when *the subscriber* clicks Grade, but grade routes accept any tenant `admin`. | Selling AI grading to an outside company breaks our own stated rule. The pilot is MCQ-only, so it's safe **today**. | `docs/05-ai-pipeline.md:23-36,839-845`; `07-ai-grading/src/routes.ts:50,58` |
| S7 | **Invite links die in 72 h** while the copy says 7 days; no resend/extend/remind; a revoked invite blocks re-inviting. Worker queue runs at concurrency 1 (emails queue ahead of the assessment-open cron) and Brevo free is 300/day. | Students lose access and nobody can fix it from the UI. | `05-assessment-lifecycle/src/tokens.ts:66`; `service.ts:1531,1653`; `apps/api/src/worker.ts:430`; the "7 days" copy: `11-candidate-ui/src/components/CandidateHelp.tsx:179`, `10-admin-dashboard/src/pages/admin-guide.tsx:518` |

Also: MFA is off in prod; webhook URLs have no SSRF guard; the API container runs as root; a personal email
is hard-coded in a public migration (`01-auth/migrations/016_super_admin.sql:84-92`).

---

## 1. The verdict in plain words

- **What's genuinely strong:** the engineering core is enterprise-grade for a young product — fail-closed
  tenant isolation (RLS), an append-only audit trail written in the same transaction, versioned + frozen
  question sets, a server-side timer, answer-key stripping, tamper-evident certificates with revoke,
  DPDP erase/retention tooling, CI guards, a 103-entry incident log and a passed restore drill.
- **The crown jewel:** explainable AI grading — anchor hits quoted from the candidate's own words, a 0-4
  band with justification, a human who accepts or overrides (without erasing the AI verdict), prompt
  version pinned per grade. This is exactly what buyers, candidates and regulators now demand (HIGH).
- **What's missing is almost everything a buyer or candidate touches:** ~1 real content pack, no
  results for candidates, no integrity controls, no self-serve start, no public pricing, grading capped
  at one person's subscription (~50-150 attempts/day), no working API, and marketing that runs ahead of
  the product. Production today: 6 tenants, 11 users, 337 questions, 5 attempts.
- **The opening (HIGH, all 3 streams):** nobody combines real-work tasks (logs, KQL, scenarios) +
  auto-graded objective parts + explainable AI-graded written reasoning + campus scale + INR pricing +
  a verifiable credential. Cyber vendors are hands-on but slow (up to 20 business days), human-graded and
  USD-priced; generalist platforms test cyber with 10-45-minute MCQs.
- **How platforms become "the default" (HIGH, all 3 streams):** a candidate-owned, portable, verifiable
  score that many employers accept — Duolingo English Test, TCS NQT, AMCAT, CodeSignal's coding score.
- **Strategy in one line:** *Be India's trusted, explainable readiness score — for campus aptitude first
  and SOC analysts as the premium wedge — with instant objective results, human-verified AI reasoning
  scores within 48 h, credentials candidates want to share, and a free tier any college can start in
  five minutes.*

---

## 2. Scorecard — AssessIQ today vs market best (reviewer's rating, 1-5)

| Pillar | Us | Market best (who) | Gap |
|---|:-:|---|---|
| Trust & integrity | 1 | 4-5 (HackerRank tiers, HackerEarth Integrity Index, Mettl, Superset) | Critical |
| Question bank breadth/depth | 1.5 | 5 (Mettl 100k+, Testlify 180k Qs, HackerEarth 25k) | Critical (go deep, not wide) |
| AI generation & grading | 3.5 | 4 (CodeSignal JD→test, TestGorilla scored + override) | Throughput + reach |
| Candidate experience | 2 | 4 (Sapia, HackerEarth practice, NQT feedback) | High |
| Results & feedback | 1 | 4 (NQT scorecard, AMCAT report, Sapia insights) | Critical |
| Dashboards & analytics | 2.5 | 4 (Superset TnP, HackerRank replay, Mettl) | High |
| Credentials & sharing | 3 | 5 (Credly/Accredible, TryHackMe/HTB) | Medium — best asset to build on |
| Admin usability & onboarding | 2 | 4-5 (TestGorilla free, Testlify <1 min) | High |
| Integrations & API | 1 | 4 (SHL 80+ ATS, HackerRank 28 ATS + SCIM) | High |
| Scale & reliability | 2 | 4 (Superset "1 lakh" concurrency claim) | Critical for campus |
| Security, privacy, compliance | 3 | 4 (SOC 2 + ISO table stakes) | Medium (claims accuracy = critical) |
| Pricing & go-to-market | 1.5 | 4 (public tiers, free plans) | High |

---

## 3. What we have — architecture and module review

### 3.1 Architecture
- **Stack:** 6 containers on one shared Hostinger VPS (Postgres 16, Redis 7, api, worker, frontend,
  marketing) behind Cloudflare + Caddy. One BullMQ queue (`assessiq-cron`, concurrency 1) carries cron +
  email + webhooks. AI runs synchronously via Claude Code CLI; API mode (`anthropic-api`) and
  `open-weights` are 503 stubs (`07-ai-grading/src/runtimes/anthropic-api.ts:26-35`).
- **Risks:** single host with weekly offsite only (RPO up to ~7 days; `MASTER_KEY` not in the dump and not
  rotatable); DB pool max 10 while each request pins a transaction nobody uses and then opens a second
  connection (`02-tenancy/src/pool.ts:14`, `req.db` unused — code-read risk, not load-tested); one AI
  operation per API process; shallow `/api/health`; no Sentry/metrics; migrations applied by hand;
  `docs/01-architecture-overview.md` stale (PM2/PgBouncer/grading worker don't exist).

### 3.2 Module status (00-20)

| Module | Status | Strength | Main gap |
|---|---|---|---|
| 00-core | ✅ | Zod config, refuses API key in Phase 1 | — |
| 01-auth | ✅/🟡 | Google OIDC, email OTP, magic link, TOTP, step-up MFA | No SAML/SCIM; API keys unusable (`requireScope` no callers); MFA off in prod |
| 02-tenancy | ✅ | Fail-closed RLS, `withTenant` | Pool/connection pinning (self-rename now live, `aff53c8`) |
| 03-users | 🟡 | Roles, invites, CSV import + invite (live `aff53c8`, ≤200 per import) | Candidate invitations stub 501 (`invitations.ts:58,66`); import takes name and email only (no roll number or branch) |
| 04-question-bank | 🟡 | Versioning, frozen pools, Bloom/NICE/ATT&CK tags, clone-on-grant | 5 types only; generation SOC-only (citation gate) + super-admin only; no export/CSV/QTI; tenants can't author |
| 05-lifecycle | 🟡 | State machine, blueprint draws | No sections, retakes, resend/remind; fixed 72 h invites |
| 06-attempt-engine | 🟡 | Server timer, idempotent submit, autosave/offline | Timer at link open; integrity logs only; no accommodations; results endpoint always 202 |
| 07-ai-grading | ✅/🟡 | 3-stage cascade, proposals cache, accept/override, prompt SHA | Manual, ~2.3 min/attempt; API runtime stub; eval set 1 of 250 cases |
| 08-rubric-engine | ✅ | Anchor + band maths, reasoning-only fallback | — |
| 09-scoring | 🟡 | Archetypes, cohort p25-p90, leaderboard | MCQ scoring only in tree; KQL silently dropped from totals (`service.ts:84-85`) |
| 10-admin-dashboard | 🟡 | Coherent kit, grading review UX, mobile A0-A6 | No onboarding, exports, per-question analytics; 100-row caps; 26.7k lines, 7 test files |
| 11-candidate-ui | 🟡 | Runner, navigator, flags, mobile | No pre-check/consent/practice; `window.confirm` submit |
| 12-embed-sdk | 🟡 | JWT iframe, CSP origins, replay cache | First-time candidate insert references non-existent columns (`jit-user.ts:61-75`, "BUG-A"); SDK is a stub |
| 13-notifications | 🟡 | Queued SMTP, HMAC webhooks, retries | 4 of 9 templates used; results email missing; webhooks emit only `audit.*`; no SSRF guard; timestamp unsigned |
| 14-audit-log | ✅ | Append-only, in-tx, ~99 sites | S3 archive stub; no hash chain |
| 15-analytics | 🟡 | Cohort/individual/heatmap/activity; live results CSV with a download button (`aff53c8`) | Nightly MV (≤24 h stale); other exports API-only; no PDF/per-question/norms |
| 16-help-system | 🟡 | 132 YAML keys, tenant overrides | `HelpDrawer` never mounted — long help unreachable |
| 17-ui-system | ✅ | 22 primitives, tokens, Storybook | No Toast/ErrorBoundary; English only |
| 18-certification | ✅/🟡 | HMAC, verify page, OG PNG, PDF+QR, revoke | HMAC only (no third-party verification); no expiry, OB3/VC, Add-to-Profile, credential email |
| 19-billing | 🟡 | Metering atomic with grade; entitlements gate publish | No payments/invoices; no self-serve plans |
| 20-data-rights | 🟡 | Export, erase (tombstone), retention purge | Consent table has no writers; no candidate self-serve; 0 tests |

### 3.3 Pipelines
- **Content:** super-admin → AI generation (type-sharded skills, difficulty + citation gates) → review →
  publish → license to tenants → clone. Works for SOC; blocked for other domains by SOC-only citation IDs
  (`04-question-bank/src/service.ts:1695-1700`); the multi-category loop runs in the browser.
- **Delivery:** invite (per-email token) → landing → attempt (random draw from frozen pool) → submit.
- **Scoring:** MCQ at submit (live since `b18562f`) → admin "Grade all" (AI, ~2.3 min) → Accept/Override → manual
  Release → certificate if ≥70%. KQL never scored. Nothing reaches the candidate.
- **Messaging:** Brevo SMTP (300/day free, shared with 5 products); webhooks for audit events only.

### 3.4 Question bank reality
Live: ~337 questions (251 untagged legacy SOC-L2, ~10 phishing, SOC/phishing/threat-intel packs mostly
unpublished) + new Aptitude pack (60 MCQ, L1-L2). Types: `mcq` (single-correct, 2-8 options),
`subjective`, `scenario`, `log_analysis`, `kql` (text only). Missing: multi-select, numeric entry, ordering/
matching, data-interpretation sets, coding, SIEM execution, media. No item statistics, no IRT.

### 3.5 User management & tenancy
Roles super_admin/admin/reviewer/candidate; super-admin provisions companies (fresh MFA) — no self-serve;
tenant-less login picker; candidates via magic link (30-day session); per-tenant candidate identity (no
global candidate profile — which blocks a portable score); reviewer scoping claimed on site but absent.

### 3.6 UX journeys
- **Admin, first result:** ~9 screens, ~25 clicks, excluding operator work (licensing content). Grading
  100 attempts ≈ 500 clicks. No first-run checklist; `/admin/guide` is stale.
- **Candidate:** invite → landing (no consent/system check) → good runner → "Thank you" → nothing.
  LinkedIn is the only share channel; the certificate page is unreachable from navigation.

---

## 4. Competitor landscape (collated)

### 4.1 Segments and who leads
| Segment | Leaders | What they do best | Their weakness (our opening) |
|---|---|---|---|
| Dev-hiring | HackerRank, CodeSignal, Codility, HackerEarth | IDE, plagiarism + AI proctoring, JD→test, portable coding score (CodeSignal) | Puzzle tasks, hidden tests, $15-20/attempt overage, hostile candidate reviews (Trustpilot 1.7/5) |
| SMB skills (PLG) | TestGorilla, Testlify, Adaface, WeCP | Free plan, <1 min JD→test, per-test validity fact sheets (TestGorilla) | Annual lock-in, weak customization, shallow coding |
| Enterprise/exam | Mercer Mettl, SHL, iMocha, Talview, Criteria | Breadth, proctoring suites, norms, 80+ ATS | Quote-only pricing, proctor false positives, opaque reports |
| India campus | TCS NQT, AMCAT, eLitmus, Unstop, Superset, HirePro | Portable candidate-paid scores (NQT 4,000+ corporates, 2-yr validity); placement-cell OS (Superset) | In-centre only (NQT), English only, no candidate-owned credential, reporting glitches |
| Cyber skills | Immersive, Hack The Box (+LetsDefend), TryHackMe (SAL1), CyberDefenders, Cyberbit (+RangeForce) | Hands-on SOC sims, SIEM (KQL/SPL) tasks, Credly badges | Multi-day exams, human grading up to 20 business days, seat minimums, USD/EUR, ~$35k/yr (Immersive median) |
| AI-native | micro1, Mercor, Sapia.ai, Glider, HeyMilo | AI interviewers, feedback to every candidate (Sapia), text AI-detector | Low candidate trust in AI (26%), pivots to AI-data businesses |

### 4.2 Best-in-class by stage (Stream C, confirmed by A)
Signup: TestGorilla (free, no card, credit table) · Create: Testlify/HackerRank (JD→test <1 min), Unstop
(bulk CSV) · Invite: Mettl (system check + mock test in email) · Take: HackerEarth (auto practice test,
5 regional languages), Sapia (untimed mobile chat) · Results: HackerRank (timeline replay), HackerEarth
(3-level integrity index), TestGorilla (0-5 per criterion + reasoning + override) · Share: Credly/Accredible
(no-login, branded, reminder nudges), TryHackMe/HTB (badges, non-decreasing XP, public profiles).

### 4.3 Pricing benchmarks (HIGH, A+B+C)
Entry self-serve $79-199/mo · mid-tier $375-600/mo · effective $4-20 per candidate · enterprise quote-only
($13.5k median HackerRank, $24k CodeSignal per Vendr) · India candidate-paid ₹599-1,298 (NQT/AMCAT/eLitmus)
· India campus employer-side ~₹25-45/assessment (B, low confidence) · free tiers: TestGorilla 10 credits/mo,
WeCP 5/mo · trials 7-30 days. Openings: public INR price, monthly, credit rollover, ATS in base tier.

---

## 5. What the industry needs (collated)

### 5.1 HIGH-confidence needs (≥2 independent streams)
| Need | Streams | We have? |
|---|---|---|
| Job-relevant, realistic tasks (not puzzles/trivia) | A B C | 🟡 scenario/log/KQL types exist; content thin |
| Integrity buyers can trust — layered, explainable, human-reviewed, ID checks | A B C | ❌ |
| Explainable scoring with human oversight (and legal explanation rights) | A B C | ✅ **our USP** |
| Fast results (<48 h; instant for objective) + feedback to every candidate | A B C | ❌ |
| Transparent, flexible pricing + free tier, no lock-in | A B C | ❌ |
| Bulk campus operations: CSV/links, concurrency, rank lists, branch-wise reports, shortlist exports | A B C | 🟡 CSV import + results CSV live; no rank/branch views, no public drive link |
| Portable, verifiable credential candidates own | A B C | 🟡 HMAC cert, no portability |
| Minutes-to-first-test (JD→test, templates, practice tests) | A C | ❌ |
| Integrations: ATS, SSO/SAML/SCIM, API/webhooks | A B C | ❌ |
| Validity/reliability evidence (buyers ask reliability first 41.9% vs adverse impact 12.4%) | A B | ❌ |
| Compliance pack: SOC 2/ISO, DPDP, AI-law notices, WCAG 2.2 + ACR | A B | 🟡 DPDP base only |
| Mobile + regional languages (India) | A B C | 🟡 mobile yes, English only |

### 5.2 Unsolved industry pains (Stream B ranked, cross-checked)
1. Remote scores aren't trusted (fraud attempts 16%→35% of proctored tests 2024→2025, vendor data;
   Infosys paused tests for 20,000+ candidates over impersonation, Jun 2026; ACCA ended remote exams).
2. Identity fraud/proxies (Gartner: 1 in 4 candidate profiles fake by 2028).
3. Distrust of AI evaluation (26% of candidates trust it; 87% want transparency).
4. Irrelevant, time-pressured content. 5. No feedback (only ~6% get assessment feedback; candidate NPS −28
for rejected). 6. No reliable tooling for written reasoning/soft skills. 7. Skills-first validation gap.
8. Vendor legal liability (NYC LL144, California, Mobley v. Workday). 9. Proctoring false positives that
hurt disabled candidates. 10. Customization limits. 11. Pricing/lock-in. 12. Opaque reports, weak ATS.
13. India mass-scale verification. 14. Placement cells lack a trusted yardstick and must prove outcomes to
NIRF/NAAC. 15. Entry-level pipeline eroding (54% of employers who find skills hard to evaluate cut
entry-level hiring).

### 5.3 Key principle from the research: **verification beats detection** (B, supported by A + C)
61% of flagged cheaters still passed (Fabric); overlay tools are invisible to browser monitors. Winning
design = cheap remote screening + honest signals + a short *verified* step (campus lab with invigilator,
live "explain your answer" viva) + credentials that show *how* they were verified. Avoid emotion/biometric
inference (banned in EU work/education since Feb 2025; harms disabled candidates).

### 5.4 Regulation timeline that shapes the product (HIGH, A+B)
- India DPDP Rules notified 13 Nov 2025 → consent-manager rules ~13 Nov 2026 → notice/security/breach/
  erasure/children duties ~13 May 2027 (proposal to compress not notified as of 30 Sep 2026). Under-18s need
  verifiable parental consent; CERT-In 6-hour incident reporting, 180-day logs in India.
- EU AI Act: Annex III high-risk (recruitment, grading, cheating detection) moved to **2 Dec 2027**
  (Reg. 2026/1744); Art. 50 transparency from 2 Aug 2026; emotion inference banned since Feb 2025.
- US: NYC LL144 bias audits live; Illinois HB 3773 live 1 Jan 2026; California FEHA ADS rules live;
  Colorado SB 26-189 effective 1 Jan 2027 (notice, 30-day explanation, correction, human review).
- Credentials: W3C VC 2.0 Recommendation (May 2025); Open Badges 3.0 = VCs; Accredible supports OB3.
- Accessibility: WCAG 2.2 AA + ACR/VPAT expected; India Supreme Court (Apr 2025) — digital access is a right.

---

## 6. Gap analysis — have / partial / missing (⭐ = needed to become the default)

**Trust & integrity:** question shuffle ✅ · option shuffle ❌ (claimed) · parameterized items ❌ ·
browser signals 🟡 logged, never shown · integrity summary per candidate ❌ ⭐ · consented webcam ❌ ·
ID check (DigiLocker/Aadhaar) ❌ · verified sitting (lab PIN / viva) ❌ ⭐ · human flag review + appeals ❌ ⭐
· written-answer AI-use detection ❌ (only Sapia does it — opening) · SOC 2/ISO ❌.

**Question bank:** versioning/freeze/provenance ✅ · taxonomy ✅ · breadth ❌ ⭐ (go deep in 2 beachheads) ·
multi-select/numeric/sections/calculator ❌ ⭐ (aptitude) · hands-on SOC (KQL execution, alert triage,
log highlighting) ❌ ⭐ · JD→test generator ❌ · tenant custom questions ❌ (by design) · import/export ❌ ·
item stats/IRT/CAT ❌ · practice tests ❌ ⭐.

**AI:** explainable grading ✅ ⭐ · throughput/async ❌ ⭐ · candidate-facing explanation ❌ ⭐ ·
two-model vote 🟡 · eval set 🟡 (1 of 250) · AI interviewer ❌ (don't fight).

**Candidate experience:** mobile ✅ · autosave/offline ✅ · pre-check/consent/practice ❌ ⭐ · fair timer ❌ ·
regional language ❌ · accommodations ❌ · retakes ❌ (unique constraint) · results + feedback ❌ ⭐ · appeal ❌.

**Results & dashboards:** cohort/individual/archetypes ✅ · live monitor 🟡 · per-question analytics ❌ ·
rank list / branch-wise / shortlist ❌ ⭐ · UI exports 🟡 API-only · candidate percentile ❌ · NIRF/NAAC
evidence export ❌ ⭐ (opening) · decision workflow ❌.

**Credentials & sharing:** verify page + OG + PDF/QR ✅ · asymmetric OB3/VC ❌ ⭐ · Add-to-Profile/WhatsApp/X ❌
· share nudges ❌ · expiry/validity ❌ · public profile 🟡 unlinked · DigiLocker/NAD ❌ · "take this test" CTA ❌ ⭐.

**Admin usability:** design system ✅ · self-serve + free tier ❌ ⭐ · onboarding ❌ · templates/duplicate ❌ ·
public drive link ❌ ⭐ · resend/remind ❌ · bulk grading ❌ · help drawer 🟡.

**Integrations:** embed 🟡 (first-user bug) · webhooks 🟡 (audit only, SSRF gap) · API keys ❌ · OpenAPI ❌ ·
SAML/SCIM ❌ · ATS ❌ · LTI 1.3 (Moodle, for universities — my inference) ❌.

**Scale & ops:** correctness ✅ · campus concurrency ❌ ⭐ · alerting ❌ · offsite daily backup 🟡 · multi-host ❌.

**Compliance:** RLS/audit/DPDP tooling ✅ · MFA 🟡 off · accurate notices ❌ ⭐ · consent capture ❌ ·
AI notice/explanation 🟡 · WCAG/ACR 🟡 · bias monitoring ❌.

**Go-to-market:** SEO/comparison content ✅ · public pricing ❌ · payments ❌ · claims accuracy ❌ ⭐.

---

## 7. USP and positioning

**Own these (defensible, evidence-backed):**
1. **Explainable readiness score** — every AI score shows evidence from the candidate's own words, a band
   with justification and a named human sign-off. Regulator-ready (EU Art. 14/86, Colorado explanation
   right). Nobody does this for domain written answers + logs.
2. **Real SOC work at campus scale, in rupees** — log analysis, KQL, scenarios, incident write-ups;
   objective parts instant, reasoning within 48 h (vs 20 business days at HTB), priced in INR.
3. **Trust without surveillance** — verification tiers instead of creepy AI proctoring, no biometric
   inference, human review + appeals, DPDP-native, tamper-evident credentials.
4. **Candidate-first** — every candidate gets a result, feedback and a credential they own.

**Don't fight (partner or defer):** coding IDE breadth (HackerRank/Codility), psychometric batteries (SHL),
AI video interviews (HireVue/Chakra), placement-cell ERP (integrate with Superset rather than rebuild).

**Reconcile positioning:** keep private, branded per-company assessments (B2B core) **and** add an opt-in
"AssessIQ Verified" public track that produces the portable score. The compare pages currently sell
"private, not a shared pool" — the research says the shared, portable score is what becomes the default.

---

## 8. The virality engine — how to become the default

| Mechanic (proven by) | AssessIQ version |
|---|---|
| Portable score + acceptance list (DET, NQT, AMCAT, CodeSignal) | "AssessIQ Readiness Score" for Campus Aptitude and SOC L1-L3; validity 1-2 years; best score counts with cool-down retakes; public "accepted by" employer list |
| Free practice builds supply (HackerRank, NQT, IndiaBIX) | Free practice tests per domain (also SEO pages) → verified sitting → credential |
| No-login branded share + nudges (Accredible: 20-25% → 88% share rate) | Share to LinkedIn (Add-to-Profile + copy-fields fallback), **WhatsApp** (India), X; OG card; 7/14-day reminder emails |
| "Powered by" loops (Typeform, Calendly) | Verify page + certificate + free-tier candidate screens carry "Verified by AssessIQ — take this assessment / hire with it" |
| Competitions + streaks (Unstop 20M+ users; HTB XP) | Monthly free SOC triage challenge; seasonal ranks; employer-sponsored challenges; opt-in college leaderboards |
| Institution free tier | Colleges run drives free on deterministic tests; every student gets a readiness report; TPO gets NIRF/NAAC evidence export |
| Opt-in talent directory (Accredible 5× employer searches) | Candidates opt in; employers search verified credentials (later, DPDP-safe) |

**Growth KPIs:** candidate share rate · verify-page → signup conversion · % candidates with result <24 h ·
candidate NPS · time-to-first-assessment · employer acceptances · AI-human agreement (published).
**Guardrails:** opt-in only; no email/answers/employer on public pages; parental consent for under-18s;
no "guaranteed placement" wording (India CCPA coaching rules); no dark patterns.

---

## 9. AI economics — the Phase 2 decision
- Current pricing (Anthropic, cached 2026-09-25): Haiku 4.5 $1/$5, Sonnet 5.5 $2/$10, Opus 5.5 $4/$20 per
  million tokens; Batch API −50%; cached reads ~10%.
- One written answer (Haiku anchors + Sonnet band + ~10% Opus escalation) ≈ $0.015-0.025 → an attempt with
  5 written answers ≈ **$0.05-0.12 (₹4-10)**; about half via Batch (fine for async grading).
- vs price points: enterprise/SOC $4-20 per candidate → ~1% of revenue; India campus ₹25-45 per assessment
  → material. **So:** campus free tier = deterministic items (instant, no AI cost); AI-graded written items
  = paid tier; external tenants on API mode (fixes S6 and the 50-150/day cap).
- On switch: re-baseline the eval harness on current models (docs still name Sonnet 4.6 / Opus 4.7); handle
  `refusal` stop reasons — Sonnet 5.5/Opus 5.5 run a `cyber` safety classifier, so test SOC content and
  enable fallbacks.

---

## 10. Roadmap

Legend: **Who** C = Claude builds · O = owner · C+O = both. **LB** = load-bearing path (Opus review + adversarial
gate). Existing IDs from `PENDING_TASKS_2026-10-01.md` in brackets.

### NOW — 0-4 weeks: "make the pilot safe, fair and honest"
| ID | Item | Effort | Who | LB |
|---|---|---|---|---|
| N1 | Protect exam content: repo stays public (owner decision); 0109 moved out of git in `3fc8a34` ✅; regenerate the 60 aptitude items outside git before any real drive (history copy is still public); `prompts/skills` still public — moving it needs a deploy change (S1) | S | O | — |
| N2 | Campus-scale candidate traffic: rate limit keyed by attempt/session, not IP; fix pool/connection pinning; k6 load test 300-500 concurrent (S2) | M | C | yes |
| N3 | Results loop v1 (now detailed in `docs/design/2026-10-01-scoring-and-result-release-plan.md`, SP1-SP4; owner rule: no partial scores, emailed results, auto/manual release per tenant): candidate result page, results email, optional auto-release for deterministic-only tests, KQL shown as ungraded (not silently dropped) (S3) [A9; A1/A6 done]. Auto-release is opt-in per tenant and must keep the erased-candidate release block | M | C | yes |
| N4 | Candidate pre-test: timer starts at Begin, consent + AI-use policy, system check, practice question, remove "Phase 1"/stale copy, real submit dialog (S4) | S-M | C | — |
| N5 | Invites: configurable expiry, resend/extend/revoke UI, reminders, public drive link with registration; split email queue from cron; paid email plan (S7) [A9 resend, A5; A4 done]. The public drive link is a new candidate self-registration surface: design-gated, with D5 rate limits | M | C+O | — |
| N6 | Truth pass on marketing/pricing/security/privacy: remove or label "coming soon"; list AI sub-processor + cross-border note (S5) | S | C drafts, O approves | — |
| N7 | Prod safety: MFA on, Sentry + uptime + deep health, daily offsite backup + `MASTER_KEY` escrow, webhook SSRF guard + signed timestamp, non-root API; leave the email in applied migration 016 (editing it fails the checksum gate) [B1 offsite part, B2, B4, E8] | S-M | C+O | yes |
| N8 | Aptitude essentials: option shuffle, numeric + multi-select types, sections with timers, calculator, rank list + branch-wise export | M-L | C | partly |
| N9 | Integrity v1: fullscreen + exit count, copy/paste toggle, tab-switch warnings, integrity summary per candidate (= A8) | M | C | — |
| N10 | **Decided 2026-10-01:** AI evaluation triggered only by the super admin while there is no API key (`AI_PIPELINE_MODE=claude-code-vps`); when API budget exists (`anthropic-api`, OD2) tenant admins may trigger it — build as a mode switch (SP9). After evaluation, release to the tenant is automatic when the last grade is accepted; Auto-mode tenants publish to students immediately (SP10). Generation stays super-admin only | S | C after OD2 | yes (codex) |

### NEXT — 1-3 months: "launchable, self-serve, differentiated"
| ID | Item | Effort | Who |
|---|---|---|---|
| X1 | API-mode AI grading for paying tenants: async after submit, human-review SLA ≤48 h, batch grade, budgets, refusal fallbacks, eval re-baseline; JD→test generator; lift SOC-only citation gate. Documented Phase 2 path, but it needs OD2 plus an update to CLAUDE.md rule #1 and the ambient-AI lint (codex gate) | L | C+O (budget) |
| X2 | Self-serve + PLG: signup, free tier (credits exist in billing), onboarding checklist, templates, duplicate; public demo test [P1-H H1]; INR pricing + Razorpay [P1-D D2, D3]. **Reverses today's model** (super-admin provisions companies; tenant creation is design-gated) — needs OD8 | L | C+O |
| X3 | Credentials 2.0: Ed25519-signed OB3/VC export + published keys; verify page with skills, level, verification tier, validity; credential email; Add-to-Profile + WhatsApp/X; share nudges; "take this test" CTA; certificates in candidate nav | M-L | C |
| X4 | Hands-on SOC items: KQL execution on synthetic datasets (needs an engine — ADX emulator or subset evaluator), alert-triage queue, log-highlight items, per-candidate parameterized logs | L | C (🟡 engine) |
| X5 | Integrity v2: consented webcam snapshots (adults), ID check via partner/DigiLocker, human review queue + appeals, "verified sitting" (invigilator PIN), AI-free/AI-allowed modes, written-answer AI-use signal. Webcam reverses the documented "live proctoring out of scope" decision — needs OD5 | L | C+partner |
| X6 | Dashboards: live monitor, per-question analytics, cohort distributions, NIRF/NAAC evidence export, readiness heatmap, shortlist workflow, UI exports | M-L | C |
| X7 | Integrations: working API keys + OpenAPI, `attempt.*` webhooks, Sheets/Zapier, LTI 1.3 (Moodle), SAML; fix embed first-user bug | L | C |
| X8 | Trust center + accessibility: `/trust` (controls, sub-processors, DPA, AI statement, residency), WCAG 2.2 AA audit + ACR, i18n + Hindi candidate UI, DPDP consent capture incl. under-18 | M-L | C+O (legal) |
| X9 | Content depth: Aptitude L3 + data interpretation + verbal; SOC L1-L3 refreshed and published; item stats after each cohort; retire bad items; per-pack fact sheet | L | C+O review |
| X10 | Tenant-private questions (only if OD3 = yes; reverses the platform-only content model), clearly labelled "not platform-validated" | M | C |

### LATER — 3-9 months: "moat and virality"
L1 portable Readiness Score + validity + retake policy + public acceptance list + opt-in talent directory (needs a cross-tenant candidate identity, a tenancy-model change) ·
L2 item statistics → IRT → adaptive aptitude; publish reliability + AI-human agreement; adverse-impact
monitoring · L3 free practice tracks, streaks/XP, seasons, college leaderboards, ambassadors, annual "State
of SOC & campus readiness in India" report · L4 SCIM, SOC 2 Type I→II, ISO 27001, bias audit, ATS connectors
(Greenhouse, Lever, Keka, Darwinbox, Zoho Recruit) · L5 DigiLocker/NAD issuance, AI viva authorship checks,
AI-allowed "grade the process" tests · L6 managed Postgres + separate app host, point-in-time recovery
(RPO ≤1 h), staging, key rotation.

---

## 11. Decisions only you can make (recommendations; numbered OD so they don't clash with PENDING_TASKS section P1-D)
- **OD1 Repo visibility** — DECIDED 2026-10-01: stays public. Exam content lives in gitignored `docs/exam-content/` instead (`3fc8a34`).
- **OD2 Paid AI API budget** — yes for paying tenants; keep Phase 1 only for your own tenant (fixes S6, removes the throughput cap).
- **OD3 Tenant custom questions** — every stream calls customization a must-have; recommend allowing private, "unvalidated"-labelled questions that never enter the platform library.
- **OD4 Beachheads** — campus aptitude first (volume + live pilot), SOC readiness as the premium wedge; defer developer coding.
- **OD5 Proctoring stance** — tiered and consent-first; no biometric/emotion inference; webcam only for adults who opt in.
- **OD6 Pricing model** — public INR tiers, a free tier, institution-paid; candidate-paid "verified sitting" only after employers accept the score.
- **OD7 Claims policy** — ship first, then claim; everything else says "coming soon".

---

## 12. Confidence notes and conflicts
- HackerRank list price differs by source ($100-199 / $375-450 monthly; Vendr median $13.5k/yr) → ranges used.
- CyberDefenders CCD price: $800 (A) vs unverified $1,199 bundle (C).
- NIRF weights differ by framework (colleges vs engineering) — both correct for their institution type.
- LinkedIn Add-to-Profile: help page says no autofill; some vendors still document prefill → test live, ship a copy-fields fallback.
- Cheating prevalence numbers are vendor data and vary widely (17%-50%); direction agreed, size uncertain.
- Unstop scale 20M (Feb 2025) vs 23-24M (later) — growth, not conflict.
- Internal drift (code wins): backups now installed (daily local, weekly offsite) though PENDING_TASKS said missing; admin mobile shipped though PROJECT_BRAIN says desktop-only; KQL "keyword scoring" in docs/05 doesn't exist; docs/01 architecture is stale.
- G2 and Reddit were blocked for all three streams — complaints come from Capterra/Trustpilot/search summaries.

## 13. Key sources (curated; full lists go in the appendices)
Pricing/products: codesignal.com/pricing · testgorilla.com/pricing · hackerearth.com/recruit/pricing-custom ·
codility.com/pricing · testlify.com/compare-plans · tcsion.com/hub/national-qualifier-test ·
help.hackerearth.com/integrity-index · support.mettl.com (credibility index) · joinsuperset.com/assessments ·
tryhackme.com/certification/security-analyst-level-1 · hackthebox.com/blog/defensive-security-analyst-certification ·
forrester.com (Wave: cybersecurity skills & training Q1 2026) · sapia.ai (AI-content detection).
Market/needs: gartner.com newsroom 2025-07-31 (26% trust) · greenhouse.com (AI interview survey) ·
codesignal.com newsroom (fraud doubled 2025) · fabrichq.ai (19,368 interviews) · peoplematters.in (Infosys) ·
accountingweb.co.uk (ACCA) · Deloitte India campus 2026 · unstop.com/blog/state-of-campus-hiring-india-report ·
India Skills Report 2026 (careers360) · dsci.in cyber skilling 2025-26 · isc2.org India 2026 · nirfindia.org frameworks.
Credentials/virality: blog.englishtest.duolingo.com · accredible.com/guides/how-to-increase-credential-sharing ·
plc.pearson.com (Credly 100M) · w3.org VC 2.0 · 1edtech.org/standards/open-badges · linkedin.com/help a528030.
Regulation: eur-lex Reg (EU) 2026/1744 · legal500/mondaq DPDP Rules 2025 · dlapiper.com (NYC LL144 audit) ·
mcdermottlaw.com (Colorado SB 26-189) · seyfarth.com (Mobley v. Workday) · CERT-In directions (trilegal).

---

## 14. Follow-ups (approved 2026-10-01; steps 1-4 done, no code changes)
1. Save this report as `docs/design/2026-10-01-product-review-competitive-strategy.md` — **local only**
   (docs/ is gitignored); do **not** commit: it contains unfixed security details and the repo is public.
2. Save the three raw research reports with full source lists as
   `docs/design/research-2026-10-01/{A-vendor-matrix,B-industry-needs,C-product-teardown}.md`.
3. Append "New from 2026-10-01 review" (S1-S7, N1-N10) to `docs/PENDING_TASKS_2026-10-01.md` (local).
4. Memory: point the `global-competitiveness-roadmap` entry to this review; add one memory for S1/S2/S3/S6
   with the must-know facts on the index line.
5. Optional: publish as a private web page for sharing (strip S-items first if it goes outside).

## Verification (how to re-check the key claims)
- S1: `git ls-tree -r --name-only origin/main modules/04-question-bank/migrations` lists `0109_…`; `gh repo view manishjnv/assessIQ --json visibility` → PUBLIC; `git ls-files prompts/skills`.
- S2: read `modules/01-auth/src/middleware/rate-limit.ts:217-230`.
- S3: `modules/06-attempt-engine/src/routes.candidate.ts:315-325` returns 202; `sendResultReleasedEmail` absent from `modules/13-notifications/src/index.ts`.
- S4: `modules/06-attempt-engine/src/service.ts:306-308` sets the timer on landing.
- S5: grep `webcam|lockdown|free trial|SAML` in `apps/marketing/src/pages` vs no `getUserMedia`/fullscreen code in `modules/`.
- S6: `modules/07-ai-grading/src/routes.ts:50,58` (`roles: ['admin']`) vs `docs/05-ai-pipeline.md:839-845`.

## 15. Consistency check against PENDING_TASKS and shipped work (2026-10-01, after approval)

Every R/N item was re-checked against `docs/PENDING_TASKS_2026-10-01.md` (as updated by the parallel pilot session) and current code. Changes made:
- **IDs:** owner decisions renamed D1-D7 → OD1-OD8 (P1-D already uses D1-D7). Bracket references now point at existing items: R3 → A9 (results email, bulk release), R7 → A9 (invite resend), R2 → D5 (client IP behind Cloudflare), R4/R5 → D1 (consent, privacy page), R5 → D2 (pricing page), R8 → B1/E8, R10 = A8.
- **Shipped since the audit:** MCQ scoring (A1), aptitude pack (A2), CSV import (A4, ≤200 per import), results CSV with download button (A6), daily backups (B1, weekly offsite), five stale tests (B3). Module table and pipeline text updated.
- **Contradictions fixed:** (1) "remove the email from migration 016" dropped: the migration is applied and editing it fails the `tools/migrate.ts --check` checksum gate. (2) R1: the generator's pack slug is fixed, so replacement questions must go into a new pack; grant the `aptitude` domain entitlement in A3 so replacements are covered. (3) R6/N10: generation is already super-admin only; restricting AI grading changes today's behaviour for company admins, so it waits for OD2. (4) The generated SQL header no longer points at `migrate.ts --force-rerun` (that runner cannot see `docs/exam-content/`).
- **Constraints recorded:** option shuffle must keep A1's index-based MCQ scoring correct (`09-scoring/src/mcq.ts:54`); ranking needs a score sort (the CSV sorts by name); branch-wise reports need a new import column; auto-release must stay opt-in and keep the erased-candidate block.
- **Items that reverse an existing decision, now marked as owner decisions:** X1 async API grading (OD2 + CLAUDE.md rule #1 / ambient-AI lint, codex gate), X2 self-serve signup (OD8 vs super-admin provisioning), X5 webcam (OD5 vs "live proctoring out of scope"), X10 tenant questions (OD3 vs platform-only content), L1 portable score (cross-tenant candidate identity).
- **Re-verified unchanged:** `/result` always 202, results email not exported, timer starts on page load, 72 h invite TTL vs "7 days" copy, candidate limit 30/min per IP (via `cf-connecting-ip`), KQL has no grader, grade routes `roles: ['admin']`, erased-candidate release block present.