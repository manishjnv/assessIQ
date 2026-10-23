// Z-165 step 5: a deterministic band floor from the anchor hits. Read-only, no AI call, ids and counts only.
//   ssh assessiq-vps 'docker exec -i -e SET=dev -e DEV=<q1,q2,...> assessiq-api node - <runIds>' < tools/eval-floor.mjs
// SET=dev   : print the tables and the effect of each candidate rule on the DEV questions only (free to look at).
// SET=sealed: print the effect of the chosen rule (RULE=...) on the SEALED questions. Run it ONCE.
import fs from "node:fs";
import path from "node:path";

const EVAL = "/app/modules/07-ai-grading/eval";
const runs = (process.argv[2] ?? "").split(",").filter(Boolean);
const dev = new Set((process.env.DEV ?? "").split(",").filter(Boolean));
const which = process.env.SET ?? "dev";
const qKey = (id) => id.replace(/-\d{2}$/, "");

const expected = new Map();
for (const dir of ["cases", "cases-private"]) {
  const d = path.join(EVAL, dir);
  if (!fs.existsSync(d)) continue;
  for (const f of fs.readdirSync(d).filter((x) => x.endsWith(".expected.json"))) {
    const j = JSON.parse(fs.readFileSync(path.join(d, f), "utf8"));
    expected.set(j.id, j);
  }
}
const rows = [];
for (const r of runs) {
  const d = path.join(EVAL, "runs", r);
  for (const f of fs.readdirSync(d).filter((x) => x.endsWith(".actual.json"))) {
    const a = JSON.parse(fs.readFileSync(path.join(d, f), "utf8"));
    const e = expected.get(a.id);
    if (!e || a.error) continue;
    const inDev = dev.has(qKey(a.id));
    if ((which === "dev") !== inDev) continue;
    const n = e.anchors.length;
    const hits = (a.anchors ?? []).filter((x) => x.hit).length;
    rows.push({ id: a.id, exp: e.band, act: a.band, n, hits, adv: !!e.adversarial });
  }
}
const frac = (r) => (r.n === 0 ? null : r.hits / r.n);
const bucket = (r) => { const f = frac(r); return f === null ? "no anchors" : f === 0 ? "0" : f < 0.5 ? "<0.5" : f < 1 ? "0.5-<1" : "all"; };

if (which === "dev") {
  console.log(`DEV cases ${rows.length}`);
  const b = new Map();
  for (const r of rows) { const k = bucket(r); const s = b.get(k) ?? { exp: [0, 0, 0, 0, 0], act: [0, 0, 0, 0, 0] }; s.exp[r.exp]++; s.act[r.act]++; b.set(k, s); }
  for (const [k, s] of [...b].sort()) console.log(`  hit share ${k.padEnd(10)} expected bands ${s.exp.join(" ")}   graded bands ${s.act.join(" ")}`);
}

// candidate rules: return the new band
const rules = {
  none: (r) => r.act,
  "all->3": (r) => (bucket(r) === "all" ? Math.max(r.act, 3) : r.act),
  "all->3,>=.5->2": (r) => (bucket(r) === "all" ? Math.max(r.act, 3) : frac(r) !== null && frac(r) >= 0.5 ? Math.max(r.act, 2) : r.act),
  "all->3,>=.5->1": (r) => (bucket(r) === "all" ? Math.max(r.act, 3) : frac(r) !== null && frac(r) >= 0.5 ? Math.max(r.act, 1) : r.act),
  "all->4": (r) => (bucket(r) === "all" ? 4 : r.act),
  "all->4 if graded 3": (r) => (bucket(r) === "all" && r.act === 3 ? 4 : r.act),
  "mid(.5-<1)->3 floor": (r) => (bucket(r) === "0.5-<1" ? Math.max(r.act, 3) : r.act),
  "all->4,mid->3": (r) => (bucket(r) === "all" ? 4 : bucket(r) === "0.5-<1" ? Math.max(r.act, 3) : r.act),
};
const only = process.env.RULE;
for (const [name, fn] of Object.entries(rules)) {
  if (which === "sealed" && name !== "none" && name !== only) continue;
  let exact = 0, fixed = 0, broken = 0, adv = 0, over = 0;
  for (const r of rows) {
    const nb = fn(r);
    if (nb === r.exp) exact++;
    if (r.act !== r.exp && nb === r.exp) fixed++;
    if (r.act === r.exp && nb !== r.exp) broken++;
    if (r.adv && nb >= 3) adv++;
    if (nb > r.exp) over++;
  }
  // McNemar discordant pairs are fixed (only floor right) and broken (only original right)
  console.log(`  rule ${name.padEnd(16)} exact ${exact}/${rows.length} (${((exact / rows.length) * 100).toFixed(1)}%)  fixed ${fixed}  broken ${broken}  too-high ${over}  adversarial at 3+: ${adv}`);
}
