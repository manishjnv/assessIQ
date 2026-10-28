/**
 * Test sections in the candidate runner: section header + timer, "Finish section"
 * confirm, section-only navigator, calculator only where enabled, plain tests unchanged.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';

const finishSection = vi.fn();
const recordPosition = vi.fn();
let nextView: unknown;
let currentView: unknown;

const mkQ = (i: number, position: number) => ({
  question_id: `q${i}`,
  position,
  type: 'mcq',
  topic: 't',
  points: 1,
  content: { question: `Question text ${i}?`, options: ['A', 'B'] },
});
const answersFor = (ids: number[]) =>
  ids.map((i) => ({ question_id: `q${i}`, answer: null, flagged: false, client_revision: 0 }));
const sectionView = (current: number, calculator: boolean, ids: number[], endsAt: string) => ({
  attempt: { id: 'att1', status: 'in_progress', ends_at: '2099-01-01T00:00:00.000Z' },
  questions: ids.map((i, k) => mkQ(i, 10 * current + k + 1)),
  answers: answersFor(ids),
  remaining_seconds: 600,
  sections: {
    current,
    total: 3,
    name: ['Quantitative', 'Logical reasoning', 'Verbal'][current],
    calculator,
    ends_at: endsAt,
    remaining_seconds: 600,
  },
});

vi.mock('@assessiq/candidate-ui', async () => {
  const actual = await vi.importActual<typeof import('@assessiq/candidate-ui')>('@assessiq/candidate-ui');
  return {
  neighbor: actual.neighbor,
  filterSuffix: actual.filterSuffix,
  NavCollapseHandle: actual.NavCollapseHandle,
  AttemptTimer: (p: { endsAt: string }) => <span data-testid="timer">{p.endsAt}</span>,
  Calculator: () => <button type="button">Calculator</button>,
  AutosaveIndicator: () => null,
  IntegrityBanner: () => null,
  QuestionNavigator: (p: { items: Array<{ position: number }> }) => (
    <nav data-testid="nav">{p.items.map((i) => i.position).join(',')}</nav>
  ),
  CandidateHelp: () => null,
  useAutosave: () => ({ queueSave: vi.fn(), flushSave: vi.fn(), status: 'idle' }),
  FullscreenGate: () => null,
  useIntegrityHooks: () => ({ leaveCount: 0, showLeaveWarning: false, dismissLeaveWarning: () => {}, copyBlockedNotice: false, fullscreenGateOpen: false, fullscreenExitCount: 0, enterFullscreen: () => {} }),
  useMultiTabWarning: () => ({ multiTabActive: false }),
  getAttempt: () => Promise.resolve(currentView),
  submitAttempt: vi.fn(),
  finishSection: (...a: unknown[]) => finishSection(...a),
  recordPosition: (...a: unknown[]) => recordPosition(...a),
  toggleFlag: vi.fn(),
  clearBackup: vi.fn(),
  readBackup: () => null,
  CandidateApiError: class extends Error {},
  };
});

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

describe('Attempt runner with sections', () => {
  it('shows the section header, section timer, section-only navigator; calculator only when enabled', async () => {
    const END = '2099-01-01T00:20:00.000Z';
    currentView = sectionView(1, false, [21, 22], END);
    renderAttempt();
    expect(await screen.findByText('Section 2 of 3 · Logical reasoning')).toBeTruthy();
    expect(screen.getByText('Question 1 of 2')).toBeTruthy();
    expect(screen.getByTestId('timer').textContent).toBe(END); // section deadline, not attempt.ends_at
    expect(screen.getByTestId('nav').textContent).toBe('1,2'); // numbered inside the section
    expect(screen.queryByRole('button', { name: 'Calculator' })).toBeNull();
    cleanup();

    currentView = sectionView(0, true, [1, 2], END);
    renderAttempt();
    expect(await screen.findByText('Section 1 of 3 · Quantitative')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Calculator' })).toBeTruthy();
  });

  it('Finish section asks for confirmation, then opens the next section; last section shows Finish assessment (top bar)', async () => {
    currentView = sectionView(1, false, [21, 22], '2099-01-01T00:20:00.000Z');
    nextView = sectionView(2, false, [31], '2099-01-01T00:40:00.000Z');
    finishSection.mockImplementation(() => {
      currentView = nextView;
      return Promise.resolve({ section_index: 2 });
    });
    renderAttempt();
    await screen.findByText('Section 2 of 3 · Logical reasoning');
    expect(screen.queryByRole('button', { name: 'Finish assessment' })).toBeNull(); // not the last section

    fireEvent.click(screen.getByRole('button', { name: 'Finish section' }));
    const dialog = await screen.findByRole('dialog', { name: 'Finish this section?' });
    expect(dialog.textContent).toContain("You can't come back to this section.");
    expect(finishSection).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Go back' }));
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Finish section' }));
    const dlg = await screen.findByRole('dialog', { name: 'Finish this section?' });
    const confirm = Array.from(dlg.querySelectorAll('button')).find((b) => b.textContent === 'Finish section');
    fireEvent.click(confirm as HTMLElement);

    expect(await screen.findByText('Section 3 of 3 · Verbal')).toBeTruthy();
    expect(finishSection).toHaveBeenCalledWith('att1');
    expect(screen.getByRole('button', { name: 'Finish assessment' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Finish section' })).toBeNull();
    expect(screen.getByTestId('nav').textContent).toBe('1');
  });

  it('Z-171: the final review counts EVERY section and keeps Finish section out of the last section', async () => {
    currentView = {
      ...sectionView(2, false, [31, 32], '2099-01-01T00:40:00.000Z'),
      sections_summary: [
        { index: 0, name: 'Quantitative', status: 'done', question_count: 5, answered_count: 4 },
        { index: 1, name: 'Logical reasoning', status: 'done', question_count: 3, answered_count: 3 },
        { index: 2, name: 'Verbal', status: 'current', question_count: 2, answered_count: 0 },
      ],
    };
    renderAttempt();
    fireEvent.click(await screen.findByRole('button', { name: 'Finish assessment' }));
    const summary = await screen.findByTestId('finish-summary');
    expect(summary.textContent).toContain('Answered7 / 10'); // 4 + 3 + 0 of 5 + 3 + 2
    expect(summary.textContent).toContain('Open3');
    expect(screen.queryByRole('button', { name: 'Finish section' })).toBeNull();
  });

  it('REGRESSION: a test without sections has no section header, Finish section or calculator', async () => {
    currentView = {
      attempt: { id: 'att1', status: 'in_progress', ends_at: '2099-01-01T00:00:00.000Z' },
      questions: [mkQ(1, 1), mkQ(2, 2)],
      answers: answersFor([1, 2]),
      remaining_seconds: 600,
    };
    renderAttempt();
    await waitFor(() => expect(screen.getByText('Question 1 of 2')).toBeTruthy());
    expect(screen.queryByText(/Section \d of/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Finish section' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Calculator' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Finish assessment' })).toBeTruthy();
    expect(screen.getByTestId('timer').textContent).toBe('2099-01-01T00:00:00.000Z');
  });

  it('REGRESSION: a numeric answer box starts empty on the next numeric question', async () => {
    const numQ = (i: number) => ({ ...mkQ(i, i), type: 'numeric', content: { question: `Numeric ${i}?` } });
    currentView = {
      attempt: { id: 'att1', status: 'in_progress', ends_at: '2099-01-01T00:00:00.000Z' },
      questions: [numQ(1), numQ(2)],
      answers: answersFor([1, 2]),
      remaining_seconds: 600,
    };
    renderAttempt();
    const box = (await screen.findByLabelText('Your answer (a number)')) as HTMLInputElement;
    fireEvent.change(box, { target: { value: '42' } });
    expect(box.value).toBe('42');
    fireEvent.click(screen.getByRole('button', { name: /Next/ }));
    await screen.findByText('Question 2 of 2');
    expect((screen.getByLabelText('Your answer (a number)') as HTMLInputElement).value).toBe('');
  });

  it('has exactly one h1 inside main (axe page-has-heading-one)', async () => {
    currentView = sectionView(0, false, [1, 2], '2099-01-01T00:20:00.000Z');
    renderAttempt();
    await screen.findByText('Section 1 of 3 · Quantitative');
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });
});
