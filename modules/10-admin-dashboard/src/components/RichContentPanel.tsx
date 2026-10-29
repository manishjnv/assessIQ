// EXP-10 part 1: "Images and maths" panel under the content JSON of the create-question form.
// It edits the JSON text for the author: the Contains maths switch (content.math), images under the question
// (content.stem_assets) and images on options (content.option_assets). The form stays the single source of truth.
// Images upload to the question set (pack) the question is being created in; alt text is required.
import React, { useMemo, useState } from "react";
import { MathText } from "@assessiq/ui-system";
import { HelpTip } from "@assessiq/help-system/components";
import { AdminApiError } from "../api.js";
import { uploadQuestionAssetApi } from "../api/question-assets.js";
import { AdminAssetImage } from "./AdminAssetImage.js";

type Dict = Record<string, unknown>;
const MAX_STEM = 3;
const MAX_TOTAL = 6;
const RICH_TYPES: readonly string[] = ["mcq", "multi_select", "numeric"];

export const supportsRichContent = (type: string): boolean => RICH_TYPES.includes(type);

function parse(json: string): Dict | null {
  try {
    const v = JSON.parse(json) as unknown;
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Dict) : null;
  } catch {
    return null;
  }
}

const idsOf = (c: Dict): string[] => {
  const out: string[] = [];
  for (const arr of [c["stem_assets"], c["option_assets"]]) {
    if (Array.isArray(arr)) for (const x of arr) if (typeof x === "string" && !out.includes(x)) out.push(x);
  }
  return out;
};

export function RichContentPanel({ type, packId, contentJson, onChange }: {
  type: string;
  packId: string;
  contentJson: string;
  onChange: (json: string) => void;
}): React.ReactElement | null {
  const content = useMemo(() => parse(contentJson), [contentJson]);
  const [target, setTarget] = useState<string>("stem");
  const [alt, setAlt] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fileKey, setFileKey] = useState(0);

  if (!supportsRichContent(type)) return null;
  if (content === null) {
    return (
      <p className="aiq-help-text" data-testid="rich-panel-fix-json">Fix the content JSON first. Then you can add maths and images here.</p>
    );
  }

  const options = Array.isArray(content["options"]) ? (content["options"] as unknown[]) : null;
  const stem = Array.isArray(content["stem_assets"]) ? (content["stem_assets"] as string[]) : [];
  const optAssets: Array<string | null> = options === null ? [] : options.map((_, i) => {
    const a = content["option_assets"];
    return Array.isArray(a) && typeof a[i] === "string" ? (a[i] as string) : null;
  });
  const total = idsOf(content).length;
  const math = content["math"] === true;

  const write = (next: Dict): void => onChange(JSON.stringify(next, null, 2));
  const setMath = (on: boolean): void => {
    const next = { ...content };
    if (on) next["math"] = true; else delete next["math"];
    write(next);
  };
  const setStem = (ids: string[]): void => {
    const next = { ...content };
    if (ids.length > 0) next["stem_assets"] = ids; else delete next["stem_assets"];
    write(next);
  };
  const setOpt = (idx: number, id: string | null): void => {
    const arr = optAssets.map((x, i) => (i === idx ? id : x));
    const next = { ...content };
    if (arr.some((x) => x !== null)) next["option_assets"] = arr; else delete next["option_assets"];
    write(next);
  };

  async function handleUpload(): Promise<void> {
    setError(null);
    if (packId === "") { setError("Open this page from a question set so the image knows where to be stored."); return; }
    if (file === null) { setError("Choose a PNG or JPEG image first."); return; }
    if (alt.trim().length < 5) { setError("Alt text is required: describe the image in at least 5 characters."); return; }
    if (total >= MAX_TOTAL) { setError(`A question can hold at most ${MAX_TOTAL} images.`); return; }
    if (target === "stem" && stem.length >= MAX_STEM) { setError(`At most ${MAX_STEM} images under the question.`); return; }
    setBusy(true);
    try {
      const meta = await uploadQuestionAssetApi(packId, file, alt.trim());
      if (target === "stem") {
        if (!stem.includes(meta.id)) setStem([...stem, meta.id]);
      } else {
        setOpt(Number(target.slice(4)), meta.id);
      }
      setAlt("");
      setFile(null);
      setFileKey((k) => k + 1);
    } catch (e) {
      setError(e instanceof AdminApiError ? e.apiError.message : "The image could not be uploaded. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const attached: Array<{ id: string; label: string; remove: () => void }> = [
    ...stem.map((id) => ({ id, label: "Under the question", remove: () => setStem(stem.filter((x) => x !== id)) })),
    ...optAssets.flatMap((id, i) => (id === null ? [] : [{ id, label: `Option ${String.fromCharCode(65 + i)}`, remove: () => setOpt(i, null) }])),
  ];

  return (
    <fieldset className="aiq-form-group" data-testid="rich-panel" style={{ border: "1px solid var(--aiq-color-border)", borderRadius: 6, padding: "var(--aiq-space-md)" }}>
      <legend className="aiq-label" style={{ padding: "0 var(--aiq-space-xs)" }}>
        <HelpTip helpId="admin.question_editor.image"><span>Images and maths</span></HelpTip>
      </legend>

      <label style={{ display: "flex", gap: "var(--aiq-space-sm)", alignItems: "center", marginBottom: "var(--aiq-space-md)" }}>
        <input type="checkbox" checked={math} onChange={(e) => setMath(e.target.checked)} data-testid="contains-maths" />
        <HelpTip helpId="admin.question_editor.math"><span>Contains maths</span></HelpTip>
      </label>
      {math && typeof content["question"] === "string" && (
        <p className="aiq-help-text" data-testid="maths-preview" style={{ marginTop: 0 }}>
          Preview: <MathText text={content["question"] as string} math />
        </p>
      )}

      <div style={{ display: "grid", gap: "var(--aiq-space-sm)", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", alignItems: "end" }}>
        <div>
          <label className="aiq-label" htmlFor="rc-target">Add the image to</label>
          <select id="rc-target" className="aiq-input" value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="stem">Under the question</option>
            {options?.map((_, i) => (
              <option key={i} value={`opt:${i}`}>{`Option ${String.fromCharCode(65 + i)}`}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="aiq-label" htmlFor="rc-file">PNG or JPEG, up to 400 KB</label>
          <input key={fileKey} id="rc-file" className="aiq-input" type="file" accept="image/png,image/jpeg" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </div>
        <div>
          <label className="aiq-label" htmlFor="rc-alt">Alt text (describe the image) *</label>
          <input id="rc-alt" className="aiq-input" type="text" maxLength={300} value={alt} onChange={(e) => setAlt(e.target.value)} />
        </div>
        <div>
          <button type="button" className="aiq-btn" disabled={busy} onClick={() => void handleUpload()}>
            {busy ? "Uploading…" : "Upload image"}
          </button>
        </div>
      </div>
      {error && <div role="alert" style={{ color: "var(--aiq-color-danger)", fontSize: "var(--aiq-text-xs)", marginTop: "var(--aiq-space-xs)" }}>{error}</div>}

      {attached.length > 0 && (
        <ul style={{ listStyle: "none", margin: "var(--aiq-space-md) 0 0", padding: 0, display: "grid", gap: "var(--aiq-space-sm)" }} data-testid="attached-images">
          {attached.map((a) => (
            <li key={`${a.label}:${a.id}`} style={{ display: "flex", gap: "var(--aiq-space-md)", alignItems: "center", flexWrap: "wrap" }}>
              <span style={{ minWidth: 110, fontSize: "var(--aiq-text-xs)", color: "var(--aiq-color-fg-muted)" }}>{a.label}</span>
              <AdminAssetImage id={a.id} maxHeight={80} linked={false} />
              <button type="button" className="aiq-btn" onClick={a.remove} aria-label={`Remove the image from ${a.label}`}>Remove</button>
            </li>
          ))}
        </ul>
      )}
    </fieldset>
  );
}
