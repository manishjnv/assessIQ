import type { Dispatch, SetStateAction } from "react";
import { QuestionNavigator, CandidateHelp } from "@assessiq/candidate-ui";

export interface NavigatorBodyProps {
  navigatorItems: React.ComponentProps<typeof QuestionNavigator>["items"];
  setCurrentQuestionId: Dispatch<SetStateAction<string | null>>;
  setNavOpen: Dispatch<SetStateAction<boolean>>;
}

export function NavigatorBody({ navigatorItems, setCurrentQuestionId, setNavOpen }: NavigatorBodyProps): React.JSX.Element {
  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 'var(--aiq-space-sm)' }}>
        <CandidateHelp />
      </div>
      <QuestionNavigator
        items={navigatorItems}
        onSelect={(qid) => {
          setCurrentQuestionId(qid);
          setNavOpen(false); // close mobile drawer after pick; no-op on desktop
          // Navigator click does NOT flush; debounced autosave handles it.
        }}
      />
      {/* Legend */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--aiq-space-xs)',
          marginTop: 'var(--aiq-space-md)',
          paddingLeft: 'var(--aiq-space-md)',
        }}
      >
        {[
          { color: 'var(--aiq-color-accent)', label: 'Current' },
          { color: 'var(--aiq-color-success-soft)', border: 'var(--aiq-color-success)', label: 'Answered' },
          { color: 'var(--aiq-color-warning-soft)', border: 'var(--aiq-color-warning)', label: 'Flagged' },
          { color: 'var(--aiq-color-bg-base)', border: 'var(--aiq-color-border)', label: 'Unseen' },
        ].map(({ color, border, label }) => (
          <span
            key={label}
            style={{ display: 'flex', alignItems: 'center', gap: 'var(--aiq-space-sm)', fontSize: 11, color: 'var(--aiq-color-fg-secondary)', fontFamily: 'var(--aiq-font-sans)' }}
          >
            <span
              style={{
                width: 10,
                height: 10,
                borderRadius: 3,
                background: color,
                border: border ? `1px solid ${border}` : undefined,
                flexShrink: 0,
              }}
            />
            {label}
          </span>
        ))}
      </div>
    </>
  );
}
