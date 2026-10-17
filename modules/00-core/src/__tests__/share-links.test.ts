import { describe, it, expect } from "vitest";
import { buildShareLinks } from "../share-links.js";

describe("buildShareLinks", () => {
  it("encodes the verify URL and text", () => {
    const l = buildShareLinks("https://a.test/verify/AIQ-1?x=a&b=c", "I passed & earned it")!;
    expect(l.linkedin).toBe(
      "https://www.linkedin.com/sharing/share-offsite/?url=" + encodeURIComponent("https://a.test/verify/AIQ-1?x=a&b=c"),
    );
    expect(l.x).toContain("&text=I%20passed%20%26%20earned%20it");
    expect(l.whatsapp.startsWith("https://wa.me/?text=")).toBe(true);
    expect(l.whatsapp).not.toContain(" ");
    expect(l.copy).toBe("https://a.test/verify/AIQ-1?x=a&b=c");
  });
  it("rejects non-https and invalid URLs", () => {
    expect(buildShareLinks("http://a.test/v", "t")).toBeNull();
    expect(buildShareLinks("javascript:alert(1)", "t")).toBeNull();
    expect(buildShareLinks("nope", "t")).toBeNull();
  });
});
