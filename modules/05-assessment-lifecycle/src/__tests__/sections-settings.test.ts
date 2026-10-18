import { describe, it, expect } from "vitest";
import { assertSectionsSettings } from "../service.js";

const ok = { name: "Quantitative", question_count: 20, minutes: 20, calculator: true };
const cat = "0a1b2c3d-0000-4000-8000-000000000001";

describe("settings.sections validation", () => {
  it("accepts valid sections (and none)", () => {
    expect(() => assertSectionsSettings(undefined)).not.toThrow();
    expect(() => assertSectionsSettings({})).not.toThrow();
    expect(() => assertSectionsSettings({ sections: [ok, { name: "Logical", category_ids: [cat], minutes: 15 }] })).not.toThrow();
  });

  it.each([
    ["empty list", []],
    ["11 sections", Array.from({ length: 11 }, () => ok)],
    ["no name", [{ ...ok, name: " " }]],
    ["minutes 0", [{ ...ok, minutes: 0 }]],
    ["minutes 301", [{ ...ok, minutes: 301 }]],
    ["no minutes", [{ name: "x", question_count: 1 }]],
    ["neither count nor categories", [{ name: "x", minutes: 5 }]],
    ["unknown key (strict)", [{ ...ok, extra: 1 }]],
    ["non-uuid category", [{ name: "x", minutes: 5, category_ids: ["nope"] }]],
  ])("rejects %s", (_n, sections) => {
    expect(() => assertSectionsSettings({ sections } as never)).toThrow(/settings\.sections is invalid/);
  });

  it("Z-42: whole_test_minutes replaces per-section minutes; marks per question is accepted", () => {
    const bare = { name: "Quant", question_count: 25, marks_per_question: 2, negative_marks_per_question: 0.5 };
    expect(() => assertSectionsSettings({ whole_test_minutes: 60, sections: [bare] } as never)).not.toThrow();
    expect(() => assertSectionsSettings({ sections: [bare] } as never)).toThrow(/needs minutes/); // no timer at all
    expect(() => assertSectionsSettings({ whole_test_minutes: 60, sections: [ok] } as never)).toThrow(/must not have minutes/);
    for (const bad of [0, 601, 1.5, "60"]) {
      expect(() => assertSectionsSettings({ whole_test_minutes: bad, sections: [bare] } as never)).toThrow(/whole_test_minutes/);
    }
    expect(() => assertSectionsSettings({ sections: [{ ...ok, marks_per_question: -1 }] } as never)).toThrow(/settings\.sections is invalid/);
  });

  it("rejects sections combined with a blueprint", () => {
    expect(() =>
      assertSectionsSettings({ sections: [ok], blueprint: {} } as never),
    ).toThrow(/cannot be combined with settings\.blueprint/);
  });
});
