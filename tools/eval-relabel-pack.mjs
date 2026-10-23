// Z-165 step 3: a blind re-label pack. Read-only, no AI call. Run on the VPS in the API container; the output holds
// STUDENT-STYLE ANSWER TEXT, so save it OUTSIDE the repo and never commit or paste it:
//   ssh assessiq-vps 'docker exec -i assessiq-api node - <runIds>' < tools/eval-relabel-pack.mjs > out.txt
// out.txt = the pack (markdown, items P01..), then a line "=====KEY=====", then a JSON key (item -> case id).
// The pack shows NO expected band and NO model band. Items: every miss plus the same number of random matches, shuffled.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const EVAL = "/app/modules/07-ai-grading/eval";
const runs = (process.argv[2] ?? "").split(",").filter(Boolean);
const h = (s) => crypto.createHash("sha1").update("z165-relabel-v1:" + s).digest("hex");

function find(id, suffix) {
  for (const dir of ["cases", "cases-private"]) {
    const p = path.join(EVAL, dir, `${id}.${suffix}.json`);
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8"));
  }
  return null;
}

const miss = [], ok = [];
for (const r of runs) {
  const d = path.join(EVAL, "runs", r);
  for (const f of fs.readdirSync(d).filter((x) => x.endsWith(".actual.json"))) {
    const a = JSON.parse(fs.readFileSync(path.join(d, f), "utf8"));
    const e = find(a.id, "expected");
    if (!e || a.error) continue;
    (a.band === e.band ? ok : miss).push(a.id);
  }
}
ok.sort((a, b) => h(a).localeCompare(h(b)));
let picked = [...miss, ...ok.slice(0, miss.length)].sort((a, b) => h("shuffle" + a).localeCompare(h("shuffle" + b)));
// SLICE=<band>: instead, every case whose LABEL is that band (misses and matches together), shuffled. Still blind.
if (process.env.SLICE) {
  const want = Number(process.env.SLICE);
  picked = [...miss, ...ok].filter((id) => find(id, "expected")?.band === want).sort((a, b) => h("shuffle" + a).localeCompare(h("shuffle" + b)));
}

const out = [];
const key = {};
out.push("# Blind re-label pack (Z-165). Local file: do NOT commit, do NOT share.\n");
out.push("For each item read the question, the rubric and the answer, then write the band you would give (0-4) using the rubric band table. Do not look at any model or earlier label. Optional: one line why for a 3 or 4.\n");
picked.forEach((id, i) => {
  const code = `P${String(i + 1).padStart(2, "0")}`;
  key[code] = id;
  const inp = find(id, "input");
  out.push(`\n---\n## ${code}\n`);
  if (!inp) { out.push("(case file missing)\n"); return; }
  out.push(`**Question:** ${inp.question?.title ?? ""}\n\n${inp.question?.text ?? ""}\n`);
  if (inp.question_content) out.push(`\n**Question content:**\n\`\`\`json\n${JSON.stringify(inp.question_content, null, 1)}\n\`\`\`\n`);
  const anchors = inp.rubric?.anchors ?? [];
  if (anchors.length) out.push(`\n**Rubric anchors:** ${anchors.map((a) => `${a.label} (w${a.weight})`).join("; ")}\n`);
  const bands = inp.rubric?.bands ?? inp.rubric?.reasoning_bands;
  if (bands) out.push(`\n**Rubric bands:**\n${Object.entries(bands).map(([k, v]) => `- ${k}: ${v}`).join("\n")}\n`);
  out.push(`\n**Candidate answer:**\n\n${typeof inp.answer === "string" ? inp.answer : inp.candidate_answer ?? JSON.stringify(inp.answer)}\n`);
  out.push(`\n**Your band (0-4):** ____    **Why (optional):** ____\n`);
});
console.log(out.join(""));
console.log("\n=====KEY=====");
console.log(JSON.stringify({ items: picked.length, key }));
