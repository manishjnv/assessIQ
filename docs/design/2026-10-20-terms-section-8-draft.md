# Terms section 8 (intellectual property): draft wording for owner approval

Rows: Z-20

**Summary**

- This draft changes one sentence in terms section 8, "Who owns what."
- The new wording matches the product: AssessIQ writes or licenses the question sets, and organisations own and keep private the questions they upload.
- Nothing is live. The public `/terms` page changes only after the owner approves and the lawyer agrees.

**Old task or feature checked:** Z-20 (RV31 terms, owner wording). Proposal from `docs/SESSION_STATE.md` S14 § Owner gates (1) is the base. This draft adds the EXP-17 upload rule and the roles from `docs/design/2026-10-18-liability-and-dpa-proposal.md`.

**Status:** as-built (S37, 2026-10-20). The sentence is in `apps/marketing/src/pages/terms.astro`.

---

## Old sentence

Exact text now live at `apps/marketing/src/pages/terms.astro:199`. This is the sentence that needs to change:

> The Customer retains ownership of its own data — including questions it creates, candidate responses, and assessment configurations — and grants AssessIQ a limited licence to process that data solely to provide the service.

## New sentence

Replace the old sentence with these five short sentences:

> The Customer owns its own data. This includes the questions it uploads, candidate responses, results, reports and assessment configurations. The Customer grants AssessIQ a limited licence to process that data solely to provide the service. Questions that the Customer uploads stay private to the Customer and are not shared with other customers. AssessIQ owns the platform and the question sets that it authors; question sets that AssessIQ licenses stay with their licensors, and the Customer may use them only while its subscription is active.

Word count check: each sentence is under 25 words.

---

## Why it changes

- The old words "questions it creates" suggest the Customer owns question sets. Only AssessIQ authors or licenses the platform sets (ROADMAP EXP-0 and EXP-1 decisions, 2026-10-17).
- Organisations may now upload their own questions (ROADMAP EXP-17, owner decision 2026-10-17). The terms must say who owns those questions and that they stay private.
- The new roles match the DPA draft: the Customer is the data fiduciary and AssessIQ is the processor for candidate data (DPA draft, section 1 and table A1). The words "candidate responses, results, reports" follow that table.
- The sentence about licensed sets stops the Customer from claiming ownership of sets that AssessIQ only licenses.

## What is not changed

- The first paragraph of section 8. It still says AssessIQ owns the platform and the question packs that AssessIQ creates.
- The limited licence to process the Customer's data (same words as today).
- The trademark sentence: the Customer may not use the AssessIQ name, logo or trademarks without consent.
- Section 6 (roles and data processing). This draft uses the same roles but does not edit section 6.
- Section 9 (third-party services).
- The 2026-10-18 DPA draft. It is not changed by this wording.

## Questions for the lawyer

1. The sentence "Candidates own their answers" is not in this draft. Does Indian law (DPDP Act) give candidates ownership of their answers? If yes, where should the terms say it?
2. Does an uploader warranty (the Customer confirms it has the right to upload the questions) need its own sentence in section 8? The upload flow depends on it (ROADMAP EXP-17).
3. Are the licensed question sets safe to use after the subscription ends, or does the licence need a different end date?

## Owner action

Approve or edit. The live /terms page changes only after the lawyer agrees.
