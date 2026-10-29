// EXP-10 part 1: strict PNG / JPEG structure check and metadata strip. Pure: no DB, no I/O.
//
// WHY a parser and not a library: the API has no image library, and we never need pixels. We read only the chunk /
// marker structure, verify it, keep the chunks a browser needs and drop everything else (EXIF, GPS, text chunks,
// ICC profiles, comments, thumbnails). Bytes after the end marker are refused (polyglot files). Nothing is inflated,
// so a decompression bomb costs nothing here; the dimensions come from the header and are capped.
//
// ponytail: a JPEG that needs an Adobe colour transform keeps its APP14 "Adobe" segment; every other APPn and COM goes.
// CMYK, arithmetic coding, lossless JPEG and 12-bit JPEG are refused (browsers do not draw them reliably).
import { crc32 } from "node:zlib";
import { AppError } from "@assessiq/core";

export const ASSET_MAX_BYTES = 400 * 1024;
export const ASSET_MIN_PX = 16;
export const ASSET_MAX_PX = 4000;
export const ASSET_MAX_PIXELS = 16_000_000;

export interface CleanImage {
  mime: "image/png" | "image/jpeg";
  width: number;
  height: number;
  data: Buffer;
}

const bad = (message: string, code = "ASSET_BAD_FORMAT", status = 422): AppError =>
  new AppError(message, code, status, { details: { code } });

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_KEEP = new Set(["IHDR", "PLTE", "tRNS", "IDAT", "IEND", "gAMA", "cHRM", "sRGB", "pHYs", "sBIT"]);
const PNG_CRITICAL = new Set(["IHDR", "PLTE", "IDAT", "IEND"]);
const MAX_CHUNKS = 4096;

function checkDims(w: number, h: number): void {
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < ASSET_MIN_PX || h < ASSET_MIN_PX || w > ASSET_MAX_PX || h > ASSET_MAX_PX || w * h > ASSET_MAX_PIXELS) {
    throw bad(`The image must be ${ASSET_MIN_PX} to ${ASSET_MAX_PX} pixels on each side.`, "ASSET_BAD_DIMENSIONS");
  }
}

function cleanPng(buf: Buffer): CleanImage {
  const parts: Buffer[] = [PNG_SIG];
  let off = 8;
  let first = true;
  let idat = false;
  let width = 0;
  let height = 0;
  let ended = false;
  let n = 0;
  while (off < buf.length) {
    if (++n > MAX_CHUNKS) throw bad("The PNG has too many chunks.", "ASSET_CORRUPT");
    if (off + 12 > buf.length) throw bad("The PNG is cut short.", "ASSET_CORRUPT");
    const len = buf.readUInt32BE(off);
    if (len > buf.length - off - 12) throw bad("A PNG chunk is longer than the file.", "ASSET_CORRUPT");
    const type = buf.toString("latin1", off + 4, off + 8);
    if (!/^[A-Za-z]{4}$/.test(type)) throw bad("The PNG has a bad chunk name.", "ASSET_CORRUPT");
    const end = off + 12 + len;
    if (crc32(buf.subarray(off + 4, off + 8 + len)) !== buf.readUInt32BE(off + 8 + len)) throw bad("The PNG failed its checksum.", "ASSET_CORRUPT");
    if (first) {
      if (type !== "IHDR" || len !== 13) throw bad("The PNG header is wrong.", "ASSET_CORRUPT");
      width = buf.readUInt32BE(off + 8);
      height = buf.readUInt32BE(off + 12);
      const [depth, color, comp, filt, inter] = [buf[off + 16]!, buf[off + 17]!, buf[off + 18]!, buf[off + 19]!, buf[off + 20]!];
      if (![1, 2, 4, 8, 16].includes(depth) || ![0, 2, 3, 4, 6].includes(color) || comp !== 0 || filt !== 0 || inter > 1) throw bad("The PNG header is wrong.", "ASSET_CORRUPT");
      checkDims(width, height);
      first = false;
    } else if (type === "IHDR") {
      throw bad("The PNG has two headers.", "ASSET_CORRUPT");
    }
    const isCritical = (type.charCodeAt(0) & 0x20) === 0;
    if (isCritical && !PNG_CRITICAL.has(type)) throw bad("The PNG has an unknown required chunk.", "ASSET_CORRUPT");
    if (type === "IDAT") idat = true;
    if (PNG_KEEP.has(type)) parts.push(buf.subarray(off, end));
    off = end;
    if (type === "IEND") {
      if (len !== 0) throw bad("The PNG end chunk is wrong.", "ASSET_CORRUPT");
      ended = true;
      break;
    }
  }
  if (!ended || !idat) throw bad("The PNG is incomplete.", "ASSET_CORRUPT");
  if (off !== buf.length) throw bad("The file has extra bytes after the end of the image.", "ASSET_TRAILING_DATA");
  return { mime: "image/png", width, height, data: Buffer.concat(parts) };
}

const SOF_OK = new Set([0xc0, 0xc1, 0xc2]);
const SOF_NO = new Set([0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function cleanJpeg(buf: Buffer): CleanImage {
  const parts: Buffer[] = [buf.subarray(0, 2)];
  let i = 2;
  let width = 0;
  let height = 0;
  let sof = false;
  let sos = false;
  let ended = false;
  let guard = 0;
  while (i < buf.length) {
    if (++guard > 8192) throw bad("The JPEG has too many segments.", "ASSET_CORRUPT");
    if (buf[i] !== 0xff) throw bad("The JPEG has bytes where a marker should be.", "ASSET_CORRUPT");
    while (i + 1 < buf.length && buf[i + 1] === 0xff) i++; // fill bytes
    if (i + 1 >= buf.length) throw bad("The JPEG is cut short.", "ASSET_CORRUPT");
    const m = buf[i + 1]!;
    const markerAt = i;
    i += 2;
    if (m === 0xd9) {
      if (!sof || !sos) throw bad("The JPEG has no image data.", "ASSET_CORRUPT");
      parts.push(Buffer.from([0xff, 0xd9]));
      ended = true;
      break;
    }
    if (m === 0x00 || m === 0x01 || m === 0xd8 || (m >= 0xd0 && m <= 0xd7)) throw bad("The JPEG has a stray marker.", "ASSET_CORRUPT");
    if (i + 2 > buf.length) throw bad("The JPEG is cut short.", "ASSET_CORRUPT");
    const len = buf.readUInt16BE(i);
    if (len < 2 || i + len > buf.length) throw bad("A JPEG segment is longer than the file.", "ASSET_CORRUPT");
    const segEnd = i + len;
    if (SOF_NO.has(m) || m === 0xc8 || m === 0xcc || m === 0xdc || m === 0xde || m === 0xdf || (m >= 0xf0 && m <= 0xfd)) {
      throw bad("This kind of JPEG is not supported. Save it as a normal JPEG or PNG.");
    }
    if (SOF_OK.has(m)) {
      if (sof || len < 8) throw bad("The JPEG header is wrong.", "ASSET_CORRUPT");
      const precision = buf[i + 2]!;
      height = buf.readUInt16BE(i + 3);
      width = buf.readUInt16BE(i + 5);
      const comps = buf[i + 7]!;
      if (precision !== 8 || (comps !== 1 && comps !== 3) || len !== 8 + comps * 3) throw bad("This kind of JPEG is not supported. Save it as a normal JPEG or PNG.");
      checkDims(width, height);
      sof = true;
      parts.push(buf.subarray(markerAt, segEnd));
      i = segEnd;
    } else if (m === 0xc4 || m === 0xdb || m === 0xdd) {
      parts.push(buf.subarray(markerAt, segEnd));
      i = segEnd;
    } else if (m === 0xda) {
      if (!sof) throw bad("The JPEG scan comes before its header.", "ASSET_CORRUPT");
      let j = segEnd;
      while (j < buf.length) {
        if (buf[j] !== 0xff) { j++; continue; }
        const nx = buf[j + 1];
        if (nx === undefined) { j++; break; }
        if (nx === 0x00 || (nx >= 0xd0 && nx <= 0xd7)) { j += 2; continue; }
        if (nx === 0xff) { j++; continue; }
        break;
      }
      parts.push(buf.subarray(markerAt, j));
      sos = true;
      i = j;
    } else if (m === 0xee && len >= 14 && buf.toString("latin1", i + 2, i + 7) === "Adobe" && len <= 32) {
      parts.push(buf.subarray(markerAt, segEnd)); // colour transform flag
      i = segEnd;
    } else if ((m >= 0xe0 && m <= 0xef) || m === 0xfe) {
      i = segEnd; // APPn, COM: dropped (EXIF, GPS, ICC, comments)
    } else {
      throw bad("The JPEG has a segment we do not accept.", "ASSET_CORRUPT");
    }
  }
  if (!ended) throw bad("The JPEG is incomplete.", "ASSET_CORRUPT");
  if (i !== buf.length) throw bad("The file has extra bytes after the end of the image.", "ASSET_TRAILING_DATA");
  return { mime: "image/jpeg", width, height, data: Buffer.concat(parts) };
}

/** Check and clean an uploaded image. Throws AppError (422 / 413) with a stable details.code. Never trusts a client type. */
export function cleanImage(input: Buffer): CleanImage {
  if (input.length === 0) throw bad("The file is empty.", "ASSET_EMPTY");
  if (input.length > ASSET_MAX_BYTES) throw bad(`The image is larger than ${ASSET_MAX_BYTES / 1024} KB.`, "ASSET_TOO_LARGE", 413);
  let out: CleanImage;
  if (input.length >= 8 && input.subarray(0, 8).equals(PNG_SIG)) out = cleanPng(input);
  else if (input.length >= 4 && input[0] === 0xff && input[1] === 0xd8 && input[2] === 0xff) out = cleanJpeg(input);
  else throw bad("Only PNG and JPEG images are accepted.");
  if (out.data.length > ASSET_MAX_BYTES) throw bad(`The image is larger than ${ASSET_MAX_BYTES / 1024} KB.`, "ASSET_TOO_LARGE", 413);
  return out;
}

// Built from escapes so no raw line separator character sits in the source file.
const CONTROL_CHARS = new RegExp("[\u0000-\u001f\u007f\u2028\u2029]");

/** Alt text: plain text, 5 to 300 characters, no control characters. Returned trimmed with spaces collapsed. */
export function cleanAltText(raw: unknown): string {
  if (typeof raw !== "string") throw bad("Alt text is required.", "ASSET_ALT_REQUIRED");
  if (CONTROL_CHARS.test(raw)) throw bad("Alt text must be plain text on one line.", "ASSET_ALT_INVALID");
  const t = raw.replace(/\s+/g, " ").trim();
  if (t.length < 5) throw bad("Alt text is required: describe the image in at least 5 characters.", "ASSET_ALT_REQUIRED");
  if (t.length > 300) throw bad("Alt text may have at most 300 characters.", "ASSET_ALT_INVALID");
  return t;
}
