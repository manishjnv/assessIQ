// Structural tests for @assessiq/candidate-ui presentation primitives.
// Per CLAUDE.md AssessIQ-specific rule on integration tests, these are
// component-shape assertions (jsdom + @testing-library/react) — NOT
// browser-level interaction tests. Browser interaction lives in
// apps/web/e2e/ (Playwright; mostly skipped pending Session 4b backend).

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import {
  AttemptTimer,
  AutosaveIndicator,
  IntegrityBanner,
  QuestionNavigator,
} from "../components";
import {
  readBackup,
  writeBackup,
  clearBackup,
} from "../resilience/localStorage-backup";

afterEach(() => {
  cleanup();
});

describe("AttemptTimer", () => {
  it("renders mm:ss format for under-an-hour deadlines", () => {
    // 5 minutes from now — display "05:00" (or 04:59 depending on tick timing)
    const future = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    render(<AttemptTimer endsAt={future} data-test-id="t1" />);
    const timer = screen.getByRole("timer");
    expect(timer).toBeDefined();
    expect(timer.textContent).toMatch(/^0[45]:\d{2}$/);
  });

  it("renders h:mm:ss when remaining ≥ 1 hour", () => {
    const future = new Date(Date.now() + 3700 * 1000).toISOString(); // 1h 1m 40s
    render(<AttemptTimer endsAt={future} />);
    const timer = screen.getByRole("timer");
    expect(timer.textContent).toMatch(/^1:\d{2}:\d{2}$/);
  });

  it("calls onExpire exactly once when deadline is already past", async () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const onExpire = vi.fn();
    render(<AttemptTimer endsAt={past} onExpire={onExpire} />);
    // The expire callback fires from the mount-time effect; one microtask later
    // it has been called.
    await Promise.resolve();
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it("includes a screen-reader label with remaining seconds", () => {
    const future = new Date(Date.now() + 60 * 1000).toISOString();
    render(<AttemptTimer endsAt={future} />);
    const timer = screen.getByRole("timer");
    expect(timer.getAttribute("aria-label")).toMatch(/\d+ seconds remaining/);
  });
});

describe("AutosaveIndicator", () => {
  it("renders the Idle label for status='idle'", () => {
    render(<AutosaveIndicator status="idle" />);
    expect(screen.getByText("Idle")).toBeDefined();
  });

  it("renders Saving… for status='saving' and applies the pulse class", () => {
    const { container } = render(<AutosaveIndicator status="saving" />);
    expect(screen.getByText("Saving…")).toBeDefined();
    const pulse = container.querySelector(".aiq-autosave-dot-saving");
    expect(pulse).not.toBeNull();
  });

  it("includes lastSavedAt relative time when status='saved'", () => {
    const tenSecondsAgo = new Date(Date.now() - 10_000).toISOString();
    render(<AutosaveIndicator status="saved" lastSavedAt={tenSecondsAgo} />);
    expect(screen.getByText(/Saved.*just now/)).toBeDefined();
  });

  it("includes retry hint when status='error' and retryCount > 0", () => {
    render(<AutosaveIndicator status="error" retryCount={3} />);
    expect(screen.getByText(/retry 3\/5/)).toBeDefined();
  });

  it("renders Offline · queued for status='offline'", () => {
    render(<AutosaveIndicator status="offline" />);
    expect(screen.getByText("Offline · queued")).toBeDefined();
  });
});

describe("IntegrityBanner", () => {
  it("renders the multi_tab variant copy + status role", () => {
    render(<IntegrityBanner kind="multi_tab" />);
    const banner = screen.getByRole("status");
    expect(banner.textContent).toMatch(/Multiple tabs/);
  });

  it("renders the stale_connection variant with role='alert'", () => {
    render(<IntegrityBanner kind="stale_connection" />);
    expect(screen.getByRole("alert")).toBeDefined();
  });

  it("renders the action button when action prop provided", () => {
    const onClick = vi.fn();
    render(
      <IntegrityBanner
        kind="stale_connection"
        action={{ label: "Reload", onClick }}
      />,
    );
    const btn = screen.getByRole("button", { name: "Reload" });
    expect(btn).toBeDefined();
  });

  it("renders the dismiss X when onDismiss is provided", () => {
    const onDismiss = vi.fn();
    render(<IntegrityBanner kind="multi_tab" onDismiss={onDismiss} />);
    expect(screen.getByLabelText("Dismiss")).toBeDefined();
  });

  it("does not render dismiss X when onDismiss is omitted", () => {
    render(<IntegrityBanner kind="multi_tab" />);
    expect(screen.queryByLabelText("Dismiss")).toBeNull();
  });
});

describe("QuestionNavigator", () => {
  const items = [
    { questionId: "q1", position: 1, status: "answered" as const },
    { questionId: "q2", position: 2, status: "current" as const },
    { questionId: "q3", position: 3, status: "flagged" as const },
    { questionId: "q4", position: 4, status: "unanswered" as const },
  ];

  it("renders one button per item", () => {
    render(<QuestionNavigator items={items} onSelect={() => {}} />);
    const nav = screen.getByLabelText("Question navigator");
    expect(nav.querySelectorAll("button").length).toBe(4);
  });

  it("marks the current item with aria-current='step'", () => {
    render(<QuestionNavigator items={items} onSelect={() => {}} />);
    const current = screen.getByLabelText("Question 2: current");
    expect(current.getAttribute("aria-current")).toBe("step");
  });

  it("calls onSelect with the questionId on click", () => {
    const onSelect = vi.fn();
    render(<QuestionNavigator items={items} onSelect={onSelect} />);
    const target = screen.getByLabelText("Question 3: flagged");
    target.click();
    expect(onSelect).toHaveBeenCalledWith("q3");
  });

  it("renders the position number in each square", () => {
    render(<QuestionNavigator items={items} onSelect={() => {}} />);
    expect(screen.getByLabelText("Question 1: answered").textContent).toContain("1");
    expect(screen.getByLabelText("Question 4: unanswered").textContent).toContain("4");
  });
});

describe("localStorage-backup", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("writes and reads back a single answer", () => {
    writeBackup("att-1", { questionId: "q1", answer: "hello", clientRevision: 1 });
    const backup = readBackup("att-1");
    expect(backup).not.toBeNull();
    expect(backup!.answers["q1"]).toBe("hello");
    expect(backup!.clientRevision).toBe(1);
    expect(typeof backup!.savedAt).toBe("string");
  });

  it("merges multiple answers into the same backup envelope", () => {
    writeBackup("att-2", { questionId: "q1", answer: "a", clientRevision: 1 });
    writeBackup("att-2", { questionId: "q2", answer: "b", clientRevision: 2 });
    const backup = readBackup("att-2");
    expect(backup!.answers["q1"]).toBe("a");
    expect(backup!.answers["q2"]).toBe("b");
    expect(backup!.clientRevision).toBe(2); // max-of stored vs incoming
  });

  it("retains the higher clientRevision across writes (monotonic)", () => {
    writeBackup("att-3", { questionId: "q1", answer: "first", clientRevision: 5 });
    writeBackup("att-3", { questionId: "q1", answer: "second", clientRevision: 2 });
    const backup = readBackup("att-3");
    // The latest answer overwrites, but the recorded clientRevision is the max.
    expect(backup!.answers["q1"]).toBe("second");
    expect(backup!.clientRevision).toBe(5);
  });

  it("returns null for an unknown attemptId", () => {
    expect(readBackup("never-saved")).toBeNull();
  });

  it("returns null for corrupt JSON", () => {
    window.localStorage.setItem("aiq:attempt:bad:answers", "{not json");
    expect(readBackup("bad")).toBeNull();
  });

  it("clears the backup", () => {
    writeBackup("att-4", { questionId: "q1", answer: "x", clientRevision: 1 });
    clearBackup("att-4");
    expect(readBackup("att-4")).toBeNull();
  });
});
