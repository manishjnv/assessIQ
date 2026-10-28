import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { QuestionNavigator, NavCollapseHandle, type NavigatorItem } from "../components/index.js";

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

  it("collapse pill toggles and its name and aria-expanded follow the state", () => {
    const toggle = vi.fn();
    const { rerender } = render(<NavCollapseHandle collapsed={false} onToggle={toggle} />);
    const pill = screen.getByRole("button", { name: "Collapse question panel" });
    expect(pill.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(pill);
    expect(toggle).toHaveBeenCalledTimes(1);
    rerender(<NavCollapseHandle collapsed onToggle={toggle} />);
    expect(screen.getByRole("button", { name: "Expand question panel" }).getAttribute("aria-expanded")).toBe("false");
  });

  it("the folded rail keeps the cell names, aria-current and a lens, and drops the panel parts", () => {
    render(<QuestionNavigator items={items} onSelect={() => {}} collapsed />);
    expect(screen.queryByRole("button", { name: "Next unanswered" })).toBeNull();
    expect(screen.getByLabelText("Question 1, answered, flagged")).toBeTruthy();
    const cur = screen.getByLabelText("Question 3, unanswered, current");
    expect(cur.getAttribute("aria-current")).toBe("step");
    expect(screen.getByLabelText("Question navigator").querySelectorAll("button").length).toBe(6);
    expect(document.querySelector('[data-rail-lens="true"]')).not.toBeNull();
    expect(screen.getByText("03")).toBeTruthy();
    expect(screen.getByText("of 6")).toBeTruthy();
  });

  it("rail chevrons step through the filtered sequence", () => {
    const onSelect = vi.fn();
    render(<QuestionNavigator items={items} onSelect={onSelect} collapsed filter="flagged" />);
    // current q3 is outside the filter; next flagged after it is q5, previous is q1.
    fireEvent.click(screen.getByRole("button", { name: "Next question" }));
    expect(onSelect).toHaveBeenLastCalledWith("q5");
    fireEvent.click(screen.getByRole("button", { name: "Previous question" }));
    expect(onSelect).toHaveBeenLastCalledWith("q1");
    expect(screen.getByText(/of 3 flagged/)).toBeTruthy();
  });

  it("the mobile strip is a horizontal rail with its own name and the sheet button slot", () => {
    render(<QuestionNavigator items={items} onSelect={() => {}} layout="strip" trailing={<button type="button">Open all questions</button>} />);
    expect(screen.getByLabelText("Question strip")).toBeTruthy();
    expect(document.querySelector('[data-axis="x"]')).not.toBeNull();
    expect(screen.getByRole("button", { name: "Open all questions" })).toBeTruthy();
    expect(screen.queryByText("of 6")).toBeNull(); // footer is vertical-rail only
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
