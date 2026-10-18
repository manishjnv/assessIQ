// Z-39 follow-up — ExtraAttemptDialog replaces window.prompt.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import React, { useState } from "react";
import { ExtraAttemptDialog } from "../components/ExtraAttemptDialog.js";

afterEach(cleanup);

const submitBtn = (): HTMLButtonElement => screen.getByText("Give extra attempt") as HTMLButtonElement;
const type = (v: string): void => {
  fireEvent.change(screen.getByLabelText("Reason (required, up to 500 characters)"), { target: { value: v } });
};

describe("ExtraAttemptDialog", () => {
  it("blocks empty and 501-char reasons, allows 500", () => {
    render(<ExtraAttemptDialog busy={false} error={null} onSubmit={vi.fn()} onCancel={vi.fn()} />);
    expect(submitBtn().disabled).toBe(true);
    type("   ");
    expect(submitBtn().disabled).toBe(true);
    type("a".repeat(501));
    expect(submitBtn().disabled).toBe(true);
    type("a".repeat(500));
    expect(submitBtn().disabled).toBe(false);
    expect(screen.getByText("500 / 500")).toBeTruthy();
  });

  it("submits once with the trimmed reason and shows an API error inside", () => {
    const onSubmit = vi.fn();
    const { rerender } = render(<ExtraAttemptDialog busy={false} error={null} onSubmit={onSubmit} onCancel={vi.fn()} />);
    type("  late due to outage  ");
    fireEvent.click(submitBtn());
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith("late due to outage");
    rerender(<ExtraAttemptDialog busy={false} error="Not allowed" onSubmit={onSubmit} onCancel={vi.fn()} />);
    expect(screen.getByRole("alert").textContent).toBe("Not allowed");
  });

  it("Escape closes and focus returns to the trigger", () => {
    function Host(): React.ReactElement {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>Open</button>
          {open && <ExtraAttemptDialog busy={false} error={null} onSubmit={vi.fn()} onCancel={() => setOpen(false)} />}
        </>
      );
    }
    render(<Host />);
    const trigger = screen.getByText("Open");
    trigger.focus();
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
