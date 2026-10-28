# Paste this into Claude Code from the root of the AssessIQ repo

I'm adding the **student exam engine** to AssessIQ. The design handoff is in `design_handoff_exam_engine/`.

1. Read `design_handoff_exam_engine/README.md` end to end, then open `prototype/exam-engine.html` in a browser to see the intended behaviour. The HTML is a **design reference**. Don't copy it in; rebuild it with our stack and existing components.
2. Explore our codebase first:
   - where the routes, layout shell, design tokens, `Button`/`Chip`/`Card`/`Input`/`Icon`/`Logo` components and the API client live
   - how theming works
   
   Map the README's tokens to ours. Add the **mid-tone theme** (the default) and the `warn/ok/danger` soft and ink pairs as new theme tokens; don't hard-code hex values.
3. Use `types/exam.ts` as the contract. Adapt names to our API conventions. Use `data/sample-exam.json` as a seed or mock until the backend endpoints exist.
4. Build in this order, and show me each step before moving on:
   1. The exam shell: top bar (org, assessment, candidate, save status, timer, display settings, full screen, Finish), progress row, full-bleed layout.
   2. The question stage with all eight answer types, plus flag and clear.
   3. The navigator: the expanded panel with **clickable Answered/Flagged/Open filters**, the **collapsed rail that keeps the current question centred in the lens**, and the edge handle. Filters must drive Previous/Next and the arrow keys.
   4. Keyboard shortcuts, autosave (debounced PATCH with a local fallback) and a server-authoritative timer.
   5. The finish summary, confirm dialog, result (ring and meter animation) and answer key.
   6. The responsive behaviour (horizontal rail + bottom sheet at ≤ 900px), reduced motion and an accessibility pass.
5. Grading and the answer key must come from the server after submit. Never send `ans`/`accept` to the candidate before submission.
6. Write component tests for:
   - grading rules
   - "answered" rules
   - filter-aware navigation (`neighbor`)
   - rail centring maths
