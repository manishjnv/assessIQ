import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

vi.mock("../api", () => ({ recordEvent: vi.fn(() => Promise.resolve()) }));

import { evaluate, formatResult, calcPress, CALC_INITIAL, keyToCalc } from "../calculator-eval";
import type { CalcState } from "../calculator-eval";
import { Calculator } from "../components/Calculator";
import { useIntegrityHooks } from "../hooks/useIntegrityHooks";

afterEach(cleanup);

describe("evaluate", () => {
  it.each([
    ["1+2", 3],
    ["2+3*4", 14], // * binds tighter
    ["10-4-3", 3], // left to right
    ["8/2/2", 2],
    ["-5+2", -3], // unary minus
    ["5*-2", -10],
    ["2--3", 5],
    ["1.5*4", 6],
    [".5+.25", 0.75],
    ["12", 12],
  ])("%s = %d", (expr, want) => {
    expect(evaluate(expr)).toBe(want);
  });

  it.each(["", "+", "1+", "*2", "1..2", "1+*2", "abc", "2(3)", "1/0", "0/0", "1 2"])(
    "rejects %j",
    (expr) => {
      expect(evaluate(expr)).toBeNull();
    },
  );

  it("never evaluates code", () => {
    expect(evaluate("process.exit()")).toBeNull();
    expect(evaluate("1;alert(1)")).toBeNull();
  });

  it("formats away float noise", () => {
    expect(formatResult(0.1 + 0.2)).toBe("0.3");
    expect(formatResult(1 / 3)).toBe("0.333333333333");
  });
});

function type(keys: string[], from: CalcState = CALC_INITIAL): CalcState {
  return keys.reduce(calcPress, from);
}

describe("calcPress", () => {
  it("builds and evaluates an expression", () => {
    expect(type(["1", "2", "+", "3", "*", "4", "="])).toEqual({ expr: "24", done: true });
  });
  it("one decimal point per number, leading 0", () => {
    expect(type([".", "5", ".", "2"]).expr).toBe("0.52");
    expect(type(["1", ".", "5", "+", ".", "5"]).expr).toBe("1.5+0.5");
  });
  it("operator after a result continues; digit after a result starts over", () => {
    expect(type(["2", "+", "3", "=", "*", "2", "="]).expr).toBe("10");
    expect(type(["2", "+", "3", "=", "7"]).expr).toBe("7");
  });
  it("a second operator replaces the first (but 5*-2 keeps the sign)", () => {
    expect(type(["5", "+", "*", "2"]).expr).toBe("5*2");
    expect(type(["5", "*", "-", "2"]).expr).toBe("5*-2");
  });
  it("backspace, clear, divide by zero", () => {
    expect(type(["1", "2", "back"]).expr).toBe("1");
    expect(type(["1", "2", "clear"])).toEqual(CALC_INITIAL);
    expect(type(["5", "/", "0", "="]).expr).toBe("Error");
    expect(type(["5", "/", "0", "=", "3"]).expr).toBe("3"); // recovers
  });
  it("a trailing operator is ignored on =", () => {
    expect(type(["5", "+", "="]).expr).toBe("5");
  });
  it("maps keyboard keys", () => {
    expect(keyToCalc("7")).toBe("7");
    expect(keyToCalc("x")).toBe("*");
    expect(keyToCalc("Enter")).toBe("=");
    expect(keyToCalc("Backspace")).toBe("back");
    expect(keyToCalc("Escape")).toBe("clear");
    expect(keyToCalc("q")).toBeNull();
  });
});

// Integrity v1 block_copy_paste on: the calculator's own buttons and keyboard must still work.
function Harness() {
  useIntegrityHooks({ attemptId: "a1", currentQuestionId: "q1", blockCopyPaste: true });
  return (
    <div>
      <Calculator />
      <textarea aria-label="answer" />
    </div>
  );
}

describe("Calculator component", () => {
  it("works with buttons while copy/paste is blocked", () => {
    render(<Harness />);
    expect(screen.queryByRole("group", { name: "Calculator" })).toBeNull(); // closed until opened
    fireEvent.click(screen.getByRole("button", { name: "Calculator" }));
    for (const name of ["7", "Add", "3", "Multiply", "2", "Equals"]) {
      fireEvent.click(screen.getByRole("button", { name }));
    }
    expect(screen.getByTestId("calc-display").textContent).toBe("13");
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.getByTestId("calc-display").textContent).toBe("0");
  });

  it("supports the keyboard inside the panel only", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Calculator" }));
    const panel = screen.getByRole("group", { name: "Calculator" });
    for (const key of ["9", "/", "3", "Enter"]) fireEvent.keyDown(panel, { key });
    expect(screen.getByTestId("calc-display").textContent).toBe("3");
    fireEvent.keyDown(panel, { key: "Backspace" });
    expect(screen.getByTestId("calc-display").textContent).toBe("0");
    // Typing in the answer box does not reach the calculator.
    fireEvent.keyDown(screen.getByLabelText("answer"), { key: "5" });
    expect(screen.getByTestId("calc-display").textContent).toBe("0");
  });

  it("copy is still blocked on the page", () => {
    render(<Harness />);
    const ev = new Event("copy", { cancelable: true, bubbles: true });
    document.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
  });
});
