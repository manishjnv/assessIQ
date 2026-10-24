// AssessIQ — "Start a test": one screen to pick a licensed question set, pick
// candidates and send. Kit pattern: patterns.md "forms" (stacked cards, one
// primary pill button) + components.md "cards" / "chips".
// Reuses existing routes only: from-set create -> publish -> invite -> users/import.
// The six-screen path (assessments / assessment-detail) stays untouched.

import React, { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { Button, Card, Chip, FieldHelp, Input, Label, PageHeader, Spinner } from "@assessiq/ui-system";
import { HelpTip } from "@assessiq/help-system/components";
import { csvCell } from "@assessiq/core/escape";
import { AdminShell } from "../components/AdminShell.js";
import {
  AdminApiError, createAssessmentFromSet, createFullMockApi, getAvailableSets, getPackLevelsApi, importCandidates,
  importLicensedSet, inviteAssessmentUsers, listCandidates, listExamBlueprintsApi, publishAssessmentApi,
} from "../api.js";
import type { AvailableSet, CandidateOption, ExamBlueprintSummary } from "../api.js";
import { formatDate } from "../lib/format.js";
import { inviteSkipReasonLabel } from "../lib/labels.js";
import { cameraNoticeSettingsPath } from "../lib/camera-errors.js";

const LEVELS = ["Beginner", "Intermediate", "Advanced"];

/** Help ids of this page start with its helpPage prefix and never contain a hyphen. */
export const START_TEST_HELP_PAGE = "admin.start_test";
export const START_TEST_MOCK_HELP = {
  card: "admin.start_test.mock",
  unverified: "admin.start_test.mock.unverified",
} as const;

/** A step that stops with a message for the admin (not an API error). */
class StepError extends Error {}
const MAX_QUESTIONS = 200;
const EMAIL_RE = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;
const sans: React.CSSProperties = { fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)" };
const stack: React.CSSProperties = { display: "flex", flexDirection: "column", gap: "var(--aiq-space-md)" };

/** Local "YYYY-MM-DDTHH:mm" for a datetime-local input. */
function toLocalInput(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** One entry per line or comma-separated; a non-email token after an email is its name. */
export function parsePasted(text: string): { entries: { email: string; name: string }[]; invalid: string[] } {
  const entries: { email: string; name: string }[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    let last: { email: string; name: string } | null = null;
    for (const tok of line.split(",").map((t) => t.trim()).filter(Boolean)) {
      if (EMAIL_RE.test(tok)) {
        const email = tok.toLowerCase();
        last = null;
        if (seen.has(email)) continue;
        seen.add(email);
        last = { email, name: "" };
        entries.push(last);
      } else if (last !== null && last.name === "" && !tok.includes("@")) last.name = tok;
      else invalid.push(tok);
    }
  }
  return { entries, invalid };
}

interface Done {
  id: string;
  invited: number;
  created: number;
  skipped: { who: string; reason: string }[];
  warning?: string;
}

export function AdminStartTest(): React.ReactElement {
  const [sets, setSets] = useState<AvailableSet[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [setId, setSetId] = useState("");
  const [level, setLevel] = useState(1);
  const [count, setCount] = useState(10);
  const [minutes, setMinutes] = useState(""); // optional time limit; empty = level time
  const [name, setName] = useState("");
  const [search, setSearch] = useState("");
  const [candidates, setCandidates] = useState<CandidateOption[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [pasted, setPasted] = useState("");
  const [opensAt, setOpensAt] = useState(() => {
    const d = new Date(Math.ceil(Date.now() / 300000) * 300000); // next 5 minutes
    return toLocalInput(d);
  });
  const [closesAt, setClosesAt] = useState(() => toLocalInput(new Date(Date.now() + 7 * 86400000)));
  const [steps, setSteps] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ step: string; message: string; id: string | null; cameraPath: string | null } | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const [blueprints, setBlueprints] = useState<ExamBlueprintSummary[] | null>(null);
  const [mockOpen, setMockOpen] = useState(false);
  const [blueprintId, setBlueprintId] = useState("");
  // Z-142 (7): test type and camera for the new test (the page had no type input before).
  const [testType, setTestType] = useState<"real" | "mock">("real");
  const [cameraRequired, setCameraRequired] = useState(false);

  useEffect(() => {
    getAvailableSets().then((d) => setSets(d.sets)).catch((e: unknown) => {
      setSets([]);
      setLoadError(e instanceof AdminApiError ? e.apiError.message : "Could not load the question sets.");
    });
  }, []);

  useEffect(() => {
    listExamBlueprintsApi().then((d) => setBlueprints(d.items)).catch(() => setBlueprints([]));
  }, []);

  useEffect(() => {
    const t = setTimeout(() => {
      listCandidates(search).then((d) => setCandidates(d.items.filter((u) => u.status === "active"))).catch(() => setCandidates([]));
    }, 250);
    return () => clearTimeout(t);
  }, [search]);

  const set = sets?.find((s) => s.source_pack_id === setId) ?? null;
  const blueprint = blueprints?.find((b) => b.id === blueprintId) ?? null;
  const parsed = useMemo(() => parsePasted(pasted), [pasted]);
  const total = picked.size + parsed.entries.length;
  const minutesOk = minutes.trim() === "" || (Number.isInteger(Number(minutes)) && Number(minutes) >= 1 && Number(minutes) <= 600);
  // Z-103: suggestion only; the time limit field stays the override.
  const avg = set?.avg_minutes_per_question ?? 0;
  const suggestedMinutes = blueprint === null && avg > 0 && count >= 1 ? Math.ceil(count * avg) : 0;
  const canSend = set !== null && total > 0 && name.trim() !== "" && opensAt !== "" && minutesOk && !busy;

  function chooseSet(s: AvailableSet) {
    setSetId(s.source_pack_id);
    setLevel(1);
    setMinutes("");
    setCount(Math.min(10, s.question_count));
    setName(`${s.name} — ${formatDate(new Date())}`);
  }

  function reset() {
    setDone(null); setFailure(null); setSteps([]); setPicked(new Set()); setPasted(""); setSetId("");
    setBlueprintId(""); setMockOpen(false);
  }

  async function send() {
    if (set === null) return;
    setBusy(true); setFailure(null); setSteps([]);
    let id: string | null = null;
    let step = "Create the assessment";
    const mark = (s: string) => setSteps((p) => [...p, s]);
    try {
      let mockNote: string | undefined;
      if (blueprint !== null) {
        step = "Copy the question set into your organisation";
        const imported = await importLicensedSet(set.source_pack_id);
        step = "Find the difficulty level";
        const levels = (await getPackLevelsApi(imported.cloned_pack_id)).levels;
        const levelId = levels.find((l) => l.order === level)?.id;
        if (levelId === undefined) throw new StepError(`This question set has no difficulty ${level}.`);
        step = "Create the full mock";
        const mock = await createFullMockApi(blueprint.id, {
          pack_id: imported.cloned_pack_id,
          level_id: levelId,
          opens_at: new Date(opensAt).toISOString(),
          ...(closesAt ? { closes_at: new Date(closesAt).toISOString() } : {}),
          name: name.trim(),
          delivery_mode: testType,
          camera_required: testType === "real" && cameraRequired,
        });
        id = mock.assessment.id;
        if (mock.warnings.length > 0) mockNote = mock.warnings.join(" ");
        mark("Full mock created");
      } else {
        const body = {
          source_pack_id: set.source_pack_id,
          level_position: level,
          name: name.trim(),
          question_count: Math.max(1, Math.min(count, set.question_count, MAX_QUESTIONS)),
          opens_at: new Date(opensAt).toISOString(),
          ...(closesAt ? { closes_at: new Date(closesAt).toISOString() } : {}),
          ...(minutes.trim() !== "" ? { duration_minutes: Number(minutes) } : {}),
          delivery_mode: testType,
          camera_required: testType === "real" && cameraRequired,
        };
        id = (await createAssessmentFromSet(body)).id;
        mark("Assessment created");
      }
      step = "Publish the assessment";
      await publishAssessmentApi(id);
      mark("Assessment published");
      const skipped: Done["skipped"] = [];
      let invited = 0, created = 0;
      let warning: string | undefined;
      if (picked.size > 0) {
        step = "Invite the chosen candidates";
        const r = await inviteAssessmentUsers(id, [...picked]);
        invited += r.invited;
        for (const k of r.skipped) {
          skipped.push({ who: candidates.find((c) => c.id === k.userId)?.email ?? k.userId, reason: inviteSkipReasonLabel(k.reason) });
        }
        mark(`Invited ${r.invited} chosen candidate${r.invited === 1 ? "" : "s"}`);
      }
      if (parsed.entries.length > 0) {
        step = "Invite the pasted email addresses";
        const csv = "name,email\n" + parsed.entries.map((e) => `${csvCell(e.name || e.email.split("@")[0]!)},${csvCell(e.email)}`).join("\n");
        const r = await importCandidates(csv, id);
        invited += r.invited; created += r.created; warning = r.warning;
        for (const k of r.skipped) skipped.push({ who: k.email, reason: inviteSkipReasonLabel(k.reason) });
        mark(`Invited ${r.invited} pasted address${r.invited === 1 ? "" : "es"}`);
      }
      const doneWarning = [mockNote, warning].filter((x): x is string => Boolean(x)).join(" ");
      setDone({ id, invited, created, skipped, ...(doneWarning ? { warning: doneWarning } : {}) });
    } catch (e) {
      const message = e instanceof AdminApiError ? e.apiError.message
        : e instanceof StepError ? e.message
        : "Something went wrong.";
      setFailure({ step, id, message, cameraPath: cameraNoticeSettingsPath(e) });
    } finally {
      setBusy(false);
    }
  }

  if (done !== null) {
    return (
      <AdminShell breadcrumbs={["Start a test"]} helpPage="admin.start_test">
        <div style={stack}>
          <PageHeader title="Assessment created." lede="Candidates get their invitation by email." />
          <Card>
            <div style={stack} data-testid="start-test-result">
              <HelpTip helpId="admin.start_test.result">
                <div style={{ display: "flex", gap: "var(--aiq-space-sm)", flexWrap: "wrap" }}>
                  <Chip variant="success">{done.invited} invited</Chip>
                  <Chip>{done.created} new candidates</Chip>
                  <Chip>{done.skipped.length} skipped</Chip>
                </div>
              </HelpTip>
              <Link to={`/admin/assessments/${done.id}`} style={sans}>/admin/assessments/{done.id}</Link>
              {done.warning && <FieldHelp>{done.warning}</FieldHelp>}
              {done.skipped.length > 0 && (
                <ul style={{ ...sans, margin: 0, paddingLeft: 18 }}>
                  {done.skipped.map((s, i) => <li key={i}>{s.who}: {s.reason}</li>)}
                </ul>
              )}
              <div style={{ display: "flex", gap: "var(--aiq-space-sm)" }}>
                <Link to={`/admin/assessments/${done.id}`}><Button>Open assessment</Button></Link>
                <Button variant="outline" onClick={reset}>Start another</Button>
              </div>
            </div>
          </Card>
        </div>
      </AdminShell>
    );
  }

  return (
    <AdminShell breadcrumbs={["Start a test"]} helpPage="admin.start_test">
      <div style={stack}>
        <PageHeader title="Start a test." lede="Pick a question set, pick candidates, and send the invitations." />

        <Card>
          <div style={stack}>
            <HelpTip helpId="admin.start_test.set"><h2 className="aiq-serif" style={{ margin: 0 }}>1. Question set</h2></HelpTip>
            {sets === null && <Spinner />}
            {loadError && <div role="alert" style={{ ...sans, color: "var(--aiq-color-danger)" }}>{loadError}</div>}
            {sets !== null && sets.length === 0 && !loadError && (
              <FieldHelp>No question sets are licensed for your organisation yet. Contact your platform operator.</FieldHelp>
            )}
            {(sets ?? []).map((s) => (
              <label key={s.source_pack_id} style={{ ...sans, display: "flex", gap: "var(--aiq-space-sm)", alignItems: "center", cursor: "pointer" }}>
                <input type="radio" name="set" checked={setId === s.source_pack_id} onChange={() => chooseSet(s)} />
                <span>{s.name} · {s.domain} · {s.question_count} questions</span>
                <Chip variant={s.cloned ? "success" : "default"}>{s.cloned ? "Licensed" : "Not yet imported"}</Chip>
              </label>
            ))}
            {set !== null && (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "var(--aiq-space-md)" }}>
                <div>
                  <Label htmlFor="st-level">Difficulty</Label>
                  <select id="st-level" className="aiq-input" value={level} onChange={(e) => setLevel(Number(e.target.value))}>
                    {Array.from({ length: Math.max(1, set.level_count) }, (_, i) => i + 1).map((p) => (
                      <option key={p} value={p}>{LEVELS[p - 1] ?? `Difficulty ${p}`}</option>
                    ))}
                  </select>
                </div>
                {blueprint === null && (
                  <div>
                    <Label htmlFor="st-count">Number of questions</Label>
                    <Input id="st-count" type="number" min={1} max={Math.min(set.question_count, MAX_QUESTIONS)} value={count}
                      onChange={(e) => setCount(Number(e.target.value))} />
                  </div>
                )}
                {blueprint === null && (
                  <div>
                    <HelpTip helpId="admin.start_test.time_limit"><Label htmlFor="st-minutes">Time limit (minutes)</Label></HelpTip>
                    <Input id="st-minutes" type="number" min={1} max={600} step={1} value={minutes}
                      placeholder={set.level_minutes?.[level - 1] !== undefined ? String(set.level_minutes[level - 1]) : ""}
                      onChange={(e) => setMinutes(e.target.value)} />
                    {suggestedMinutes > 0 && (
                      <HelpTip helpId="admin.start_test.suggested_time">
                        <div style={{ ...sans, marginTop: 4, display: "flex", gap: "var(--aiq-space-sm)", alignItems: "center", flexWrap: "wrap" }}>
                          <span data-testid="st-suggested">Suggested time: {suggestedMinutes} min</span>
                          <Button variant="outline" onClick={() => setMinutes(String(Math.min(600, suggestedMinutes)))}>Use suggested time</Button>
                        </div>
                      </HelpTip>
                    )}
                    <div style={{ color: "var(--aiq-color-fg-muted)", marginTop: 4 }}>
                      Leave this empty to use the time of the difficulty you chose. A running attempt keeps the time it started with.
                    </div>
                  </div>
                )}
                <div>
                  <Label htmlFor="st-type">Test type</Label>
                  <select id="st-type" className="aiq-input" value={testType}
                    onChange={(e) => { const next = e.target.value === "mock" ? "mock" : "real"; setTestType(next); if (next === "mock") setCameraRequired(false); }}>
                    <option value="real">Real exam</option>
                    <option value="mock">Mock test</option>
                  </select>
                  <label data-help-id="admin.assessment.invite.test_type" style={{ ...sans, display: "flex", gap: "var(--aiq-space-xs)", alignItems: "center", marginTop: 6 }}>
                    <input type="checkbox" checked={testType === "real" && cameraRequired} disabled={testType === "mock"}
                      onChange={(e) => setCameraRequired(e.target.checked)} />
                    Camera required
                  </label>
                </div>
                <div>
                  <Label htmlFor="st-name">Test name</Label>
                  <Input id="st-name" value={name} onChange={(e) => setName(e.target.value)} />
                </div>
              </div>
            )}
          </div>
        </Card>

        <Card>
          <div style={stack}>
            <HelpTip helpId={START_TEST_MOCK_HELP.card}><h2 className="aiq-serif" style={{ margin: 0 }}>Full mock (optional)</h2></HelpTip>
            {!mockOpen && (
              <div>
                <Button variant="outline" onClick={() => setMockOpen(true)}>Start a full mock</Button>
              </div>
            )}
            {mockOpen && (
              <>
                <FieldHelp>A full mock uses an exam blueprint: its sections, timing and marks. Pick the question set and difficulty in step 1.</FieldHelp>
                <label style={{ ...sans, display: "flex", gap: "var(--aiq-space-sm)", alignItems: "center", cursor: "pointer" }}>
                  <input type="radio" name="blueprint" checked={blueprintId === ""} onChange={() => setBlueprintId("")} />
                  <span>No full mock (a normal test)</span>
                </label>
                {blueprints === null && <Spinner />}
                {(blueprints ?? []).map((b) => (
                  <label key={b.id} style={{ ...sans, display: "flex", gap: "var(--aiq-space-sm)", alignItems: "center", cursor: "pointer" }}>
                    <input type="radio" name="blueprint" checked={blueprintId === b.id}
                      onChange={() => { setBlueprintId(b.id); setName(`${b.name} — ${formatDate(new Date())}`); }} />
                    <span>{b.name} · {b.total_questions} questions · {b.total_minutes} minutes</span>
                    {b.verification_status === "verified" ? <Chip variant="success">Verified</Chip> : <Chip>Unverified</Chip>}
                  </label>
                ))}
                {blueprint !== null && blueprint.verification_status !== "verified" && (
                  <HelpTip helpId={START_TEST_MOCK_HELP.unverified}>
                    <FieldHelp>This blueprint is not verified. Check its sections and marks against the official notice before a real test.</FieldHelp>
                  </HelpTip>
                )}
                <div>
                  <Button variant="outline" onClick={() => { setMockOpen(false); setBlueprintId(""); }}>Cancel full mock</Button>
                </div>
              </>
            )}
          </div>
        </Card>

        <Card>
          <div style={stack}>
            <HelpTip helpId="admin.start_test.candidates"><h2 className="aiq-serif" style={{ margin: 0 }}>2. Candidates</h2></HelpTip>
            <Chip leftIcon="user">{picked.size} selected</Chip>
            <Input aria-label="Search candidates" placeholder="Search by name or email" value={search} onChange={(e) => setSearch(e.target.value)} />
            <div style={{ maxHeight: 220, overflowY: "auto", border: "1px solid var(--aiq-color-border)", borderRadius: "var(--aiq-radius-sm)" }}>
              {candidates.length === 0 && <div style={{ ...sans, padding: "var(--aiq-space-md)" }}>No active candidates found.</div>}
              {candidates.map((u) => (
                <label key={u.id} style={{ ...sans, display: "flex", gap: "var(--aiq-space-sm)", padding: "var(--aiq-space-sm) var(--aiq-space-md)", cursor: "pointer" }}>
                  <input type="checkbox" checked={picked.has(u.id)}
                    onChange={() => setPicked((p) => { const n = new Set(p); if (n.has(u.id)) n.delete(u.id); else n.add(u.id); return n; })} />
                  <span>{u.name} · {u.email}</span>
                </label>
              ))}
            </div>
            <div>
              <HelpTip helpId="admin.start_test.emails"><Label htmlFor="st-paste">Or paste email addresses</Label></HelpTip>
              <textarea id="st-paste" className="aiq-input" rows={4} value={pasted} onChange={(e) => setPasted(e.target.value)}
                placeholder={"asha@example.com, Asha Verma\nrohan@example.com"} />
              <FieldHelp>One address per line, or separate them with commas. Add a name after the address if you wish. New addresses become candidates.</FieldHelp>
            </div>
            {pasted.trim() !== "" && <Chip variant="success">{parsed.entries.length} valid address{parsed.entries.length === 1 ? "" : "es"}</Chip>}
            {parsed.invalid.length > 0 && (
              <div role="alert" style={{ ...sans, color: "var(--aiq-color-danger)" }}>
                These entries are not valid email addresses: {parsed.invalid.join(", ")}
              </div>
            )}
          </div>
        </Card>

        <Card>
          <div style={stack}>
            <HelpTip helpId="admin.start_test.window"><h2 className="aiq-serif" style={{ margin: 0 }}>3. Window</h2></HelpTip>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "var(--aiq-space-md)" }}>
              <div>
                <Label htmlFor="st-opens">Opens</Label>
                <Input id="st-opens" type="datetime-local" value={opensAt} onChange={(e) => setOpensAt(e.target.value)} />
              </div>
              <div>
                <Label htmlFor="st-closes">Closes</Label>
                <Input id="st-closes" type="datetime-local" value={closesAt} onChange={(e) => setClosesAt(e.target.value)} />
              </div>
            </div>
            <FieldHelp>Candidates can start between these two times. The time limit comes from the difficulty you chose.</FieldHelp>

            {steps.map((s) => <div key={s} style={sans}>✓ {s}</div>)}
            {busy && <Spinner />}
            {failure !== null && (
              <div role="alert" style={{ ...sans, color: "var(--aiq-color-danger)" }}>
                Step failed: {failure.step}. {failure.message}
                {failure.cameraPath !== null && <> <Link to={failure.cameraPath}>Open camera settings</Link></>}
                {failure.id !== null && <> The assessment exists. <Link to={`/admin/assessments/${failure.id}`}>Open it to finish there.</Link></>}
              </div>
            )}
            <div>
              <HelpTip helpId="admin.start_test.send">
                <Button disabled={!canSend} onClick={() => void send()}>Send invitations</Button>
              </HelpTip>
            </div>
          </div>
        </Card>
      </div>
    </AdminShell>
  );
}
