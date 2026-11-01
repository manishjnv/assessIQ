import { ValidationError } from "./errors.js";

/**
 * The ONLY place in the codebase that calls `new Date()`.
 * Returns the current time as a UTC ISO 8601 string (ends in "Z").
 */
export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Parses a UTC ISO 8601 string into a Date.
 *
 * Rejects:
 *   - Strings that do not end in "Z" (local-timezone strings like "+05:30" are
 *     refused — UTC enforcement per SKILL.md line 48).
 *   - Strings that produce an invalid Date (NaN milliseconds).
 *   - Empty strings.
 */
export function parseIso(s: string): Date {
  if (!s || !s.endsWith("Z")) {
    throw new ValidationError(
      `parseIso: string must end with "Z" (UTC required), got: ${JSON.stringify(s)}`
    );
  }
  const d = new Date(s);
  if (isNaN(d.getTime())) {
    throw new ValidationError(
      `parseIso: invalid ISO 8601 date string: ${JSON.stringify(s)}`
    );
  }
  return d;
}

const IST_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// ponytail: fixed zone, fixed English month names, so the output does not depend on ICU locale data.
const IST_PARTS_FORMAT = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  day: "numeric",
  month: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

/**
 * Formats an instant for a student in Indian time (fixed zone Asia/Kolkata).
 * Output: "8 Nov 2026, 9:32 am IST". Pure: formats the given date, never reads the clock.
 * Throws ValidationError for an invalid date or string.
 */
export function formatIst(input: Date | string): string {
  const d = typeof input === "string" ? new Date(input) : input;
  if (!(d instanceof Date) || isNaN(d.getTime())) {
    throw new ValidationError(`formatIst: invalid date: ${JSON.stringify(String(input))}`);
  }
  const p: Record<string, string> = {};
  for (const part of IST_PARTS_FORMAT.formatToParts(d)) p[part.type] = part.value;
  const period = (p["dayPeriod"] ?? "").replace(/\./g, "").toLowerCase();
  const month = IST_MONTHS[Number(p["month"]) - 1];
  return `${Number(p["day"])} ${month} ${p["year"]}, ${Number(p["hour"])}:${p["minute"]} ${period} IST`;
}

/**
 * Same as formatIst, but never throws. For recipient-facing text (mail, pages):
 * an invalid input comes back as its raw String, so a bad date never breaks a send or a page.
 * Pure: no logging, no clock read.
 */
export function formatIstOr(input: Date | string): string {
  const d = typeof input === "string" ? new Date(input) : input;
  if (!(d instanceof Date) || isNaN(d.getTime())) return String(input);
  return formatIst(d);
}
