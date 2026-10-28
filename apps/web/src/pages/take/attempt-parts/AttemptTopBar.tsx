import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { Button, Chip, Icon, Logo } from "@assessiq/ui-system";
import { AttemptTimer, Calculator, AutosaveIndicator, useAutosave } from "@assessiq/candidate-ui";
import type { CandidateAttemptViewWire } from "@assessiq/candidate-ui";
import { TOP_BAR } from "./shared.js";
import type { TakePrefs } from "./takePrefs.js";

export interface AttemptTopBarProps {
  sec: CandidateAttemptViewWire["sections"];
  /** Whole-test timer: name of the current question's section (no `sec`, one countdown). */
  wholeTestSectionName?: string | undefined;
  attempt: CandidateAttemptViewWire["attempt"];
  safeIdx: number;
  questionCount: number;
  isLastSection: boolean;
  handleExpire: () => void;
  refreshAfterSectionChange: (fromSection: number, retriesLeft: number) => Promise<void>;
  autosave: ReturnType<typeof useAutosave>;
  setNavOpen: Dispatch<SetStateAction<boolean>>;
  /** Logo L3a: organisation co-branding; empty name + null url renders nothing. */
  companyName?: string;
  companyLogoUrl?: string | null;
  /** Z-167: display preferences (theme, text size, organisation display). */
  prefs: TakePrefs;
  setPrefs: (patch: Partial<TakePrefs>) => void;
  /** Names show when the server sends them; else the short ids show. */
  candidateName?: string | undefined;
  candidateId: string;
  assessmentName?: string | undefined;
  assessmentId: string;
  /** Z-171: "Finish assessment" (owner decision 2026-10-28, Z-7 Move). Undefined hides it. */
  onFinish?: (() => void) | undefined;
  finishDisabled?: boolean;
  /** UAT 2026-10-29: full screen is set by the org or the assessment; then no student toggle. */
  fullscreenEnforced?: boolean;
}

const shortId = (id: string | undefined): string => (id ?? "").replace(/-/g, "").slice(0, 8).toUpperCase();

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "";
  return (first + last).toUpperCase() || "··";
}

function savedAgo(iso: string | null, now: number): string | null {
  if (iso === null) return null;
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (Number.isNaN(s)) return null;
  if (s < 5) return "Saved just now";
  if (s < 60) return `Saved ${s}s ago`;
  return `Saved ${Math.round(s / 60)} min ago`;
}

function Segments<T extends string>(props: {
  label: string;
  value: T;
  options: ReadonlyArray<readonly [T, string]>;
  onPick: (v: T) => void;
}): React.JSX.Element {
  return (
    <div className="aiq-take-pop-row">
      <div className="aiq-take-eyebrow">{props.label}</div>
      <div className="aiq-take-seg" role="group" aria-label={props.label}>
        {props.options.map(([v, text]) => (
          <button key={v} type="button" aria-pressed={props.value === v} onClick={() => props.onPick(v)}>
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}

function DisplaySettings(props: { prefs: TakePrefs; setPrefs: (p: Partial<TakePrefs>) => void }): React.JSX.Element {
  const { prefs, setPrefs } = props;
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (wrap.current !== null && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div ref={wrap} style={{ position: "relative" }} data-help-id="candidate.attempt.display_settings">
      <button
        type="button"
        className="aiq-take-icon-btn"
        aria-label="Display settings"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name="settings" size={16} />
      </button>
      {open && (
        <div className="aiq-take-pop" role="dialog" aria-label="Display settings">
          <Segments label="Theme" value={prefs.theme} options={[["mid", "Mid-tone"], ["light", "Light"], ["dark", "Dark"]]} onPick={(theme) => setPrefs({ theme })} />
          <Segments label="Text size" value={prefs.size} options={[["S", "S"], ["M", "M"], ["L", "L"], ["XL", "XL"]]} onPick={(size) => setPrefs({ size })} />
          <div className="aiq-take-pop-row" style={{ fontSize: 12, color: "var(--aiq-color-fg-muted)", lineHeight: 1.6 }}>
            <div className="aiq-take-eyebrow">Keyboard</div>
            ← → or P N move · A–D answer · F flag · \ panel
          </div>
        </div>
      )}
    </div>
  );
}

function FullscreenToggle(): React.JSX.Element {
  const [full, setFull] = useState(false);
  useEffect(() => {
    const on = (): void => setFull(document.fullscreenElement !== null);
    document.addEventListener("fullscreenchange", on);
    return () => document.removeEventListener("fullscreenchange", on);
  }, []);
  return (
    <button
      type="button"
      className="aiq-take-icon-btn aiq-take-hide-narrower"
      aria-label={full ? "Exit full screen" : "Full screen"}
      aria-pressed={full}
      onClick={() => {
        if (document.fullscreenElement !== null) void document.exitFullscreen();
        else void document.documentElement.requestFullscreen?.().catch(() => undefined);
      }}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {full ? <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" /> : <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />}
      </svg>
    </button>
  );
}

/** Z-174: 32 px organisation mark. Logo (contain) or initials. Empty alt when the name sits beside it. */
export function OrgBadge(props: { url: string | null; name: string; nameBeside: boolean }): React.JSX.Element {
  const { url, name, nameBeside } = props;
  return (
    <span className="aiq-take-org-mark">
      {url !== null && url !== "" ? (
        <img src={url} alt={nameBeside ? "" : `${name} logo`} />
      ) : (
        <span {...(nameBeside ? { "aria-hidden": true } : { role: "img", "aria-label": name })}>{initials(name)}</span>
      )}
    </span>
  );
}

export function AttemptTopBar(props: AttemptTopBarProps): React.JSX.Element {
  const {
    sec, wholeTestSectionName, attempt, isLastSection, handleExpire,
    refreshAfterSectionChange, autosave, setNavOpen, companyName = "", companyLogoUrl = null,
    prefs, setPrefs, candidateName, candidateId, assessmentName, assessmentId, onFinish, finishDisabled = false, fullscreenEnforced = false,
  } = props;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(id);
  }, []);
  const saved = savedAgo(autosave.lastSavedAt, now);
  // UAT 2026-10-29: logo and name when both exist, else the one that exists, else nothing. No student setting.
  const showLogo = companyLogoUrl !== null && companyLogoUrl !== "";
  const showName = companyName !== "";
  const hasOrg = showLogo || showName;
  // Z-174: whole-test timer bar = time left / planned total. Sectioned timers have no section total, so no bar.
  const total = attempt.duration_seconds;
  const timerFill =
    sec === undefined && attempt.ends_at !== null && total !== null && total > 0
      ? Math.max(0, Math.min(100, ((new Date(attempt.ends_at).getTime() - now) / 1000 / total) * 100))
      : null;
  const candLabel = candidateName ?? `STU-${shortId(candidateId)}`;
  return (
  <header className="aiq-attempt-top" style={TOP_BAR}>
    <Logo />
    {hasOrg && (
      <>
        <span className="aiq-take-divider aiq-take-hide-900" aria-hidden="true" />
        <span data-help-id="candidate.take.attempt.logo" className="aiq-take-org aiq-take-hide-900">
          {showLogo && <OrgBadge url={companyLogoUrl} name={companyName} nameBeside={showName} />}
          {showName && (
            <span className="aiq-take-meta aiq-take-hide-narrow">
              <span className="aiq-take-eyebrow">ASSIGNED BY</span>
              <span className="aiq-take-meta-val" title={companyName}>{companyName}</span>
            </span>
          )}
        </span>
      </>
    )}
    <span className="aiq-take-divider aiq-take-hide-900" aria-hidden="true" />
    <span className="aiq-take-meta aiq-take-hide-900" data-testid="take-assessment-meta">
      <span className="aiq-take-eyebrow">ASSESSMENT · #{shortId(assessmentId)}</span>
      {assessmentName !== undefined && <span className="aiq-take-meta-val" title={assessmentName}>{assessmentName}</span>}
    </span>
    <span className="aiq-take-divider aiq-take-hide-640" aria-hidden="true" />
    <span style={{ display: "inline-flex", alignItems: "center", gap: 10, minWidth: 0 }} data-testid="take-candidate-meta">
      <span className="aiq-take-avatar" aria-hidden="true">{initials(candLabel)}</span>
      <span className="aiq-take-meta aiq-take-hide-640">
        <span className="aiq-take-eyebrow aiq-take-hide-narrow">CANDIDATE{candidateName !== undefined ? ` · STU-${shortId(candidateId)}` : ""}</span>
        <span className="aiq-take-meta-val" title={candLabel}>{candLabel}</span>
      </span>
    </span>

    {sec !== undefined && (
      <Chip variant="default" style={{ flexShrink: 0 }} data-help-id="candidate.attempt.section">
        Section {sec.current + 1} of {sec.total} · {sec.name}
      </Chip>
    )}

    {sec === undefined && wholeTestSectionName !== undefined && (
      <Chip variant="default" style={{ flexShrink: 0 }} data-help-id="candidate.attempt.section">
        {wholeTestSectionName}
      </Chip>
    )}

    <span style={{ flex: 1 }} />

    {sec?.calculator === true && <Calculator data-help-id="candidate.attempt.calculator" />}

    {sec !== undefined ? (
      // Section timer: re-keyed per section so it restarts on the next deadline.
      // The last section's end is the end of the test (existing expiry path).
      <AttemptTimer
        key={sec.current}
        endsAt={sec.ends_at}
        onExpire={isLastSection ? handleExpire : () => void refreshAfterSectionChange(sec.current, 5)}
        data-help-id="candidate.attempt.timer"
      />
    ) : (
      attempt.ends_at !== null && (
        <AttemptTimer
          endsAt={attempt.ends_at}
          onExpire={handleExpire}
          data-help-id="candidate.attempt.timer"
        />
      )
    )}

    {saved !== null && autosave.status === "saved" && (
      <span className="aiq-take-save aiq-take-hide-narrower" aria-hidden="true">
        <span className="aiq-take-save-dot" />
        {saved}
      </span>
    )}
    <AutosaveIndicator
      status={autosave.status}
      lastSavedAt={autosave.lastSavedAt}
      retryCount={autosave.retryCount}
    />
    <DisplaySettings prefs={prefs} setPrefs={setPrefs} />
    {!fullscreenEnforced && <FullscreenToggle />}
    {onFinish !== undefined && (
      <Button
        variant="primary"
        size="sm"
        className="aiq-take-finish"
        disabled={finishDisabled}
        onClick={onFinish}
        data-help-id="candidate.attempt.submit.confirm"
      >
        Finish assessment
      </Button>
    )}

    {/* M2a — mobile-only: open the bottom-sheet question navigator.
        Hidden on desktop (the right-side aside is always visible there). */}
    <button
      type="button"
      className="aiq-attempt-nav-toggle"
      onClick={() => setNavOpen(true)}
      aria-label="Open question navigator"
      data-help-id="candidate.attempt.navigator.toggle"
      style={{
        background: 'transparent',
        border: '1px solid var(--aiq-color-border-strong)',
        borderRadius: 'var(--aiq-radius-pill)',
        width: 36,
        height: 36,
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'pointer',
        padding: 0,
        color: 'var(--aiq-color-fg-primary)',
      }}
    >
      <Icon name="grid" size={14} />
    </button>
    {timerFill !== null && (
      <span className="aiq-take-timerbar" aria-hidden="true" data-testid="take-timer-bar">
        <span style={{ width: `${timerFill}%` }} />
      </span>
    )}
  </header>
  );
}
