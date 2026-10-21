# New public pages for assessiq.in: proposals

Rows: Z-76, Z-26

**Status:** proposal only. No page is written. No copy is written. No code is changed.
**Owner task:** ROADMAP Z-76 (PAGES-1, owner Q42).
**Date:** 2026-10-19.

## Summary

- We propose 7 new pages. Six can ship now. One waits for the Free plan.
- Each page targets a search query that no current page answers well.
- The proposals rest on keyword research and the existing pages. There is no Search Console data. Z-26 is not done, so we have no impression or click data.
- Every page only claims a feature that exists today. Webcam checks are not built. Embed is not ready. No public prices are shown.
- The owner approves each page: yes, no, or later. See the last section.

## Proposals

| # | Page | URL slug | Target query | Searcher intent | Why this page (gap in current site) | What the page contains | Existing feature it shows | Effort | Risk of overclaiming |
|---|---|---|---|---|---|---|---|---|---|
| 1 | How to run a campus aptitude test | `/resources/how-to-run-a-campus-aptitude-test` | how to conduct online aptitude test for students | Learn steps and then act (placement cell, lecturer) | No how-to page. Existing solution pages sell the product. | Steps, CSV import limit, timers, review before release, FAQ | CSV import (up to 1,000 rows), server-side timers, question sets | M | Low to medium |
| 2 | Release test results to students | `/resources/release-campus-test-results` | release exam results to students online | Find out how results reach students and when | Result release is a product step with no page of its own | What release means, who sees what, when results go out | Result release control | S | Medium: confirm the release steps in the admin UI first |
| 3 | Send test invitations to students | `/resources/send-test-invitations-to-students` | send online test link to students by email | Learn how invites work and how many can go out | Invites are named in the aptitude FAQ but have no page | Import, one-by-one invite, email content, daily send limit | Email invites (Q11 bulk email daily cap) | S | Medium: state the daily cap as it is set, not as a promise |
| 4 | Verify a skill certificate | `/resources/verify-skill-certificate` | verify online skill certificate | Check if a certificate is real | Live home page says certificates have a public verification page. No page explains it. | How a certificate is issued, how a third party checks it, what the check shows | Certificates and public verification page | S | Medium: confirm the verify URL and fields before writing |
| 5 | Aptitude test syllabus for campus placement | `/resources/campus-aptitude-test-syllabus` | aptitude test syllabus for campus placement India | Learn what is on the test | `/tests/aptitude` has a topic list but no full guide | Topics (quantitative, logical, verbal, data interpretation), question format, sample items labelled as examples | Aptitude test topics and sample items | M | High if it implies a company's real test pattern. Do not name employers as sources. |
| 6 | Test reports for a placement cell | `/resources/test-reports-for-placement-cell` | student test report for college placement cell | Find out what a report shows and who can read it | Cohort reports are named on the education page. No page shows what is in them. | Report fields, cohort view, who sees what, sample layout | Cohort reports | M | Medium: confirm the report fields and export formats first |
| 7 | Free online test for students (later) | `/resources/free-online-test-for-students` | conduct online exam for students free | Find a free option for a class or a club | The Free plan is in design, not live. Plan limits act only when `PLAN_TIERS_ENFORCED=true`. Today the flag is `false` on the VPS (ROADMAP Z-18). | Free plan limits, sign-up steps, what is not free | Free plan (design: `docs/design/2026-10-18-free-plan-pack.md`) | M | High now. Do not publish until the flag is on and the owner approves the plan. |

## Per-page notes

### 1. How to run a campus aptitude test
- Write as a numbered how-to with 6 to 8 steps.
- Link to `/tests/aptitude` and `/solutions/campus-recruitment`. Do not copy their text.
- Name the CSV limit only as it is set in the product today.

### 2. Release test results to students
- Confirm the release control in the admin screens before writing. Describe only what the screen does.
- Keep the page short. It is a reference-style answer to one question.

### 3. Send test invitations to students
- Give the daily send cap as a number from the code, with the date it was set.
- Do not promise delivery. Say that email depends on the recipient's mail provider.

### 4. Verify a skill certificate
- Use one example certificate that the owner approves, not a made-up one.
- Do not claim accreditation, blockchain storage or employer recognition.

### 5. Aptitude test syllabus for campus placement
- Name the four topics as the product uses them. Mark all sample items as illustrative.
- Do not say that any company uses this pattern.

### 6. Test reports for a placement cell
- List only the report fields the product shows today.
- Show a labelled sample layout, not a live customer report.

### 7. Free online test for students (later)
- Do not write this page until the Free plan is live and the owner approves it.
- Check the sign-up and limit copy against `docs/design/2026-10-18-free-plan-pack.md` on the day it is written.

## Not included

- No page is written. No copy is written. No code is changed. No file is committed.
- No new page for webcam or AI proctoring. Webcam checks are not built.
- No page for embed. Embed is not ready.
- No page that shows public prices. Pricing stays on `/pricing`.
- No "best platform" or "vs" page. The site already has `/alternatives` and `/compare`.
- No "online exam platform for colleges" page. `/solutions/educational-institutions` already targets that query. Improve the existing page instead.
- No "MCQ test platform" page for the same reason. Treat it as the same query as above.
- No page for coding tests. The site already has `/tests/*` pages for each language.
- No Search Console or analytics data. Z-26 is open. Re-check these proposals after 2 to 4 weeks of data.
- Sitemap and `page-dates.json` entries are not added. Each approved page needs both. The build guard in `apps/marketing/astro.config.mjs` fails the build if an indexable page is missing from the sitemap.

## Search check (standard web search, 2026-10-19)

- "online aptitude test for campus placement" returns practice sites (IndiaBix, FACE Prep, PlacementPreparation.io, TCS iON, Unstop and others). Most results are practice platforms for students, not platforms for colleges. Source pages are vendor blogs and mirrored PDFs. We did not verify them.
- "conduct online exam for students free" returns open-source and free tools (Take A Test, phpMyExam), and paid tools with trials (TestWe, ClassMatrix). Free options are self-hosted. Our Free plan is not live.
- "online assessment platform India colleges MCQ test" returns Indian vendors (Wzdm, Testpress, Think Exam, Conduct Exam, HireMee). Results show a mix of school, college and corporate products.
- Takeaway: the college query is contested. Our strongest angle is how-to and result-flow pages that the vendors do not write. This is a reading of search results, not measured rank data.

## Owner decision needed

Approve each page: yes, no, or later.

| # | Page | Decision (yes / no / later) |
|---|---|---|
| 1 | How to run a campus aptitude test | |
| 2 | Release test results to students | |
| 3 | Send test invitations to students | |
| 4 | Verify a skill certificate | |
| 5 | Aptitude test syllabus for campus placement | |
| 6 | Test reports for a placement cell | |
| 7 | Free online test for students | later (Free plan not live) |

Owner notes for pages 2, 4 and 6: confirm that the feature works as the page will describe it.

## Claims to check before any page is written (S30 note)

- Result release: the exact control and steps. Read the admin code first.
- Certificate verify page: the URL and the fields it shows (`modules/18-certification`).
- Daily email cap: the number (250 a day, Q11) and the wording.
- Cohort report fields and export formats.
- Server-side timers and the CSV import limit.
- Proposal 7 (Free plan) waits until the Free plan is live (Z-18, Z-71).
