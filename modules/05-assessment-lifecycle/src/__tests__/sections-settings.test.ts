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

  it("rejects sections combined with a blueprint", () => {
    expect(() =>
      assertSectionsSettings({ sections: [ok], blueprint: {} } as never),
    ).toThrow(/cannot be combined with settings\.blueprint/);
  });
});
