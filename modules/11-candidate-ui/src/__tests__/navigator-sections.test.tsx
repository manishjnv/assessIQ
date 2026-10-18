import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { QuestionNavigator, type NavigatorItem } from "../components/index.js";
import { groupNavigatorItems } from "../components/navigatorGroups.js";

afterEach(cleanup);

const A = { index: 0, name: "Reasoning" };
const B = { index: 1, name: "Maths" };
const whole: NavigatorItem[] = [
  { questionId: "q1", position: 1, status: "current", answered: true, section: A },
  { questionId: "q2", position: 2, status: "unanswered", section: A },
  { questionId: "q3", position: 3, status: "answered", section: B },
  { questionId: "q4", position: 4, status: "flagged", section: B },
];
const flat: NavigatorItem[] = whole.map(({ section: _s, ...rest }) => rest);

describe("groupNavigatorItems", () => {
  it("whole-test: one group per section in order", () => {
    const g = groupNavigatorItems(whole);
    expect(g.map((x) => [x.section?.name, x.items.length])).toEqual([["Reasoning", 2], ["Maths", 2]]);
  });
  it("unsectioned and per-section (no item section): a single flat group", () => {
    const g = groupNavigatorItems(flat);
    expect(g).toHaveLength(1);
    expect(g[0]!.section).toBeNull();
    expect(g[0]!.items).toHaveLength(4);
  });
});

describe("QuestionNavigator section groups", () => {
  it("shows a heading per section with the answered count", () => {
    render(<QuestionNavigator items={whole} onSelect={() => {}} />);
    expect(screen.getByRole("button", { name: "Reasoning (1/2 answered)" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Maths (1/2 answered)" })).toBeTruthy();
  });
  it("a heading jumps to the first question of its section", () => {
    const onSelect = vi.fn();
    render(<QuestionNavigator items={whole} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("button", { name: /^Maths/ }));
    expect(onSelect).toHaveBeenCalledWith("q3");
  });
  it("renders no headings when items carry no section", () => {
    render(<QuestionNavigator items={flat} onSelect={() => {}} />);
    expect(screen.queryByRole("button", { name: /answered\)$/ })).toBeNull();
  });
});
