import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";

const recordEvent = vi.fn(() => Promise.resolve());
vi.mock("../api", () => ({ recordEvent: (...a: unknown[]) => recordEvent(...(a as [])) }));

import { useIntegrityHooks } from "../hooks/useIntegrityHooks";
import { FullscreenGate } from "../components/FullscreenGate";

function Harness({ fullscreen, block }: { fullscreen: boolean; block: boolean }) {
  const s = useIntegrityHooks({
    attemptId: "att1",
    currentQuestionId: "q1",
    fullscreenRequired: fullscreen,
    blockCopyPaste: block,
  });
  return (
    <div>
      {s.fullscreenGateOpen && <FullscreenGate exitCount={s.fullscreenExitCount} onEnter={s.enterFullscreen} />}
      {s.copyBlockedNotice && <p role="status">Copy and paste are turned off for this test.</p>}
      {s.showLeaveWarning && <p role="status">left {s.leaveCount}</p>}
      <textarea aria-label="answer" />
    </div>
  );
}

let fsEl: Element | null = null;
const requestFullscreen = vi.fn(function () {
  fsEl = document.documentElement;
  document.dispatchEvent(new Event("fullscreenchange"));
  return Promise.resolve();
});

beforeEach(() => {
  fsEl = null;
  Object.defineProperty(document, "fullscreenEnabled", { configurable: true, value: true });
  Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => fsEl });
  Object.defineProperty(document, "exitFullscreen", { configurable: true, value: () => Promise.resolve() });
  document.documentElement.requestFullscreen = requestFullscreen as never;
  recordEvent.mockClear();
  try {
    sessionStorage.clear();
  } catch {
    /* ignore */
  }
});
afterEach(cleanup);

const types = () => (recordEvent.mock.calls as unknown as Array<[string, { event_type: string; payload?: unknown }]>).map((c) => c[1]);

describe("full screen gate", () => {
  it("shows a labelled dialog, enters on click, records exit and re-prompts; Esc does not dismiss", () => {
    render(<Harness fullscreen block={false} />);
    const dlg = screen.getByRole("dialog", { name: /runs in full screen/i });
    fireEvent.keyDown(dlg, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /enter full screen/i }));
    expect(requestFullscreen).toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(types().some((e) => e.event_type === "fullscreen_enter")).toBe(true);

    act(() => {
      fsEl = null;
      document.dispatchEvent(new Event("fullscreenchange"));
    });
    expect(types().some((e) => e.event_type === "fullscreen_exit")).toBe(true);
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText(/You left full screen 1 time\./)).toBeTruthy();
  });

  it("does not block when full screen is unsupported", () => {
    Object.defineProperty(document, "fullscreenEnabled", { configurable: true, value: false });
    render(<Harness fullscreen block={false} />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("copy/paste block", () => {
  it("cancels paste, records blocked:true and shows the note", () => {
    render(<Harness fullscreen={false} block />);
    const ev = new Event("paste", { bubbles: true, cancelable: true });
    act(() => {
      document.dispatchEvent(ev);
    });
    expect(ev.defaultPrevented).toBe(true);
    expect(types().find((e) => e.event_type === "paste")?.payload).toMatchObject({ blocked: true });
    expect(screen.getByText(/Copy and paste are turned off/)).toBeTruthy();
  });

  it("leaves paste alone when not blocking", () => {
    render(<Harness fullscreen={false} block={false} />);
    const ev = new Event("paste", { bubbles: true, cancelable: true });
    act(() => {
      document.dispatchEvent(ev);
    });
    expect(ev.defaultPrevented).toBe(false);
  });
});

describe("tab-leave warning", () => {
  it("counts a return after leaving the tab", () => {
    render(<Harness fullscreen={false} block={false} />);
    const vis = (s: string) => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: s });
      act(() => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
    };
    vis("hidden");
    vis("visible");
    expect(screen.getByText("left 1")).toBeTruthy();
  });
});
