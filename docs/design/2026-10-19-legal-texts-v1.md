# Legal texts v1.0 (drafted by Claude, no lawyer review)

**Status:** final draft for go-live. Date: 2026-10-19. Owner decision: no lawyer review before 2 or 3 paying customers; the owner asked Claude to draft the best text and go live. Rows: Z-81 (DPA click-through), Z-71 (sign-up), Z-20 (terms), Z-72 (liability), Z-74 and Z-82 (camera), Z-89 (test types), Z-92 (credits).

> [!WARNING]
> Claude is not a lawyer. This text is a careful working draft, not legal advice. The owner accepts the risk of using it unreviewed. Keep every text versioned (DPA version 1.0). When a lawyer reviews it, the reviewed text replaces this one and every organisation ticks again.

**Old task or feature checked:** live `apps/marketing/src/pages/terms.astro` (sections 6 to 12) and `privacy.astro` (sub-processors, retention, children), `docs/design/2026-10-20-dpa-and-candidate-notice-text.md` (S32 draft), `docs/design/2026-10-18-liability-and-dpa-proposal.md`, `docs/design/2026-10-18-tiered-proctoring-design.md`, `ORG_UPLOAD_WARRANTY_TEXT` in `modules/10-admin-dashboard`, memory `owner-decisions.md` (v2 sheet and follow-ups).

## 1. What this file decides (owner choices that shape the text)

| Topic | Choice used in the text |
| --- | --- |
| Roles | The organisation is the controller (data fiduciary). AssessIQ is the processor. For its own account and website data, AssessIQ is the controller |
| Liability | Moves to the organisation. The platform keeps the minimum: cap = the fees paid in the last 12 months, with a floor of 10,000 rupees (so Free accounts have a cap). The floor is Claude's default; the owner may change it |
| Uploads | The organisation owns what it uploads, uploads at its own risk for use within its own candidates, and gives AssessIQ a licence to store, process and run the service. No reuse for other organisations |
| Test types | Real exam: laptop or desktop only, camera on (schools: school admin controls it). Mock test: any device, no camera |
| Camera data | Photos 90 days, video 7 days (low size). Schools: 7 days, only if the school admin switches it on. Flagged attempts: until the appeal closes, schools up to 90 days, others up to 1 year |
| Credits | Valid 12 months, oldest first. Free plan: 20 credits a month, no rollover. Burn: mock 1, real exam 2, real exam with camera 3. Prices only in private quotes |
| AI | An AI score is advice. A person at the organisation decides. Anthropic is a sub-processor for AI-assisted evaluation (already on the live privacy page) |
| Breach notice | AssessIQ tells the organisation within 48 hours after it confirms a breach (Claude's default; the lawyer may change it later) |

## 2. DPA, version 1.0 (page `/dpa`, linked from sign-up)

**Page title:** Data Processing Addendum (DPA), version 1.0. **Date:** 19 October 2026.

> **1. What this is.** This addendum is part of the agreement between AssessIQ and the organisation that signs up ("the Organisation"). It explains who is responsible for candidate data. It applies when the Organisation ticks the box at sign-up, or accepts it in writing.
>
> **2. Roles.** The Organisation decides why and how it tests people. For candidate data, the Organisation is the controller (data fiduciary) and AssessIQ is the processor. AssessIQ uses candidate data only to run the platform for the Organisation, on the Organisation's instructions. For the Organisation's own account data and for the public website, AssessIQ is the controller.
>
> **3. What data AssessIQ handles for the Organisation.** Candidate name and email; answers; start, pause and submit times; browser and device information; an IP address for security; activity events (for example leaving full screen, switching tabs, copy and paste); the result of the readiness check; and, only for a real exam with the camera on, photos and low-size video.
>
> **4. The Organisation's promises.** The Organisation (a) has a lawful basis for testing each candidate and gets any consent that the law requires; (b) gives each candidate a notice before the test (the platform shows a start-screen notice that names the Organisation); (c) uses the data only for lawful purposes; (d) is responsible for every decision about a candidate; (e) will not use the platform for anything illegal.
>
> **5. AI scores are advice.** Some written answers are scored with AI help. An AI score is advice only. A named person at the Organisation reviews it and decides what happens to the candidate. AssessIQ does not make decisions about candidates.
>
> **6. Camera.** A real exam may use the camera. The Organisation chooses to run real exams, and for a real exam the camera is on unless this section says otherwise. A mock test never uses the camera. For a school, the school admin decides whether the camera is on; if it is off, no photo or video is taken. The Organisation must tell each candidate before the test that the camera is used, and the candidate can choose "I do not agree, do not start". Photos and video are used only to review the exam and are not used to identify a person by face or to judge emotion.
>
> **7. Adults and schools.** The Organisation confirms that every candidate in a camera-on real exam is 18 years or older, or that the school or guardian has agreed to the camera for that candidate. For candidates who are children, the Organisation (for example the school) is responsible for getting the consent that the law requires.
>
> **8. How long data is kept.** Photos are deleted 90 days after they are taken, and video 7 days after it is recorded. For schools, photos and video are kept 7 days. If an attempt is flagged and a candidate appeals, the photos and video stay until the appeal closes, up to 90 days for schools and up to 1 year for other organisations. On an erasure request they are deleted sooner. Other candidate data is kept while the Organisation's account is active and is deleted when the Organisation asks, or after the Organisation's account is closed, as the privacy page describes.
>
> **9. Uploads.** The Organisation keeps ownership of what it uploads. It uploads at its own risk, for use within its own tests, and confirms that it owns the content or has the right to use and upload it. It gives AssessIQ a licence to store, process and run the service with that content. AssessIQ does not use one Organisation's uploads for other organisations.
>
> **10. Security and breaches.** AssessIQ keeps data safe with reasonable measures: encryption in transit, access control for each Organisation, an audit log and backups. If AssessIQ confirms a personal data breach, it tells the Organisation within 48 hours, so the Organisation can meet its own duties.
>
> **11. Sub-processors.** AssessIQ uses the sub-processors listed on the privacy page (server hosting, network security, email, optional Google sign-in, AI-assisted evaluation). AssessIQ gives notice on the website before it adds one. Sub-processors may not use data for their own purposes.
>
> **12. Requests from candidates.** If a candidate asks to see, correct or delete data, the Organisation sends the request to AssessIQ. AssessIQ helps the Organisation to answer it and confirms when data is deleted.
>
> **13. Liability and cost.** Section 11 (liability) and section 12 (misuse and indemnity) of the Terms apply to this DPA. The Organisation pays for claims, fines and costs that come from its own instructions, its missing notice or consent, its uploads, or its decisions about candidates. AssessIQ's total liability is limited as the Terms say.
>
> **14. Ending.** When the agreement ends, AssessIQ returns or deletes the Organisation's data within 30 days, unless the law requires it to keep some data.
>
> **15. New versions.** AssessIQ may publish a new version. The Organisation must accept it before it starts its next test.
>
> **16. Law.** Indian law applies, as in the Terms.

**Sign-up checkbox label:** `I have read and accept the Data Processing Addendum (version 1.0) for my organisation, and I have authority to accept it.` The link text is `Read the DPA (version 1.0)`. The box is not ticked by default. The Sign up button is enabled only when the box is ticked.

**Record kept at each acceptance:** time, user, a hash of the IP address, a hash of the browser, and the DPA version (table `tenant_legal_acceptances`, Z-71 design).

## 3. Terms: what to add or change on the live `/terms` page

Keep the live sections. Add or change only the points below. Section names are the live ones.

| Live section | Change |
| --- | --- |
| You control your candidates' data | Add: "The Data Processing Addendum (version 1.0 or newer) forms part of these terms. You must accept it at sign-up." |
| Paid plans, taxes, and renewal | Add: "Usage is measured in credits. A credit is valid for 12 months from the day it is granted, and the oldest credits are used first. A mock test, a real exam and a real exam with the camera use different numbers of credits, as your quote or plan says. The Free plan includes a monthly amount of credits that does not roll over. Prices are given in a private quote. Credits are not refunded, except when a fault on our side stops a test from being graded." |
| Who owns what | Replace the sentence about questions with: "You own your data and the questions you upload. You upload them at your own risk, for use within your own tests, and you confirm that you own the content or have the right to use and upload it. You give AssessIQ a licence to store and process them and to run the service. We do not use your uploads for other customers. AssessIQ owns the platform and the question sets that it creates. Question sets that AssessIQ licenses from others stay with their owners, and you may use them only while your plan is active." |
| Honest participation is required | Add: "A real exam is taken on a laptop or desktop computer. A mock test can be taken on any device. For a real exam with the camera on, the candidate must allow the camera or the test does not start. A mock test never uses the camera." |
| The service is provided as-is | Add: "AI scores and AI-written questions can be wrong. They are advice. You must have a person decide on hiring, admission, marks and certificates." |
| Our liability is limited | State the cap clearly: "Our total liability for all claims in any 12-month period is limited to the fees you paid in the previous 12 months, or 10,000 rupees if that is more. We are not liable for lost profit or indirect loss. Nothing here limits a liability that the law does not allow us to limit." |
| Responsibility for misuse | Add that the Organisation pays for claims that come from missing consent or notice, its uploads and its decisions about candidates (the DPA, section 13). |

## 4. Privacy page: what to add on the live `/privacy` page

- **What data we process:** add "photos and low-size video from a real exam with the camera on", "the result of the readiness check (device type, screen size, browser, camera permission, network speed)" and "activity events".
- **Purpose:** add "to review the exam for cheating. We do not identify a person by face and we do not judge emotion".
- **Retention (section "Kept as long as needed"):** photos 90 days, video 7 days; schools 7 days; flagged attempts until the appeal closes (up to 90 days for schools, up to 1 year for others); earlier on an erasure request.
- **Who can see candidate data:** add "people at the Organisation who review flagged events".
- **Children:** keep "not directed at children under 18". Add: "A school or other organisation that tests children is responsible for the consent that the law requires. For schools the camera is off unless the school admin turns it on."
- **Sub-processors:** the live list already names Hostinger, Cloudflare, Brevo, Google and Anthropic. Keep it. Add Cloudflare R2 only on the day the off-site backup is switched on.

## 5. Candidate notice on the test start screen

**Variant A (mock test, or a real exam with the camera off).**

> **About this test.** This test is run by {{organisation_name}}. {{organisation_name}} decides how your data is used. AssessIQ runs the test platform for {{organisation_name}} and handles your data on its behalf.
> **What we collect:** your answers; the times you start, pause and submit; your browser and device information; your IP address, for security; activity events such as leaving full screen, switching tabs, or copy and paste.
> **Why:** to run the test, score it and give the result to {{organisation_name}}.
> **AI scores:** some written answers are scored with AI help. An AI score is advice. A person at {{organisation_name}} decides what happens next.
> **Who sees it:** {{organisation_name}}. AssessIQ sees it only to run the service.
> **Your rights:** to see, correct or delete your data, ask {{organisation_name}} or write to {{contact_email}}. Read the AssessIQ privacy page for more.

**Variant B (real exam with the camera on).** Add to variant A:

> **Camera.** This test needs your camera. We take photos and record low-size video during the test. We use them only to review the test for cheating. We do not identify you by your face and we do not judge emotion. Photos are kept 90 days and video 7 days (schools: 7 days). If your test is flagged and you appeal, they are kept until the appeal closes. You can ask {{organisation_name}} to delete them.
> [Allow camera and start]   [I do not agree. Do not start]
> If you cannot use a camera, ask {{organisation_name}} for another way to take the test.

## 6. Upload warranty (replaces `ORG_UPLOAD_WARRANTY_TEXT`)

> I confirm that I own this content or have the right to use and upload it. I upload it at my own risk, for use within my organisation's tests. I allow AssessIQ to store and process it to run the service for my organisation. I will remove it if its owner asks.

## 7. Assumptions and points for the first lawyer review (at 2 or 3 paying customers)

1. Is a tick-box enough to bind an organisation, especially on the Free plan? Do paid plans need a signed order form?
2. Is the liability cap valid, with a 10,000 rupee floor, and what can Indian law not let us cap?
3. Is an indemnity from a school valid for claims about children's data?
4. Can the camera be mandatory and still count as consent? The text treats refusal as "the test does not start", with no penalty.
5. Are 90 days for photos, 7 days for video and the flagged-attempt limits right?
6. What breach-notice time should the DPA promise (the text says 48 hours)?
7. Do we need a separate notice for sending answers to Anthropic in the United States?
8. Does the licence for uploads cover enough for AssessIQ to run the service without claiming ownership?

## 8. How this goes live

1. `/dpa` page: a new page in `apps/marketing` with section 2. Marketing deploy by the manual steps in `docs/06-deployment.md`.
2. Terms and privacy edits: sections 3 and 4 above, then rebuild marketing. Update `page-dates.json` for the changed pages.
3. Sign-up checkbox, start-screen notice and upload warranty text: in the Z-71, Z-74 and EXP-17 builds.
4. Keep the version number in one constant so a reviewed version can replace v1.0.
