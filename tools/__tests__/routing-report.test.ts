// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parseText, summarize } from "../routing-report.mjs";

describe("routing report parser (Z-66)", () => {
  it("reads footer, packed, prose and new-template telemetry lines", () => {
    const runs = parseText(
      [
        "  - Sonnet · Z-47 signed-in sweep · reworked: Y (port 3000 blocker; Opus fixed the port)",
        "Sonnet · Z-7 take submit · reworked: N · Sonnet · Z-9 copy · reworked: N",
        "- Haiku: Phase 0 digest · 117k tokens (reworked: N)",
        "- Sonnet: `ci.yml` rewrite 117k tokens (reworked: N); flaky 108k (reworked: Y)",
        "- Haiku 5.5 · Z-70 copy · reworked: N · tokens: 87000",
        "- Haiku: n/a — no delegation this session",
      ].join("\r\n"),
    );
    expect(runs.map((r) => r.route)).toEqual(["Sonnet", "Sonnet", "Sonnet", "Haiku", "Sonnet", "Sonnet", "Haiku"]);
    expect(runs.filter((r) => r.reworked)).toHaveLength(2);
    expect(runs.find((r) => r.task === "Z-70 copy")?.tokens).toBe(87000);
    expect(runs.find((r) => r.task.startsWith("Phase 0"))?.tokens).toBe(117000);
  });

  it("applies the Haiku 5.5 stop rule after 8 non-gate runs", () => {
    const haiku = (n: number, reworked: number, task = "docs sweep") =>
      Array.from({ length: n }, (_, i) => ({ route: "Haiku", task, reworked: i < reworked, gate: task.includes("gate"), tokens: null }));
    expect(summarize(haiku(2, 1)).haikuTrial.result).toBe("TOO FEW RUNS (2 of 8)");
    expect(summarize(haiku(8, 2)).haikuTrial.result).toBe("CONTINUE"); // 25% is not above 25%
    expect(summarize(haiku(8, 3)).haikuTrial.result).toBe("STOP");
    // Gate runs are excluded from the non-gate rate.
    expect(summarize([...haiku(8, 0), ...haiku(4, 4, "gate check")]).haikuTrial.result).toBe("CONTINUE");
  });
});
