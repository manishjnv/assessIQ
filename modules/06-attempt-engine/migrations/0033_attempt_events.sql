-- owned by modules/06-attempt-engine
-- Phase 1 G1.C Session 4 — attempt_events table.
--
-- Append-only behavioural-signal log for an attempt. Powers the archetype
-- computation in module 09-scoring (Phase 2). The event_type taxonomy and
-- payload shapes are documented in modules/06-attempt-engine/EVENTS.md and
-- enforced by Zod schemas in src/types.ts (decision #14).
--
-- WHY BIGSERIAL primary key:
--   High-volume table — every keystroke-burst, tab-switch, or copy/paste
--   produces a row (subject to the rate cap, decision #23). UUIDs would
--   bloat both the table and every JOIN. attempt_events is internal-only
--   observability; no external referrer needs a stable id beyond the
--   attempt_id+at composite for chronological replay.
--
-- WHY the partial unique index on event_type='event_volume_capped' (decision #23):
--   The rate cap fires once per attempt — the FIRST time the per-attempt total
--   exceeds 5000 events, a single 'event_volume_capped' marker is inserted and
--   subsequent overflow events are dropped silently. Without a UNIQUE
--   constraint a high-volume burst could insert dozens of marker events
--   between the count read and the marker insert. The partial UNIQUE collapses
--   the cap-once invariant into a structural guarantee — the 23505 unique
--   violation on the second attempt is caught and ignored at the service
--   layer, no race condition possible.
--
-- WHY JOIN-based RLS: same as attempt_questions / attempt_answers.

CREATE TABLE attempt_events (
  id              BIGSERIAL PRIMARY KEY,
  attempt_id      UUID NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  event_type      TEXT NOT NULL,
  question_id     UUID,
  payload         JSONB,
  at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Chronological replay: "give me every event for this attempt in order".
CREATE INDEX attempt_events_attempt_idx
  ON attempt_events (attempt_id, at);

-- Cap-once invariant — see file header.
CREATE UNIQUE INDEX attempt_events_capped_unique_idx
  ON attempt_events (attempt_id)
  WHERE event_type = 'event_volume_capped';

ALTER TABLE attempt_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON attempt_events
  USING (
    EXISTS (
      SELECT 1 FROM attempts a
      WHERE a.id = attempt_events.attempt_id
        AND a.tenant_id = current_setting('app.current_tenant', true)::uuid
    )
  );

CREATE POLICY tenant_isolation_insert ON attempt_events
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM attempts a
      WHERE a.id = attempt_events.attempt_id
        AND a.tenant_id = current_setting('app.current_tenant', true)::uuid
    )
  );
