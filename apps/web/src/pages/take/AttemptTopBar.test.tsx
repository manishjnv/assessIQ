// Z-174: top bar names and fallbacks. No name, no title, no logo each fall back without breaking the bar.
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
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
  prefs: { theme: "mid", size: "M", navCollapsed: false },
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

  it("org mark: logo and name when both exist; the one that exists otherwise; nothing when neither", () => {
    const { unmount } = render(<AttemptTopBar {...base({ companyName: "Acme College", companyLogoUrl: "/logo.png" })} />);
    expect(document.querySelector(".aiq-take-org-mark img")).not.toBeNull();
    expect(screen.getByText("Acme College")).toBeTruthy();
    unmount();
    const b = render(<AttemptTopBar {...base({ companyName: "", companyLogoUrl: "/logo.png" })} />);
    expect(document.querySelector(".aiq-take-org-mark img")).not.toBeNull();
    expect(screen.queryByText("ASSIGNED BY")).toBeNull();
    b.unmount();
    const c = render(<AttemptTopBar {...base({ companyName: "Acme College", companyLogoUrl: null })} />);
    expect(screen.getByText("Acme College")).toBeTruthy();
    c.unmount();
    render(<AttemptTopBar {...base({ companyName: "", companyLogoUrl: null })} />);
    expect(document.querySelector('[data-help-id="candidate.take.attempt.logo"]')).toBeNull();
  });

  it("no student org setting; full screen toggle only when not enforced", () => {
    const { unmount } = render(<AttemptTopBar {...base({ companyName: "Acme" })} />);
    expect(screen.getByRole("button", { name: "Full screen" })).toBeTruthy();
    unmount();
    render(<AttemptTopBar {...base({ companyName: "Acme", fullscreenEnforced: true })} />);
    expect(screen.queryByRole("button", { name: "Full screen" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Display settings" }));
    expect(screen.queryByText("Organization")).toBeNull();
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
