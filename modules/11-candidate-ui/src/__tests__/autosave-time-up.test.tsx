/**
 * FUT-7: a save refused with AE_QUESTION_TIME_UP (409) is final. No retry, no "error" status.
 * Other failures (5xx) keep the old retry behaviour.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { CandidateApiError, saveAnswer } from "../api";
import { useAutosave } from "../hooks/useAutosave";

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return { ...actual, saveAnswer: vi.fn() };
});

const saveMock = vi.mocked(saveAnswer);

function apiErr(status: number, details?: Record<string, unknown>): CandidateApiError {
  return new CandidateApiError(status, { code: "CONFLICT", message: "x", ...(details ? { details } : {}) });
}

beforeEach(() => {
  vi.useFakeTimers();
  saveMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useAutosave with a question time-up", () => {
  it("does not retry a 409 time-up, reports it once, and shows no error status", async () => {
    saveMock.mockRejectedValue(apiErr(409, { code: "AE_QUESTION_TIME_UP" }));
    const onQuestionTimeUp = vi.fn();
    const { result } = renderHook(() =>
      useAutosave({ attemptId: "att1", locked: false, onQuestionTimeUp, debounceMs: 5000 }),
    );

    await act(async () => {
      result.current.queueSave("q1", "x");
      await result.current.flushSave("q1");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });

    expect(saveMock).toHaveBeenCalledTimes(1);
    expect(onQuestionTimeUp).toHaveBeenCalledWith("q1");
    expect(onQuestionTimeUp).toHaveBeenCalledTimes(1);
    expect(result.current.status).not.toBe("error");
    expect(result.current.retryCount).toBe(0);
  });

  it("a stopped question is never saved again", async () => {
    saveMock.mockResolvedValue({ client_revision: 1 });
    const { result } = renderHook(() => useAutosave({ attemptId: "att1", locked: false, debounceMs: 5000 }));

    await act(async () => {
      result.current.queueSave("q2", "x");
      result.current.stopQuestion("q2");
      await vi.advanceTimersByTimeAsync(10_000);
      await result.current.flushSave("q2");
    });

    expect(saveMock).not.toHaveBeenCalled();
  });

  it("keeps the old retry for a server error (5xx)", async () => {
    saveMock.mockRejectedValueOnce(apiErr(500)).mockResolvedValueOnce({ client_revision: 1 });
    const onQuestionTimeUp = vi.fn();
    const { result } = renderHook(() =>
      useAutosave({ attemptId: "att1", locked: false, onQuestionTimeUp, debounceMs: 5000 }),
    );

    await act(async () => {
      result.current.queueSave("q3", "x");
      await result.current.flushSave("q3");
    });
    expect(saveMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });

    expect(saveMock).toHaveBeenCalledTimes(2);
    expect(onQuestionTimeUp).not.toHaveBeenCalled();
  });
});
