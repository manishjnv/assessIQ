// @vitest-environment node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "..", "..");

describe("next-brief", () => {
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
