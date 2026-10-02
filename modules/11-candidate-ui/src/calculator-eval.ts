// Basic-calculator logic for the candidate runner. Pure, no eval()/Function().
// Grammar: [-] number (op [-] number)*   with op in + - * /  (* and / bind tighter).
// No parentheses, no memory — a four-function pocket calculator.

/** Evaluate an expression like "12+3*4-5/2". Returns null when invalid or not finite (e.g. /0). */
export function evaluate(input: string): number | null {
  const expr = input.trim();
  const re = /(\d+\.?\d*(?:e[+-]?\d+)?|\.\d+)|([+\-*/])/y;
  const nums: number[] = [];
  const ops: string[] = [];
  let i = 0;
  let expectNum = true;
  let neg = false;
  while (i < expr.length) {
    re.lastIndex = i;
    const m = re.exec(expr);
    if (m === null) return null;
    i = re.lastIndex;
    if (m[1] !== undefined) {
      if (!expectNum) return null;
      nums.push(neg ? -Number(m[1]) : Number(m[1]));
      neg = false;
      expectNum = false;
    } else if (expectNum) {
      if (m[2] !== "-") return null; // unary minus only
      neg = !neg;
    } else {
      ops.push(m[2] as string);
      expectNum = true;
    }
  }
  if (expectNum || nums.length === 0) return null;

  // Pass 1: * and /  ->  list of terms joined by + / -.
  const terms: number[] = [nums[0] as number];
  const addOps: string[] = [];
  for (const [k, op] of ops.entries()) {
    const n = nums[k + 1] as number;
    const last = terms.length - 1;
    if (op === "*") terms[last] = (terms[last] as number) * n;
    else if (op === "/") {
      if (n === 0) return null;
      terms[last] = (terms[last] as number) / n;
    } else {
      addOps.push(op);
      terms.push(n);
    }
  }
  let r = terms[0] as number;
  for (const [k, op] of addOps.entries()) {
    r = op === "+" ? r + (terms[k + 1] as number) : r - (terms[k + 1] as number);
  }
  return Number.isFinite(r) ? r : null;
}

/** 12 significant digits so 0.1+0.2 shows 0.3. */
export function formatResult(n: number): string {
  return String(Number(n.toPrecision(12)));
}

export interface CalcState {
  /** ASCII expression (operators + - * /) or "Error". */
  expr: string;
  /** True right after "=": the next digit starts fresh, an operator continues from the result. */
  done: boolean;
}

export const CALC_INITIAL: CalcState = { expr: "", done: false };
const MAX_LEN = 40;
const isOp = (c: string | undefined): boolean => c !== undefined && "+-*/".includes(c);

/** One key press. Keys: 0-9 . + - * / = back clear */
export function calcPress(state: CalcState, key: string): CalcState {
  let { expr, done } = state;
  if (expr === "Error") {
    expr = "";
    done = false;
  }
  if (key === "clear") return CALC_INITIAL;
  if (key === "back") return done ? CALC_INITIAL : { expr: expr.slice(0, -1), done: false };

  if (key === "=") {
    if (done || expr === "") return { expr, done };
    const r = evaluate(expr.replace(/[+\-*/]+$/, ""));
    return r === null ? { expr: "Error", done: true } : { expr: formatResult(r), done: true };
  }

  if (isOp(key)) {
    if (expr === "") return key === "-" ? { expr: "-", done: false } : { expr, done };
    if (expr === "-") return { expr, done };
    if (isOp(expr.slice(-1))) {
      if (key === "-" && "*/".includes(expr.slice(-1)) && !isOp(expr.slice(-2, -1))) {
        return { expr: expr + key, done: false }; // 5*-2
      }
      return { expr: expr.replace(/[+\-*/]+$/, "") + key, done: false }; // swap operator
    }
    return expr.length >= MAX_LEN ? { expr, done } : { expr: expr + key, done: false };
  }

  if (/^[0-9.]$/.test(key)) {
    if (done) {
      expr = "";
      done = false;
    }
    if (expr.length >= MAX_LEN) return { expr, done };
    const seg = expr.split(/[+\-*/]/).pop() as string;
    if (key === ".") {
      if (seg.includes(".")) return { expr, done };
      return { expr: expr + (seg === "" ? "0." : "."), done: false };
    }
    return { expr: expr + key, done: false };
  }
  return { expr, done };
}

/** Display form of an ASCII expression. */
export function prettyExpr(expr: string): string {
  return expr.replace(/\*/g, "×").replace(/\//g, "÷").replace(/(?<=.)-/g, "−");
}

/** Map a KeyboardEvent.key to a calcPress key, or null if the key is not for the calculator. */
export function keyToCalc(key: string): string | null {
  if (/^[0-9.]$/.test(key) || (key.length === 1 && "+-*/".includes(key))) return key;
  if (key === "x" || key === "X") return "*";
  if (key === "Enter" || key === "=") return "=";
  if (key === "Backspace") return "back";
  if (key === "Escape" || key === "c" || key === "C") return "clear";
  return null;
}
