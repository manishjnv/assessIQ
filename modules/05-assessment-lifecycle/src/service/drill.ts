// EXP-11: drill mode (admin path). A topic practice test: a DRAFT mock assessment with one section per chosen
// Subject-map node, a fixed question total split across the nodes, an optional difficulty range (FUT-9) and one
// whole-test timer. It goes through createAssessment (all guards run) and is scored by the normal fixed rules, so
// the result already shows per-section (per-topic) accuracy. No AI. Student self-service entry is not built.
import { ValidationError } from "@assessiq/core";
import { withTenant } from "@assessiq/tenancy";
import { MAX_QUESTIONS_PER_ASSESSMENT, type Assessment, type AssessmentSection } from "../types.js";
import { createAssessment } from "./assessments.js";

export interface CreateDrillInput {
  pack_id: string;
  level_id: string;
  /** Even split: these topics share `question_count`. Ignored when `topics` is given. */
  node_ids?: string[];
  question_count?: number;
  /** CT-0: one count per topic (uneven counts, one topic, fewer questions). The total is the sum. */
  topics?: Array<{ node_id: string; count: number }>;
  difficulty_min?: number;
  difficulty_max?: number;
  /** Whole-test minutes. Absent = 1.5 minutes per question, rounded up. */
  minutes?: number;
  opens_at: Date | null;
  closes_at?: Date | null;
  name?: string;
  /** Type-card settings (integrity, feedback_level) from the Mock card; merged as given, createAssessment validates them. */
  settings?: { integrity?: { fullscreen: boolean; block_copy_paste: boolean }; feedback_level?: "none" | "right_wrong" | "with_expected_answer" | "with_ai_justification" };
}

const bad = (message: string, param: string): ValidationError => new ValidationError(message, { details: { code: "INVALID_PARAM", param } });

/** A section named after its topic (the result page shows it). Falls back to "Topic N" when the node name is unknown. */
const topicName = (names: ReadonlyMap<string, string>, id: string, i: number): string => (names.get(id) ?? `Topic ${i + 1}`).slice(0, 80);

/**
 * CT-0: one section per topic with its own count. Pure; throws on a bad shape.
 * 1 to 10 distinct topics, each count at least 1, total at most 100.
 */
export function buildTopicSections(
  topics: ReadonlyArray<{ node_id: string; count: number }>,
  names: ReadonlyMap<string, string> = new Map(),
  diffMin?: number,
  diffMax?: number,
): AssessmentSection[] {
  if (topics.length === 0 || topics.length > 10) throw bad("pick 1 to 10 topics", "topics");
  if (new Set(topics.map((t) => t.node_id)).size !== topics.length) throw bad("a topic is listed twice", "topics");
  if (topics.some((t) => !Number.isInteger(t.count) || t.count < 1)) throw bad("each topic needs at least 1 question", "topics");
  const total = topics.reduce((n, t) => n + t.count, 0);
  if (total > MAX_QUESTIONS_PER_ASSESSMENT) throw bad("a test can have at most 100 questions", "topics");
  return topics.map((t, i) => ({
    name: topicName(names, t.node_id, i),
    node_id: t.node_id,
    question_count: t.count,
    ...(diffMin !== undefined ? { difficulty_min: diffMin } : {}),
    ...(diffMax !== undefined ? { difficulty_max: diffMax } : {}),
  }));
}

/** Split `count` over the nodes: even share, the remainder goes to the first nodes. Pure; throws on a bad shape. */
export function buildDrillSections(nodeIds: string[], count: number, diffMin?: number, diffMax?: number, names: ReadonlyMap<string, string> = new Map()): AssessmentSection[] {
  const nodes = [...new Set(nodeIds)];
  if (nodes.length === 0 || nodes.length > 10) throw new ValidationError("pick 1 to 10 topics", { details: { code: "INVALID_PARAM", param: "node_ids" } });
  if (!Number.isInteger(count) || count < nodes.length || count > MAX_QUESTIONS_PER_ASSESSMENT) {
    throw new ValidationError("question_count must be at least the number of topics and at most 100", { details: { code: "INVALID_PARAM", param: "question_count" } });
  }
  const base = Math.floor(count / nodes.length);
  const extra = count % nodes.length;
  return nodes.map((node_id, i) => ({
    name: topicName(names, node_id, i),
    node_id,
    question_count: base + (i < extra ? 1 : 0),
    ...(diffMin !== undefined ? { difficulty_min: diffMin } : {}),
    ...(diffMax !== undefined ? { difficulty_max: diffMax } : {}),
  }));
}

/** Real topic names for the section titles. Runs under the tenant session (RLS shows platform and own nodes). */
async function loadTopicNames(tenantId: string, ids: string[]): Promise<Map<string, string>> {
  const rows = await withTenant(tenantId, async (client) => (await client.query<{ id: string; name: string }>(
    `SELECT id, label AS name FROM taxonomy_nodes WHERE id = ANY($1::uuid[])`, [ids])).rows);
  return new Map(rows.map((r) => [r.id, r.name]));
}

export async function createDrill(tenantId: string, input: CreateDrillInput, createdByUserId: string): Promise<{ assessment: Assessment }> {
  const ids = input.topics?.map((t) => t.node_id) ?? input.node_ids ?? [];
  const names = ids.length > 0 && ids.length <= 10 ? await loadTopicNames(tenantId, ids) : new Map<string, string>();
  let sections: AssessmentSection[];
  let questionCount: number;
  if (input.topics !== undefined) {
    sections = buildTopicSections(input.topics, names, input.difficulty_min, input.difficulty_max);
    questionCount = input.topics.reduce((n, t) => n + t.count, 0);
  } else {
    if (input.node_ids === undefined || input.question_count === undefined) throw bad("give topics, or node_ids and question_count", "topics");
    sections = buildDrillSections(input.node_ids, input.question_count, input.difficulty_min, input.difficulty_max, names);
    questionCount = input.question_count;
  }
  const minutes = input.minutes ?? Math.ceil(questionCount * 1.5);
  const assessment = await createAssessment(
    tenantId,
    {
      pack_id: input.pack_id,
      level_id: input.level_id,
      name: input.name?.trim() || "Topic drill",
      question_count: questionCount,
      delivery_mode: "mock",
      opens_at: input.opens_at,
      ...(input.closes_at !== undefined ? { closes_at: input.closes_at } : {}),
      settings: { ...input.settings, sections, whole_test_minutes: Math.min(600, Math.max(1, minutes)), drill: true },
    },
    createdByUserId,
  );
  return { assessment };
}
