/**
 * EXP-10 part 1 - attack list, pure part (no database): the image cleaner, alt text, the maths splitter and
 * the KaTeX save-time check. Test names carry the attack number from the S79 plan (A01 .. A22).
 */
import { describe, it, expect } from "vitest";
import katex from "katex";
import { cleanImage, cleanAltText, ASSET_MAX_BYTES } from "../assets/image-clean.js";
import { assertValidMath, KATEX_OPTIONS } from "../assets/rich-validate.js";
import { splitMath } from "@assessiq/question-types";
import { png, pngChunk, jpeg, GIF, SVG, HTML, PDF, ZIP_TAIL } from "./image-fixtures.js";

const code = (fn: () => unknown): string | undefined => {
  try { fn(); } catch (e) { return (e as { details?: { code?: string } }).details?.code ?? (e as { code?: string }).code; }
  return undefined;
};

describe("images: clean, check, strip", () => {
  it("accepts a valid PNG and a valid JPEG and reports their size", () => {
    expect(cleanImage(png({ w: 120, h: 80 }))).toMatchObject({ mime: "image/png", width: 120, height: 80 });
    expect(cleanImage(jpeg({ w: 200, h: 100 }))).toMatchObject({ mime: "image/jpeg", width: 200, height: 100 });
  });
  it("A01 SVG, HTML, script and PDF files are refused, whatever the client says", () => {
    for (const f of [SVG, HTML, PDF]) expect(code(() => cleanImage(f))).toBe("ASSET_BAD_FORMAT");
  });
  it("A02 polyglot: PNG or JPEG with bytes appended (ZIP, HTML, PHP) is refused", () => {
    expect(code(() => cleanImage(png({ trailing: ZIP_TAIL })))).toBe("ASSET_TRAILING_DATA");
    expect(code(() => cleanImage(png({ trailing: HTML })))).toBe("ASSET_TRAILING_DATA");
    expect(code(() => cleanImage(jpeg({ trailing: ZIP_TAIL })))).toBe("ASSET_TRAILING_DATA");
    expect(code(() => cleanImage(jpeg({ trailing: Buffer.from("<?php system($_GET[0]); ?>") })))).toBe("ASSET_TRAILING_DATA");
  });
  it("A03 type spoof: GIF, SVG and PDF bytes behind an image name or type are refused; the file name is never read", () => {
    expect(code(() => cleanImage(GIF))).toBe("ASSET_BAD_FORMAT");
    expect(code(() => cleanImage(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), SVG])))).toBeDefined();
    // cleanImage takes bytes only: there is no name or mime argument to spoof.
    expect(cleanImage.length).toBe(1);
  });
  it("A04 dimensions come from the header and are capped; a bomb-shaped PNG is judged without being inflated", () => {
    expect(code(() => cleanImage(png({ w: 60000, h: 60000 })))).toBe("ASSET_BAD_DIMENSIONS");
    expect(code(() => cleanImage(png({ w: 3, h: 3 })))).toBe("ASSET_BAD_DIMENSIONS");
    expect(code(() => cleanImage(jpeg({ w: 65535, h: 65535 })))).toBe("ASSET_BAD_DIMENSIONS");
    expect(code(() => cleanImage(png({ w: 4001, h: 100 })))).toBe("ASSET_BAD_DIMENSIONS");
    const t0 = Date.now();
    const r = cleanImage(png({ w: 3900, h: 4000 })); // 15.6 million pixels, under the 16 million cap, never inflated
    expect(r.width).toBe(3900);
    expect(Date.now() - t0).toBeLessThan(500);
    // A chunk that claims more bytes than the file holds.
    const lie = png();
    lie.writeUInt32BE(0x7fffffff, 8);
    expect(code(() => cleanImage(lie))).toBe("ASSET_CORRUPT");
  });
  it("A05 corrupt or truncated files: bad checksum, missing end, cut short, unsupported JPEG kinds", () => {
    expect(code(() => cleanImage(png({ badCrc: true })))).toBe("ASSET_CORRUPT");
    expect(code(() => cleanImage(png({ noIend: true })))).toBe("ASSET_CORRUPT");
    expect(code(() => cleanImage(png().subarray(0, 40)))).toBe("ASSET_CORRUPT");
    expect(code(() => cleanImage(jpeg().subarray(0, 30)))).toBe("ASSET_CORRUPT");
    expect(code(() => cleanImage(jpeg({ sof: 0xc3 })))).toBe("ASSET_BAD_FORMAT"); // lossless JPEG
    expect(code(() => cleanImage(jpeg({ comps: 4 })))).toBe("ASSET_BAD_FORMAT"); // CMYK
    expect(code(() => cleanImage(Buffer.alloc(0)))).toBe("ASSET_EMPTY");
  });
  it("A06 metadata is stripped: EXIF and GPS in a JPEG, text and eXIf chunks in a PNG never reach the stored bytes", () => {
    const exif = Buffer.from("Exif\0\0MM\0*GPSLatitude=12.97;GPSLongitude=77.59;Make=SecretCam", "latin1");
    const j = cleanImage(jpeg({ app1: exif, com: Buffer.from("hidden comment HIDE-ME"), adobe: true }));
    expect(j.data.includes(Buffer.from("GPSLatitude"))).toBe(false);
    expect(j.data.includes(Buffer.from("HIDE-ME"))).toBe(false);
    expect(j.data.includes(Buffer.from("Adobe"))).toBe(true); // colour transform flag is kept
    const p = cleanImage(png({ extra: [pngChunk("tEXt", Buffer.from("Comment\0GPSLatitude=12.97")), pngChunk("eXIf", exif), pngChunk("iTXt", Buffer.from("XML:com.adobe.xmp\0secret"))] }));
    expect(p.data.includes(Buffer.from("GPSLatitude"))).toBe(false);
    expect(p.data.includes(Buffer.from("tEXt"))).toBe(false);
    expect(p.data.includes(Buffer.from("eXIf"))).toBe(false);
    expect(code(() => cleanImage(png({ extra: [pngChunk("ABCD", Buffer.alloc(2))] })))).toBe("ASSET_CORRUPT"); // unknown required chunk
  });
  it("A07 oversize: more than 400 KB is refused before any parsing", () => {
    expect(code(() => cleanImage(Buffer.alloc(ASSET_MAX_BYTES + 1, 1)))).toBe("ASSET_TOO_LARGE");
  });
  it("A14 alt text: required, 5 to 300 characters, plain text on one line (stored as text, drawn as text)", () => {
    expect(code(() => cleanAltText(undefined))).toBe("ASSET_ALT_REQUIRED");
    expect(code(() => cleanAltText("   hi "))).toBe("ASSET_ALT_REQUIRED");
    expect(code(() => cleanAltText("x".repeat(301)))).toBe("ASSET_ALT_INVALID");
    expect(code(() => cleanAltText("line one\nline two"))).toBe("ASSET_ALT_INVALID");
    expect(code(() => cleanAltText("bad\u0000byte"))).toBe("ASSET_ALT_INVALID");
    expect(cleanAltText("  Bar chart   of   sales  ")).toBe("Bar chart of sales");
    // markup in alt text is kept as inert text: React only ever draws it as a text node or an attribute value.
    expect(cleanAltText('<img src=x onerror="alert(1)"> diagram')).toContain("<img");
  });
});

describe("maths: split and save-time check", () => {
  const field = (tex: string) => ({ question: `Find \\(${tex}\\) now`, options: ["a", "b"], correct: 0, rationale: "r", math: true });
  it("splits inline and display parts and flags broken delimiters", () => {
    expect(splitMath("a \\(x^2\\) b \\[y\\]")).toEqual({ ok: true, parts: [
      { kind: "text", value: "a " }, { kind: "inline", value: "x^2" }, { kind: "text", value: " b " }, { kind: "display", value: "y" }] });
    expect(splitMath("open \\(x").ok).toBe(false);
    expect(splitMath("close x\\)").ok).toBe(false);
    expect(splitMath("nest \\(a \\(b\\) \\)").ok).toBe(false);
    expect(splitMath("price $5 and $10").ok).toBe(true); // dollar signs are plain text
  });
  it("accepts good LaTeX and ignores questions without the math flag", () => {
    expect(() => assertValidMath(field("\\frac{a}{b} + \\sqrt{x}"))).not.toThrow();
    expect(() => assertValidMath({ question: "Broken \\(\\frac{ here", math: false })).not.toThrow(); // old content never changes
    expect(() => assertValidMath({ question: "No flag \\(\\href{x}{y}\\)" })).not.toThrow();
  });
  it("A18 links, raw html and file commands are refused: \\href javascript, \\url, \\includegraphics, \\htmlStyle", () => {
    for (const tex of ["\\href{javascript:alert(1)}{x}", "\\url{http://evil}", "\\includegraphics{x.png}", "\\htmlStyle{color:red}{x}", "\\htmlClass{a}{x}", "\\verb|x|"]) {
      expect(code(() => assertValidMath(field(tex))), tex).toBe("INVALID_MATH");
    }
  });
  it("A19 macro bombs, huge sizes and deep nesting are refused or bounded", () => {
    expect(code(() => assertValidMath(field("\\def\\a{\\a\\a}\\a")))).toBe("INVALID_MATH");
    expect(code(() => assertValidMath(field("\\newcommand{\\x}{y}\\x")))).toBe("INVALID_MATH");
    // KaTeX caps user sizes to maxSize (20 em) instead of failing: the page never gets a 9999 em box.
    for (const tex of ["\\rule{9999em}{9999em}", "\\hspace{9999em}x"]) {
      // The MathML annotation keeps the source text; look at the drawn html only, and every size in it.
      const drawn = katex.renderToString(tex, { ...KATEX_OPTIONS, displayMode: false }).replace(/<math[\s\S]*?<\/math>/g, "");
      const sizes = [...drawn.matchAll(/(\d+(?:\.\d+)?)em/g)].map((m) => Number(m[1]));
      expect(sizes.length).toBeGreaterThan(0);
      expect(Math.max(...sizes)).toBeLessThanOrEqual(20);
    }
    expect(code(() => assertValidMath(field("{".repeat(300) + "x" + "}".repeat(300))))).toBe("INVALID_MATH"); // over 500 characters
    expect(code(() => assertValidMath(field("x".repeat(501))))).toBe("INVALID_MATH");
    expect(code(() => assertValidMath({ question: "\\(x\\) ".repeat(31), math: true }))).toBe("INVALID_MATH"); // 31 expressions
    expect(code(() => assertValidMath(field("\\frac{1}{")))).toBe("INVALID_MATH"); // does not parse
  });
  it("A20 the rendered html has no script, no href and no event attribute (same options as the page)", () => {
    for (const tex of ["x^2 + \\sqrt{y}", "\\frac{\\alpha}{\\beta}", "\\text{<img src=x onerror=alert(1)>}", "\\text{javascript:alert(1)}"]) {
      const html = katex.renderToString(tex, { ...KATEX_OPTIONS, displayMode: false });
      // Look at real tags only: text such as "onerror=" inside a text node is escaped and harmless.
      expect(/<(script|img|iframe|object|embed|a)[\s>]/i.test(html), tex).toBe(false);
      expect(/<[^>]*\s(href|src|on[a-z]+)\s*=/i.test(html), tex).toBe(false);
    }
  });
});
