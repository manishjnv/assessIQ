# 06-attempt-engine — Event catalog (`attempt_events.event_type`)

**Source of truth.** Every `event_type` that may appear in `attempt_events` is listed here with its payload schema. The Zod schemas live in `src/types.ts` (`EVENT_PAYLOAD_SCHEMAS`) and are enforced at `recordEvent` time. Adding a new `event_type` is a code change, not an ad-hoc candidate-driven payload — both the Zod schema and a section here are required in the same PR.

The catalog is **closed** — `recordEvent` rejects unknown types with `AE_UNKNOWN_EVENT_TYPE`.

## Common rules

- `payload` is JSONB; the per-type schema below is what `recordEvent` accepts.
- `question_id` is set when the event is question-scoped (e.g. `answer_save`, `flag`).
- Events are append-only; nothing in this module ever updates or deletes a row from `attempt_events`.
- Timestamp is server-side `now()` at insert. Clients do not pass `at`.
- Two rate caps apply (decision #23):
  - **Per-second:** at most 10 events/second per attempt; bursts above the cap are dropped silently. Implemented in-process in `src/rate-cap.ts` (Phase 1; Phase 2 swaps to Redis for multi-replica scale-out).
  - **Per-attempt total:** at most 5000 events. The first overflow inserts a single `event_volume_capped` marker (enforced via partial UNIQUE index on `(attempt_id) WHERE event_type='event_volume_capped'`); subsequent overflow events are dropped silently.

## Event types

### `question_view`

Candidate viewed a question. Server-side write at `startAttempt` for the first question; client-side write on every navigation.

```json
{}
```

### `answer_save`

Server-side write inside `saveAnswer`. Records that an answer was persisted.

```json
{
  "edits_count": 0,
  "client_revision": 1
}
```

Both fields optional. `client_revision` is the **post-save** revision.

### `flag` / `unflag`

Candidate flagged or unflagged a question. Server-side write inside `toggleFlag`.

```json
{ "flagged": true }
```

### `tab_blur` / `tab_focus`

Visibility transition. Client-side write.

```json
{ "duration_ms": 12450 }   // tab_blur only; tab_focus payload is {}
```

### `copy` / `paste`

Clipboard event. Client-side write.

```json
{ "length": 247 }   // optional — character count of clipboard payload
```

> **Privacy:** never include the clipboard *content* in the payload. Only length.

### `nav_back`

Candidate navigated backwards in the question list. Client-side write.

```json
{
  "from_position": 5,
  "to_position": 3
}
```

### `time_milestone`

Per-question time crossed a threshold (client-side) OR auto-submit boundary fired (server-side, in `getAttemptForCandidate` or `sweepStaleTimers`).

```json
{
  "seconds": 1800,
  "kind": "auto_submit"   // optional: 'per_question' | 'auto_submit'
}
```

When `kind === 'auto_submit'`, `seconds` is the duration of the attempt (i.e., the timer that just fired).

### `multi_tab_conflict`

Server-side write inside `saveAnswer` when the incoming `client_revision` is less than the stored value (decision #7). Recorded but not blocking — last-write-wins semantics still apply, the conflict event is observability for the archetype computation.

```json
{
  "incoming_revision": 0,
  "stored_revision": 3
}
```

### `event_volume_capped`

Server-side write the first time an attempt's total event count exceeds 5000 (decision #23). Cap-once invariant enforced by partial UNIQUE index.

```json
{ "cap": 5000 }
```

## Phase 2 archetype hooks

Module 09-scoring will replay `attempt_events` chronologically to compute candidate **archetypes** (e.g., `methodical_diligent`, `fast_then_slow`, `last_minute_rusher`, `tab_jumper`). The events documented above are the canonical inputs to that pipeline; the archetype DSL itself lives in `modules/09-scoring/SKILL.md`.

When module 09 lands, the read path should:

1. Read `attempt_events` ordered by `(at, id)`.
2. Filter by `event_type` per archetype rule.
3. Aggregate. Output goes to `attempt_scores.behavioural_features`.

No backfill is required — Phase 1 attempts already accumulate the right rows.
