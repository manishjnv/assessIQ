/**
 * R4 - submit confirmation modal in AttemptPage (replaces window.confirm).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';

const submitAttempt = vi.fn();
const flushSave = vi.fn();
let expireCb: (() => void) | null = null;
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
  AttemptTimer: (p: { onExpire: () => void }) => { expireCb = p.onExpire; return null; },
  AutosaveIndicator: () => null,
  IntegrityBanner: () => null,
  QuestionNavigator: () => null,
  CandidateHelp: () => null,
  useAutosave: () => ({ queueSave: vi.fn(), flushSave: (...a: unknown[]) => flushSave(...a), status: 'idle' }),
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

/** Z-171: top bar "Finish assessment" -> finish summary -> "Submit assessment" -> confirm dialog. */
async function openConfirm(): Promise<HTMLElement> {
  fireEvent.click(await screen.findByRole('button', { name: 'Finish assessment' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Submit assessment' }));
  return screen.findByRole('alertdialog', { name: 'Submit your assessment?' });
}

describe('Attempt submit modal', () => {
  it('shows answered / unanswered / flagged counts and Review answers closes it', async () => {
    renderAttempt();
    const dialog = await openConfirm();
    // q2 has {selected:null} - must count as unanswered, like the navigator.
    expect(dialog.textContent).toContain('You answered 1 of 4 questions.');
    expect(dialog.textContent).toContain(
      'This sends your answers to your organisation and ends your test. You cannot change them after this. You have 3 unanswered questions.',
    );
    expect(dialog.textContent).toContain('1 question is flagged');
    expect(submitAttempt).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Keep reviewing' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    // Back on the summary, not submitted.
    expect(screen.getByTestId('finish-summary')).toBeTruthy();
  });

  it('Escape = Review answers; failure shows inline error; success navigates', async () => {
    renderAttempt();
    await openConfirm();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('alertdialog')).toBeNull();

    submitAttempt.mockRejectedValueOnce(new Error('boom'));
    fireEvent.click(screen.getByRole('button', { name: 'Submit assessment' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Submit now' }));
    await screen.findByText('Submit failed: boom');

    submitAttempt.mockResolvedValueOnce({});
    fireEvent.click(screen.getByRole('button', { name: 'Submit now' }));
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
    const dialog = await openConfirm();
    expect(dialog.textContent).toContain(
      'This sends your answers to your organisation and ends your test. ' + tail,
    );
    if (n === 0) expect(dialog.textContent).not.toContain('unanswered');
    expect(screen.getByRole('button', { name: 'Submit now' })).toBeTruthy();
  });

  it('Z-7 Move: no Submit in the footer; focus starts on "Submit now"', async () => {
    renderAttempt();
    await screen.findByRole('button', { name: 'Finish assessment' });
    expect(screen.queryByRole('button', { name: 'Submit' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Submit assessment' })).toBeNull(); // only inside the summary
    await openConfirm();
    expect(document.activeElement?.textContent).toBe('Submit now');
    expect(submitAttempt).not.toHaveBeenCalled();
  });

  it('last question: Next reads "Review & finish" and opens the summary; Back returns', async () => {
    renderAttempt();
    await screen.findByText('Question 1 of 4');
    for (let i = 0; i < 3; i++) fireEvent.click(screen.getByRole('button', { name: /^Next/ }));
    await screen.findByText('Question 4 of 4');
    fireEvent.click(await screen.findByRole('button', { name: /Review & finish/ }));
    expect(await screen.findByTestId('finish-summary')).toBeTruthy();
    expect(screen.getByText('Finish summary.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Finish assessment' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Back to questions/ }));
    await screen.findByText('Question 4 of 4');
  });

  it('summary row opens that question', async () => {
    renderAttempt();
    fireEvent.click(await screen.findByRole('button', { name: 'Finish assessment' }));
    fireEvent.click(await screen.findByRole('row', { name: /Question 3, open/ }));
    await screen.findByText('Question 3 of 4');
  });

  it('summary filter counts match the answers; the Open filter hides answered rows', async () => {
    renderAttempt();
    fireEvent.click(await screen.findByRole('button', { name: 'Finish assessment' }));
    await screen.findByTestId('finish-summary');
    // q1 answered; q2 {selected:null} is open but flagged; q3 and q4 open.
    expect(screen.getByRole('button', { name: 'All · 4' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open · 3' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Flagged · 1' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open · 3' }));
    expect(screen.queryByRole('row', { name: /Question 1, answered/ })).toBeNull();
    expect(screen.getAllByRole('row', { name: /^Question [0-9]+, .*Edit$/ })).toHaveLength(3);
    fireEvent.click(screen.getByRole('button', { name: 'Flagged · 1' }));
    expect(screen.getAllByRole('row', { name: /^Question [0-9]+, .*Edit$/ })).toHaveLength(1);
  });

  it('Submit flushes pending saves first, then submits', async () => {
    const order: string[] = [];
    flushSave.mockImplementation(() => { order.push('flush'); return Promise.resolve(); });
    submitAttempt.mockImplementation(() => { order.push('submit'); return Promise.resolve({}); });
    renderAttempt();
    await openConfirm();
    fireEvent.click(screen.getByRole('button', { name: 'Submit now' }));
    await waitFor(() => screen.getByText('SUBMITTED PAGE'));
    expect(order[order.length - 1]).toBe('submit');
    expect(order).toContain('flush');
    expect(order.indexOf('flush')).toBeLessThan(order.indexOf('submit'));
  });

  it('timer expiry still ends the attempt without any click', async () => {
    renderAttempt();
    await screen.findByText('Question 1 of 4');
    await act(async () => { expireCb?.(); });
    await waitFor(() => screen.getByText('SUBMITTED PAGE'));
    expect(submitAttempt).not.toHaveBeenCalled(); // server auto-submits; the page only redirects
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
