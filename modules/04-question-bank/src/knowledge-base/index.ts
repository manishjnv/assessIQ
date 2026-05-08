/**
 * SOC Knowledge Base — unified export
 *
 * The KB is split into three level-specific files to keep each Write
 * call within token budget limits.  This index re-assembles them into
 * a single typed array consumed by the AI question generator.
 *
 * Quarterly refresh process (from modules/04-question-bank/SKILL.md):
 *   1. Edit soc-l1.json / soc-l2.json / soc-l3.json with new entries or
 *      updated citations.  Bump the `version` field in each file.
 *   2. Run `pnpm tsx modules/04-question-bank/src/knowledge-base/index.ts`
 *      to validate all entries pass the Zod schema.
 *   3. Commit and re-deploy — the new version propagates to the generator
 *      on next admin click.
 */

import { z } from "zod";
import l1Raw from "./soc-l1.json" with { type: "json" };
import l2Raw from "./soc-l2.json" with { type: "json" };
import l3Raw from "./soc-l3.json" with { type: "json" };

// ---------------------------------------------------------------------------
// Zod schema for a single KB source entry
// ---------------------------------------------------------------------------

export const KbSourceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  citation: z.string().min(1),
  url: z.string().url(),
  level_fit: z.enum(["L1", "L2", "L3"]),
  function: z.enum([
    "triage",
    "analysis",
    "detection",
    "forensics",
    "hunting",
    "response",
    "intelligence",
    "governance",
    "architecture",
  ]),
  description: z.string().min(20),
  tags: z.array(z.string().min(1)).min(1),
  kb_version: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export type KbSource = z.infer<typeof KbSourceSchema>;

// ---------------------------------------------------------------------------
// File-level schema — validates level_fit consistency per file
// ---------------------------------------------------------------------------

const KbFileSchema = z.object({
  version: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  level_fit: z.enum(["L1", "L2", "L3"]),
  sources: z.array(KbSourceSchema),
}).superRefine((file, ctx) => {
  file.sources.forEach((source, i) => {
    if (source.level_fit !== file.level_fit) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sources", i, "level_fit"],
        message: `Entry '${source.id}' has level_fit '${source.level_fit}' but file declares '${file.level_fit}'`,
      });
    }
  });
});

// ---------------------------------------------------------------------------
// Parse + validate at module load time (fails fast on corrupt KB files)
// ---------------------------------------------------------------------------

function parseFile(raw: unknown, filename: string) {
  const result = KbFileSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  [${i.path.join(".")}] ${i.message}`)
      .join("\n");
    throw new Error(`SOC KB validation failed in ${filename}:\n${issues}`);
  }
  return result.data;
}

const l1 = parseFile(l1Raw, "soc-l1.json");
const l2 = parseFile(l2Raw, "soc-l2.json");
const l3 = parseFile(l3Raw, "soc-l3.json");

// ---------------------------------------------------------------------------
// Public exports
// ---------------------------------------------------------------------------

/** All 70 KB entries in a single flat array — the primary export. */
export const SOC_KNOWLEDGE_BASE: KbSource[] = [
  ...l1.sources,
  ...l2.sources,
  ...l3.sources,
];

/** KB version derived from the most recent of the three file versions. */
export const SOC_KB_VERSION: string = [l1.version, l2.version, l3.version]
  .sort()
  .at(-1)!;

/** Lookup table: id → KbSource, for O(1) resolution when inserting rows. */
export const SOC_KB_BY_ID: ReadonlyMap<string, KbSource> = new Map(
  SOC_KNOWLEDGE_BASE.map((s) => [s.id, s]),
);

/** Entries grouped by level_fit.  Used by the generator to slice context. */
export const SOC_KB_BY_LEVEL: Record<"L1" | "L2" | "L3", KbSource[]> = {
  L1: l1.sources,
  L2: l2.sources,
  L3: l3.sources,
};

/** Unique function categories present in the KB — for topic-focus chips. */
export const SOC_KB_FUNCTIONS: ReadonlyArray<KbSource["function"]> = [
  ...new Set(SOC_KNOWLEDGE_BASE.map((s) => s.function)),
] as KbSource["function"][];

// ---------------------------------------------------------------------------
// Standalone validation entry-point (quarterly-refresh check)
// ---------------------------------------------------------------------------

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
  console.log(`SOC KB loaded successfully.`);
  console.log(`  L1: ${l1.sources.length} entries`);
  console.log(`  L2: ${l2.sources.length} entries`);
  console.log(`  L3: ${l3.sources.length} entries`);
  console.log(`  Total: ${SOC_KNOWLEDGE_BASE.length} entries`);
  console.log(`  Version: ${SOC_KB_VERSION}`);
  console.log(`  Functions: ${SOC_KB_FUNCTIONS.join(", ")}`);
}
