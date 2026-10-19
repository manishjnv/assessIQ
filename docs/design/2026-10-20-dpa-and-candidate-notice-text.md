# DRAFT: DPA tick-box, candidate notice and camera clauses (for the lawyer)

**Status:** draft for the owner's lawyer. Not approved. Nothing here goes live.
**Date:** 2026-10-19. **Roadmap:** Z-72 (LIABILITY-1). Related: Z-71 (sign-up), Z-74 (camera photos), owner decisions Q9 and Q22.

> [!WARNING]
> This file is **not legal advice**. The lawyer decides every point. Do not publish any text here until the lawyer approves it. The live `/terms` and `/privacy` pages do not change in this draft.

**Old task or feature checked:** `docs/design/2026-10-18-liability-and-dpa-proposal.md` (points 1 to 7, Addenda A and B), `docs/design/2026-10-18-tiered-proctoring-design.md` (Q9, Z-74), `docs/design/2026-10-18-self-serve-signup-design.md` (Z-71), live `apps/marketing/src/pages/terms.astro` (sections 6, 10, 11, 12) and `privacy.astro` (candidate data, retention, children).

## Summary

- This file gives draft text for five items: the sign-up tick-box, the candidate notice, the adult clause, the 90-day photo line and the school-test clause.
- Each item cites the proposal point or addendum it puts into practice.
- The text keeps the live wording in `/terms` and `/privacy`. It does not contradict it.
- Eight questions for the lawyer are at the end. Text in `{{double braces}}` is a placeholder that someone must fill.

## Defined terms

Use these words only. Do not use other words for the same thing.

| Term | Meaning in this file |
|---|---|
| Organisation | The company or institution that runs an Assessment. The live Terms call it the "Customer". It is the controller of Candidate data. |
| AssessIQ | The company that runs the Platform. It is the processor of Candidate data. |
| Platform | The AssessIQ online service. |
| Candidate | A person who takes an Assessment. |
| Assessment | A test or exam run on the Platform. |
| Camera feature | Camera checks: Photos and, at tier 2, one ID photo. It is off unless the Organisation turns it on for an Assessment. |
| Photo | An image taken by the Camera feature. |
| ID photo | An image of an identity card that the Candidate holds to the camera. Tier 2 only. |
| Activity events | Recorded events in an attempt, such as leaving full-screen mode, switching tabs, or copy and paste. |
| DPA | The Data Processing Addendum. Its short form is in item 1. |
| Notice | The candidate notice on the test start screen (item 2). |
| Placeholder | Text in `{{double braces}}`. The lawyer or the owner fills it. |

## Point map

| Proposal point (Z-72) | Where this file uses it |
|---|---|
| Point 1: Roles | Item 1 (DPA clause 1), item 2 |
| Point 2: DPA by tick-box | Item 1 |
| Point 3: Consent and notice | Items 2, 3, 5 |
| Point 4: Indemnity | Item 3 (pointer), question 6 |
| Point 5: Liability cap | Item 1 (DPA clause 10), question 7 |
| Point 6: AI scores are advice | Items 1 and 2 |
| Point 7: Duties that stay with AssessIQ | Item 1 (DPA clauses 8, 9, 11) |
| Addendum A1 (role map) | Item 1 (DPA clause 2) |
| Addendum A2 (children) | Item 5 |
| Addendum B, questions 8 and 9 (photos, age) | Items 3 and 4 |

---

## Item 1. DPA tick-box at Organisation sign-up

**Where it shows:** the sign-up page (`/signup`, Z-71). The form has two tick-boxes: the Terms and the DPA. The DPA tick-box is not ticked by default. The sign-up cannot continue without it. The same tick is also needed for an existing Organisation that accepts a new DPA version.

**Exact text, checkbox label:**

> [ ] I accept the Data Processing Addendum (DPA) for my Organisation. I have authority to accept it for my Organisation.

**Exact text, link under the checkbox:**

> Read the DPA (version {{dpa_version}})

**Exact text, the short DPA that the link opens:**

> **Data Processing Addendum, short form (version {{dpa_version}})**
>
> 1. **Roles.** The Organisation is the controller (data fiduciary) of Candidate personal data. AssessIQ is the processor of that data. AssessIQ processes it only on the Organisation's documented instructions, through the Platform.
> 2. **Data.** AssessIQ processes Candidate name and email, Assessment answers, timing, browser and device information, an IP address for security, and Activity events. If the Organisation turns on the Camera feature, AssessIQ also processes Photos and ID photos.
> 3. **Notice and consent.** The Organisation has a lawful basis for the processing. The Organisation gives each Candidate the Notice before the invitation. Where the law requires consent, the Organisation obtains it.
> 4. **Adults only.** The Organisation confirms that every Candidate is 18 years or older before it turns on the Camera feature. See item 3.
> 5. **School tests and minors.** The Organisation must not use the Camera feature for a school test or for any Candidate under 18. See item 5.
> 6. **AI scores.** An AI-assisted score is advice. A named person at the Organisation decides any outcome that affects a Candidate.
> 7. **Retention.** Photos and ID photos are deleted 90 days after they are taken, or sooner on an erasure request. See item 4.
> 8. **Breach notice.** AssessIQ tells the Organisation about a personal data breach without undue delay, and in any case within {{breach_notice_hours}} hours after it confirms the breach.
> 9. **Sub-processors.** The current list of sub-processors is on the `/privacy` page. AssessIQ gives the Organisation notice before it adds a sub-processor.
> 10. **Liability.** The liability cap and the indemnity in sections 11 and 12 of the Terms apply to this DPA.
> 11. **Candidate requests.** When a Candidate asks for access, correction or erasure, the Organisation sends the request to AssessIQ. AssessIQ helps the Organisation to answer it, and confirms when the data is deleted.
> 12. **New versions.** A new version of this DPA needs a new acceptance before the Organisation starts its next Assessment.

**Record kept for each acceptance:** the time, the user who accepted, a hash of the IP address, a hash of the browser, and the DPA version. (From the Z-71 design, table `tenant_legal_acceptances`. The proposal asks for the plain IP. The design uses a hash. The lawyer decides which is right.)

**Source point:** Point 2 (DPA by tick-box), Point 1 (roles), Points 3 to 7 (clauses 3 to 11). Addendum A3, row 1 and row for the Free plan.

**Open questions for the lawyer:**
- Is a tick-box enough for a DPA, or does a signed order form give stronger proof? The Free plan has no order form. Does the same tick-box apply there?
- What is the breach-notice time? The proposal suggests 48 hours. Placeholder `{{breach_notice_hours}}` until the lawyer decides.

---

## Item 2. Candidate notice on the test start screen

**Where it shows:** the test start screen, before the Candidate starts the Assessment. The Organisation may also add its own notice link for each Assessment (proposal, Addendum A3, row 2). There are two variants. Variant A is used when the Camera feature is off. Variant B is used when the Organisation turns on the Camera feature.

### Variant A: without camera

**Exact text:**

> **About this test**
>
> This test is run by {{organisation_name}}. {{organisation_name}} decides how your data is used. AssessIQ runs the test platform for {{organisation_name}} and handles your data on its behalf.
>
> **What we collect**
>
> - Your answers to the questions.
> - The times when you start, pause and submit the test.
> - Your browser and device information.
> - Your IP address, for security.
> - Activity events during the test, such as leaving full-screen mode, switching tabs, or copy and paste.
>
> **Why**
>
> We collect this data to run the test, score it, and give the result to {{organisation_name}}.
>
> **Who sees it**
>
> {{organisation_name}} sees your answers, scores and Activity events. AssessIQ can see them only to run the service for {{organisation_name}}.
>
> **AI scores**
>
> Some written answers are scored with AI help. An AI score is advice. A person at {{organisation_name}} decides what happens next.
>
> **How long we keep it**
>
> {{retention_period}}.
>
> **Your rights and contact**
>
> You can ask {{organisation_name}} for a copy, a correction, or deletion of your data. Contact {{organisation_name}} at {{organisation_contact}}. You can also raise a grievance with AssessIQ. The grievance address is on the `/privacy` page.

### Variant B: with camera

Variant B has the same text as Variant A, with one extra section. Put this section after "Who sees it".

**Exact text, extra section:**

> **Camera checks**
>
> {{organisation_name}} has turned on camera checks for this test. During the test we take Photos with your camera at the start and at random times. If the test requires an ID check, we also take one photo of your ID card.
>
> We do not record video or sound. We do not match your face to your ID. We do not read your emotions or your attention.
>
> A person at {{organisation_name}} reviews the Photos. A Photo can show a concern. A Photo does not decide anything on its own.
>
> Cover your ID number before you show your ID.
>
> You can stop camera checks at any time. Press **Stop camera**. Photos taken before you stop are kept for the time in "How long we keep it".
>
> Photos are deleted 90 days after they are taken.

**Exact text, consent control (camera optional):** shown only when the Organisation allows another route.

> [ ] I am 18 years or older. I agree that AssessIQ takes Photos of me with my camera during this test, as described above.
>
> If you do not agree, you can still take the test. {{decline_route_text}}

**Exact text, consent control (camera required):** shown only when the Organisation has set "camera is required for this test".

> [ ] I am 18 years or older. I agree that AssessIQ takes Photos of me with my camera during this test, as described above.
>
> {{organisation_name}} requires camera checks for this test. If you do not agree, you cannot start this test. To ask for another way to take the test, contact {{organisation_contact}}.

**Rules for the control:**
- The camera does not start before the Candidate ticks the box.
- A "no" ends the camera part only. It does not end the test unless the Organisation requires the camera.

**Source point:** Point 3 (consent and notice; the start screen names the organisation), Point 6 (AI scores are advice), Addendum A1 (use only to run the service), Addendum B (consent first; adults only; no face or emotion analysis). The "Stop camera" button and the ID-number tip follow the Q9 design (finding 11).

**Open questions for the lawyer:**
- Is this Notice enough as notice under the DPDP Act, or does AssessIQ need a separate candidate notice (proposal, Addendum A4, question 5)?
- Is consent "free" when the Organisation sets "camera is required"? If a "no" ends the test, is the consent still freely given?
- Is the list of Activity events complete? The live `/privacy` page names integrity events. The Notice must match it.
- Does the Notice need to name Anthropic, the AI sub-processor, for written answers? (See question 5 in the list at the end.)

---

## Item 3. Adult-attestation clause

**Where it shows:** three places.
1. DPA clause 4 (item 1).
2. The assessment settings, as a tick-box that the Organisation ticks before it turns on the Camera feature.
3. The consent control on the test start screen (item 2, Variant B).

**Exact text, DPA clause 4:**

> **Adults only.** Before the Organisation turns on the Camera feature for any Assessment, the Organisation confirms that every Candidate of that Assessment is 18 years or older. The Organisation answers for this confirmation. The Organisation must not turn on the Camera feature for any Candidate under 18.

**Exact text, assessment setting tick-box:**

> [ ] All Candidates in this Assessment are 18 years or older. I confirm this for {{organisation_name}}.

**Exact text, shown when a Candidate says they are under 18:**

> You have told us that you are under 18. Camera checks are not available to you. {{organisation_name}} decides how this test continues.

**What AssessIQ does if the Organisation says otherwise:**

> If the Organisation tells AssessIQ that a Candidate is under 18, or AssessIQ learns this, AssessIQ turns off the Camera feature for that Assessment at once. AssessIQ may also turn it off for the whole Organisation. AssessIQ tells the Organisation what it did. [Lawyer to confirm: AssessIQ deletes Photos of a Candidate under 18 at once, and tells the Organisation when it does so.]

**Effect on the report:** the report shows "check not done: candidate not an adult" for that Candidate. The Organisation decides whether the test continues.

**Source point:** Addendum B, question 9 (self-declared age, adults only); the adult warranty in Point 3 (consent and notice); the indemnity in Point 4, which covers claims from a wrong adult warranty. The design rule is in the Q9 design, section "Adults only".

**Open questions for the lawyer:**
- Is a self-declared "18 or older" answer, plus the Organisation's warranty, enough for the Camera feature? (Question 3 in the list at the end.)
- Should AssessIQ delete Photos of a Candidate who turns out to be under 18, and how fast?

---

## Item 4. The 90-day photo retention line

**Where it shows:** DPA clause 7 (item 1), the Notice (Variant B, item 2), and the privacy page when the feature goes live (not changed now).

**Exact text, customer-facing sentence (DPA and privacy page):**

> Photos and ID photos are deleted automatically 90 days after they are taken. If a Candidate asks for erasure, they are deleted sooner.

**Exact text, one-line version for the candidate notice:**

> Camera photos are deleted 90 days after they are taken.

**Optional sentence, only if the owner approves the appeal hold:**

> If a Photo is part of an open appeal about a flagged attempt, it may be kept until the appeal closes. It is never kept more than {{hold_maximum}} after it was taken.

**Backup sentence (owner decision still open):**

> Copies in backups are deleted within {{backup_expiry_days}} days after the original is deleted.

**Source point:** Addendum B, question 8 (90 days, earlier deletion on erasure, longer hold only during an appeal). The rules are in the Q9 design, sections "Retention" and "Erasure". The backup sentence follows the Q9 design, finding 7.

**Open questions for the lawyer:**
- Is 90 days proportionate for Photos and ID photos? (Question 2 in the list at the end.)
- Is an appeal hold up to `{{hold_maximum}}` (the design uses 180 days as a placeholder) lawful at all?
- How long may backups keep Photos? The owner has not decided this.

---

## Item 5. School-test exclusion clause

**Where it shows:** DPA clause 5 (item 1). It also goes into the Terms, as a new paragraph in section 6 (proposal, "Live-page sentences that would change").

**Exact text, DPA clause 5 and Terms addition:**

> **School tests and Candidates under 18.** The Organisation must not turn on the Camera feature for a school test. The Organisation must not turn on the Camera feature for any Candidate under 18. This rule applies until AssessIQ agrees in writing. AssessIQ gives that agreement only after the lawyer has approved the rules for children's data. Until then, AssessIQ keeps the Camera feature off for the Organisation.
>
> Before the Organisation sends an Assessment to a Candidate under 18, the Organisation obtains verified consent from a parent or guardian. The Organisation keeps the record of that consent.

**Platform rule (for the build, not for the text):** the tenant setting `proctoring_allowed` is false by default. Staff set it to true only after the lawyer agrees in writing.

**Source point:** Addendum A2 (children and consent); Addendum B, question 9 (school tests excluded until the lawyer agrees); Point 3 (the minors warranty). The live `/privacy` page section "Not directed at children under 18" already puts parent consent on the Organisation.

**Open questions for the lawyer:**
- Is a school test different from any other test for a Candidate who is 18 or older? Give a definition of "school test" that the Organisation can apply.
- Is an Organisation indemnity valid for claims about children's data? (Proposal, Addendum A4, question 3.)

---

## Questions for the lawyer

1. **Parental consent under 18 (DPDP).** Does the DPDP Act require verifiable parent or guardian consent before the Camera feature runs for a Candidate under 18? Does it also apply to the Assessment answers of a Candidate under 18?
2. **90-day retention and appeal hold.** Is 90 days proportionate for Photos and ID photos? Is an appeal hold of up to `{{hold_maximum}}` lawful? Is holding a Photo because a reviewer marks a concern allowed?
3. **Self-declared age.** Is a self-declared "18 or older" answer, plus the Organisation's DPA warranty, enough for the Camera feature? Or must the age be verified?
4. **Consent records (owner decision Q22).** How long must AssessIQ keep the consent record (the answer, the box, the notice version) and the DPA acceptance record? Does that period still apply after an Organisation's data is purged?
5. **Cross-border processing.** Written answers go to Anthropic in the United States for AI-assisted scoring. Must the DPA or the Notice name the country and the transfer basis? Does any other sub-processor move data outside India?
6. **Indemnity wording.** Should the Terms section 12 indemnity cover claims about notice, consent, the adult confirmation and decisions made from results? Can it be uncapped under Indian law, or does it need its own cap?
7. **Cap wording.** Is "fees paid in the last 12 months, or INR 10,000, whichever is greater" right for both paid and Free plans? Is the INR 10,000 floor valid when the fee is zero and the plan has no end date?
8. **Controller and processor for the Free plan.** When an Organisation signs up alone on the Free plan, is it the controller of Candidate data? Is AssessIQ a fiduciary for any data it collects directly, such as sign-in data and the public `/try` demo?

## What is not included

- Any change to the live `/terms` or `/privacy` page. The lawyer approves the text first.
- Legal advice, or a view on how a court or regulator would decide.
- A signed DPA contract or an order form.
- The AI legal opinion (proposal point 6, owner question Q7).
- The final breach-notice time (`{{breach_notice_hours}}` stays a placeholder).
- Pricing, payment and plan limits (Z-70, Z-71).
- Single-person (B2C) sign-up.
- Other language versions of the Notice.
- The build: the tick-box, the Notice screens, the consent table and the 90-day deletion job (Z-71, Z-74).

## Next steps

1. The owner reads this draft and marks the points to keep.
2. The lawyer answers the eight questions and approves or changes each text block.
3. Claude then makes a new roadmap row for the approved text. No page changes before that.
