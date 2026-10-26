/**
 * EXP-28 - "Report a problem" modal on the question view. The API call is mocked; nothing leaves the test.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';

const reportQuestion = vi.fn();
vi.mock('@assessiq/candidate-ui', () => ({
  reportQuestion: (...a: unknown[]) => reportQuestion(...a),
  CandidateApiError: class CandidateApiError extends Error {
    apiError: { code: string; message: string };
    constructor(_s: number, e: { code: string; message: string }) { super(e.message); this.apiError = e; }
  },
}));

import { CandidateApiError } from '@assessiq/candidate-ui';
import { ReportProblemModal } from './attempt-parts/ReportProblemModal.js';

afterEach(() => { cleanup(); vi.clearAllMocks(); });

function open(onClose = vi.fn()) {
  render(<ReportProblemModal attemptId="att1" questionId="q1" open onClose={onClose} />);
  return onClose;
}

describe('ReportProblemModal', () => {
  it('sends the chosen reason and note, then thanks the candidate without touching the test', async () => {
    reportQuestion.mockResolvedValue({ reported: true });
    open();
    fireEvent.change(screen.getByLabelText('What is wrong?'), { target: { value: 'wrong_answer' } });
    fireEvent.change(screen.getByLabelText(/Tell us more/), { target: { value: 'Option B is also right' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send report' }));
    await waitFor(() => expect(reportQuestion).toHaveBeenCalledWith('att1', 'q1', 'wrong_answer', 'Option B is also right'));
    expect((await screen.findByRole('status')).textContent).toContain('Your test is not changed');
  });

  it('sends no note when the box is empty and shows the server message when the report fails', async () => {
    reportQuestion.mockRejectedValue(new CandidateApiError(400, { code: 'AE_INVALID_PARAM', message: 'You have reported the most questions allowed for one test.' }));
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Send report' }));
    expect((await screen.findByRole('alert')).textContent).toContain('most questions allowed');
    expect(reportQuestion).toHaveBeenCalledWith('att1', 'q1', 'unclear', null);
  });

  it('Cancel closes without sending', () => {
    const onClose = open();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalled();
    expect(reportQuestion).not.toHaveBeenCalled();
  });
});
