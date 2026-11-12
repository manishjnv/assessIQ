// EXP-9 A6: English | Hindi preview switch in the read-only MCQ view. Fake text only.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import React from "react";

vi.mock("@assessiq/help-system/components", () => ({
  HelpTip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("../api/question-assets.js", () => ({
  getQuestionAssetMetaApi: vi.fn(),
  questionAssetUrl: (id: string) => `/api/admin/question-assets/${id}`,
}));

import { McqContentSchema } from "@assessiq/question-types";
import { QuestionContentView } from "../components/QuestionContentView.js";

const en = { question: "Sample question", options: ["a", "b", "c"], correct: 1, rationale: "English why" };
const hi = { question: "नमूना प्रश्न", options: ["क", "ख", "ग"], rationale: "हिन्दी कारण" };

afterEach(() => cleanup());

it("fixture parses with the real schema", () => {
  expect(McqContentSchema.safeParse({ ...en, i18n: { hi } }).success).toBe(true);
});

describe("Hindi preview switch", () => {
  it("has no switch without an overlay", () => {
    render(<QuestionContentView type="mcq" content={en} />);
    expect(screen.queryByRole("button", { name: "हिन्दी" })).toBeNull();
  });

  it("shows Hindi text with lang=hi, the same correct index and the Hindi rationale", () => {
    render(<QuestionContentView type="mcq" content={{ ...en, i18n: { hi } }} />);
    fireEvent.click(screen.getByRole("button", { name: "हिन्दी" }));
    expect(screen.getByText("नमूना प्रश्न").getAttribute("lang")).toBe("hi");
    expect(screen.getByText("हिन्दी कारण", { exact: false })).toBeTruthy();
    const items = screen.getAllByRole("listitem");
    expect(items[1]!.textContent).toContain("✓");
    expect(items[1]!.textContent).toContain("ख");
    expect(items[0]!.textContent).not.toContain("✓");
    fireEvent.click(screen.getByRole("button", { name: "English" }));
    expect(screen.getByText("Sample question")).toBeTruthy();
  });

  it("warns and keeps English when the option counts differ", () => {
    render(<QuestionContentView type="mcq" content={{ ...en, i18n: { hi: { ...hi, options: ["क"] } } }} />);
    expect(screen.getByText("Hindi options do not match the English options.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "हिन्दी" }));
    expect(screen.getByText("Sample question")).toBeTruthy();
  });
});
