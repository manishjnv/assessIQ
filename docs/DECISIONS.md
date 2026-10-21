# Decisions

*Type: reference* — One append-only list of decisions: date, decision, source. Add a row at the end; never edit an old row. `tools/close-session.mjs` appends the session decisions. Older decisions: `PROJECT_BRAIN.md` and `docs/archive/PROJECT_BRAIN-decisions-2026-05.md`.

| Date | Decision | Source |
|---|---|---|
| 2026-10-02 | **Owner decision: the product has plan tiers.** Tier contents, prices and the payment provider are not decided. Why: Replaces the earlier "no customer payments" statement. Module `19-billing` holds the metering base. | PROJECT_BRAIN.md decision log |
| 2026-10-02 | **Owner decision: MFA for tenant admins is optional now and to be enabled later.** All MFA code stays. The super admin always uses TOTP. Why: Lower sign-in friction for the pilot; the gate stays available (`MFA_REQUIRED`). | PROJECT_BRAIN.md decision log |
| 2026-10-02 | **Owner decision: the reviewer role is to be removed.** Why: Keeps the product simple (owner). Company admins review and publish results. | PROJECT_BRAIN.md decision log |
| 2026-10-21 | One repo; no second docs repo. Docs are tracked; only docs/private/ and docs/exam-content/ are ignored. | Z-105, owner |
| 2026-10-21 | Every doc move is recorded in docs/moves.json; nothing is deleted. | Z-107, owner |
| 2026-10-21 | New docs guards start in WARN mode and turn strict on 2026-10-29; the privacy check enforces from day one. | Z-106, owner |
