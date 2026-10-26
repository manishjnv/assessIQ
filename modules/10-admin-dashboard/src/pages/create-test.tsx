// AssessIQ — "Create a test" (CT-2). /admin/create-test
//
// One page for any test: exam and question set, what to cover (whole set, chosen topics with a count each,
// or an exam pattern), test type and rules, name and window. One button, "Save as draft": it copies the set into
// the organisation, finds the level and calls POST /api/admin/tests (module 05 compileTestSpec). Nothing is
// published or invited here: the admin opens the assessment page to finish and invite students.
// Type-card settings come from the same helpers as Start a test (fromTestType, feedbackSetting).
// The Exam list shows every pattern today; CT-4 will list only exams the organisation holds a grant for.

import React, { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { Button, Card, Chip, FieldHelp, Input, Label, PageHeader, Spinner } from "@assessiq/ui-system";
import { HelpTip } from "@assessiq/help-system/components";
import { AdminShell } from "../components/AdminShell.js";
import { FrameworkTreePicker } from "../components/FrameworkTreePicker.js";
import { TestTypeChooser, fromTestType, feedbackSetting, type FeedbackLevel, type TestType, type ChooserCameraSettings } from "../components/TestTypeChooser.js";
import { AdminApiError, getAvailableSets, getPackLevelsApi, importLicensedSet, listExamBlueprintsApi } from "../api.js";
import type { AvailableSet, ExamBlueprintSummary } from "../api.js";
import { createTestApi } from "../api/create-test.js";
import type { CreateTestCover } from "../api/create-test.js";
import { getCameraSettingsApi } from "../api/camera.js";
import { cameraNoticeSettingsPath } from "../lib/camera-errors.js";
import { formatDate } from "../lib/format.js";

/** Help ids of this page start with its helpPage prefix and never contain a hyphen. */
export const CREATE_TEST_HELP_PAGE = "admin.create_test";
const MAX_QUESTIONS = 100; // owner rule 2026-10-25
const MAX_TOPICS = 10;
const LEVELS = ["Beginner", "Intermediate", "Advanced"];

class StepError extends Error {}
const sans: React.CSSProperties = { fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)" };
const stack: React.CSSProperties = { display: "flex", flexDirection: "column", gap: "var(--aiq-space-md)" };
const cols: React.CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 240px), 1fr))", gap: "var(--aiq-space-md)" };
const heading: React.CSSProperties = { margin: 0 };

function toLocalInput(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** `total` split over `n` rows: even share, the remainder goes to the first rows. */
export function evenSplit(total: number, n: number): number[] {
  if (n <= 0) return [];
  const base = Math.floor(total / n);
  const extra = total % n;
  return Array.from({ length: n }, (_, i) => base + (i < extra ? 1 : 0));
}

interface TopicRow { id: string; name: string; count: number }

export function AdminCreateTest(): React.ReactElement {
  const [sets, setSets] = useState<AvailableSet[] | null>(null);
  const [exams, setExams] = useState<ExamBlueprintSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // CT-3: the exam patterns page links here with ?exam=<pattern id>.
  const [examId, setExamId] = useState(() => (typeof window === "undefined" ? "" : new URLSearchParams(window.location.search).get("exam") ?? ""));
  const [setId, setSetId] = useState("");
  const [level, setLevel] = useState(1);
  const [cover, setCover] = useState<"whole" | "topics" | "pattern">("whole");
  const [count, setCount] = useState(60); // owner 2026-10-25: default 60
  const [rows, setRows] = useState<TopicRow[]>([]);
  const [scope, setScope] = useState<"full" | "subjects">("full");
  const [subjects, setSubjects] = useState<number[]>([]);
  const [sizePct, setSizePct] = useState(100);
  const [minutes, setMinutes] = useState("");
  const [name, setName] = useState("");
  const [opensAt, setOpensAt] = useState(() => toLocalInput(new Date(Math.ceil(Date.now() / 300000) * 300000)));
  const [closesAt, setClosesAt] = useState(() => toLocalInput(new Date(Date.now() + 7 * 86400000)));
  const [testType, setTestType] = useState<TestType>("real");
  const [integrity, setIntegrity] = useState({ fullscreen: false, blockCopyPaste: false });
  const [feedbackLevel, setFeedbackLevel] = useState<FeedbackLevel>("none");
  const [cameraSettings, setCameraSettings] = useState<ChooserCameraSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ step: string; message: string; cameraPath: string | null } | null>(null);
  const [done, setDone] = useState<{ id: string; warnings: string[] } | null>(null);

  useEffect(() => {
    getAvailableSets().then((d) => setSets(d.sets)).catch((e: unknown) => {
      setSets([]);
      setLoadError(e instanceof AdminApiError ? e.apiError.message : "Could not load the question sets.");
    });
    listExamBlueprintsApi().then((d) => setExams(d.items)).catch(() => setExams([]));
    getCameraSettingsApi().then(setCameraSettings).catch(() => setCameraSettings(null));
  }, []);

  const set = sets?.find((s) => s.source_pack_id === setId) ?? null;
  const exam = exams?.find((b) => b.id === examId) ?? null;
  const topicTotal = rows.reduce((n, r) => n + r.count, 0);
  const overCap = cover === "topics" && topicTotal > MAX_QUESTIONS;
  const minutesOk = minutes.trim() === "" || (Number.isInteger(Number(minutes)) && Number(minutes) >= 1 && Number(minutes) <= 600);
  const avg = set?.avg_minutes_per_question ?? 0;
  const shown = cover === "topics" ? topicTotal : count;
  const suggested = cover !== "pattern" && avg > 0 && shown >= 1 ? Math.min(600, Math.ceil(shown * avg)) : 0;
  const coverOk =
    cover === "whole" ? count >= 1 && count <= MAX_QUESTIONS
    : cover === "topics" ? rows.length > 0 && rows.every((r) => Number.isInteger(r.count) && r.count >= 1) && !overCap
    : exam !== null && (scope === "full" || subjects.length > 0);
  const canSave = set !== null && name.trim() !== "" && opensAt !== "" && minutesOk && coverOk && !busy;
  const typeCost = useMemo(() => ({ mock: 10, real: 20, real_camera: 30 })[testType], [testType]);

  function pickExam(id: string) {
    setExamId(id);
    setSubjects([]);
    setScope("full");
    setSizePct(100);
    const b = exams?.find((x) => x.id === id);
    if (b) { setCover("pattern"); setName(`${b.name} — ${formatDate(new Date())}`); }
    else if (cover === "pattern") setCover("whole");
  }

  function pickSet(s: AvailableSet) {
    setSetId(s.source_pack_id);
    setLevel(1);
    setMinutes("");
    setCount(Math.min(60, s.question_count));
    if (exam === null) setName(`${s.name} — ${formatDate(new Date())}`);
  }

  function pickTopics(ids: string[], _n: unknown, lookup: ReadonlyMap<string, { label: string }>) {
    const chosen = ids.slice(0, MAX_TOPICS);
    const total = Math.min(MAX_QUESTIONS, Math.max(chosen.length, rows.length > 0 ? topicTotal : count));
    const even = evenSplit(total, chosen.length);
    setRows(chosen.map((id, i) => ({ id, name: lookup.get(id)?.label ?? rows.find((r) => r.id === id)?.name ?? "Topic", count: even[i] ?? 1 })));
  }

  const splitEvenly = () => setRows((rs) => evenSplit(Math.min(MAX_QUESTIONS, Math.max(rs.length, topicTotal)), rs.length).map((c, i) => ({ ...rs[i]!, count: c })));

  async function save() {
    if (set === null) return;
    setBusy(true); setFailure(null); setDone(null);
    let step = "Copy the question set into your organisation";
    try {
      const imported = await importLicensedSet(set.source_pack_id);
      step = "Find the difficulty level";
      const levelId = (await getPackLevelsApi(imported.cloned_pack_id)).levels.find((l) => l.order === level)?.id;
      if (levelId === undefined) throw new StepError(`This question set has no difficulty ${level}.`);
      step = "Save the draft";
      const body: CreateTestCover =
        cover === "whole" ? { kind: "whole", question_count: count }
        : cover === "topics" ? { kind: "topics", topics: rows.map((r) => ({ node_id: r.id, count: r.count })) }
        : { kind: "pattern", blueprint_id: examId, ...(scope === "subjects" ? { section_positions: [...subjects].sort((a, b) => a - b) } : {}), ...(sizePct < 100 ? { scale_percent: sizePct } : {}) };
      // Same type-card settings helper as Start a test: Real is fixed on, Mock follows the two checkboxes.
      const settings = { integrity: {
        fullscreen: testType !== "mock" || integrity.fullscreen,
        block_copy_paste: testType !== "mock" || integrity.blockCopyPaste,
      }, ...feedbackSetting(testType, feedbackLevel) };
      const r = await createTestApi({
        pack_id: imported.cloned_pack_id,
        level_id: levelId,
        name: name.trim(),
        cover: body,
        ...(cover !== "pattern" && minutes.trim() !== "" ? { minutes: Number(minutes) } : {}),
        ...fromTestType(testType),
        opens_at: new Date(opensAt).toISOString(),
        ...(closesAt ? { closes_at: new Date(closesAt).toISOString() } : {}),
        settings,
      });
      setDone({ id: r.assessment.id, warnings: r.warnings });
    } catch (e) {
      setFailure({
        step,
        message: e instanceof AdminApiError ? e.apiError.message : e instanceof StepError ? e.message : "Something went wrong.",
        cameraPath: cameraNoticeSettingsPath(e),
      });
    } finally {
      setBusy(false);
    }
  }

  if (done !== null) {
    return (
      <AdminShell breadcrumbs={["Create a test"]} helpPage={CREATE_TEST_HELP_PAGE}>
        <div style={stack}>
          <PageHeader title="Draft saved." lede="Open the assessment to check it, then invite your students." />
          <Card>
            <div style={stack} data-testid="create-test-result">
              {done.warnings.map((w) => <FieldHelp key={w}>{w}</FieldHelp>)}
              <div style={{ display: "flex", gap: "var(--aiq-space-sm)", flexWrap: "wrap" }}>
                <Link to={`/admin/assessments/${done.id}`}><Button>Open assessment</Button></Link>
                <Button variant="outline" onClick={() => setDone(null)}>Create another</Button>
              </div>
            </div>
          </Card>
        </div>
      </AdminShell>
    );
  }

  return (
    <AdminShell breadcrumbs={["Create a test"]} helpPage={CREATE_TEST_HELP_PAGE}>
      <div style={stack}>
        <HelpTip helpId="admin.create_test.page">
          <PageHeader title="Create a test." lede="Pick the exam and question set, choose what it covers, and save a draft." />
        </HelpTip>

        <Card>
          <div style={stack}>
            <h2 className="aiq-serif" style={heading}>1. Exam and question set</h2>
            {loadError && <div role="alert" style={{ ...sans, color: "var(--aiq-color-danger)" }}>{loadError}</div>}
            {(sets === null || exams === null) && <Spinner />}
            <div style={cols}>
              <div>
                <HelpTip helpId="admin.create_test.exam"><Label htmlFor="ct-exam">Exam</Label></HelpTip>
                <select id="ct-exam" className="aiq-input" value={examId} onChange={(e) => pickExam(e.target.value)}>
                  <option value="">No exam pattern (use a set directly)</option>
                  {(exams ?? []).map((b) => <option key={b.id} value={b.id}>{b.name} · {b.edition}</option>)}
                </select>
                {exam !== null && exam.verification_status !== "verified" && <FieldHelp>This exam pattern is not verified. Check it against the official notice before a real test.</FieldHelp>}
              </div>
              <div>
                <HelpTip helpId="admin.create_test.set"><Label htmlFor="ct-set">Question set</Label></HelpTip>
                <select id="ct-set" className="aiq-input" value={setId} onChange={(e) => { const s = sets?.find((x) => x.source_pack_id === e.target.value); if (s) pickSet(s); else setSetId(""); }}>
                  <option value="">Choose a question set</option>
                  {(sets ?? []).map((s) => <option key={s.source_pack_id} value={s.source_pack_id}>{s.name} · {s.question_count} questions</option>)}
                </select>
                {sets !== null && sets.length === 0 && !loadError && <FieldHelp>No question sets are licensed for your organisation yet. Contact your platform operator.</FieldHelp>}
              </div>
              {set !== null && (
                <div>
                  <Label htmlFor="ct-level">Difficulty</Label>
                  <select id="ct-level" className="aiq-input" value={level} onChange={(e) => setLevel(Number(e.target.value))}>
                    {Array.from({ length: Math.max(1, set.level_count) }, (_, i) => i + 1).map((p) => (
                      <option key={p} value={p}>{LEVELS[p - 1] ?? `Difficulty ${p}`}</option>
                    ))}
                  </select>
                </div>
              )}
            </div>
          </div>
        </Card>

        {set !== null && (
          <>
            <Card>
              <div style={stack}>
                <HelpTip helpId="admin.create_test.cover"><h2 className="aiq-serif" style={heading}>2. What to cover</h2></HelpTip>
                <div role="radiogroup" aria-label="What to cover" style={{ display: "flex", gap: "var(--aiq-space-md)", flexWrap: "wrap" }}>
                  {([["whole", "Whole set"], ["topics", "Chosen topics"], ...(exam !== null ? [["pattern", "Exam pattern"]] : [])] as Array<[typeof cover, string]>).map(([k, label]) => (
                    <label key={k} style={{ ...sans, display: "flex", gap: "var(--aiq-space-xs)", alignItems: "center", cursor: "pointer" }}>
                      <input type="radio" name="cover" checked={cover === k} onChange={() => setCover(k)} />
                      {label}
                    </label>
                  ))}
                </div>
                {cover === "whole" && (
                  <div style={{ maxWidth: 240 }}>
                    <Label htmlFor="ct-count">Number of questions (at most {MAX_QUESTIONS})</Label>
                    <Input id="ct-count" type="number" min={1} max={Math.min(set.question_count, MAX_QUESTIONS)} value={count} onChange={(e) => setCount(Number(e.target.value))} />
                    <FieldHelp>The questions are drawn from the whole set with an equal share of each topic.</FieldHelp>
                  </div>
                )}
                {cover === "topics" && (
                  <HelpTip helpId="admin.create_test.topics">
                    <div style={stack}>
                      <FrameworkTreePicker multiple kinds={["unit", "outcome"]} value={rows.map((r) => r.id)} helpId="admin.create_test.topic_picker" onChange={pickTopics} />
                      {rows.length > 0 && (
                        <table style={{ ...sans, width: "100%", borderCollapse: "collapse" }}>
                          <caption style={{ textAlign: "left" }}>Questions for each topic</caption>
                          <thead><tr><th scope="col" style={{ textAlign: "left" }}>Topic</th><th scope="col" style={{ textAlign: "left" }}>Questions</th><th scope="col"><span className="aiq-sr-only">Remove</span></th></tr></thead>
                          <tbody>
                            {rows.map((r) => (
                              <tr key={r.id}>
                                <td>{r.name}</td>
                                <td><Input aria-label={`Questions for ${r.name}`} type="number" min={1} max={MAX_QUESTIONS} value={r.count}
                                  onChange={(e) => setRows((rs) => rs.map((x) => (x.id === r.id ? { ...x, count: Number(e.target.value) } : x)))} /></td>
                                <td><Button variant="outline" onClick={() => setRows((rs) => rs.filter((x) => x.id !== r.id))}>Remove {r.name}</Button></td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                      <div style={{ display: "flex", gap: "var(--aiq-space-sm)", alignItems: "center", flexWrap: "wrap" }}>
                        <Chip variant={overCap ? "warn" : "default"}>Total {topicTotal} of {MAX_QUESTIONS}</Chip>
                        <Button variant="outline" disabled={rows.length === 0} onClick={splitEvenly}>Split evenly</Button>
                      </div>
                      {overCap && <div role="alert" style={{ ...sans, color: "var(--aiq-color-danger)" }}>A test can have at most {MAX_QUESTIONS} questions. Lower a count.</div>}
                      <FieldHelp>Up to {MAX_TOPICS} topics. Whether each topic has enough questions is checked when you save.</FieldHelp>
                    </div>
                  </HelpTip>
                )}
                {cover === "pattern" && exam !== null && (
                  <div style={stack}>
                    <div style={cols}>
                      <div>
                        <Label htmlFor="ct-scope">Sections</Label>
                        <select id="ct-scope" className="aiq-input" value={scope} onChange={(e) => setScope(e.target.value as "full" | "subjects")}>
                          <option value="full">All sections</option>
                          <option value="subjects">Chosen subjects only</option>
                        </select>
                      </div>
                      <div>
                        <Label htmlFor="ct-size">Size</Label>
                        <select id="ct-size" className="aiq-input" value={sizePct} onChange={(e) => setSizePct(Number(e.target.value))}>
                          {[100, 75, 50, 25].map((n) => <option key={n} value={n}>{n === 100 ? "Full size" : `${n}% of the questions`}</option>)}
                        </select>
                      </div>
                    </div>
                    {scope === "subjects" && (
                      <div role="group" aria-label="Subjects" style={{ display: "flex", flexWrap: "wrap", gap: "var(--aiq-space-sm)" }}>
                        {(exam.sections ?? []).map((s, i) => (
                          <label key={i} style={{ ...sans, display: "flex", gap: 4, alignItems: "center" }}>
                            <input type="checkbox" checked={subjects.includes(i)} onChange={(e) => setSubjects((cur) => (e.target.checked ? [...cur, i] : cur.filter((x) => x !== i)))} />
                            {s.name}
                          </label>
                        ))}
                      </div>
                    )}
                    <FieldHelp>{exam.name}: {exam.total_questions} questions, {exam.total_minutes} minutes. {(scope === "subjects" || sizePct < 100) ? "A shorter test is practice: it has no cut-off. " : ""}Sections, timing and marks come from the pattern.</FieldHelp>
                  </div>
                )}
              </div>
            </Card>

            <Card>
              <div style={stack}>
                <HelpTip helpId="admin.create_test.type"><h2 className="aiq-serif" style={heading}>3. Test type and rules</h2></HelpTip>
                <TestTypeChooser
                  value={testType} onChange={setTestType}
                  integrity={integrity} onIntegrityChange={setIntegrity}
                  cameraSettings={cameraSettings}
                  feedbackLevel={feedbackLevel} onFeedbackLevelChange={setFeedbackLevel}
                />
                {cover !== "pattern" && (
                  <div style={{ maxWidth: 320 }}>
                    <HelpTip helpId="admin.create_test.time"><Label htmlFor="ct-minutes">Time limit (minutes)</Label></HelpTip>
                    <Input id="ct-minutes" type="number" min={1} max={600} step={1} value={minutes}
                      placeholder={set.level_minutes?.[level - 1] !== undefined ? String(set.level_minutes[level - 1]) : ""}
                      onChange={(e) => setMinutes(e.target.value)} />
                    {suggested > 0 && (
                      <div style={{ ...sans, marginTop: 4, display: "flex", gap: "var(--aiq-space-sm)", alignItems: "center", flexWrap: "wrap" }}>
                        <span data-testid="ct-suggested">Suggested time: {suggested} min</span>
                        <Button variant="outline" onClick={() => setMinutes(String(suggested))}>Use suggested time</Button>
                      </div>
                    )}
                    <FieldHelp>Leave this empty to use the time of the difficulty you chose.</FieldHelp>
                  </div>
                )}
              </div>
            </Card>

            <Card>
              <div style={stack}>
                <HelpTip helpId="admin.create_test.name"><h2 className="aiq-serif" style={heading}>4. Name and window</h2></HelpTip>
                <div style={cols}>
                  <div><Label htmlFor="ct-name">Test name</Label><Input id="ct-name" value={name} onChange={(e) => setName(e.target.value)} /></div>
                  <div><Label htmlFor="ct-opens">Opens</Label><Input id="ct-opens" type="datetime-local" value={opensAt} onChange={(e) => setOpensAt(e.target.value)} /></div>
                  <div><Label htmlFor="ct-closes">Closes</Label><Input id="ct-closes" type="datetime-local" value={closesAt} onChange={(e) => setClosesAt(e.target.value)} /></div>
                </div>
                <FieldHelp>Students can start between these two times.</FieldHelp>
              </div>
            </Card>

            <Card>
              <div style={stack} data-testid="create-test-summary">
                <h2 className="aiq-serif" style={heading}>Review</h2>
                <div style={{ display: "flex", gap: "var(--aiq-space-sm)", flexWrap: "wrap" }}>
                  <Chip>{set.name}</Chip>
                  {exam !== null && <Chip>{exam.name}</Chip>}
                  <Chip>{cover === "pattern" ? "Exam pattern" : `${shown} questions`}</Chip>
                  <Chip>{testType === "real_camera" ? "Real + camera" : testType === "real" ? "Real" : "Mock"}</Chip>
                </div>
                <p style={{ ...sans, margin: 0, color: "var(--aiq-color-fg-secondary)" }}>Cost: {typeCost} credits for each submitted test. Nothing is charged or sent now.</p>
                {failure !== null && (
                  <div role="alert" style={{ ...sans, color: "var(--aiq-color-danger)" }}>
                    Step failed: {failure.step}. {failure.message}
                    {failure.cameraPath !== null && <> <Link to={failure.cameraPath}>Open camera settings</Link></>}
                  </div>
                )}
                {busy && <Spinner />}
                <div>
                  <HelpTip helpId="admin.create_test.save"><Button disabled={!canSave} onClick={() => void save()}>Save as draft</Button></HelpTip>
                </div>
              </div>
            </Card>
          </>
        )}
      </div>
    </AdminShell>
  );
}
