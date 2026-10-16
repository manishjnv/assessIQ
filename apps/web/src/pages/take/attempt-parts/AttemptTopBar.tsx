import type { Dispatch, SetStateAction } from "react";
import { Chip, Icon, Logo, TenantLogo } from "@assessiq/ui-system";
import { AttemptTimer, Calculator, AutosaveIndicator, useAutosave } from "@assessiq/candidate-ui";
import type { CandidateAttemptViewWire } from "@assessiq/candidate-ui";
import { TOP_BAR, COUNTER_LABEL } from "./shared.js";

export interface AttemptTopBarProps {
  sec: CandidateAttemptViewWire["sections"];
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
}

export function AttemptTopBar(props: AttemptTopBarProps): React.JSX.Element {
  const {
    sec, attempt, safeIdx, questionCount, isLastSection, handleExpire,
    refreshAfterSectionChange, autosave, setNavOpen, companyName = "", companyLogoUrl = null,
  } = props;
  return (
  <header className="aiq-attempt-top" style={TOP_BAR}>
    <Logo />
    {(companyLogoUrl !== null || companyName !== "") && (
      <span data-help-id="candidate.take.attempt.logo" style={{ flexShrink: 1, minWidth: 0 }}>
        <TenantLogo src={companyLogoUrl} name={companyName} height={28} />
      </span>
    )}

    {sec !== undefined && (
      <Chip variant="default" style={{ flexShrink: 0 }} data-help-id="candidate.attempt.section">
        Section {sec.current + 1} of {sec.total} · {sec.name}
      </Chip>
    )}

    <span style={{ ...COUNTER_LABEL, flex: 1 }}>
      Question {safeIdx + 1} of {questionCount}
    </span>

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

    <AutosaveIndicator
      status={autosave.status}
      lastSavedAt={autosave.lastSavedAt}
      retryCount={autosave.retryCount}
    />

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
  </header>
  );
}
