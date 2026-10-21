/**
 * FUT-4 / FUT-7 on the take page: question countdown, "Time is up" message with the answer
 * closed, the leave confirm for a locked section, and unchanged behaviour without the keys.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const recordPosition = vi.fn();
const stopQuestion = vi.fn();
let currentView: unknown;

const mkQ = (i: number, sectionIndex: number) => ({
  question_id: `q${i}`,
  position: i + 1,
  section_index: sectionIndex,
  type: 'mcq',
  topic: 't',
  points: 1,
  content: { question: `Question text ${i}?`, options: ['A', 'B'] },
});

/** Free-movement view: two sections, q0 in section 0 and q1 in section 1. */
const freeView = (timing?: unknown) => ({
  attempt: { id: 'att1', status: 'in_progress', ends_at: '2099-01-01T00:00:00.000Z' },
  questions: [mkQ(0, 0), mkQ(1, 1)],
  answers: [
    { question_id: 'q0', answer: null, flagged: false, client_revision: 0 },
    { question_id: 'q1', answer: null, flagged: false, client_revision: 0 },
  ],
  remaining_seconds: 600,
  section_names: ['Case', 'Logic'],
  ...(timing !== undefined ? { section_timing: timing } : {}),
});

vi.mock('@assessiq/candidate-ui', () => ({
  AttemptTimer: () => null,
  Calculator: () => null,
  AutosaveIndicator: () => null,
  IntegrityBanner: () => null,
  QuestionNavigator: () => <nav />,
  CandidateHelp: () => null,
  useAutosave: () => ({
    queueSave: vi.fn(),
    flushSave: vi.fn(),
    status: 'idle',
    stopQuestion: (...a: unknown[]) => stopQuestion(...a),
  }),
  FullscreenGate: () => null,
  useIntegrityHooks: () => ({ leaveCount: 0, showLeaveWarning: false, dismissLeaveWarning: () => {}, copyBlockedNotice: false, fullscreenGateOpen: false, fullscreenExitCount: 0, enterFullscreen: () => {} }),
  useMultiTabWarning: () => ({ multiTabActive: false }),
  getAttempt: () => Promise.resolve(currentView),
  submitAttempt: vi.fn(),
  finishSection: vi.fn(),
  recordPosition: (...a: unknown[]) => recordPosition(...a),
  toggleFlag: vi.fn(),
  clearBackup: vi.fn(),
  readBackup: () => null,
  CandidateApiError: class extends Error {},
}));

import { AttemptPage } from './Attempt';

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

function renderAttempt(): void {
  render(
    <MemoryRouter initialEntries={['/take/attempt/att1']}>
      <Routes>
        <Route path="/take/attempt/:id" element={<AttemptPage />} />
        <Route path="/take/attempt/:id/submitted" element={<div>SUBMITTED PAGE</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

const inFuture = (sec: number) => new Date(Date.now() + sec * 1000).toISOString();
const inPast = (sec: number) => new Date(Date.now() - sec * 1000).toISOString();
const LOCKED = [
  { locked: true, seconds_per_question: 30 },
  { locked: false, seconds_per_question: null },
];

describe('Attempt runner: question timer and locked sections', () => {
  it('shows a countdown when the position call returns a question deadline', async () => {
    currentView = freeView(LOCKED);
    recordPosition.mockResolvedValue({ question_ends_at: inFuture(30) });
    renderAttempt();
    expect(await screen.findByText(/Time left for this question: 0:(29|30)/)).toBeTruthy();
    expect(screen.queryByText('Time is up for this question.')).toBeNull();
  });

  it('shows the time-up message, closes the answer and stops saves when the deadline has passed', async () => {
    currentView = freeView(LOCKED);
    recordPosition.mockResolvedValue({ question_ends_at: inPast(5) });
    renderAttempt();
    expect(await screen.findByText('Time is up for this question.')).toBeTruthy();
    const inputs = document.querySelectorAll('main input[type="radio"], main input[type="checkbox"]');
    expect(inputs.length).toBeGreaterThan(0);
    inputs.forEach((r) => expect((r as HTMLInputElement).disabled).toBe(true));
    expect(stopQuestion).toHaveBeenCalledWith('q0');
  });

  it('asks before leaving a locked section, and Stay keeps the candidate in place', async () => {
    currentView = freeView(LOCKED);
    recordPosition.mockResolvedValue({ question_ends_at: null });
    renderAttempt();
    expect(await screen.findByText('Question text 0?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('You cannot return to this section. Leave it now?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Stay' }));
    await waitFor(() => expect(screen.queryByText('You cannot return to this section. Leave it now?')).toBeNull());
    expect(screen.getByText('Question text 0?')).toBeTruthy();
  });

  it('Leave moves to the next section after the confirm', async () => {
    currentView = freeView(LOCKED);
    recordPosition.mockResolvedValue({ question_ends_at: null });
    renderAttempt();
    expect(await screen.findByText('Question text 0?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Leave' }));
    expect(await screen.findByText('Question text 1?')).toBeTruthy();
  });

  it('without the new keys: no countdown, no confirm, Next moves straight on', async () => {
    currentView = freeView();
    recordPosition.mockResolvedValue({ question_ends_at: null });
    renderAttempt();
    expect(await screen.findByText('Question text 0?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Question text 1?')).toBeTruthy();
    expect(screen.queryByText('You cannot return to this section. Leave it now?')).toBeNull();
    expect(screen.queryByText(/Time left for this question/)).toBeNull();
  });
});
