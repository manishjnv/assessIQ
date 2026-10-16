import { describe, it, expect } from "vitest";
import { sniffImage, validateLogo, LOGO_MAX_BYTES } from "../logo.js";

function png(w: number, h: number, extra = 0): Buffer {
  const b = Buffer.alloc(33 + extra);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "latin1");
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}

// SOI + APP0 (len 16) + SOF0 (len 17, precision 8, height, width)
function jpeg(w: number, h: number): Buffer {
  const app0 = Buffer.concat([Buffer.from([0xff, 0xe0, 0x00, 0x10]), Buffer.alloc(14)]);
  const sof = Buffer.alloc(19);
  sof.set([0xff, 0xc0, 0x00, 0x11, 0x08], 0);
  sof.writeUInt16BE(h, 5);
  sof.writeUInt16BE(w, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]).subarray(0, 2), app0, sof]);
}

describe("sniffImage", () => {
  it("reads PNG size", () => {
    expect(sniffImage(png(200, 100))).toEqual({ mime: "image/png", width: 200, height: 100 });
  });
  it("reads JPEG size past an APP0 segment", () => {
    // jpeg() builds FF D8 + FF E0 ... so the third byte is FF as the sniff requires
    expect(sniffImage(jpeg(640, 480))).toEqual({ mime: "image/jpeg", width: 640, height: 480 });
  });
  it("rejects SVG, truncated PNG and a JPEG with no SOF", () => {
    expect("error" in sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"/>'))).toBe(true);
    expect("error" in sniffImage(png(64, 64).subarray(0, 20))).toBe(true);
    expect("error" in sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xd9]))).toBe(true);
  });
});

describe("validateLogo", () => {
  it("accepts a valid PNG and returns a sha256", () => {
    const r = validateLogo(png(256, 128));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
  it("accepts a valid JPEG", () => {
    expect(validateLogo(jpeg(64, 64)).ok).toBe(true);
  });
  it("rejects SVG and truncated PNG as LOGO_BAD_FORMAT", () => {
    const svg = validateLogo(Buffer.from("<svg></svg>"));
    expect(svg).toMatchObject({ ok: false, code: "LOGO_BAD_FORMAT" });
    expect(validateLogo(png(64, 64).subarray(0, 10))).toMatchObject({ ok: false, code: "LOGO_BAD_FORMAT" });
  });
  it("rejects 1x1 and 4000px images as LOGO_BAD_DIMENSIONS", () => {
    expect(validateLogo(png(1, 1))).toMatchObject({ ok: false, code: "LOGO_BAD_DIMENSIONS" });
    expect(validateLogo(png(2049, 100))).toMatchObject({ ok: false, code: "LOGO_BAD_DIMENSIONS" });
    expect(validateLogo(png(32, 32)).ok).toBe(true);
    expect(validateLogo(png(2048, 2048)).ok).toBe(true);
  });
  it("rejects 600 KB as LOGO_TOO_LARGE before sniffing", () => {
    expect(validateLogo(png(64, 64, 600 * 1024))).toMatchObject({ ok: false, code: "LOGO_TOO_LARGE" });
    expect(validateLogo(png(64, 64, LOGO_MAX_BYTES - 33)).ok).toBe(true);
  });
});
