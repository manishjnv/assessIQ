import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
afterEach(() => cleanup());

import { StatusPill, PageHeader, EmptyState, ConfirmDialog, Pagination } from "../index.js";

describe("StatusPill", () => {
  it("uses the label prop, then the labels map, then the raw status", () => {
    const { rerender } = render(<StatusPill status="in_progress" labels={{ in_progress: "In progress" }} />);
    expect(screen.getByText("In progress")).toBeInTheDocument();
    rerender(<StatusPill status="in_progress" labels={{ in_progress: "In progress" }} label="Custom" />);
    expect(screen.getByText("Custom")).toBeInTheDocument();
    rerender(<StatusPill status="draft" />);
    expect(screen.getByText("draft")).toBeInTheDocument();
  });
});

describe("PageHeader", () => {
  it("renders title and lede; count chip only when given", () => {
    const { rerender, container } = render(<PageHeader title="Assessments" lede="Lede text" />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveClass("aiq-serif");
    expect(screen.getByText("Lede text")).toBeInTheDocument();
    expect(container.querySelector(".aiq-chip")).toBeNull();
    rerender(<PageHeader title="Assessments" count={0} />);
    expect(container.querySelector(".aiq-chip")).toHaveTextContent("0");
  });
});

describe("EmptyState", () => {
  it("renders title, body and action", () => {
    render(<EmptyState title="Nothing here" body="Add one" action={<button>Add</button>} />);
    expect(screen.getByText("Nothing here")).toBeInTheDocument();
    expect(screen.getByText("Add one")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add" })).toBeInTheDocument();
  });
});

describe("ConfirmDialog", () => {
  const base = { open: true, title: "Sure?", body: "Body", confirmLabel: "Yes" };
  it("calls onConfirm and onCancel (button + Escape); renders mfaGuard", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<ConfirmDialog {...base} onConfirm={onConfirm} onCancel={onCancel} mfaGuard={<div>MFA slot</div>} />);
    expect(screen.getByText("MFA slot")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Yes" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(2);
  });
  it("disables both buttons while busy", () => {
    render(<ConfirmDialog {...base} busy onConfirm={() => {}} onCancel={() => {}} />);
    expect(screen.getByRole("button", { name: "Yes" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  });
  it("renders nothing when closed", () => {
    render(<ConfirmDialog {...base} open={false} onConfirm={() => {}} onCancel={() => {}} />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("Pagination", () => {
  it("disables Previous on the first page and Next on the last", () => {
    const { rerender } = render(<Pagination page={1} pageSize={10} total={25} onPageChange={() => {}} />);
    expect(screen.getByText("Page 1 of 3")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next" })).toBeEnabled();
    rerender(<Pagination page={3} pageSize={10} total={25} onPageChange={() => {}} />);
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
  });
  it("clamps to 1 page when total is 0 and calls onPageChange", () => {
    const fn = vi.fn();
    const { rerender } = render(<Pagination page={1} pageSize={10} total={0} onPageChange={fn} />);
    expect(screen.getByText("Page 1 of 1")).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Pagination" })).toBeInTheDocument();
    rerender(<Pagination page={2} pageSize={10} total={25} onPageChange={fn} />);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(fn).toHaveBeenCalledWith(3);
  });
});
