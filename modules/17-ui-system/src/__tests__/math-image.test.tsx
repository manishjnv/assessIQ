/**
 * EXP-10 part 1: MathText (lazy KaTeX) and QuestionImage (alt text, load error fallback).
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { MathText, QuestionImage } from "../index.js";

afterEach(() => cleanup());

const INLINE = "Find \\(x^2 + 1\\) now";

describe("MathText", () => {
  it("draws old questions (no math flag) as plain text, exactly as stored", () => {
    const { container } = render(<p><MathText text={INLINE} /></p>);
    expect(container).toHaveTextContent(INLINE);
    expect(container.querySelector("[data-testid='math-piece']")).toBeNull();
    const off = render(<p><MathText text={INLINE} math={false} /></p>);
    expect(off.container).toHaveTextContent(INLINE);
  });

  it("with the flag, loads KaTeX on demand and draws the expression; the raw text shows until then", async () => {
    const { container } = render(<p><MathText text={INLINE} math /></p>);
    const piece = container.querySelector("[data-testid='math-piece']")!;
    expect(piece).toBeInTheDocument();
    expect(container).toHaveTextContent("Find");
    await waitFor(() => expect(piece).toHaveAttribute("data-math-state", "ready"), { timeout: 10_000 });
    expect(container.querySelector(".katex")).toBeInTheDocument();
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("a[href]")).toBeNull();
  });

  it("a broken or unclosed expression stays as raw text and never throws", () => {
    const { container } = render(<p><MathText text={"open \\(x^2 never closed"} math /></p>);
    expect(container).toHaveTextContent("open \\(x^2 never closed");
    expect(container.querySelector("[data-testid='math-piece']")).toBeNull();
  });

  it("an expression KaTeX refuses with an error (html commands) falls back to its raw text", async () => {
    const { container } = render(<p><MathText text={"x \\(\\htmlClass{a}{y}\\) z"} math /></p>);
    const piece = container.querySelector("[data-testid='math-piece']")!;
    await waitFor(() => expect(piece).toHaveAttribute("data-math-state", "failed"), { timeout: 10_000 });
    expect(container).toHaveTextContent("\\htmlClass{a}{y}");
    expect(container.querySelector("a")).toBeNull();
  });

  it("a link command is never a link: KaTeX shows it as inert text", async () => {
    const { container } = render(<p><MathText text={"x \\(\\href{javascript:alert(1)}{y}\\) z"} math /></p>);
    const piece = container.querySelector("[data-testid='math-piece']")!;
    await waitFor(() => expect(piece).not.toHaveAttribute("data-math-state", "loading"), { timeout: 10_000 });
    expect(container.querySelector("a")).toBeNull();
    expect(container.querySelector("[href]")).toBeNull();
    expect(container.innerHTML).not.toMatch(/<[^>]*\shref=/i);
  });

  it("html in the text is never parsed: it is drawn as text", () => {
    const { container } = render(<p><MathText text={"<img src=x onerror=alert(1)> \\(x\\)"} math /></p>);
    expect(container.querySelector("img")).toBeNull();
    expect(container).toHaveTextContent("<img src=x onerror=alert(1)>");
  });
});

describe("QuestionImage", () => {
  it("draws an img with the stored alt text and size, wrapped in a link that opens it full size", () => {
    render(<QuestionImage src="/api/me/attempts/a/assets/b" alt="Circuit with two switches" width={320} height={200} />);
    const img = screen.getByAltText("Circuit with two switches");
    expect(img).toHaveAttribute("src", "/api/me/attempts/a/assets/b");
    expect(img).toHaveAttribute("width", "320");
    expect(img).toHaveAttribute("loading", "lazy");
    const link = screen.getByRole("link");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("data-help-id", "candidate.take.image");
  });

  it("option images are not links", () => {
    render(<QuestionImage src="/x" alt="Option b figure" linked={false} />);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByAltText("Option b figure")).toBeInTheDocument();
  });

  it("when the image fails to load, the alt text shows in a box with a note and the question stays usable", () => {
    render(<QuestionImage src="/x" alt="Figure of a router" />);
    fireEvent.error(screen.getByAltText("Figure of a router"));
    const box = screen.getByTestId("question-image-fallback");
    expect(box).toHaveTextContent("Figure of a router");
    expect(box).toHaveTextContent("Image did not load");
    expect(screen.queryByRole("img")).toBeNull();
  });
});
