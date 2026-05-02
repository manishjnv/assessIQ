# 11-candidate-ui — Resilience contract

> Decision #8 (PHASE_1_KICKOFF.md) and decisions #7 + #23 (multi-tab + rate cap) — formalized.
> Status: live 2026-05-02 (Phase 1 G1.D).

## What can go wrong while a candidate is taking an assessment

1. **Network drop** — laptop loses wifi for 30 seconds. Server's autosave API returns network errors.
2. **Hard-stale connection** — connection dead for > 2 min; the candidate cannot reach the server.
3. **Tab close without submit** — laptop runs out of battery; browser kills the tab; candidate reopens later.
4. **Two tabs open against the same attempt** — candidate has the magic link in two windows, types in one, then the other.
5. **Server-side timer expiry** — candidate's `ends_at` passes while the candidate is mid-edit. Server ignores writes; auto-submits on next read.
6. **Event-volume flooding** — keystroke storm or scripted automation drives `attempt_events` past the per-second / per-attempt caps.

## Layered defenses

### Layer 1 — Server is source of truth

- Autosave writes go to `POST /api/me/attempts/:id/answer`. The server's SQL increments `attempt_answers.client_revision` via `GREATEST(stored, incoming) + 1`, guaranteeing monotonicity even if multi-tab sends out-of-order writes (decision #7).
- The timer is server-pinned at `attempts.ends_at`. The client renders a local countdown for visual smoothness; it never decides expiry. Past-deadline saves are silently ignored server-side; the next `GET /api/me/attempts/:id` auto-submits.
- The 10-events/sec rate cap and 5000-events-per-attempt cap (decision #23) are enforced by the in-process token bucket plus a partial UNIQUE index on `attempt_events (attempt_id) WHERE event_type='event_volume_capped'` — even a perfect client-side bypass cannot exceed the database invariants.

### Layer 2 — Client autosave with retry queue

`useAutosave` (`src/hooks/useAutosave.ts`) wraps the API client:

- **5-second debounce** per question on every `queueSave(qid, answer, opts)` call. `flushSave(qid)` cancels the debounce and runs the save immediately (used on `onBlur`).
- **Per-question state** in a `Map` ref so debounce timers and revision counters never trigger React re-renders.
- **Exponential backoff** on 5xx / network failures: 1s → 2s → 4s → 8s → 16s, capped at 30s. Max 5 attempts; after that the indicator shows `Save failed`.
- **4xx errors are terminal** — validation failures and writes-locked responses do NOT retry. The page should handle the locked state by re-fetching the attempt view (which will surface the auto-submit and route to `/submitted`).
- **Online recovery** — `window.addEventListener("online", ...)` clears any pending retry timer and runs the save immediately, so the candidate doesn't wait out the back-off after wifi returns.
- **Lock guard** — when the parent passes `locked: true` (e.g. timer reached zero), all queued and flushed saves are silently dropped to avoid futile post-expiry network traffic.

### Layer 3 — localStorage backup

`writeBackup` (in `src/resilience/localStorage-backup.ts`) writes the candidate's answer to `localStorage` BEFORE the network call returns:

```
key:   aiq:attempt:<attemptId>:answers
value: {
  answers: { [questionId]: <answer payload> },
  savedAt: "2026-05-02T18:34:21.000Z",
  clientRevision: 7
}
```

If the candidate reopens the tab after a hard close, the page reads the backup and re-hydrates pending answers, then re-saves them through the autosave hook (which deduplicates against the server's `client_revision` automatically).

`clearBackup(attemptId)` is called on submit/abandon. Stale entries from prior attempts are NEVER auto-pruned by age — the candidate may legitimately reopen an hours-old in-progress attempt, and the backup is the safety net.

### Layer 4 — Multi-tab warning (informational, never blocking)

`useMultiTabWarning` (`src/hooks/useMultiTabWarning.ts`) opens a `BroadcastChannel(`aiq-attempt-${attemptId}`)`:

- On mount: posts `{ type: "hello", at: Date.now() }`.
- Heartbeat every 3 seconds: `{ type: "ping", at: Date.now() }`.
- On receiving any message from another tab: `multiTabActive = true` for 5 seconds (one missed heartbeat tolerance).

Per decision #7 we DO NOT block multi-tab — the server's last-write-wins handles it correctly, and forcing one tab to close would be hostile UX. The warning is shown via `<IntegrityBanner kind="multi_tab" />` so the candidate can choose to close the duplicate.

The `multi_tab_conflict` event is recorded *server-side* when a save with a stale `client_revision` arrives; the warning banner is the *client-side* heads-up that this is about to happen.

### Layer 5 — Integrity-hook rate cap

`useIntegrityHooks` (`src/hooks/useIntegrityHooks.ts`) listens for visibility changes, copy/paste, and question-view transitions, then emits via `POST /api/me/attempts/:id/event`. To stay under the server's 10-events/sec cap:

- **Token bucket** in a ref: 8 tokens/sec budget (server cap is 10/sec; we leave 2/sec headroom). Refill rate = wall-clock delta × 8.
- **Per-attempt counter**: stops emitting once the local counter hits 5000.
- **Clipboard payload carries only `length`**, never the actual text. Privacy + data-leak prevention.
- **Errors are swallowed** — `recordEvent(...).catch(() => {})`. Telemetry must never block the candidate.

## What the candidate sees

| Server / network state | UI surface |
|---|---|
| All saves OK | `<AutosaveIndicator status="saved" lastSavedAt={iso} />` — green dot, "Saved · just now" |
| Save in flight | `status="saving"` — pulsing blue dot, "Saving…" |
| 5xx / network blip; retrying | `status="error"` — red dot, "Save failed · retry 3/5" |
| `navigator.onLine === false` | `status="offline"` — yellow dot, "Offline · queued" |
| Hard-stale > 2 min | `<IntegrityBanner kind="stale_connection" action={{ label: "Reload", ... }} />` |
| Another tab pinged in last 5s | `<IntegrityBanner kind="multi_tab" />` |
| Tab regained focus | `<IntegrityBanner kind="tab_was_blurred" onDismiss={...} />` |
| Reconnecting after offline | `<IntegrityBanner kind="reconnecting" />` |

## Known cosmetic limitations (Phase 2 cleanup)

These behaviors are functionally correct per the contract but have audit-log or
ergonomics rough edges that are tracked for Phase 2:

1. **Retry-storm revision inflation.** `useAutosave` increments `client_revision`
   on every `runSave` call, including retries. The server's
   `GREATEST(stored, incoming) + 1` contract prevents data loss
   (decision #7 — last-write-wins by arrival order, not by revision number), but
   a tab that retries heavily inflates its local revision faster than a tab that
   saves once. The server then logs `multi_tab_conflict` events when the
   single-save tab's revision arrives below the retry-storm tab's stored value —
   a false conflict event in the audit trail. Fix path: capture the revision
   once per pending payload in `queueSave/flushSave` and have `runSave` read
   without bumping. Deferred to Phase 2 — semantic-only refinement, no data loss.

2. **AttemptTimer drift-check unwired.** `AttemptTimer` ships an `onDriftCheck`
   callback that fires every 30 seconds, but `apps/web/src/pages/take/Attempt.tsx`
   does not pass it. Phase 1 has no admin-side mid-attempt `ends_at` mutation
   (decision #5 — `assessments.settings` JSONB empty), and local
   `getRemainingSeconds` re-derives from the deadline string each tick (so local
   clock skew can't drift more than 1s of display). Phase 2 ships
   admin-extendable deadlines and will wire the drift check.

3. **AnswerArea component identity flip.** The dispatcher in `Attempt.tsx`'s
   `<AnswerArea>` switches between `<McqAnswerArea>` / `<SubjectiveAnswerArea>` /
   `<KqlAnswerArea>` based on `question.type`. React's reconciler treats them as
   different elements at the slot, so navigating between heterogeneous-type
   questions remounts the answer area each time (no state preservation across
   questions of different types). Acceptable for Phase 1 — the autosave hook
   persists answers to its own ref + localStorage so no candidate input is lost.

## What is NOT in scope (Phase 1)

- **Save-and-resume across days** — explicitly NOT supported in v1 per `modules/11-candidate-ui/SKILL.md` § Open questions. Once started, must finish or abandon (terminal state).
- **Server-side reconciliation of localStorage backups** — Phase 1 trusts the client's re-save loop. Phase 2 may add a `POST /api/me/attempts/:id/recover` endpoint that takes the localStorage envelope and reconciles it server-side against the most recent saves.
- **Live grading status updates via WebSocket** — Phase 1 uses HTTP polling on `/api/me/attempts/:id/result`. WebSocket is a Phase 3 perceived-latency optimization.
- **Mid-attempt "save and resume later"** — not supported in v1.
- **Webcam / screen capture / fullscreen-required** — explicitly out of scope per `docs/01-architecture-overview.md` § "What's NOT in scope for v1".

## Cross-references

- `modules/06-attempt-engine/EVENTS.md` — closed catalog of `attempt_events.event_type` values.
- `modules/06-attempt-engine/SKILL.md` — server-side decisions #6 / #7 / #14 / #19 / #20 / #23.
- `docs/03-api-contract.md` § Candidate — `/api/me/*` endpoint shapes.
- `docs/RCA_LOG.md` 2026-05-02 § "Multi-tab autosave: last-write-wins" (decision #7 implementation).
