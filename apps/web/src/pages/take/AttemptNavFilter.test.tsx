/**
 * Z-169: the navigator filter drives the footer. With the Flagged filter the footer reads
 * "Prev flagged" / "Next flagged" and moves between flagged questions only (wrapping).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';

const mkQ = (i: number) => ({
  question_id: `q${i}`,
  position: i,
  type: 'mcq',
  topic: 't',
  points: 1,
  content: { question: `Question text ${i}?`, options: ['A', 'B'] },
});
const VIEW = {
  attempt: { id: 'att1', status: 'in_progress', ends_at: new Date(Date.now() + 600000).toISOString() },
  questions: [mkQ(1), mkQ(2), mkQ(3), mkQ(4)],
  // q2 and q4 are flagged.
  answers: [1, 2, 3, 4].map((i) => ({ question_id: `q${i}`, answer: null, flagged: i % 2 === 0, client_revision: 0 })),
  remaining_seconds: 600,
};

vi.mock('@assessiq/candidate-ui', async () => {
  const actual = await vi.importActual<typeof import('@assessiq/candidate-ui')>('@assessiq/candidate-ui');
  return {
    neighbor: actual.neighbor,
    filterSuffix: actual.filterSuffix,
    AttemptTimer: () => null,
    AutosaveIndicator: () => null,
    IntegrityBanner: () => null,
    // Stand-in for the panel: one button that sets the Flagged filter.
    QuestionNavigator: (p: { onFilterChange: (f: string) => void }) => (
      <button type="button" onClick={() => p.onFilterChange('flagged')}>Pick flagged</button>
    ),
    CandidateHelp: () => null,
    useAutosave: () => ({ queueSave: vi.fn(), flushSave: vi.fn(), status: 'idle' }),
    FullscreenGate: () => null,
    useIntegrityHooks: () => ({ leaveCount: 0, showLeaveWarning: false, dismissLeaveWarning: () => {}, copyBlockedNotice: false, fullscreenGateOpen: false, fullscreenExitCount: 0, enterFullscreen: () => {} }),
    useMultiTabWarning: () => ({ multiTabActive: false }),
    getAttempt: () => Promise.resolve(VIEW),
    submitAttempt: vi.fn(),
    toggleFlag: vi.fn(),
    clearBackup: vi.fn(),
    readBackup: () => null,
    CandidateApiError: class extends Error {},
  };
});

import { AttemptPage } from './Attempt';

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe('Attempt navigator filter (Z-169)', () => {
  it('Flagged filter: footer reads Next flagged and jumps between flagged questions, wrapping', async () => {
    render(
      <MemoryRouter initialEntries={['/take/attempt/att1']}>
        <Routes>
          <Route path="/take/attempt/:id" element={<AttemptPage />} />
        </Routes>
      </MemoryRouter>,
    );
    await screen.findByText('Question 1 of 4');
    expect(screen.getByRole('button', { name: /^Next$/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Pick flagged' }));
    const next = () => screen.getByRole('button', { name: /^Next flagged/ });
    expect(screen.getByRole('button', { name: /^Prev flagged/ })).toBeTruthy();
    fireEvent.click(next());
    await screen.findByText('Question 2 of 4');
    fireEvent.click(next());
    await screen.findByText('Question 4 of 4');
    // Last question, but Next flagged stays and wraps to the first flagged one.
    fireEvent.click(next());
    await screen.findByText('Question 2 of 4');
    fireEvent.click(screen.getByRole('button', { name: /^Prev flagged/ }));
    await screen.findByText('Question 4 of 4');
  });
});
