// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parseText, summarize, TRIAL_START } from "../routing-report.mjs";

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
      Array.from({ length: n }, (_, i) => ({ route: "Haiku", task, reworked: i < reworked, gate: task.includes("gate"), tokens: null, date: "2026-10-18" }));
    expect(summarize(haiku(2, 1)).haikuTrial.result).toBe("TOO FEW RUNS (2 of 8)");
    expect(summarize(haiku(8, 2)).haikuTrial.result).toBe("CONTINUE"); // 25% is not above 25%
    expect(summarize(haiku(8, 3)).haikuTrial.result).toBe("STOP");
    // Gate runs are excluded from the non-gate rate.
    expect(summarize([...haiku(8, 0), ...haiku(4, 4, "gate check")]).haikuTrial.result).toBe("CONTINUE");
  });

  it("attaches the session header date to each run (TOK-6)", () => {
    const runs = parseText(
      [
        "# Session — 2026-10-10 — S1",
        "- Haiku: old task · 10k tokens (reworked: N)",
        "# Session S2 (2026-10-18): change record",
        "- Haiku: new task · reworked: Y",
        "Haiku · loose line · reworked: N",
        "No header line here",
      ].join("\n"),
    );
    expect(runs.map((r) => [r.date, r.reworked])).toEqual([
      ["2026-10-10", false],
      ["2026-10-18", true],
      ["2026-10-18", false],
    ]);
    expect(parseText("- Haiku: no header · reworked: N")[0].date).toBeNull();
  });

  it("counts the trial only from the start date and reports undated and earlier runs", () => {
    const run = (date: string | null, reworked: boolean, task = "docs sweep") => ({ route: "Haiku", task, reworked, gate: false, tokens: null, date, file: "docs/SESSION_STATE.md" });
    const runs = [
      ...Array.from({ length: 20 }, () => run("2026-10-10", true)), // before the start: ignored
      ...Array.from({ length: 3 }, () => run(null, true)), // undated: ignored
      ...Array.from({ length: 8 }, () => run("2026-10-18", false)),
    ];
    const trial = summarize(runs).haikuTrial;
    expect(TRIAL_START).toBe("2026-10-18");
    expect(trial.since).toBe("2026-10-18");
    expect(trial.runs).toBe(8);
    expect(trial.before).toBe(20);
    expect(trial.undated).toBe(3);
    expect(trial.files).toEqual({ "docs/SESSION_STATE.md": 8 });
    expect(trial.result).toBe("CONTINUE");
    // --since overrides the start date.
    expect(summarize(runs, "2026-10-01").haikuTrial.runs).toBe(28);
    expect(summarize(runs, "2026-10-19").haikuTrial.runs).toBe(0);
    // The all-time table still counts every run.
    expect(summarize(runs).routes.find((r) => r.route === "Haiku")?.runs).toBe(31);
  });
});
