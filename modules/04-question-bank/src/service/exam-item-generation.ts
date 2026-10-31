/**
 * EXP-7: super-admin click path for exam-item generation (A1 new original, A2 light edit).
 *
 * Reuses the existing global generation single-flight lease (withAiLock in generation.ts).
 * The AI runtime hook (skill `gen-exam-items` on the VPS, run by module 07) is NOT wired yet:
 * the default `run` dependency throws 501 EXAMGEN_RUNTIME_NOT_WIRED, so no AI call can happen
 * from this file. When 07 supplies the hook it returns the drafts plus the private seeds and
 * the platform-bank texts, loaded on the VPS at run time and held in memory only.
 */

import { ValidationError } from "@assessiq/core";
import {
  EXAM_ITEM_MODES,
  gateA1,
  gateA2,
  itemText,
  provenanceFor,
  type ExamItemMode,
  type GateResult,
} from "../exam-item-gate.js";
import { withAiLock } from "./generation.js";
import { _notImplemented, log } from "./_shared.js";

export interface ExamItemRequest {
  mode: ExamItemMode;
  /** A1: concept to write about. */
  concept?: string | undefined;
  /** A2: references of the source questions to light-edit (kept on the row as source_ref). */
  sourceRefs?: string[] | undefined;
  count: number;
}

export interface ExamDraft {
  stem: string;
  options?: string[] | undefined;
  /** A2 only: the source reference this draft was edited from. */
  sourceRef?: string | undefined;
}

export interface ExamRunResult {
  drafts: ExamDraft[];
  /** A1: private seed texts. A2: source texts keyed by reference. */
  seeds: string[];
  sources: Record<string, string>;
  bank: string[];
}

export interface ExamGeneratedItem {
  draft: ExamDraft;
  gate: GateResult;
  provenance: ReturnType<typeof provenanceFor> | null;
}

export interface ExamItemDeps {
  run: (req: ExamItemRequest, signal: AbortSignal) => Promise<ExamRunResult>;
  lock: <T>(key: string, run: (signal: AbortSignal) => Promise<T>) => Promise<T>;
}

const defaultDeps: ExamItemDeps = {
  run: () => {
    throw _notImplemented("exam-item runtime hook is not wired in module 07 yet", "EXAMGEN_RUNTIME_NOT_WIRED");
  },
  lock: withAiLock,
};

/** Validate the mode-specific part of the request body. Domain, level and count are validated by the route. */
export function parseExamItemBody(raw: unknown, count: number): ExamItemRequest {
  const b = (raw ?? {}) as { mode?: unknown; concept?: unknown; source_refs?: unknown };
  if (typeof b.mode !== "string" || !(EXAM_ITEM_MODES as readonly string[]).includes(b.mode)) {
    throw new ValidationError("mode must be a1 or a2", { details: { code: "INVALID_PARAM", param: "mode" } });
  }
  const mode = b.mode as ExamItemMode;
  const noCtl = /[\u0000-\u001f\u007f]/;
  if (mode === "a1") {
    const concept = typeof b.concept === "string" ? b.concept.trim() : "";
    if (concept.length === 0 || concept.length > 200 || noCtl.test(concept)) {
      throw new ValidationError("concept must be 1 to 200 characters with no control characters", {
        details: { code: "INVALID_PARAM", param: "concept" },
      });
    }
    return { mode, concept, count };
  }
  const refs = b.source_refs;
  if (!Array.isArray(refs) || refs.length === 0 || refs.length > 30 ||
      refs.some((r) => typeof r !== "string" || r.trim() === "" || r.length > 500 || noCtl.test(r))) {
    throw new ValidationError("source_refs must be 1 to 30 strings of at most 500 characters", {
      details: { code: "INVALID_PARAM", param: "source_refs" },
    });
  }
  return { mode, sourceRefs: (refs as string[]).map((r) => r.trim()), count };
}

/** Apply the similarity gate to run output. Pure apart from the logging. */
export function gateExamDrafts(mode: ExamItemMode, res: ExamRunResult): ExamGeneratedItem[] {
  return res.drafts.map((draft) => {
    const text = itemText(draft);
    if (mode === "a1") {
      return { draft, gate: gateA1(text, res.seeds), provenance: provenanceFor("a1") };
    }
    const src = draft.sourceRef !== undefined ? res.sources[draft.sourceRef] : undefined;
    const gate = gateA2(text, src, res.bank);
    return { draft, gate, provenance: draft.sourceRef ? provenanceFor("a2", draft.sourceRef) : null };
  });
}

/**
 * One admin click = one run under the single-flight lease (409 if another AI job holds it).
 * Returns only gate-passing items for persistence as ai_draft; rejected items are counted, not returned.
 */
export async function runExamItemGenerate(
  tenantId: string,
  req: ExamItemRequest,
  deps: ExamItemDeps = defaultDeps,
): Promise<{ accepted: ExamGeneratedItem[]; rejected: { reason: string; score: number }[] }> {
  const res = await deps.lock(`exam-items:${tenantId}`, (signal) => deps.run(req, signal));
  const gated = gateExamDrafts(req.mode, res);
  const accepted = gated.filter((g) => g.gate.ok);
  const rejected = gated.filter((g) => !g.gate.ok).map((g) => ({ reason: g.gate.reason, score: g.gate.score }));
  log.info({ tenantId, mode: req.mode, accepted: accepted.length, rejected: rejected.length }, "examgen.gated");
  return { accepted, rejected };
}
