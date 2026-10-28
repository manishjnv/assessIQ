/**
 * R4 - submit confirmation modal in AttemptPage (replaces window.confirm).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';

const submitAttempt = vi.fn();
const mkQ = (i: number) => ({
  question_id: `q${i}`,
  position: i,
  type: 'mcq',
  topic: 't',
  points: 5,
  content: { question: `Question ${i}?`, options: ['A', 'B', 'C', 'D'], correct: 0 },
});
const BASE_ANSWERS = [
  { question_id: 'q1', answer: { selected: 1 }, flagged: false, client_revision: 1 },
  { question_id: 'q2', answer: { selected: null }, flagged: true, client_revision: 0 },
  { question_id: 'q3', answer: null, flagged: false, client_revision: 0 },
  { question_id: 'q4', answer: null, flagged: false, client_revision: 0 },
];
let VIEW = {
  attempt: { id: 'att1', status: 'in_progress', ends_at: new Date(Date.now() + 600000).toISOString() },
  questions: [mkQ(1), mkQ(2), mkQ(3), mkQ(4)],
  answers: BASE_ANSWERS,
  remaining_seconds: 600,
};

vi.mock('@assessiq/candidate-ui', async () => {
  const actual = await vi.importActual<typeof import('@assessiq/candidate-ui')>('@assessiq/candidate-ui');
  return {
  neighbor: actual.neighbor,
  filterSuffix: actual.filterSuffix,
  NavCollapseHandle: actual.NavCollapseHandle,
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
  };
});

import { AttemptPage } from './Attempt';

afterEach(() => {
  cleanup();
  VIEW = { ...VIEW, answers: BASE_ANSWERS };
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
  it('shows answered / unanswered / flagged counts and Review answers closes it', async () => {
    renderAttempt();
    const submit = await screen.findByRole('button', { name: 'Submit' });
    fireEvent.click(submit);
    const dialog = await screen.findByRole('dialog', { name: 'Submit your test?' });
    // q2 has {selected:null} - must count as unanswered, like the navigator.
    expect(dialog.textContent).toContain('You answered 1 of 4 questions.');
    expect(dialog.textContent).toContain(
      'This sends your answers to your organisation and ends your test. You cannot change them after this. You have 3 unanswered questions.',
    );
    expect(dialog.textContent).toContain('1 question is flagged');
    expect(submitAttempt).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Review answers' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Escape = Review answers; failure shows inline error; success navigates', async () => {
    renderAttempt();
    fireEvent.click(await screen.findByRole('button', { name: 'Submit' }));
    await screen.findByRole('dialog');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();

    submitAttempt.mockRejectedValueOnce(new Error('boom'));
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Submit test' }));
    await screen.findByText('Submit failed: boom');

    submitAttempt.mockResolvedValueOnce({});
    fireEvent.click(screen.getByRole('button', { name: 'Submit test' }));
    await waitFor(() => screen.getByText('SUBMITTED PAGE'));
  });

  it.each([
    [0, 'You cannot change them after this.'],
    [1, 'You cannot change them after this. You have 1 unanswered question.'],
    [2, 'You cannot change them after this. You have 2 unanswered questions.'],
  ])('body text for %i unanswered', async (n, tail) => {
    VIEW = {
      ...VIEW,
      answers: BASE_ANSWERS.map((a, i) => ({ ...a, answer: i < 4 - n ? { selected: 1 } : null })),
    };
    renderAttempt();
    fireEvent.click(await screen.findByRole('button', { name: 'Submit' }));
    const dialog = await screen.findByRole('dialog', { name: 'Submit your test?' });
    expect(dialog.textContent).toContain(
      'This sends your answers to your organisation and ends your test. ' + tail,
    );
    if (n === 0) expect(dialog.textContent).not.toContain('unanswered');
    expect(screen.getByRole('button', { name: 'Submit test' })).toBeTruthy();
  });

  it('Submit sits first in the action bar, before Prev and Next', async () => {
    renderAttempt();
    const submit = await screen.findByRole('button', { name: 'Submit' });
    const prev = screen.getByRole('button', { name: /^Prev/ });
    const next = screen.getByRole('button', { name: /^Next/ });
    expect(submit.compareDocumentPosition(prev) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(prev.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('N and P keys move between questions', async () => {
    renderAttempt();
    // findBy resolves on the DOM change, which can come before React runs the
    // passive effect that (re)binds the keydown listener. Flush effects first.
    const settle = (): Promise<void> => act(async () => {});
    await screen.findByText('Question 1 of 4');
    await settle();
    fireEvent.keyDown(document.body, { key: 'n' });
    await screen.findByText('Question 2 of 4');
    await settle();
    fireEvent.keyDown(document.body, { key: 'p' });
    await screen.findByText('Question 1 of 4');
  });
});
