// RW-59: QTI 2.1 / 2.2 / 3.0 item import and a QTI 3.0 package export.
// The interaction <-> question type mapping goes through the registry's `qtiInteraction`.
import JSZip from "jszip";
import { SaxesParser } from "saxes";
import { ValidationError } from "@assessiq/core";
import { QUESTION_TYPE_REGISTRY, isQuestionType, type QuestionType } from "@assessiq/question-types";
import { COMMON_COLUMNS } from "../templates.js";
import { IMPORT_MAX_BYTES, IMPORT_MAX_ROWS } from "../limits.js";
import type { ParseResult } from "../types.js";
import { tooManyRows } from "./common.js";

// Import target per interaction. Each is checked against the registry's qtiInteraction below.
const SINGLE_CHOICE: QuestionType = "mcq";
const MULTI_CHOICE: QuestionType = "multi_select";
const ORDER: QuestionType = "ordering";
const NUMERIC: QuestionType = "numeric";
const FREE_TEXT: QuestionType = "subjective";
const CHOICE = QUESTION_TYPE_REGISTRY[SINGLE_CHOICE].qtiInteraction;
const ORDERING = QUESTION_TYPE_REGISTRY[ORDER].qtiInteraction;
const ENTRY = QUESTION_TYPE_REGISTRY[NUMERIC].qtiInteraction;
const EXTENDED = QUESTION_TYPE_REGISTRY[FREE_TEXT].qtiInteraction;
if (QUESTION_TYPE_REGISTRY[MULTI_CHOICE].qtiInteraction !== CHOICE) {
  throw new Error("qti adapter: single and multi choice must share an interaction");
}

/** "qti-choice-interaction" / "choiceInteraction" -> "choiceinteraction" */
const norm = (n: string): string => n.replace(/^qti-/, "").replace(/-/g, "").toLowerCase();
const SUPPORTED = new Set([CHOICE, ORDERING, ENTRY, EXTENDED].map(norm));
const ITEM_TYPES = new Set(["imsqti_item_xmlv2p1", "imsqti_item_xmlv2p2", "imsqti_item_xmlv3p0"]);
const MAX_UNZIPPED_TOTAL = 4 * IMPORT_MAX_BYTES;

// ---- minimal XML tree on top of saxes (it expands no DTD entities, so no XXE) ----
interface XNode { name: string; attrs: Record<string, string>; kids: (XNode | string)[] }

function parseXml(xml: string): XNode {
  const parser = new SaxesParser();
  const root: XNode = { name: "#root", attrs: {}, kids: [] };
  const stack: XNode[] = [root];
  parser.on("error", (e) => { throw e; });
  parser.on("opentag", (t) => {
    if (stack.length > 64) throw new Error("XML nested too deeply");
    const attrs: Record<string, string> = {};
    for (const [k, v] of Object.entries(t.attributes)) attrs[k.replace(/-/g, "").toLowerCase()] = String(v);
    const n: XNode = { name: t.name.split(":").pop()!, attrs, kids: [] };
    stack[stack.length - 1]!.kids.push(n);
    stack.push(n);
  });
  parser.on("closetag", () => { stack.pop(); });
  const text = (s: string): void => {
    const kids = stack[stack.length - 1]!.kids;
    const last = kids[kids.length - 1];
    if (typeof last === "string") kids[kids.length - 1] = last + s; else kids.push(s);
  };
  parser.on("text", text);
  parser.on("cdata", text);
  parser.write(xml).close();
  const top = root.kids.find((k): k is XNode => typeof k !== "string");
  if (top === undefined) throw new Error("empty document");
  return top;
}

const kidsOf = (n: XNode): XNode[] => n.kids.filter((k): k is XNode => typeof k !== "string");
function find(n: XNode, test: (x: XNode) => boolean, out: XNode[] = []): XNode[] {
  for (const k of kidsOf(n)) { if (test(k)) out.push(k); find(k, test, out); }
  return out;
}
const isNamed = (name: string) => (x: XNode): boolean => norm(x.name) === name;
const clean = (s: string): string => s.replace(/\s+/g, " ").trim();
/** Text of a node; an interaction contributes only its prompt, so choices stay out of the question. */
function textOf(n: XNode): string {
  if (norm(n.name).endsWith("interaction")) {
    const p = kidsOf(n).find(isNamed("prompt"));
    return p ? textOf(p) : "";
  }
  return n.kids.map((k) => (typeof k === "string" ? k : ` ${textOf(k)} `)).join("");
}
const plain = (n: XNode): string => clean(textOf(n));

// ---- one item -> cells ----
function itemCells(xml: string): Record<string, string> {
  const root = parseXml(xml);
  if (norm(root.name) !== "assessmentitem") throw new Error("root element is not an assessment item");
  const body = kidsOf(root).find(isNamed("itembody"));
  if (body === undefined) throw new Error("item has no item body");
  const inter = find(body, (x) => norm(x.name).endsWith("interaction"));
  if (inter.length === 0) throw new Error("item has no interaction");
  if (inter.length > 1) throw new Error("items with more than one interaction are not supported");
  const it = inter[0]!;
  const kind = norm(it.name);
  if (!SUPPORTED.has(kind)) throw new Error(`unsupported interaction '${it.name}'`);

  const question = plain(body);
  const decls = find(root, isNamed("responsedeclaration"));
  const rd = decls.find((d) => d.attrs["identifier"] === it.attrs["responseidentifier"]) ?? decls[0];
  const correctVals = rd ? find(rd, isNamed("correctresponse")).flatMap((c) => find(c, isNamed("value"))).map(plain) : [];
  const score = find(root, isNamed("outcomedeclaration")).find((o) => o.attrs["identifier"] === "SCORE");
  const scoreVal = score ? find(score, isNamed("value"))[0] : undefined;
  const sv = scoreVal ? Number(plain(scoreVal)) : NaN;
  const cells: Record<string, string> = {
    topic: clean(root.attrs["title"] ?? "") || clean(root.attrs["identifier"] ?? "") || question.slice(0, 60),
    points: Number.isFinite(sv) && sv >= 1 ? String(Math.round(sv)) : "1",
    level: "1",
    question,
  };

  const choices = find(it, isNamed("simplechoice"));
  const ids = choices.map((c) => c.attrs["identifier"] ?? "");
  const indexOfId = (v: string): number => {
    const i = ids.indexOf(v);
    if (i < 0) throw new Error(`correct response '${v}' is not a choice`);
    return i;
  };
  let type: QuestionType;
  if (kind === norm(CHOICE)) {
    const max = it.attrs["maxchoices"];
    const multi = max !== undefined ? max !== "1" : rd?.attrs["cardinality"] === "multiple";
    if (correctVals.length === 0) throw new Error("item has no correct response");
    cells["options"] = JSON.stringify(choices.map(plain));
    if (multi) {
      type = MULTI_CHOICE;
      cells["correct"] = JSON.stringify(correctVals.map(indexOfId).sort((a, b) => a - b));
    } else {
      if (correctVals.length !== 1) throw new Error("single-choice item must have exactly one correct response");
      type = SINGLE_CHOICE;
      cells["correct"] = String(indexOfId(correctVals[0]!));
      cells["rationale"] = "Imported from QTI";
    }
  } else if (kind === norm(ORDERING)) {
    type = ORDER;
    if (correctVals.length === 0) throw new Error("item has no correct order");
    cells["items"] = JSON.stringify(choices.map(plain));
    cells["correct_order"] = JSON.stringify(correctVals.map(indexOfId));
  } else if (kind === norm(ENTRY)) {
    type = NUMERIC;
    const v = correctVals[0] ?? "";
    if (v === "" || !Number.isFinite(Number(v))) throw new Error("text-entry correct value must be a number");
    cells["answer"] = v;
  } else {
    type = FREE_TEXT;
  }
  cells["type"] = type;
  const keep = new Set<string>(["type", ...COMMON_COLUMNS, ...QUESTION_TYPE_REGISTRY[type].importColumns.map((c) => c.key)]);
  return Object.fromEntries(Object.entries(cells).filter(([k]) => keep.has(k)));
}

// ---- package reading ----
const declaredSize = (f: JSZip.JSZipObject): number | undefined =>
  (f as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize;

const fileErr = (message: string, code: string): ValidationError => new ValidationError(message, { details: { code } });

/** Running per-package inflate budget plus a cache so no entry is inflated twice. */
interface Budget { left: number; cache: Map<string, string> }

/** Inflates one entry through a byte-counting stream, so a zip bomb is stopped mid-inflate. */
async function readEntry(zip: JSZip, name: string, budget: Budget): Promise<string> {
  const hit = budget.cache.get(name);
  if (hit !== undefined) return hit;
  const f = zip.file(name);
  if (f === null) throw new Error(`file '${name}' is missing from the package`);
  // Cheap first filter only: the declared size is attacker-controlled, so a missing or lying value counts as 0.
  if ((declaredSize(f) ?? 0) > IMPORT_MAX_BYTES) throw fileErr(`file '${name}' is larger than 4 MB`, "IMPORT_TOO_LARGE");
  const text = await new Promise<string>((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let n = 0;
    let done = false;
    // JSZipObject.internalStream exists at runtime (documented) but is missing from the shipped types.
    const s = (f as unknown as {
      internalStream(type: "uint8array"): {
        on(ev: "data", cb: (c: Uint8Array) => void): unknown;
        on(ev: "error", cb: (e: Error) => void): unknown;
        on(ev: "end", cb: () => void): unknown;
        pause(): unknown;
        resume(): unknown;
      };
    }).internalStream("uint8array");
    s.on("data", (c: Uint8Array) => {
      if (done) return;
      n += c.byteLength;
      if (n > IMPORT_MAX_BYTES || n > budget.left) {
        done = true;
        s.pause();
        reject(fileErr(n > IMPORT_MAX_BYTES ? `file '${name}' is larger than 4 MB` : "Package is too large when unzipped", "IMPORT_TOO_LARGE"));
        return;
      }
      chunks.push(c);
    });
    s.on("error", (e: Error) => { if (!done) { done = true; reject(e); } });
    s.on("end", () => { if (!done) { done = true; resolve(Buffer.concat(chunks).toString("utf8")); } });
    s.resume();
  });
  budget.left -= Buffer.byteLength(text, "utf8");
  budget.cache.set(name, text);
  return text;
}

export async function parseQtiPackage(data: Buffer): Promise<ParseResult> {
  if (data.byteLength > IMPORT_MAX_BYTES) throw fileErr(`File exceeds ${IMPORT_MAX_BYTES / 1024} KB`, "IMPORT_TOO_LARGE");
  const out: ParseResult = { rows: [], errors: [] };
  const add = (row: number, xml: string): void => {
    try { out.rows.push({ row, cells: itemCells(xml) }); }
    catch (e) { out.errors.push({ row, column: "", message: (e as Error).message }); }
  };
  const isZip = data.length > 3 && data[0] === 0x50 && data[1] === 0x4b && data[2] === 3 && data[3] === 4;
  if (!isZip) {
    add(1, data.toString("utf8").replace(/^﻿/, ""));
    return out;
  }
  let zip: JSZip;
  try { zip = await JSZip.loadAsync(data); } catch { throw fileErr("File is not a readable QTI zip package", "IMPORT_QTI_UNREADABLE"); }
  const entries = Object.values(zip.files).filter((f) => !f.dir);
  if (entries.length > IMPORT_MAX_ROWS + 50) throw tooManyRows();
  if (entries.reduce((s, f) => s + (declaredSize(f) ?? 0), 0) > MAX_UNZIPPED_TOTAL) {
    throw fileErr("Package is too large when unzipped", "IMPORT_TOO_LARGE");
  }

  const budget: Budget = { left: MAX_UNZIPPED_TOTAL, cache: new Map() };
  const hrefSet = new Set<string>(); // a Set, so a repeated href never yields a second row or inflate
  if (zip.file("imsmanifest.xml") !== null) {
    try {
      const m = parseXml(await readEntry(zip, "imsmanifest.xml", budget));
      for (const r of find(m, (x) => norm(x.name) === "resource" && ITEM_TYPES.has(x.attrs["type"] ?? ""))) {
        const h = r.attrs["href"] ?? find(r, isNamed("file"))[0]?.attrs["href"] ?? "";
        if (h !== "") hrefSet.add(decodeURI(h).replace(/^\.\//, ""));
      }
    } catch (e) {
      if (e instanceof ValidationError) throw e;
      throw fileErr(`imsmanifest.xml is not valid XML: ${(e as Error).message}`, "IMPORT_QTI_UNREADABLE");
    }
  }
  if (hrefSet.size === 0) {
    // No manifest (or no item resources): take every .xml that looks like an item (text is cached for the parse below).
    for (const f of entries) {
      if (!/\.xml$/i.test(f.name) || f.name === "imsmanifest.xml") continue;
      try { if (/<(qti-)?assessment-?item[\s>]/i.test(await readEntry(zip, f.name, budget))) hrefSet.add(f.name); }
      catch (e) { if (e instanceof ValidationError) throw e; hrefSet.add(f.name); }
    }
  }
  const hrefs = [...hrefSet];
  if (hrefs.length > IMPORT_MAX_ROWS) throw tooManyRows();
  for (const [k, href] of hrefs.entries()) {
    try { add(k + 1, await readEntry(zip, href, budget)); }
    catch (e) {
      if (e instanceof ValidationError) throw e;
      out.errors.push({ row: k + 1, column: "", message: (e as Error).message }); }
  }
  return out;
}

// ---- QTI 3.0 export ----
const esc = (s: string): string =>
  // eslint-disable-next-line no-control-regex
  s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const kebab = (s: string): string => s.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
const safeId = (s: string): string => s.replace(/[^A-Za-z0-9_-]/g, "_");
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const nums = (v: unknown): number[] => (Array.isArray(v) ? v.filter((x): x is number => typeof x === "number") : typeof v === "number" ? [v] : []);

export interface QtiExportQuestion { id: string; type: string; topic: string; points: number; content: unknown }

function itemXml(q: QtiExportQuestion): string {
  if (!isQuestionType(q.type)) throw new ValidationError(`unknown question type '${q.type}'`, { details: { code: "INVALID_PARAM" } });
  const c = (q.content !== null && typeof q.content === "object" ? q.content : {}) as Record<string, unknown>;
  const question = typeof c["question"] === "string" ? c["question"] : q.topic;
  const options = strs(c["options"]).length > 0 ? strs(c["options"]) : strs(c["items"]);
  let name = QUESTION_TYPE_REGISTRY[q.type].qtiInteraction;
  // Types whose content has no option list (e.g. a structured case) go out as free text.
  if ((name === CHOICE || name === ORDERING) && options.length === 0) name = EXTENDED;
  const tag = `qti-${kebab(name)}`;
  let decl: string;
  let inner: string;
  if (name === CHOICE || name === ORDERING) {
    const correct = name === ORDERING ? nums(c["correct_order"]) : nums(c["correct"]);
    const multiple = name === CHOICE && correct.length !== 1;
    const card = name === ORDERING ? "ordered" : multiple ? "multiple" : "single";
    decl = `<qti-response-declaration identifier="RESPONSE" cardinality="${card}" base-type="identifier"><qti-correct-response>${correct.map((i) => `<qti-value>c${i}</qti-value>`).join("")}</qti-correct-response></qti-response-declaration>`;
    const attrs = name === ORDERING ? "" : ` max-choices="${multiple ? options.length : 1}"`;
    inner = `<${tag} response-identifier="RESPONSE" shuffle="false"${attrs}><qti-prompt>${esc(question)}</qti-prompt>${options.map((o, i) => `<qti-simple-choice identifier="c${i}">${esc(o)}</qti-simple-choice>`).join("")}</${tag}>`;
  } else if (name === ENTRY) {
    decl = `<qti-response-declaration identifier="RESPONSE" cardinality="single" base-type="float"><qti-correct-response><qti-value>${esc(String(c["answer"] ?? ""))}</qti-value></qti-correct-response></qti-response-declaration>`;
    inner = `<p>${esc(question)}</p><p><${tag} response-identifier="RESPONSE"/></p>`;
  } else {
    decl = `<qti-response-declaration identifier="RESPONSE" cardinality="single" base-type="string"/>`;
    inner = `<p>${esc(question)}</p><${tag} response-identifier="RESPONSE"/>`;
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<qti-assessment-item xmlns="http://www.imsglobal.org/xsd/imsqtiasi_v3p0" identifier="q-${safeId(q.id)}" title="${esc(q.topic)}" adaptive="false" time-dependent="false">`
    + `${decl}<qti-outcome-declaration identifier="SCORE" cardinality="single" base-type="float"><qti-default-value><qti-value>${q.points}</qti-value></qti-default-value></qti-outcome-declaration>`
    + `<qti-item-body>${inner}</qti-item-body></qti-assessment-item>\n`;
}

export async function buildQtiPackage(input: { packName: string; questions: QtiExportQuestion[] }): Promise<Buffer> {
  const zip = new JSZip();
  const res: string[] = [];
  for (const q of input.questions) {
    const href = `items/${safeId(q.id)}.xml`;
    zip.file(href, itemXml(q));
    res.push(`<resource identifier="R-${safeId(q.id)}" type="imsqti_item_xmlv3p0" href="${href}"><file href="${href}"/></resource>`);
  }
  zip.file(
    "imsmanifest.xml",
    `<?xml version="1.0" encoding="UTF-8"?>\n<manifest xmlns="http://www.imsglobal.org/xsd/imscp_v1p1" identifier="MANIFEST"><metadata><schema>QTI Package</schema><schemaversion>3.0.0</schemaversion></metadata>`
      + `<organizations><organization identifier="ORG" structure="hierarchical"><title>${esc(input.packName)}</title></organization></organizations><resources>${res.join("")}</resources></manifest>\n`,
  );
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}
