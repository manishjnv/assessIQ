-- owned by modules/04-question-bank
-- 0201 — EXP-6: exam blueprints (platform-authored exam structure).
--
-- WHAT
--   exam_blueprints          one row per exam stage and edition: total minutes, qualifying flag,
--                            verification_status ('verified' | 'unverified'), source note.
--   exam_blueprint_sections  child rows: position, name, subject node, question count, marks,
--                            negative marks, minutes, sectional timing, qualifying, cutoff,
--                            calculator, allowed question types.
--   Seed: SSC CGL Tier 1, VERIFIED by the owner on 2026-10-17 (EXP-0).
--
-- WHY no tenant_id and no tenant write policy (differs from taxonomy_nodes on purpose)
--   taxonomy_nodes allows tenant-owned rows next to platform rows. A blueprint is platform data
--   only: authored by the super admin, read by every tenant. So there is no tenant_id column.
--   RLS is on; the app role gets a SELECT policy and NO insert/update/delete policy, so a tenant
--   session can never write. Writes run as assessiq_system (BYPASSRLS) from the super-admin routes,
--   audited in the same transaction.
--
-- WHY a stage/subject FK that may be NULL
--   The exam-structure and subject-map frameworks are loaded by a super-admin click, not by a
--   migration. The seed links the stage and subject nodes when they exist and leaves NULL when not.
--   ON DELETE SET NULL: removing a node never removes a blueprint.
--
-- NOT INCLUDED  Any other exam (rows stay absent until the owner verifies them), cutoff values
--   (they change every year; cutoff_marks stays NULL), any UI.
--
-- IDEMPOTENT: CREATE ... IF NOT EXISTS, fixed seed ids, ON CONFLICT DO NOTHING.

CREATE TABLE IF NOT EXISTS exam_blueprints (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  stage_node_id       uuid        REFERENCES taxonomy_nodes(id) ON DELETE SET NULL,
  edition             text        NOT NULL CHECK (btrim(edition) <> ''),
  name                text        NOT NULL CHECK (btrim(name) <> ''),
  total_minutes       int         NOT NULL CHECK (total_minutes >= 1),
  qualifying          boolean     NOT NULL DEFAULT false,
  verification_status text        NOT NULL CHECK (verification_status IN ('verified','unverified')),
  source_note         text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS exam_blueprints_stage_edition_uq
  ON exam_blueprints (stage_node_id, edition) WHERE stage_node_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS exam_blueprint_sections (
  id                          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  blueprint_id                uuid        NOT NULL REFERENCES exam_blueprints(id) ON DELETE CASCADE,
  position                    int         NOT NULL CHECK (position >= 1),
  name                        text        NOT NULL CHECK (btrim(name) <> ''),
  subject_node_id             uuid        REFERENCES taxonomy_nodes(id) ON DELETE SET NULL,
  question_count              int         NOT NULL CHECK (question_count >= 1),
  marks_per_question          numeric(8,3) NOT NULL CHECK (marks_per_question >= 0),
  negative_marks_per_question numeric(8,3) NOT NULL DEFAULT 0 CHECK (negative_marks_per_question >= 0),
  minutes                     int         CHECK (minutes IS NULL OR minutes >= 1),
  sectional_timing            boolean     NOT NULL DEFAULT false,
  qualifying                  boolean     NOT NULL DEFAULT false,
  cutoff_marks                numeric(10,3) CHECK (cutoff_marks IS NULL OR cutoff_marks >= 0),
  calculator_allowed          boolean     NOT NULL DEFAULT false,
  allowed_types               text[]      NOT NULL DEFAULT ARRAY['mcq']::text[]
                                          CHECK (cardinality(allowed_types) >= 1),
  UNIQUE (blueprint_id, position),
  CHECK (negative_marks_per_question <= marks_per_question)
);

ALTER TABLE exam_blueprints ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS platform_read ON exam_blueprints;
CREATE POLICY platform_read ON exam_blueprints FOR SELECT USING (true);

ALTER TABLE exam_blueprint_sections ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS platform_read ON exam_blueprint_sections;
CREATE POLICY platform_read ON exam_blueprint_sections FOR SELECT
  USING (EXISTS (SELECT 1 FROM exam_blueprints b WHERE b.id = exam_blueprint_sections.blueprint_id));

-- ---------------------------------------------------------------------------
-- Seed: SSC CGL Tier 1 (owner-verified 2026-10-17). Fixed ids make re-runs no-ops.
-- Nodes are looked up in the platform frameworks; a missing node leaves the id NULL.
-- ---------------------------------------------------------------------------
INSERT INTO exam_blueprints (id, stage_node_id, edition, name, total_minutes, qualifying, verification_status, source_note)
VALUES (
  '5c0e6a10-0000-4000-8000-000000000001',
  (SELECT n.id FROM taxonomy_nodes n JOIN frameworks f ON f.id = n.framework_id
    WHERE f.tenant_id IS NULL AND f.slug = 'exam-structure' AND n.tenant_id IS NULL
      AND n.kind = 'stage' AND n.code = 'ssc-cgl-tier-1' LIMIT 1),
  'current', 'SSC CGL Tier 1', 60, true, 'verified',
  'Verified by the owner on 2026-10-17 against the official notice (EXP-0). Cutoff marks change every year and are not stored.'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO exam_blueprint_sections
  (id, blueprint_id, position, name, subject_node_id, question_count, marks_per_question,
   negative_marks_per_question, minutes, sectional_timing, qualifying, cutoff_marks, calculator_allowed, allowed_types)
SELECT s.id::uuid, '5c0e6a10-0000-4000-8000-000000000001', s.position, s.name,
       (SELECT n.id FROM taxonomy_nodes n JOIN frameworks f ON f.id = n.framework_id
         WHERE f.tenant_id IS NULL AND f.slug = 'subject-map' AND n.tenant_id IS NULL
           AND n.kind = 'subject' AND n.code = s.node_code LIMIT 1),
       25, 2, 0.5, NULL, false, false, NULL, false, ARRAY['mcq']::text[]
  FROM (VALUES
    ('5c0e6a10-0000-4000-8000-000000000011', 1, 'Reasoning',          'reasoning'),
    ('5c0e6a10-0000-4000-8000-000000000012', 2, 'General Awareness',  'general-awareness'),
    ('5c0e6a10-0000-4000-8000-000000000013', 3, 'Quantitative Aptitude (Quant)', 'quant'),
    ('5c0e6a10-0000-4000-8000-000000000014', 4, 'English',            'english')
  ) AS s(id, position, name, node_code)
 WHERE EXISTS (SELECT 1 FROM exam_blueprints WHERE id = '5c0e6a10-0000-4000-8000-000000000001')
ON CONFLICT DO NOTHING;
