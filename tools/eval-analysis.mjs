// Read-only analysis of stored eval runs (Z-165 phase 1). No AI call. Prints counts and ids only, never answer text.
// Run on the VPS inside the API container (the case files are VPS-only):
//   ssh assessiq-vps 'docker exec -i assessiq-api node - <runId>[,<runId>...]' < tools/eval-analysis.mjs
// The runs are merged (one per case type). Output: confusion, bias, kappa, per-level and per-type, per-question
// misses, escalation counts, anchor hits of the misses, and the frozen dev/sealed split by QUESTION id.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const EVAL = "/app/modules/07-ai-grading/eval";
const runs = (process.argv[2] ?? "").split(",").filter(Boolean);
if (runs.length === 0) { console.error("usage: node - <runId>[,<runId>]"); process.exit(1); }

const qKey = (id) => id.replace(/-\d{2}$/, "");
const grp = (id) => { const m = /^aiq-([a-z]+)-(L\d)-/.exec(id); return m ? { type: m[1], level: m[2] } : { type: "other", level: "other" }; };

const expected = new Map();
for (const dir of ["cases", "cases-private"]) {
  const d = path.join(EVAL, dir);
  if (!fs.existsSync(d)) continue;
  for (const f of fs.readdirSync(d).filter((x) => x.endsWith(".expected.json"))) {
    const j = JSON.parse(fs.readFileSync(path.join(d, f), "utf8"));
    expected.set(j.id, j);
  }
}
const actual = new Map();
for (const r of runs) {
  const d = path.join(EVAL, "runs", r);
  for (const f of fs.readdirSync(d).filter((x) => x.endsWith(".actual.json"))) {
    const j = JSON.parse(fs.readFileSync(path.join(d, f), "utf8"));
    actual.set(j.id, j);
  }
}

const rows = [];
for (const [id, a] of actual) {
  const e = expected.get(id);
  if (!e) continue;
  rows.push({ id, q: qKey(id), ...grp(id), exp: e.band, act: a.error ? null : a.band, a, e });
}

const n = rows.length;
const exact = rows.filter((r) => r.act === r.exp).length;
const within1 = rows.filter((r) => r.act !== null && Math.abs(r.act - r.exp) <= 1).length;
const bias = rows.filter((r) => r.act !== null).reduce((s, r) => s + (r.act - r.exp), 0) / n;
console.log(`cases ${n}  exact ${exact} (${((exact / n) * 100).toFixed(1)}%)  within-one ${within1} (${((within1 / n) * 100).toFixed(1)}%)  signed bias ${bias.toFixed(3)} band`);

// weighted kappa (quadratic), bands 0..4
const B = 5;
const M = Array.from({ length: B }, () => new Array(B).fill(0));
for (const r of rows) if (r.act !== null) M[r.exp][r.act]++;
const rs = M.map((x) => x.reduce((a, b) => a + b, 0));
const cs = M[0].map((_, j) => M.reduce((a, x) => a + x[j], 0));
let o = 0, ex = 0;
for (let i = 0; i < B; i++) for (let j = 0; j < B; j++) { const w = ((i - j) ** 2) / 16; o += w * M[i][j]; ex += (w * rs[i] * cs[j]) / n; }
console.log(`weighted kappa ${ex === 0 ? "n/a" : (1 - o / ex).toFixed(3)}`);

console.log("\nconfusion (rows expected, columns graded 0..4)");
for (let i = 0; i < B; i++) console.log(`  exp ${i}: ${M[i].join(" ")}   (n=${rs[i]})`);

function table(label, keyFn) {
  const g = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    const s = g.get(k) ?? { n: 0, ok: 0, low: 0, high: 0 };
    s.n++;
    if (r.act === r.exp) s.ok++;
    else if (r.act !== null && r.act < r.exp) s.low++;
    else if (r.act !== null) s.high++;
    g.set(k, s);
  }
  console.log(`\nby ${label}`);
  for (const [k, s] of [...g].sort()) console.log(`  ${k}: ${s.ok}/${s.n} (${((s.ok / s.n) * 100).toFixed(0)}%)  too low ${s.low}  too high ${s.high}`);
}
table("level", (r) => r.level);
table("type", (r) => r.type);
table("type+level", (r) => `${r.type}/${r.level}`);
table("expected band", (r) => String(r.exp));

// per-question misses
const qs = new Map();
for (const r of rows) { const s = qs.get(r.q) ?? { n: 0, miss: 0 }; s.n++; if (r.act !== r.exp) s.miss++; qs.set(r.q, s); }
const missQ = [...qs].filter(([, s]) => s.miss > 0).sort((a, b) => b[1].miss - a[1].miss);
console.log(`\nquestions: ${qs.size}; with at least one miss: ${missQ.length}`);
console.log("  most misses:", missQ.slice(0, 12).map(([k, s]) => `${k} ${s.miss}/${s.n}`).join(", "));

// escalation (present only in runs made after Z-164)
const esc = rows.filter((r) => r.a.escalation_stage === "3").length;
const man = rows.filter((r) => r.a.escalation_stage === "manual").length;
const withField = rows.filter((r) => r.a.escalation_stage !== undefined).length;
console.log(`\nescalation: stage 3 decided ${esc}, manual ${man}, field present on ${withField}/${n}`);
const degraded = rows.filter((r) => r.a.degraded).length;
console.log(`degraded Stage 1: ${degraded}`);

// anchors of the misses vs expected hits
let missExpHit = 0, missActHit = 0, missBoth = 0, missCases = 0, okExpHit = 0, okActHit = 0, okBoth = 0, okCases = 0;
for (const r of rows) {
  const eh = new Set(r.e.anchors.filter((x) => x.hit).map((x) => x.anchor_id));
  const ah = new Set((r.a.anchors ?? []).filter((x) => x.hit).map((x) => x.anchor_id));
  const both = [...eh].filter((x) => ah.has(x)).length;
  if (r.act === r.exp) { okCases++; okExpHit += eh.size; okActHit += ah.size; okBoth += both; }
  else { missCases++; missExpHit += eh.size; missActHit += ah.size; missBoth += both; }
}
console.log(`\nanchors, misses (${missCases} cases): expected hits ${missExpHit}, graded hits ${missActHit}, in common ${missBoth}`);
console.log(`anchors, matches (${okCases} cases): expected hits ${okExpHit}, graded hits ${okActHit}, in common ${okBoth}`);
const allHitMiss = rows.filter((r) => {
  const eh = r.e.anchors.filter((x) => x.hit).map((x) => x.anchor_id);
  const ah = new Set((r.a.anchors ?? []).filter((x) => x.hit).map((x) => x.anchor_id));
  return r.act !== r.exp && eh.length > 0 && eh.every((x) => ah.has(x));
});
console.log(`misses where ALL expected hit anchors were hit: ${allHitMiss.length}`);

// score (marks): graded earned/max ratio by graded band (no expected score exists in the golden files)
const ratio = new Map();
for (const r of rows) if (r.act !== null && r.a.score_max) { const s = ratio.get(r.act) ?? { n: 0, sum: 0 }; s.n++; s.sum += r.a.score_earned / r.a.score_max; ratio.set(r.act, s); }
console.log("\nmean score share by graded band: " + [...ratio].sort().map(([b, s]) => `${b}:${(s.sum / s.n).toFixed(2)}`).join("  "));

// miss list (ids only)
console.log("\n4>3 misses: " + rows.filter((r) => r.exp === 4 && r.act === 3).map((r) => r.id).join(","));
console.log("3>2 misses: " + rows.filter((r) => r.exp === 3 && r.act === 2).map((r) => r.id).join(","));
console.log("other misses: " + rows.filter((r) => r.act !== r.exp && !(r.exp === 4 && r.act === 3) && !(r.exp === 3 && r.act === 2)).map((r) => `${r.id}(${r.exp}>${r.act})`).join(","));

// frozen split by QUESTION id: within each type/level stratum order questions by a hash, one third go to dev
const strata = new Map();
for (const q of qs.keys()) { const g = grp(q); const k = `${g.type}/${g.level}`; (strata.get(k) ?? strata.set(k, []).get(k)).push(q); }
const dev = [];
const hash = (s) => crypto.createHash("sha1").update("z165-split-v1:" + s).digest("hex");
for (const [, list] of [...strata].sort()) {
  list.sort((a, b) => hash(a).localeCompare(hash(b)));
  const k = Math.max(1, Math.round(list.length / 3));
  dev.push(...list.slice(0, k));
}
dev.sort();
const sealed = [...qs.keys()].filter((q) => !dev.includes(q)).sort();
const countCases = (list) => rows.filter((r) => list.includes(r.q)).length;
console.log(`\nSPLIT v1: dev ${dev.length} questions / ${countCases(dev)} cases; sealed ${sealed.length} questions / ${countCases(sealed)} cases`);
console.log("DEV_QUESTIONS " + dev.join(","));
