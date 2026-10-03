/**
 * tools/lint-skill-mount.ts  (RV71c)
 *
 * The grading code reads skills from ~/.claude/skills/<name>/SKILL.md (skill-sha.ts, homedir =
 * /home/node in the container). infra/docker-compose.yml must mount prompts/skills at
 * /home/node/.claude/skills in BOTH assessiq-api and assessiq-worker. (lint-deploy-procedure
 * CHECK A only checks the source side; this checks the container path and both services.)
 *
 * Usage: pnpm lint:skill-mount | pnpm lint:skill-mount:self-test
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { REPO_ROOT, finish, selfTest } from "./lint-util.js";

const SERVICES = ["assessiq-api", "assessiq-worker"];
const TARGET = "/home/node/.claude/skills";

/** Volume lines of `svc` (text between its 2-space key and the next 2-space key). */
function volumes(compose: string, svc: string): string[] {
  const m = new RegExp(`^  ${svc}:\\s*$([\\s\\S]*?)(?=^  \\S|(?![\\s\\S]))`, "m").exec(compose);
  return m ? [...m[1]!.matchAll(/^\s*-\s+(\S+:\S+)/gm)].map((x) => x[1]!) : [];
}

export function check(compose: string, code: string): string[] {
  const v: string[] = [];
  if (!code.includes('".claude", "skills"')) v.push("skill-sha.ts no longer reads ~/.claude/skills - update TARGET in tools/lint-skill-mount.ts");
  for (const svc of SERVICES) {
    const ok = volumes(compose, svc).some((x) => /(^|\/)prompts\/skills:/.test(x) && x.split(":")[1] === TARGET);
    if (!ok) v.push(`infra/docker-compose.yml: ${svc} does not mount prompts/skills at ${TARGET}`);
  }
  return v;
}

if (process.argv.includes("--self-test")) {
  const svc = (extra: string): string =>
    `services:\n  assessiq-api:\n    volumes:\n      - ../prompts/skills:${TARGET}:ro\n  assessiq-worker:\n    volumes:\n      - /x:/y\n${extra}`;
  const code = '".claude", "skills"';
  selfTest(
    "skill-mount",
    (c) => check(c, code),
    svc("").replace("- /x:/y", `- ../prompts/skills:${TARGET}:ro`),
    svc(""), // worker lacks the mount
  );
} else {
  const compose = fs.readFileSync(path.join(REPO_ROOT, "infra/docker-compose.yml"), "utf8");
  const code = fs.readFileSync(path.join(REPO_ROOT, "modules/07-ai-grading/src/skill-sha.ts"), "utf8");
  finish("skill-mount", check(compose, code), `OK (${SERVICES.join(" + ")} mount prompts/skills at ${TARGET})`);
}
