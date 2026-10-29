// EXP-10 part 1: the "Images and maths" panel of the create-question form, and the read-only question view.
//   P1  hidden for types without rich content; asks to fix invalid JSON
//   P2  Contains maths writes and removes content.math
//   P3  upload under the question writes stem_assets; alt text is required; at most 3
//   P4  upload on an option writes option_assets aligned to options; Remove clears it
//   P5  the read-only view draws maths as written (no backslash clean-up) and shows the attached images
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import React from "react";

const { upload, meta } = vi.hoisted(() => ({ upload: vi.fn(), meta: vi.fn() }));

vi.mock("../api.js", () => ({
  adminApi: vi.fn(),
  AdminApiError: class AdminApiError extends Error {
    status: number;
    apiError: { code: string; message: string };
    constructor(status: number, apiError: { code: string; message: string }) {
      super(apiError.message);
      this.status = status;
      this.apiError = apiError;
    }
  },
}));
vi.mock("../api/question-assets.js", () => ({
  uploadQuestionAssetApi: (...a: unknown[]) => upload(...a),
  getQuestionAssetMetaApi: (...a: unknown[]) => meta(...a),
  questionAssetUrl: (id: string) => `/api/admin/question-assets/${id}`,
}));
vi.mock("@assessiq/help-system/components", () => ({
  HelpTip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { RichContentPanel } from "../components/RichContentPanel.js";
import { QuestionContentView } from "../components/QuestionContentView.js";

const ID1 = "0190a0a0-0000-7000-8000-0000000000b1";
const ID2 = "0190a0a0-0000-7000-8000-0000000000b2";
const base = { question: "Which one?", options: ["a", "b", "c", "d"], correct: 0, rationale: "r" };

beforeEach(() => {
  upload.mockReset();
  meta.mockReset();
  meta.mockImplementation(async (id: string) => ({ id, pack_id: "p", sha256: "x", mime: "image/png", byte_size: 10, width: 64, height: 48, alt_text: `alt for ${id.slice(-2)}`, created_at: "" }));
});
afterEach(() => cleanup());

function Host({ type = "mcq", start = JSON.stringify(base), packId = "pack-1" }: { type?: string; start?: string; packId?: string }): React.ReactElement {
  const [json, setJson] = React.useState(start);
  return (
    <>
      <RichContentPanel type={type} packId={packId} contentJson={json} onChange={setJson} />
      <pre data-testid="json">{json}</pre>
    </>
  );
}
const current = (): Record<string, unknown> => JSON.parse(screen.getByTestId("json").textContent ?? "{}") as Record<string, unknown>;
const pick = (name: string): void => { fireEvent.change(screen.getByLabelText(/PNG or JPEG/), { target: { files: [new File([new Uint8Array([1, 2, 3])], name, { type: "image/png" })] } }); };
const alt = (v: string): void => { fireEvent.change(screen.getByLabelText(/Alt text/), { target: { value: v } }); };

describe("RichContentPanel", () => {
  it("P1 is hidden for a subjective question and asks to fix invalid JSON", () => {
    const { container, rerender } = render(<RichContentPanel type="subjective" packId="p" contentJson="{}" onChange={() => undefined} />);
    expect(container.firstChild).toBeNull();
    rerender(<RichContentPanel type="mcq" packId="p" contentJson="{ not json" onChange={() => undefined} />);
    expect(screen.getByTestId("rich-panel-fix-json")).toBeTruthy();
  });

  it("P2 Contains maths writes content.math and removes it again", () => {
    render(<Host />);
    expect(current()["math"]).toBeUndefined();
    fireEvent.click(screen.getByTestId("contains-maths"));
    expect(current()["math"]).toBe(true);
    expect(current()["options"]).toEqual(["a", "b", "c", "d"]); // the rest of the JSON is untouched
    fireEvent.click(screen.getByTestId("contains-maths"));
    expect("math" in current()).toBe(false);
  });

  it("P3 upload under the question writes stem_assets; alt text is required; the call carries the pack and the trimmed alt", async () => {
    upload.mockResolvedValue({ id: ID1, deduped: false });
    render(<Host />);
    pick("fig.png");
    fireEvent.click(screen.getByRole("button", { name: "Upload image" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Alt text is required");
    expect(upload).not.toHaveBeenCalled();
    alt("  Circuit with two switches  ");
    fireEvent.click(screen.getByRole("button", { name: "Upload image" }));
    await waitFor(() => expect(current()["stem_assets"]).toEqual([ID1]));
    expect(upload).toHaveBeenCalledWith("pack-1", expect.any(File), "Circuit with two switches");
    await waitFor(() => expect(screen.getByAltText("alt for b1")).toBeTruthy());
  });

  it("P3 at most 3 pictures under the question, and no upload without a file", async () => {
    render(<Host start={JSON.stringify({ ...base, stem_assets: [ID1, ID2, "0190a0a0-0000-7000-8000-0000000000b3"] })} />);
    alt("A fourth picture");
    fireEvent.click(screen.getByRole("button", { name: "Upload image" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Choose a PNG or JPEG");
    pick("four.png");
    fireEvent.click(screen.getByRole("button", { name: "Upload image" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("At most 3"));
    expect(upload).not.toHaveBeenCalled();
  });

  it("P4 upload on an option writes option_assets as long as options; Remove clears it and the key", async () => {
    upload.mockResolvedValue({ id: ID2, deduped: false });
    render(<Host />);
    fireEvent.change(screen.getByLabelText(/Add the image to/), { target: { value: "opt:2" } });
    pick("opt.png");
    alt("Option C figure of a switch");
    fireEvent.click(screen.getByRole("button", { name: "Upload image" }));
    await waitFor(() => expect(current()["option_assets"]).toEqual([null, null, ID2, null]));
    fireEvent.click(await screen.findByRole("button", { name: /Remove the image from Option C/ }));
    expect("option_assets" in current()).toBe(false);
  });

  it("P4 an upload error is shown and the JSON is not changed", async () => {
    const { AdminApiError } = await import("../api.js");
    upload.mockRejectedValue(new AdminApiError(422, { code: "ASSET_BAD_FORMAT", message: "Only PNG and JPEG images are accepted." }));
    render(<Host />);
    pick("x.svg");
    alt("A diagram of a circuit");
    fireEvent.click(screen.getByRole("button", { name: "Upload image" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Only PNG and JPEG");
    expect("stem_assets" in current()).toBe(false);
  });
});

describe("QuestionContentView with maths and images", () => {
  it("P5 a maths question keeps its backslashes (no clean-up) and typesets", async () => {
    const content = { ...base, math: true, question: "Find \\(x^2\\) when \\(n = 2\\)", options: ["\\(1\\)", "\\(2\\)"], correct: 0 };
    const { container } = render(<QuestionContentView type="mcq" content={content} />);
    await waitFor(() => expect(container.querySelector(".katex")).toBeTruthy(), { timeout: 10_000 });
    expect(container.querySelectorAll("[data-testid='math-piece']").length).toBe(4);
  });

  it("P5 without the flag the old text clean-up still applies", () => {
    const { container } = render(<QuestionContentView type="mcq" content={{ ...base, question: "Line one\\nLine two" }} />);
    expect(container.textContent).toContain("Line one");
    expect(container.querySelector("[data-testid='math-piece']")).toBeNull();
  });

  it("P5 stem and option pictures are drawn with the stored alt text, from the admin route", async () => {
    render(<QuestionContentView type="mcq" content={{ ...base, stem_assets: [ID1], option_assets: [null, ID2, null, null] }} />);
    const stem = await screen.findByAltText("alt for b1");
    expect(stem.getAttribute("src")).toBe(`/api/admin/question-assets/${ID1}`);
    const opt = await screen.findByAltText("alt for b2");
    expect(opt.closest("a")).toBeNull();
  });
});
