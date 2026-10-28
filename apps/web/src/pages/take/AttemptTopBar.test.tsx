// Z-174: top bar names and fallbacks. No name, no title, no logo each fall back without breaking the bar.
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { AttemptTopBar, type AttemptTopBarProps } from "./attempt-parts/AttemptTopBar.js";

const base = (over: Partial<AttemptTopBarProps> = {}): AttemptTopBarProps => ({
  sec: undefined,
  attempt: { id: "att1", status: "in_progress", started_at: null, ends_at: null, user_id: "u-1234abcd-0000", assessment_id: "a-9876fedc-0000", duration_seconds: null } as AttemptTopBarProps["attempt"],
  safeIdx: 0,
  questionCount: 3,
  isLastSection: true,
  handleExpire: () => undefined,
  refreshAfterSectionChange: async () => undefined,
  autosave: { status: "idle", lastSavedAt: null, retryCount: 0 } as unknown as AttemptTopBarProps["autosave"],
  setNavOpen: () => undefined,
  prefs: { theme: "mid", size: "M", org: "both", navCollapsed: false },
  setPrefs: () => undefined,
  candidateId: "u-1234abcd-0000",
  assessmentId: "a-9876fedc-0000",
  ...over,
});

afterEach(cleanup);

describe("AttemptTopBar identity", () => {
  it("shows the candidate name, assessment title, organisation name and logo", () => {
    render(<AttemptTopBar {...base({ candidateName: "Asha Verma", assessmentName: "Aptitude Mock 3", companyName: "Acme College", companyLogoUrl: "/logo.png" })} />);
    expect(screen.getByText("Asha Verma")).toBeTruthy();
    expect(screen.getByText("Aptitude Mock 3")).toBeTruthy();
    expect(screen.getByText("Acme College")).toBeTruthy();
    expect(screen.getByText("ASSIGNED BY")).toBeTruthy();
    expect(screen.getByText(/CANDIDATE · STU-U1234ABC/)).toBeTruthy();
    // name sits beside the logo: the logo alt is empty
    expect(document.querySelector(".aiq-take-org-mark img")?.getAttribute("alt")).toBe("");
  });

  it("no name: the short id shows, no eyebrow id", () => {
    render(<AttemptTopBar {...base({ companyName: "Acme College" })} />);
    expect(screen.getByText("STU-U1234ABC")).toBeTruthy();
    expect(screen.getByText("CANDIDATE")).toBeTruthy();
  });

  it("no title: only the eyebrow with the short id", () => {
    render(<AttemptTopBar {...base({ candidateName: "Asha Verma" })} />);
    expect(screen.getByText("ASSESSMENT · #A9876FED")).toBeTruthy();
    expect(document.querySelector('[data-testid="take-assessment-meta"] .aiq-take-meta-val')).toBeNull();
  });

  it("no logo: initials in the mark; alone it is named for screen readers", () => {
    render(<AttemptTopBar {...base({ companyName: "Acme College", prefs: { theme: "mid", size: "M", org: "logo", navCollapsed: false } })} />);
    const mark = document.querySelector(".aiq-take-org-mark span");
    expect(mark?.textContent).toBe("AC");
    expect(mark?.getAttribute("role")).toBe("img");
    expect(mark?.getAttribute("aria-label")).toBe("Acme College");
  });

  it("timer bar shows only with a planned total", () => {
    const soon = new Date(Date.now() + 30 * 60_000).toISOString();
    const { unmount } = render(<AttemptTopBar {...base({ attempt: { ...base().attempt, ends_at: soon, duration_seconds: 3600 } })} />);
    expect(document.querySelector('[data-testid="take-timer-bar"]')).not.toBeNull();
    unmount();
    render(<AttemptTopBar {...base({ attempt: { ...base().attempt, ends_at: soon, duration_seconds: null } })} />);
    expect(document.querySelector('[data-testid="take-timer-bar"]')).toBeNull();
  });
});
