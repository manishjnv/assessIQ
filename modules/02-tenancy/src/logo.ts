import { sha256Hex } from "@assessiq/core";

export const LOGO_MAX_BYTES = 512 * 1024;
export const LOGO_MIN_PX = 32;
export const LOGO_MAX_PX = 2048;

export type LogoMime = "image/png" | "image/jpeg";
export type LogoErrorCode = "LOGO_TOO_LARGE" | "LOGO_BAD_FORMAT" | "LOGO_BAD_DIMENSIONS";

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Magic-byte sniff; never trusts a client-declared mime. Only PNG and JPEG. */
export function sniffImage(
  buf: Buffer,
): { mime: LogoMime; width: number; height: number } | { error: string } {
  if (buf.length >= 24 && buf.subarray(0, 8).equals(PNG_SIG) && buf.toString("latin1", 12, 16) === "IHDR") {
    return { mime: "image/png", width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    let i = 2;
    while (i + 4 <= buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1]!;
      if (marker === 0xff) { i++; continue; }            // fill byte
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; } // no length
      if (marker === 0xd9 || marker === 0xda) break;     // EOI / SOS before any SOF
      const len = buf.readUInt16BE(i + 2);
      if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
        if (i + 9 > buf.length) break;
        return { mime: "image/jpeg", height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      i += 2 + len;
    }
    return { error: "JPEG has no readable size header" };
  }
  return { error: "Only PNG and JPEG logos are accepted" };
}

export type LogoValidation =
  | { ok: true; mime: LogoMime; width: number; height: number; sha256: string }
  | { ok: false; code: LogoErrorCode; message: string };

export function validateLogo(buf: Buffer): LogoValidation {
  if (buf.length > LOGO_MAX_BYTES) {
    return { ok: false, code: "LOGO_TOO_LARGE", message: "The logo is larger than 512 KB." };
  }
  const s = sniffImage(buf);
  if ("error" in s) return { ok: false, code: "LOGO_BAD_FORMAT", message: s.error };
  const bad = (n: number): boolean => n < LOGO_MIN_PX || n > LOGO_MAX_PX;
  if (bad(s.width) || bad(s.height)) {
    return {
      ok: false,
      code: "LOGO_BAD_DIMENSIONS",
      message: `The logo must be ${LOGO_MIN_PX} to ${LOGO_MAX_PX} pixels on each side.`,
    };
  }
  return { ok: true, ...s, sha256: sha256Hex(buf) };
}
