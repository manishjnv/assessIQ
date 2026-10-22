#!/usr/bin/env node
// tools/sample-quiz-report.mjs (Z-84, SAMPLE-1)
//
// Unpacks the sample quiz zips in docs/exam-content/Aptitude/Sample-Quiz into a scratch folder OUTSIDE the repo,
// parses each source, normalises the questions to the importer shape (stem, options, answer
// key, difficulty, topic, source reference, rights status) and writes:
//   (a) a count-and-quality report (console + docs/exam-content/Aptitude/2026-10-20-sample-quiz-report.md)
//   (b) one normalised JSON per source into docs/exam-content/Aptitude/Sample-Quiz/normalised/ (gitignored)
//
// Usage:
//   node tools/sample-quiz-report.mjs <scratch-dir> [--zips <dir>] [--out <dir>] [--report <file>]
//
// Rules: the script loads nothing into any database, runs nothing from the unpacked folders,
// and prints counts and file names only (never stems, options or author names).
// Unpacking uses the system `tar` (bsdtar reads zip). A new source needs an entry in PARSERS.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const scratchArg = argv.find((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1].startsWith("--")));
const flag = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const ZIPS = resolve(REPO, flag("zips", "docs/exam-content/Aptitude/Sample-Quiz"));
const OUT = resolve(REPO, flag("out", "docs/exam-content/Aptitude/Sample-Quiz/normalised"));
const REPORT = resolve(REPO, flag("report", "docs/exam-content/Aptitude/2026-10-20-sample-quiz-report.md"));
const TODAY = "2026-10-20";

if (!scratchArg) {
  console.error("usage: node tools/sample-quiz-report.mjs <scratch-dir> [--zips <dir>] [--out <dir>] [--report <file>]");
  process.exit(2);
}
const SCRATCH = resolve(scratchArg);
{
  const rel = relative(REPO, SCRATCH);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    console.error("refused: the scratch dir must be outside the repo");
    process.exit(2);
  }
}

// ---------------------------------------------------------------------------
// Git safety: the output folder must be ignored before anything is written there.
// ---------------------------------------------------------------------------
function isIgnored(absPath) {
  const rel = relative(REPO, absPath).split(sep).join("/");
  try {
    execFileSync("git", ["-C", REPO, "check-ignore", "-q", `${rel}/probe.json`], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Unpack (tar reads zip; no code from the archive is run) and walk
// ---------------------------------------------------------------------------
function tarBin() {
  return process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
}

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

function unpack(zipPath, dest) {
  mkdirSync(dest, { recursive: true });
  execFileSync(tarBin(), ["-xf", zipPath, "-C", dest], { stdio: "pipe" });
  const root = resolve(dest) + sep;
  for (const f of walk(dest)) {
    if (!resolve(f).startsWith(root)) throw new Error("archive entry escaped the scratch folder");
  }
  return walk(dest).map((f) => relative(dest, f).split(sep).join("/"));
}

// ---------------------------------------------------------------------------
// Licence: read the LICENSE file type only; never print its text (copyright holder names)
// ---------------------------------------------------------------------------
function licenceOf(dest, files) {
  const hit = files.find((f) => f.split("/").length <= 3 && /(^|\/)(LICEN[CS]E|COPYING)[^/]*$/i.test(f));
  if (!hit) return { type: "none found", ok: false };
  const head = readFileSync(join(dest, hit), "utf8").slice(0, 400);
  if (/MIT License/i.test(head)) return { type: "MIT", ok: true, file: hit };
  if (/Creative Commons Attribution 4\.0/i.test(head)) return { type: "CC BY 4.0", ok: true, file: hit };
  return { type: "licence file present, type not recognised", ok: false, file: hit };
}

// ---------------------------------------------------------------------------
// Parsers. Each returns raw records: { file, category, topic, difficultyRaw, stem, options, answerRaw, rationale }
// ---------------------------------------------------------------------------
const OPTION_LINE = /^\(?([a-dA-D])[).]\s+(.+)$/;
const clean = (s) => s.replace(/\*\*/g, "").replace(/\s+/g, " ").trim();

function splitOptions(lines) {
  const stemLines = [];
  const options = [];
  for (const l of lines) {
    const m = OPTION_LINE.exec(l);
    if (m) options.push(clean(m[2]));
    else if (l) stemLines.push(l);
  }
  return { stemLines, options: options.length >= 2 ? options : [] };
}

const DIFF_WORDS = { basic: "easy", intermediate: "medium", advance: "hard", advanced: "hard" };

// Source 1: Aptitude-Tests-Questions. Blocks "N. **Question**: ... **Solution**: ... **Answer**: ...".
function parseQaBlocks(text, meta) {
  const out = [];
  let cur = null;
  let field = null;
  let topic = meta.topic;
  for (const raw of text.split(/\r?\n/)) {
    const t = raw.trim();
    const q = /^\d+\.\s+\*\*Question\*\*:\s*(.*)$/.exec(t);
    if (q) {
      cur = { file: meta.file, category: meta.category, topic, difficultyRaw: meta.difficultyRaw, stemLines: [q[1].trim()], rationale: [], answerRaw: "" };
      out.push(cur);
      field = "stem";
      continue;
    }
    if (/^##\s+/.test(t)) { topic = t.replace(/^##\s+/, "").trim(); field = null; continue; }
    if (!cur) continue;
    const s = /^\*\*Solution\*\*:\s*(.*)$/.exec(t);
    if (s) { field = "rationale"; if (s[1].trim()) cur.rationale.push(s[1].trim()); continue; }
    const a = /^\*\*Answer\*\*:\s*(.*)$/.exec(t);
    if (a) { cur.answerRaw = clean(a[1]); field = null; continue; }
    if (t && field === "stem") cur.stemLines.push(t);
    if (t && field === "rationale") cur.rationale.push(t);
  }
  return out.map((r) => {
    const { stemLines, options } = splitOptions(r.stemLines);
    return { ...r, topic: r.topic || meta.topic, stem: clean(stemLines.join(" ")), options, rationale: r.rationale.join(" ") };
  });
}

function parseQa(text, file) {
  const seg = file.split("/");
  const category = (seg[1] ?? "").replace(/^\d+\s*/, "");
  const difficultyRaw = (seg[2] ?? "").replace(/^\d+\s*/, "");
  return parseQaBlocks(text, { file, category, difficultyRaw, topic: difficultyRaw });
}

// Source 2: aptitude-grind. "### Qn [M|H] — title", stem, then <details> with "**Answer: ...**".
function parseGrind(text, file) {
  const seg = file.split("/");
  const topicFromPath = (seg[seg.length - 3] ?? "").replace(/-/g, " ");
  const out = [];
  let cur = null;
  let inDetails = false;
  for (const raw of text.split(/\r?\n/)) {
    const t = raw.trim();
    const h = /^###\s+Q\d+\s+\[([A-Z])\]\s*[—-]\s*(.*)$/.exec(t);
    if (h) {
      cur = { file, category: seg[1] ?? "", topic: clean(h[2].replace(/\(Pattern[^)]*\)\s*$/, "")) || topicFromPath, difficultyRaw: h[1] === "H" ? "Hard" : "Medium", stemLines: [], rationale: [], answerRaw: "" };
      out.push(cur);
      inDetails = false;
      continue;
    }
    if (!cur) continue;
    if (/^<details>/.test(t)) { inDetails = true; continue; }
    if (/^<\/details>/.test(t)) { inDetails = false; continue; }
    if (inDetails) {
      const a = /\*\*Answer:?\s*(.*?)\*\*/.exec(t) ?? /^\*\*Answer:\s*(.*)$/.exec(t);
      if (a && !cur.answerRaw) cur.answerRaw = clean(a[1]);
      if (t && !/^<summary>|^```|^\*\*Answer/.test(t)) cur.rationale.push(t);
    } else if (t && t !== "---" && !/^\*Difficulty|^\*Solve/.test(t)) {
      cur.stemLines.push(t);
    }
  }
  return out.map((r) => {
    const { stemLines, options } = splitOptions(r.stemLines);
    return { ...r, stem: clean(stemLines.join(" ")), options, rationale: clean(r.rationale.join(" ")) };
  });
}

// Source 3: aptitude-main. "### Problem N" and "### Solution N" under one topic file.
function parseMain(text, file) {
  const topic = clean(file.split("/").pop().replace(/\.md$/, "").replace(/_/g, " "));
  const problems = new Map();
  const solutions = new Map();
  let mode = null;
  let num = null;
  let body = null;
  const flush = () => {
    if (mode === "p" && body) problems.set(num, body);
    if (mode === "s" && body) solutions.set(num, body);
    mode = null; body = null;
  };
  for (const raw of text.split(/\r?\n/)) {
    const t = raw.trim();
    const p = /^###\s+Problem\s+(\d+)/.exec(t);
    const s = /^###\s+Solution\s+(\d+)/.exec(t);
    if (p || s) { flush(); num = Number((p ?? s)[1]); mode = p ? "p" : "s"; body = { lines: [], answer: "" }; continue; }
    if (/^(##\s|---\s*$)/.test(t)) { flush(); continue; }
    if (!mode) continue;
    const tt = t.replace(/^(\d+\.|-)\s+/, "");
    const a = /^\*\*Answer\*?\*?:?\*?\*?\s*:?\s*(.*)$/.exec(tt);
    if (mode === "s" && a) { body.answer = clean(a[1]); continue; }
    if (t) body.lines.push(t);
  }
  flush();
  return [...problems.entries()].sort((x, y) => x[0] - y[0]).map(([n, b]) => {
    const { stemLines, options } = splitOptions(b.lines);
    const sol = solutions.get(n);
    return {
      file, category: "", topic, difficultyRaw: "", stem: clean(stemLines.join(" ")), options,
      answerRaw: sol ? sol.answer : "", rationale: sol ? clean(sol.lines.join(" ")) : "",
    };
  });
}

// Source 4: aptitude-test-platform. question_bank.json holds real four-option MCQs.
function parsePlatform(text, file) {
  const doc = JSON.parse(text);
  return (doc.questions ?? []).map((q) => {
    const opts = q.options && typeof q.options === "object" ? ["a", "b", "c", "d"].filter((k) => q.options[k] !== undefined).map((k) => clean(String(q.options[k]))) : [];
    const letterKey = String(q.correct_answer ?? "").trim().toLowerCase();
    const answerText = opts.length && /^[a-d]$/.test(letterKey) ? letterKey : String(q.correct_answer ?? "");
    return {
      file, category: q.category ?? "", topic: clean(q.topic ?? ""), difficultyRaw: q.difficulty ?? "",
      stem: clean(q.question ?? ""), options: opts, answerRaw: answerText, rationale: clean(q.solution ?? ""),
    };
  });
}

const PARSERS = {
  "Aptitude-Tests-Questions-main": {
    format: "Markdown: numbered Question / Solution / Answer blocks, one README per topic level (no answer options)",
    files: (f) => f.filter((p) => /(^|\/)README\.md$/.test(p) && p.split("/").length >= 4),
    parse: (text, file) => parseQa(text, file),
  },
  "aptitude-grind-master": {
    format: "Markdown: '### Qn [M|H]' headings, stem, collapsible solution with a one-line answer (no answer options)",
    files: (f) => f.filter((p) => /\/questions\/[^/]+\.md$/.test(p)),
    parse: (text, file) => parseGrind(text, file),
  },
  "aptitude-main": {
    format: "Markdown: concept notes plus '### Problem N' and '### Solution N' per topic file (options only where listed as a) b) lines)",
    files: (f) => f.filter((p) => /\.md$/.test(p) && !/(^|\/)README\.md$/.test(p) && p.split("/").length === 2),
    parse: (text, file) => parseMain(text, file),
  },
  "aptitude-test-platform-public-main": {
    format: "JSON: questions[] with category, topic, difficulty, question, four options (a to d), correct letter, solution. Dataset markdown is not parsed (see report)",
    files: (f) => f.filter((p) => /(^|\/)question_bank\.json$/.test(p) && !/\/app\//.test(p)),
    parse: (text, file) => parsePlatform(text, file),
  },
};

// ---------------------------------------------------------------------------
// Normalise, quality checks, duplicates
// ---------------------------------------------------------------------------
function resolveKey(answerRaw, options) {
  if (!answerRaw || options.length < 2) return null;
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const exact = options.findIndex((o) => norm(o) === norm(answerRaw));
  if (exact >= 0) return exact;
  const m = /^\(?([a-dA-D])\)?(?:[.)]\s|\s|$)/.exec(answerRaw.trim()) ?? /^\(?([a-dA-D])\)/.exec(answerRaw.trim());
  if (m) {
    const idx = m[1].toLowerCase().charCodeAt(0) - 97;
    if (idx < options.length) return idx;
  }
  return null;
}

const stemKey = (s) => createHash("sha256").update(s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()).digest("hex").slice(0, 16);

function normaliseRecord(raw, sourceName, lic, n) {
  const stem = raw.stem;
  const correct = resolveKey(raw.answerRaw, raw.options);
  const issues = [];
  if (!stem) issues.push("empty_stem");
  else if (stem.length < 12) issues.push("stem_too_short");
  else if (stem.length > 1000) issues.push("stem_too_long");
  if (raw.options.length < 2) issues.push("fewer_than_2_options");
  if (!raw.answerRaw) issues.push("missing_answer_key");
  else if (raw.options.length >= 2 && correct === null) issues.push("answer_not_in_options");
  if (raw.options.some((o) => o.length > 300)) issues.push("option_too_long");
  const w = DIFF_WORDS[raw.difficultyRaw.toLowerCase()] ?? (raw.difficultyRaw === "Medium" ? "medium" : raw.difficultyRaw === "Hard" ? "hard" : null);
  return {
    id: createHash("sha1").update(`${sourceName}|${raw.file}|${n}`).digest("hex").slice(0, 12),
    source: sourceName,
    file: raw.file,
    exam_stage: null,
    subject_path: raw.category || null,
    topic: raw.topic || null,
    difficulty: raw.difficultyRaw || null,
    difficulty_scale: w ? "words" : null,
    difficulty_mapped: w,
    type: raw.options.length >= 2 ? "mcq" : "open",
    stem,
    options: raw.options,
    correct,
    answer_raw: raw.answerRaw || null,
    rationale: raw.rationale || null,
    rights_status: "derived_from_source",
    licence: lic.type,
    licence_ok: lic.ok,
    origin: "derived_from_source",
    source_ref: `${sourceName}:${raw.file}#${n}`,
    stem_key: stemKey(stem || `__empty_${n}`),
    issues,
  };
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
const zipNames = readdirSync(ZIPS).filter((f) => /\.zip$/i.test(f)).sort();
if (zipNames.length === 0) {
  console.error(`no zip files in ${ZIPS}`);
  process.exit(2);
}
const results = [];
const seenStem = new Map(); // stem_key -> first source name
const unparsed = [];

for (const zipFile of zipNames) {
  const name = zipFile.replace(/\.zip$/i, "");
  const dest = join(SCRATCH, name);
  const files = unpack(join(ZIPS, zipFile), dest);
  const lic = licenceOf(dest, files);
  const parser = PARSERS[name];
  if (!parser) { unparsed.push(zipFile); continue; }
  const parsedFiles = parser.files(files);
  const raws = [];
  for (const f of parsedFiles) {
    const text = readFileSync(join(dest, f), "utf8");
    raws.push(...parser.parse(text, f));
  }
  const recs = raws.map((r, i) => normaliseRecord(r, name, lic, i));
  for (const r of recs) {
    const first = seenStem.get(r.stem_key);
    if (first !== undefined && r.stem) {
      r.issues.push("duplicate_stem");
      r.duplicate_of = first === name ? "same_source" : "other_source";
    } else if (r.stem) seenStem.set(r.stem_key, name);
  }
  results.push({ zipFile, name, format: parser.format, licence: lic, files: parsedFiles, recs, unusedFiles: files.length - parsedFiles.length });
}

// Count and report (no stems, options or author names are printed)
const lines = [];
const out = (s = "") => { lines.push(s); };
out(`# Sample quiz report (Z-84, SAMPLE-1)`);
out("");
out(`Date: ${TODAY}. Script: \`tools/sample-quiz-report.mjs\`. Counts and file names only: no question text, option text or author names. Nothing loaded into any database.`);
out("");
out("## Status");
out("");
out(`- Zip files found: ${zipNames.length}. Parsed: ${results.length}. No parser: ${unparsed.length}${unparsed.length ? ` (${unparsed.join(", ")})` : ""}.`);
out(`- Rights: every item is marked \`derived_from_source\` (owner decision D2). Items are blocked until a licence is found.`);
out("");
out("## Per source");
out("");
out("| Source zip | Licence | Questions | Two or more options | MCQ with valid key | Usable (no issue, licence ok) | Blocked by licence | Records with an issue |");
out("|---|---|---:|---:|---:|---:|---:|---:|");
for (const r of results) {
  const total = r.recs.length;
  const withOpts = r.recs.filter((x) => x.options.length >= 2).length;
  const withIssue = r.recs.filter((x) => x.issues.length > 0).length;
  const usable = r.recs.filter((x) => x.issues.length === 0 && x.licence_ok).length;
  const blocked = r.recs.filter((x) => x.issues.length === 0 && !x.licence_ok).length;
  const validMcq = r.recs.filter((x) => x.options.length >= 2 && x.correct !== null).length;
  out(`| ${r.zipFile} | ${r.licence.type} | ${total} | ${withOpts} | ${validMcq} | ${usable} | ${blocked} | ${withIssue} |`);
}
out("");
for (const r of results) {
  out(`### ${r.zipFile}`);
  out("");
  out(`- Format: ${r.format}.`);
  out(`- Licence: ${r.licence.type}${r.licence.file ? ` (file: ${r.licence.file})` : ""}.`);
  out(`- Files parsed: ${r.files.length}. Files not parsed in this zip: ${r.unusedFiles}.`);
  const counts = {};
  for (const rec of r.recs) for (const i of rec.issues) counts[i] = (counts[i] ?? 0) + 1;
  const keys = Object.keys(counts).sort();
  out(`- Issue counts: ${keys.length ? keys.map((k) => `${k} ${counts[k]}`).join("; ") : "none"}.`);
  const sameDup = r.recs.filter((x) => x.duplicate_of === "same_source").length;
  const crossDup = r.recs.filter((x) => x.duplicate_of === "other_source").length;
  out(`- Duplicate stems: ${sameDup} within this source, ${crossDup} shared with an earlier source.`);
  const byDiff = {};
  for (const rec of r.recs) { const k = rec.difficulty ?? "none"; byDiff[k] = (byDiff[k] ?? 0) + 1; }
  out(`- Difficulty labels: ${Object.entries(byDiff).map(([k, v]) => `${k} ${v}`).join("; ")}.`);
  out("");
}
if (unparsed.length) {
  out("## Not parsed");
  out("");
  for (const u of unparsed) out(`- ${u}: no parser yet. Add an entry to \`PARSERS\` in tools/sample-quiz-report.mjs.`);
  out("");
}
out("## Licence and rights notes");
out("");
out("- Source with MIT licence: reuse allowed with the licence notice. Rights can move to `licensed` only after the owner accepts a licence id (not built yet, EXP-2 follow-up).");
out("- Source with CC BY 4.0 licence: reuse needs attribution. The importer has no attribution field yet, so the source reference carries it.");
out("- A source with no licence file: not usable until the owner confirms the rights. The platform bank was built from a dataset whose licence is not in the zip.");
out("- The licence text is read for its type only. Copyright holder names are not copied into this report.");
out("");
out("## Next steps");
out("");
out("- Owner: confirm rights for sources without a licence file.");
out("- Owner: decide whether open-answer items (no options) are kept as `open` type or rewritten into MCQs (EXP-16 style seed-and-rewrite).");
out("- Claude: load into staging only after the owner says so (EXP-15 runbook).");
out("");

const report = lines.join("\n");
console.log(report);

// (b) Normalised JSON per source (gitignored folder). Refuse to write unless ignored.
if (!isIgnored(join(OUT, "probe"))) {
  console.error(`refused: ${relative(REPO, OUT)} is not gitignored. Nothing was written there.`);
  process.exit(3);
}
mkdirSync(OUT, { recursive: true });
for (const r of results) {
  const payload = {
    source: r.name, licence: r.licence.type, licence_ok: r.licence.ok, generated: TODAY,
    records: r.recs.map((rec) => { const { stem_key: _k, ...rest } = rec; return rest; }),
  };
  writeFileSync(join(OUT, `${r.name}.normalised.json`), JSON.stringify(payload, null, 2), "utf8");
}
mkdirSync(dirname(REPORT), { recursive: true });
writeFileSync(REPORT, report + "\n", "utf8");
console.error(`wrote ${results.length} normalised files to ${relative(REPO, OUT)} and the report to ${relative(REPO, REPORT)}`);
