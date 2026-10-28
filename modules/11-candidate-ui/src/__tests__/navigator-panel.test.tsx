import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { QuestionNavigator, type NavigatorItem } from "../components/index.js";

afterEach(cleanup);

// q1 flagged+answered, q2 answered, q3 current (open), q4 open, q5 flagged (open), q6 open.
const items: NavigatorItem[] = [
  { questionId: "q1", position: 1, status: "flagged", answered: true },
  { questionId: "q2", position: 2, status: "answered" },
  { questionId: "q3", position: 3, status: "current" },
  { questionId: "q4", position: 4, status: "unanswered" },
  { questionId: "q5", position: 5, status: "flagged" },
  { questionId: "q6", position: 6, status: "unanswered" },
];
const cells = () => screen.getByLabelText("Question navigator").querySelectorAll("button").length;

describe("QuestionNavigator panel (Z-169)", () => {
  it("shows the head and the three stat cards with counts", () => {
    render(<QuestionNavigator items={items} onSelect={() => {}} />);
    expect(screen.getByText("2 / 6 answered")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Answered 2" }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("button", { name: "Flagged 2" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open 4" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("Select a count to show and navigate only those questions.");
  });

  it("a stat card filters, a second click clears; the current cell stays", () => {
    render(<QuestionNavigator items={items} onSelect={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Flagged 2" }));
    expect(screen.getByRole("button", { name: "Flagged 2" }).getAttribute("aria-pressed")).toBe("true");
    expect(cells()).toBe(3); // q1, q5 and the current q3
    expect(screen.getByRole("status").textContent).toBe("Showing flagged only. Previous and Next skip the rest.");
    fireEvent.click(screen.getByRole("button", { name: "Flagged 2" }));
    expect(cells()).toBe(6);
    expect(screen.getByRole("button", { name: "Flagged 2" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("Show all clears the filter; a controlled filter reports changes", () => {
    const onFilterChange = vi.fn();
    render(<QuestionNavigator items={items} onSelect={() => {}} filter="open" onFilterChange={onFilterChange} />);
    expect(cells()).toBe(4); // q3, q4, q5, q6
    fireEvent.click(screen.getByRole("button", { name: "Show all" }));
    expect(onFilterChange).toHaveBeenLastCalledWith("all");
    fireEvent.click(screen.getByRole("button", { name: "Answered 2" }));
    expect(onFilterChange).toHaveBeenLastCalledWith("answered");
  });

  it("an empty filter shows Nothing here.", () => {
    render(<QuestionNavigator items={items.filter((i) => i.questionId !== "q1" && i.questionId !== "q5")} onSelect={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Flagged 0" }));
    expect(screen.getByText("Nothing here.")).toBeTruthy();
  });

  it("names every cell with its state and shows the flag dot, also on the current cell", () => {
    const withCurrentFlag = items.map((i) => (i.questionId === "q3" ? { ...i, flagged: true } : i));
    render(<QuestionNavigator items={withCurrentFlag} onSelect={() => {}} />);
    expect(screen.getByLabelText("Question 1, answered, flagged")).toBeTruthy();
    expect(screen.getByLabelText("Question 2, answered")).toBeTruthy();
    expect(screen.getByLabelText("Question 4, unanswered")).toBeTruthy();
    const cur = screen.getByLabelText("Question 3, unanswered, flagged, current");
    expect(cur.getAttribute("aria-current")).toBe("step");
    expect(cur.querySelector('[data-flag-dot="true"]')).not.toBeNull();
  });

  it("Next unanswered goes to the next open question and wraps", () => {
    const onSelect = vi.fn();
    render(<QuestionNavigator items={items} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("button", { name: "Next unanswered" }));
    expect(onSelect).toHaveBeenLastCalledWith("q4");
    cleanup();
    const last = items.map((i) => ({ ...i, status: i.questionId === "q6" ? ("current" as const) : i.status === "current" ? ("unanswered" as const) : i.status }));
    render(<QuestionNavigator items={last} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("button", { name: "Next unanswered" }));
    expect(onSelect).toHaveBeenLastCalledWith("q3"); // wraps past q6 to the first open
  });

  it("Next unanswered is disabled when nothing else is open", () => {
    render(<QuestionNavigator items={items.map((i) => ({ ...i, status: i.questionId === "q1" ? ("current" as const) : ("answered" as const) }))} onSelect={() => {}} />);
    expect((screen.getByRole("button", { name: "Next unanswered" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("collapse handle toggles and the folded column keeps the cell names", () => {
    const toggle = vi.fn();
    const { rerender } = render(<QuestionNavigator items={items} onSelect={() => {}} collapsed={false} onToggleCollapsed={toggle} />);
    const handle = screen.getByRole("button", { name: "Collapse question panel" });
    expect(handle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(handle);
    expect(toggle).toHaveBeenCalledTimes(1);
    rerender(<QuestionNavigator items={items} onSelect={() => {}} collapsed onToggleCollapsed={toggle} />);
    expect(screen.getByRole("button", { name: "Expand question panel" }).getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("button", { name: "Next unanswered" })).toBeNull();
    expect(screen.getByLabelText("Question 1, answered, flagged")).toBeTruthy();
    expect(screen.getByLabelText("Question navigator").querySelectorAll("button").length).toBe(6);
  });

  it("renders inside a dialog container (mobile drawer)", () => {
    render(
      <div role="dialog" aria-label="Questions">
        <QuestionNavigator items={items} onSelect={() => {}} />
      </div>,
    );
    expect(screen.getByRole("dialog").querySelector('[aria-label="Filter questions"]')).not.toBeNull();
  });
});
