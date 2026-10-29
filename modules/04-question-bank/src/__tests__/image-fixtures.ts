// EXP-10 test helpers: build tiny valid PNG and JPEG byte streams (structure only, no real pixels needed:
// the service never decodes them) and multipart bodies.
import { crc32, deflateSync } from "node:zlib";

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function pngChunk(type: string, data: Buffer, badCrc = false): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE((crc32(body) ^ (badCrc ? 1 : 0)) >>> 0);
  return Buffer.concat([len, body, crc]);
}

export interface PngOpts { w?: number; h?: number; extra?: Buffer[]; idat?: Buffer; trailing?: Buffer; noIend?: boolean; badCrc?: boolean; seed?: number }

export function png(o: PngOpts = {}): Buffer {
  const w = o.w ?? 64; const h = o.h ?? 64;
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  // A distinct body per seed so two fixtures never share a sha256.
  const raw = o.idat ?? deflateSync(Buffer.concat([Buffer.alloc(Math.min((w * 3 + 1) * h, 4096)), Buffer.from(String(o.seed ?? 0))]));
  return Buffer.concat([
    PNG_SIG, pngChunk("IHDR", ihdr, o.badCrc), ...(o.extra ?? []), pngChunk("IDAT", raw),
    ...(o.noIend ? [] : [pngChunk("IEND", Buffer.alloc(0))]), ...(o.trailing ? [o.trailing] : []),
  ]);
}

const seg = (marker: number, payload: Buffer): Buffer => {
  const len = Buffer.alloc(2); len.writeUInt16BE(payload.length + 2);
  return Buffer.concat([Buffer.from([0xff, marker]), len, payload]);
};

export interface JpegOpts { w?: number; h?: number; app1?: Buffer; com?: Buffer; trailing?: Buffer; sof?: number; comps?: number; seed?: number; adobe?: boolean }

export function jpeg(o: JpegOpts = {}): Buffer {
  const w = o.w ?? 64; const h = o.h ?? 64; const comps = o.comps ?? 3;
  const sofPayload = Buffer.alloc(6 + comps * 3);
  sofPayload[0] = 8; sofPayload.writeUInt16BE(h, 1); sofPayload.writeUInt16BE(w, 3); sofPayload[5] = comps;
  for (let i = 0; i < comps; i++) { sofPayload[6 + i * 3] = i + 1; sofPayload[7 + i * 3] = 0x11; sofPayload[8 + i * 3] = 0; }
  const dht = Buffer.concat([Buffer.from([0x00, 1]), Buffer.alloc(15), Buffer.from([0x00])]);
  const sos = Buffer.concat([Buffer.from([comps]), ...Array.from({ length: comps }, (_, i) => Buffer.from([i + 1, 0x00])), Buffer.from([0, 63, 0])]);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    ...(o.app1 ? [seg(0xe1, o.app1)] : []),
    ...(o.adobe ? [seg(0xee, Buffer.from("Adobe\0\x64\0\0\0\0\x01", "latin1"))] : []),
    ...(o.com ? [seg(0xfe, o.com)] : []),
    seg(0xdb, Buffer.concat([Buffer.from([0]), Buffer.alloc(64, 1)])),
    seg(o.sof ?? 0xc0, sofPayload),
    seg(0xc4, dht),
    seg(0xda, sos),
    Buffer.from([0x12, 0x34, 0xff, 0x00, 0x56, o.seed ?? 0]),
    Buffer.from([0xff, 0xd9]),
    ...(o.trailing ? [o.trailing] : []),
  ]);
}

export const GIF = Buffer.from("GIF89a\x10\x00\x10\x00\x80\x00\x00\x00\x00\x00\xff\xff\xff;", "latin1");
export const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><script>alert(1)</script></svg>');
export const HTML = Buffer.from("<html><body><script>alert(1)</script></body></html>");
export const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF");
export const ZIP_TAIL = Buffer.from("PK\x03\x04hostile-archive", "latin1");

/** Multipart body with one file and text fields. */
export function multipart(fields: Record<string, string>, file: { name: string; type: string; data: Buffer }): { body: Buffer; contentType: string } {
  const b = "----aiqtest" + Math.random().toString(16).slice(2);
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`), file.data, Buffer.from(`\r\n--${b}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${b}` };
}
