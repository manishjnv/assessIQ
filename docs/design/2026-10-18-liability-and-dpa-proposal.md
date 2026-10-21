# Liability and data-processing proposal for the lawyer (Z-72)

Rows: Z-70, Z-71, Z-72

**Date:** 2026-10-18. **Status:** draft for the owner and a lawyer.
**Read this first:** this file is **not legal advice**. The lawyer decides every point. No live page is changed by this file.
**Source:** owner review sheet, Q6: "We are not serving students directly, so liability is with the org, not us. Suggest a better idea to transfer liability to the org."
**Old task or feature checked:** live `terms.astro` and `privacy.astro` (read on 2026-10-18), ROADMAP D1/RV28/S5, Z-70.

## Summary

- The live terms already put most duties on the organisation. The new work is to **make that stronger and easier to prove**.
- Main idea: the organisation accepts a **Data Processing Addendum** by tick-box at sign-up.
- The test start screen names the organisation, so the candidate knows who is responsible.
- AI scores are advice only. A person at the organisation decides on hiring or marks.
- A liability cap stays at the fees of the last 12 months.
- Some duties cannot move to the organisation. They stay with AssessIQ (list below).

## What the live pages say today

| Topic | Live text (short) | Where |
|---|---|---|
| Roles | The Customer is the data fiduciary. AssessIQ is the processor for candidate data. | terms §6; privacy, roles part |
| Customer duties | Lawful basis, consent before invites, accurate data, tell candidates how data is used. | terms §6 (a) to (c) |
| Results | Results are decision support, not the only basis for decisions. The Customer is responsible for how it acts. | terms §10 |
| Liability cap | Fees paid in the last 12 months, or INR 10,000, whichever is higher. No indirect loss. | terms §11 |
| Indemnity | The Customer pays for claims from misuse, unlawful data use, no consent, and unlawful assessments. | terms §12 |
| AI | Written answers may be graded by staff with AI help (Anthropic). Names and emails are not sent. Staff review before release. | privacy, AI part |
| Minors | The institution gets parent or guardian consent. | privacy, children part |

## Proposal

### 1. Roles
- The organisation is the **data fiduciary** (controller). AssessIQ is the **data processor**.
- For administrator account data, AssessIQ stays a fiduciary (as in the live privacy page).
- **Question for the lawyer:** does the processor wording match the DPDP Act and the rules in force?

### 2. Data Processing Addendum (DPA)
- A short DPA is accepted by **tick-box at sign-up**. The log stores the time, the admin, the IP address, and the DPA version.
- The DPA lists: the purpose, the data types, the sub-processors (Hostinger, Cloudflare, Brevo, Anthropic), the location, how long data stays, the help AssessIQ gives for candidate requests, and the breach notice time.
- A new DPA version needs a new tick before the next assessment.
- **Question:** is a tick-box enough, or does an order form with a signature give stronger proof?

### 3. Consent and notice
- The organisation **warrants** that it has a lawful basis and has given notice to every candidate before the invite.
- The test start screen names the organisation: "This test is run by (organisation name). They decide how your data is used." The screen links to the notice.
- For minors, the organisation warrants parent or guardian consent.
- **Question:** what must the start screen say to count as notice under DPDP?

### 4. Indemnity
- Keep the live indemnity (terms §12). Add: claims from a candidate or a regulator about **notice, consent, or the decisions the organisation makes from results**.
- **Question:** is an uncapped indemnity valid in India for this kind of claim, or should it have its own cap?

### 5. Liability cap
- Keep: fees paid in the last 12 months, or INR 10,000.
- For the Free plan (Z-70) the fees are zero, so the INR 10,000 floor applies. **Question:** is the floor right for a plan that has no end date?
- No cap on what the law does not allow to be capped (the live text already says this).

### 6. AI scores are advice
- Every AI score is advice. The organisation must have a **person decide** on hiring, marks, or any outcome that affects a candidate.
- The result page and the report carry this line. The terms repeat it.
- Owner decision 2026-10-19 (Q7): the business API is used only after a paid contract. The Free plan grades 5 attempts with AI, with a platform kill switch, and the owner sees no legal issue. The lawyer is asked to confirm.
- **Question:** does DPDP or other law require a human review right for automated scoring?

### 7. Duties that stay with AssessIQ
These cannot move to the organisation:
- Reasonable **security safeguards** for the platform.
- **Breach notice** to the organisation without delay, and help with the organisation's own notices.
- Process data **only on instruction** and delete it on request or at the end of the contract.
- Keep the list of sub-processors true and give notice of a change.
- Its own duties as a fiduciary for administrator data.
- **Question:** what is a fair breach-notice time to promise (for example 48 hours)?

### 8. Limits on this idea
- A contract moves **cost** between two parties. It does not remove a candidate's right to complain to the regulator against either party.
- A tick-box proves less than a signed contract.
- AssessIQ collects data directly in some paths (candidate sign-in, the public `/try` demo). In those paths AssessIQ may be a fiduciary too. **Question:** list the paths where this is true.

## Live-page sentences that would change (NOT changed now)

| Page | Today | Would change to |
|---|---|---|
| terms §6 | Customer duties (a) to (c) | Add: notice named on the start screen; DPA accepted at sign-up; warranty for minors. |
| terms §10 | "must not be used as the sole basis for consequential decisions" | Add: a person at the Customer decides; AI scores are advice. |
| terms §11 | Cap at 12 months of fees or INR 10,000 | Lawyer decides the floor and the trial case. |
| terms §12 | Indemnity (a) to (d) | Add: notice, consent, decisions made from results. |
| privacy, roles part | AssessIQ is the processor | Add a link to the DPA and the breach-notice promise. |
| privacy, AI part | "results are reviewed before they are released" | Check against the final AI legal opinion (Q7). |
| Sign-up page and test start screen | not built | New text for the tick-box and the organisation line. |

## Next steps
1. Owner reads this file and marks the points to keep.
2. The lawyer answers the questions in bold.
3. Claude then drafts the exact page text for the lawyer to approve (a new row; no change before approval).
4. The sign-up tick-box is part of Z-71 (build) and needs the approved DPA text.

## Not included
- Any change to `/terms` or `/privacy`.
- Legal advice, or a promise about how a court would decide.
- The AI legal question (Q7) and the data-erasure rule for consent records (Q22).

## Addendum A (added 2026-10-18 by a second reviewer): extra points for the lawyer

The sections below add to the proposal above. They do not replace it.

### A1. Role map by kind of data

| Data | Who decides why and how | Role of the organisation | Role of AssessIQ |
| --- | --- | --- | --- |
| Candidate answers, scores, certificates | The organisation | Data fiduciary (controller) | Data processor |
| Candidate name and email given by the organisation | The organisation | Data fiduciary | Data processor |
| Organisation admin accounts and sign-in data | AssessIQ | Customer | Data fiduciary for its own service |
| Website visitors, contact form, analytics | AssessIQ | None | Data fiduciary |
| Question statistics, AI quality cases built from candidate answers | AssessIQ, if it uses them for its own goals | None | **Risk: AssessIQ becomes a fiduciary for this use** |

Design rule that follows: use candidate data only to deliver the service to that organisation. Do not use it to improve question quality or AI tests unless it is made anonymous first, or the DPA allows it and the lawyer agrees. Today the product builds AI evaluation cases from admin overrides (`harvest-overrides`) and plans question statistics (IRT). Check both against this rule.

### A2. Children and consent

If the organisation is a school, candidates may be under 18. The organisation must get verified consent from a parent or guardian before it sends the test. The lawyer should confirm the current rules on children's data.

### A3. Product changes this needs (after the lawyer approves)

| Change | Where | Load-bearing |
| --- | --- | --- |
| DPA tick-box and acceptance record | Company creation and the self-serve sign-up (Z-71) | Yes (tenancy and audit) |
| Organisation name on the test start screen | Candidate take flow | No |
| Organisation notice link or text per assessment | Assessment settings | No |
| Parent or guardian consent flag for under-18 candidates | Candidate invitation | Yes (consent) |
| Free plan: same DPA tick-box | Z-70 and Z-71 | Yes |
| Rule check on use of candidate data (section 2) | AI eval harvest, item statistics | Yes (AI grading) |

Each change is a separate roadmap row. Any change in `01-auth`, `02-tenancy`, `07-ai-grading` or `14-audit-log` needs the adversarial gate.

### A4. Extra questions for the lawyer

1. Is "fees in the last 12 months" with a floor valid for both the free and the paid plan?
2. Which liabilities cannot be capped under Indian law?
3. Is an indemnity from a school valid for claims about children's data?
4. Does using anonymous candidate data for question statistics keep AssessIQ a processor? What counts as anonymous?
5. Do we need a separate notice for candidates, or is the organisation notice enough?
6. Is a tick-box acceptance enough for a DPA, or do we need a signature on paid plans?
7. What breach notice time should the DPA promise?

## Addendum B (added 2026-10-19): webcam checks (Q9)

8. Is a photo retention period of 90 days right for webcam snapshots and ID photos, with earlier deletion on erasure and a longer hold only while an appeal about a flagged attempt is open?
9. Is a self-declared age of 18 or more, plus an attestation by the organisation that its candidates are adults, enough for webcam checks? Are school tests excluded from the webcam checks?
