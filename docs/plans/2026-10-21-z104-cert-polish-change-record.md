# Z-104 CERT-POLISH: change record (2026-10-21, S39 part 3)

Row: Z-104 (items a to e). Source: the owner's end-to-end test of 2026-10-21 (4 questions, 45 minutes, pass at 75%, certificate, LinkedIn and X share). Not built here: Z-101 (waits for the owner), Z-103 (waits for the owner's numbers), the load test, and any change to `CAMERA_ENFORCED`.

## What changed

| Item | Change | Files |
| --- | --- | --- |
| (a) Empty signature line | The empty horizontal rule above the organisation name on the certificate is removed. The issuer name, the seal and the QR block stay where they were. No new field. | `modules/18-certification/src/pdf/template.ts` |
| (b) Social preview image | Text is larger so the picture reads as a LinkedIn thumbnail: name 96 px, course 48 px, level and tier 32 px, badge, credential id and footer 28 px (were 64, 32, 28, 22, 22). A helper `fitText` shrinks a long name or title to a minimum size, then cuts it with an ellipsis, so text never leaves the 1200 by 630 canvas. Size, route, URL and cache headers are unchanged. | `modules/18-certification/src/routes-public.ts` |
| (c) Save wording | Only the idle state of the save indicator now reads "No answers yet". Save error and offline still read "Not saved yet". | `modules/11-candidate-ui/src/components/AutosaveIndicator.tsx` |
| (d) Congratulations box | Checked, one small fix: the box now marks the certificate as seen when it is shown, not only when it is closed. | `modules/11-candidate-ui/src/components/CompletionModal.tsx` |
| (e) Tier rule | Checked, no change: see below. | none |

Tests added or updated: `verify-logo.test.ts` (+1: no signature rule, issuer name present), `verify.test.ts` (+2: every font size is at least 28; a long name shrinks and is cut), `components.test.tsx` (idle wording; error and offline keep the old wording), `CompletionModal.test.tsx` (+1: after Close the box is gone and the score stays), `pass-mark.test.ts` (+1: 75 of 100 is not Distinction, 90 of 100 is).

## Why

- (a) An empty line looks like a missing signature on a certificate that people share.
- (b) A thumbnail at about 500 px wide made the old 22 to 32 px text unreadable.
- (c) "Not saved yet" at the start looked like a problem when the candidate had simply not answered. The failure states keep a warning wording on purpose: a failed save must never read as "no answers".
- (d) The owner asked whether the box hides the score for a slow reader.

## Check results

- (d) The score stays in the page behind the box. Escape, the Close button and the X button all call the same close handler. The shared modal sets no scroll lock, so there is nothing to remove after closing. One real gap: the "seen" flag was set only on Close, so a refresh or a navigation while the box was open showed it again. It is now set on show. A candidate who navigates away at once does not see it a second time; the result page and the certificate stay available.
- (e) `modules/18-certification/src/service.ts` (tier at release): Distinction when `meetsPct(total_earned, total_max, DISTINCTION_PCT)` with `DISTINCTION_PCT = 90` (`modules/00-core/src/pass-mark.ts`), else Completion. So 75% gives Completion and 90% gives Distinction; 89.99% gives Completion (integer maths in hundredths). The organisation switch for the word "Distinction" (Z-50) can still show a Distinction as Completion. The rule is unchanged.

## How to verify

1. `pnpm verify`.
2. `pnpm exec vitest run` in `modules/18-certification`, `modules/11-candidate-ui`, `modules/00-core` (one at a time).
3. Open a certificate PDF: no empty line above the organisation name.
4. Open `https://assessiq.in/verify/<credential id>` in the LinkedIn Post Inspector or paste it in a draft post: the preview text is large.
5. Start a real test: the top bar shows "No answers yet" before the first answer, then "Saved".

## Rollback

Revert the commit. No migration, no data change, no new setting. Certificates already issued re-render from stored data, so old certificates also lose the empty line. The preview image is generated on request, so it changes at once; LinkedIn may show the old picture until its cache refreshes.

## Not included

- A signatory name or signature field on the certificate (the row said to remove the line).
- A pixel check of the preview image: the text fit uses a width estimate per character, not font metrics. Check one long real name by eye.
- Pre-filled LinkedIn post text (LinkedIn does not allow it).
- Z-101, Z-103, the load test, and any change to the camera switch.

## Effect on other modules and docs

- 18-certification: the PDF and the preview image look different; no change to data, tier, signature or verify result.
- 11-candidate-ui: one wording change, one flag timing change. No API change.
- Docs: ROADMAP row Z-104 closed, recount, handoff block, NEXT brief.
