import type { Dispatch, SetStateAction } from "react";
import { QuestionNavigator, CandidateHelp, type NavigatorFilter } from "@assessiq/candidate-ui";

export interface NavigatorBodyProps {
  navigatorItems: React.ComponentProps<typeof QuestionNavigator>["items"];
  setCurrentQuestionId: (questionId: string) => void;
  setNavOpen: Dispatch<SetStateAction<boolean>>;
  /** Z-169: the filter lives in Attempt so Previous, Next and the arrow keys follow it. */
  filter: NavigatorFilter;
  onFilterChange: (filter: NavigatorFilter) => void;
  /** Z-169: desktop aside only. The mobile drawer passes neither. */
  collapsed?: boolean;
  /** Z-170: mobile strip. Renders the horizontal rail; `trailing` is the grid button that opens the sheet. */
  layout?: 'panel' | 'strip';
  trailing?: React.ReactNode;
}

export function NavigatorBody({
  navigatorItems,
  setCurrentQuestionId,
  setNavOpen,
  filter,
  onFilterChange,
  collapsed = false,
  layout = 'panel',
  trailing,
}: NavigatorBodyProps): React.JSX.Element {
  return (
    <>
      {!collapsed && layout === 'panel' && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 'var(--aiq-space-sm)' }}>
          <CandidateHelp />
        </div>
      )}
      <QuestionNavigator
        items={navigatorItems}
        filter={filter}
        onFilterChange={onFilterChange}
        collapsed={collapsed}
        layout={layout}
        trailing={trailing}
        onSelect={(qid) => {
          setCurrentQuestionId(qid);
          setNavOpen(false); // close mobile drawer after pick; no-op on desktop
          // Navigator click does NOT flush; debounced autosave handles it.
        }}
      />
    </>
  );
}
