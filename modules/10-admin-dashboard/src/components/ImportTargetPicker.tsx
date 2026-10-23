// AssessIQ — optional "add to an existing question set" picker for the import screens (EXP-36).
// Lists the organisation's own non-archived sets in the chosen subject. Empty = create a new set.
// A chosen set adds a level picker (the set's levels); empty level = the file's own level column.

import React, { useEffect, useRef, useState } from "react";
import { HelpTip } from "@assessiq/help-system/components";
import { getPackLevelsApi, listTenantPacksApi, type TenantPackOption } from "../api.js";

export interface ImportTarget {
  /** '' = create a new question set. */
  packId: string;
  /** null = the file's own level column. */
  levelPosition: number | null;
}

export const NO_IMPORT_TARGET: ImportTarget = { packId: "", levelPosition: null };

const labelStyle: React.CSSProperties = { fontSize: "var(--aiq-text-sm)", fontWeight: 500 };
const fieldStyle: React.CSSProperties = { display: "flex", flexDirection: "column", gap: "var(--aiq-space-xs)" };

export function ImportTargetPicker({
  domain,
  value,
  onChange,
  helpId,
  idPrefix,
  disabled = false,
}: {
  /** The subject slug the import uses. Sets are listed for this subject only. */
  domain: string;
  value: ImportTarget;
  onChange: (next: ImportTarget) => void;
  helpId: string;
  /** Prefix for the element ids, so two pickers on one page never clash. */
  idPrefix: string;
  disabled?: boolean;
}): React.ReactElement {
  const [packs, setPacks] = useState<TenantPackOption[] | null>(null);
  const [levels, setLevels] = useState<number[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void listTenantPacksApi()
      .then((r) => { if (!cancelled) setPacks(r.packs); })
      .catch(() => { if (!cancelled) setError("Could not load the question sets."); });
    return () => { cancelled = true; };
  }, []);

  const eligible = (packs ?? []).filter((p) => p.status !== "archived" && p.domain === domain);

  // A new subject drops a set chosen for the old one. Skipped on mount.
  const lastDomain = useRef(domain);
  useEffect(() => {
    if (lastDomain.current === domain) return;
    lastDomain.current = domain;
    if (value.packId !== "") onChange(NO_IMPORT_TARGET);
  }, [domain]);

  // The levels of the chosen set. Each change of set reloads them and drops the old level.
  useEffect(() => {
    if (value.packId === "") { setLevels([]); return; }
    let cancelled = false;
    void getPackLevelsApi(value.packId)
      .then((r) => { if (!cancelled) setLevels(r.levels.map((l) => l.order).sort((a, b) => a - b)); })
      .catch(() => { if (!cancelled) setError("Could not load the levels of this question set."); });
    return () => { cancelled = true; };
  }, [value.packId]);

  const noSubject = domain === "";
  return (
    <div style={fieldStyle} data-help-id={helpId}>
      <HelpTip helpId={helpId}>
        <label htmlFor={`${idPrefix}-pack`} style={labelStyle}>Add to an existing question set</label>
      </HelpTip>
      <select
        id={`${idPrefix}-pack`}
        className="aiq-input"
        value={value.packId}
        disabled={disabled || noSubject}
        onChange={(e) => onChange({ packId: e.target.value, levelPosition: null })}
      >
        <option value="">No. Create a new question set.</option>
        {eligible.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      {noSubject && <p style={{ margin: 0, fontSize: "var(--aiq-text-sm)", color: "var(--aiq-color-fg-muted)" }}>Choose a subject first.</p>}
      {value.packId !== "" && (
        <>
          <label htmlFor={`${idPrefix}-level`} style={labelStyle}>Level</label>
          <select
            id={`${idPrefix}-level`}
            className="aiq-input"
            value={value.levelPosition === null ? "" : String(value.levelPosition)}
            disabled={disabled}
            onChange={(e) => onChange({ packId: value.packId, levelPosition: e.target.value === "" ? null : Number(e.target.value) })}
          >
            <option value="">From each row&apos;s level column</option>
            {levels.map((n) => <option key={n} value={String(n)}>Level {n}</option>)}
          </select>
        </>
      )}
      {error !== null && <p role="alert" style={{ margin: 0, fontSize: "var(--aiq-text-sm)", color: "var(--aiq-color-danger, #dc2626)" }}>{error}</p>}
    </div>
  );
}
