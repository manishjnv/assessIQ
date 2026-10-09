/**
 * R4 - submit confirmation modal in AttemptPage (replaces window.confirm).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const submitAttempt = vi.fn();
const mkQ = (i: number) => ({
  question_id: `q${i}`,
  position: i,
  type: 'mcq',
  topic: 't',
  points: 5,
  content: { question: `Question ${i}?`, options: ['A', 'B', 'C', 'D'], correct: 0 },
});
const VIEW = {
  attempt: { id: 'att1', status: 'in_progress', ends_at: new Date(Date.now() + 600000).toISOString() },
  questions: [mkQ(1), mkQ(2), mkQ(3), mkQ(4)],
  answers: [
    { question_id: 'q1', answer: { selected: 1 }, flagged: false, client_revision: 1 },
    { question_id: 'q2', answer: { selected: null }, flagged: true, client_revision: 0 },
    { question_id: 'q3', answer: null, flagged: false, client_revision: 0 },
    { question_id: 'q4', answer: null, flagged: false, client_revision: 0 },
  ],
  remaining_seconds: 600,
};

vi.mock('@assessiq/candidate-ui', () => ({
  AttemptTimer: () => null,
  AutosaveIndicator: () => null,
  IntegrityBanner: () => null,
  QuestionNavigator: () => null,
  CandidateHelp: () => null,
  useAutosave: () => ({ queueSave: vi.fn(), flushSave: vi.fn(), status: 'idle' }),
  FullscreenGate: () => null,
  useIntegrityHooks: () => ({ leaveCount: 0, showLeaveWarning: false, dismissLeaveWarning: () => {}, copyBlockedNotice: false, fullscreenGateOpen: false, fullscreenExitCount: 0, enterFullscreen: () => {} }),
  useMultiTabWarning: () => ({ multiTabActive: false }),
  getAttempt: () => Promise.resolve(VIEW),
  submitAttempt: (...a: unknown[]) => submitAttempt(...a),
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

describe('Attempt submit modal', () => {
  it('shows answered / unanswered / flagged counts and Go back closes it', async () => {
    renderAttempt();
    const submit = await screen.findByRole('button', { name: 'Submit' });
    fireEvent.click(submit);
    const dialog = await screen.findByRole('dialog', { name: 'Submit your assessment?' });
    // q2 has {selected:null} - must count as unanswered, like the navigator.
    expect(dialog.textContent).toContain('You answered 1 of 4 questions.');
    expect(dialog.textContent).toContain('3 questions are unanswered');
    expect(dialog.textContent).toContain('will score 0');
    expect(dialog.textContent).toContain('1 question is flagged');
    expect(submitAttempt).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Go back' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Escape = Go back; failure shows inline error; success navigates', async () => {
    renderAttempt();
    fireEvent.click(await screen.findByRole('button', { name: 'Submit' }));
    await screen.findByRole('dialog');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();

    submitAttempt.mockRejectedValueOnce(new Error('boom'));
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Submit assessment' }));
    await screen.findByText('Submit failed: boom');

    submitAttempt.mockResolvedValueOnce({});
    fireEvent.click(screen.getByRole('button', { name: 'Submit assessment' }));
    await waitFor(() => screen.getByText('SUBMITTED PAGE'));
  });
});
