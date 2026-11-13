// @vitest-environment node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "..", "..");
// The tool reads these three docs files; without them it skips (see tools/next-brief.mjs).
const inputsPresent = ["docs/SESSION_STATE.md", "docs/ROADMAP.md", "docs/RCA_LOG.md"].every((p) => existsSync(join(root, p)));

describe.skipIf(!inputsPresent)("next-brief", () => {
  it("writes docs/NEXT.md with every section and reports the size estimate", () => {
    const out = execFileSync("node", ["tools/next-brief.mjs"], { cwd: root, encoding: "utf8" });
    expect(out).toMatch(/output size: \d+ bytes, ~\d+ tokens \(estimate: bytes \/ 4\)/);
    const md = readFileSync(join(root, "docs/NEXT.md"), "utf8");
    expect(md).toContain("GENERATED FILE - do not edit. Run: node tools/next-brief.mjs");
    for (const heading of ["## 1. Last session", "## 2. ROADMAP status board", "## 3. Open Z and EXP rows", "## 4. Newest RCA", "## 5. Next free migration", "## 6. Reading list reminder"]) {
      expect(md).toContain(heading);
    }
    expect(md).not.toContain("## Agent utilization");
    expect(Buffer.byteLength(md, "utf8") / 4).toBeLessThan(30000);
  });
});

// Z-193: the newest block can start with "## PICK UP HERE"; an older "# Session" block lower in the file must not win.
describe("next-brief firstSessionBlock", () => {
  const load = async (): Promise<(lines: string[]) => string[]> =>
    (await import(/* @vite-ignore */ pathToFileURL(join(root, "tools/next-brief.mjs")).href)).firstSessionBlock;

  it("takes the top PICK UP HERE block and stops at its first sub-heading", async () => {
    const block = (await load())([
      "## PICK UP HERE: new work (S108)", "**Next:** do it", "", "### Agent utilization (S108)", "- Opus: x", "---",
      "# Session S103 addendum", "old", "---",
    ]);
    expect(block).toEqual(["### PICK UP HERE: new work (S108)", "**Next:** do it", ""]);
  });

  it("still reads an old # Session block up to the --- line", async () => {
    const block = (await load())(["intro", "# Session - 2026-10-18", "**Headline:** h", "---", "## Agent utilization"]);
    expect(block).toEqual(["## Session - 2026-10-18", "**Headline:** h"]);
  });
});
