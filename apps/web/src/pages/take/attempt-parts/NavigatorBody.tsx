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
  onToggleCollapsed?: () => void;
}

export function NavigatorBody({
  navigatorItems,
  setCurrentQuestionId,
  setNavOpen,
  filter,
  onFilterChange,
  collapsed = false,
  onToggleCollapsed,
}: NavigatorBodyProps): React.JSX.Element {
  return (
    <>
      {!collapsed && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 'var(--aiq-space-sm)' }}>
          <CandidateHelp />
        </div>
      )}
      <QuestionNavigator
        items={navigatorItems}
        filter={filter}
        onFilterChange={onFilterChange}
        collapsed={collapsed}
        {...(onToggleCollapsed !== undefined ? { onToggleCollapsed } : {})}
        onSelect={(qid) => {
          setCurrentQuestionId(qid);
          setNavOpen(false); // close mobile drawer after pick; no-op on desktop
          // Navigator click does NOT flush; debounced autosave handles it.
        }}
      />
    </>
  );
}
