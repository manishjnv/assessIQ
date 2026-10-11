// Pure helpers shared by the per-type hooks. No DB, no React, no imports from modules/*.

export type Dict = Record<string, unknown>;

export function isObj(v: unknown): v is Dict {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

export function asStr(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** First defined, non-null value among the candidate keys, else undefined. */
export function pick(obj: Dict, keys: string[]): unknown {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  }
  return undefined;
}

/** Drop undefined values so strict() validation sees a clean object. */
export function compact(obj: Dict): Dict {
  const out: Dict = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/** Coerce an array of finding/keyword entries to an array of strings. */
export function toStringArray(v: unknown, objKeys: string[]): unknown {
  if (!Array.isArray(v)) return v;
  return v.map((e) => {
    if (typeof e === "string") return e;
    if (isObj(e)) return asStr(pick(e, objKeys)) ?? "";
    return String(e);
  });
}

export function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/**
 * Candidate-view wrapper: a non-object `content` is returned unchanged (nothing to strip),
 * otherwise `fn` builds the allowlisted view. Fail-closed allowlists live in the type folders.
 */
export function candidateViewOf(fn: (c: Dict) => Dict): (content: unknown) => unknown {
  return (content) => (isObj(content) ? fn(content) : content);
}

/** Allowlist view: copies only the named keys that exist on the content. */
export function pickKeys(c: Dict, keys: readonly string[]): Dict {
  const out: Dict = {};
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(c, k)) out[k] = c[k];
  }
  return out;
}

/** Default guidance text: trimmed content.question, or "". */
export function questionStem(content: unknown): string {
  return str(((content ?? {}) as Dict).question).trim();
}

/** Default rubric text: content.question when a string, else the full JSON. */
export function questionOrJson(content: unknown): string {
  const c = content as Dict | null | undefined;
  return typeof c?.question === "string" ? c.question : JSON.stringify(content);
}

export type StructuralCheck = { ok: boolean; reason?: string };

/** Parse with the type's content schema, then run `check` on the parsed data. */
export function structuralOf<T>(
  schema: { safeParse(v: unknown): { success: true; data: T } | { success: false; error: { issues: { message: string }[] } } },
  check: (data: T) => string | null,
): (content: unknown) => StructuralCheck {
  return (content) => {
    const r = schema.safeParse(content);
    if (!r.success) return { ok: false, reason: `schemaValid: ${r.error.issues.map((e) => e.message).join("; ")}` };
    const reason = check(r.data);
    return reason === null ? { ok: true } : { ok: false, reason };
  };
}
