// Date/time display formatters — kit format (design-system/copy-and-voice.md):
// "Apr 29, 2026 · 14:32" (24 h, no seconds); relative up to 6 days, then absolute.

const DATE_FMT = new Intl.DateTimeFormat("en-US", { day: "numeric", month: "short", year: "numeric" });
const DATE_NOYEAR_FMT = new Intl.DateTimeFormat("en-US", { day: "numeric", month: "short" });
const TIME_FMT = new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const MONTH_YEAR_FMT = new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric" });

type DateInput = string | number | Date | null | undefined;

function toDate(v: DateInput): Date | null {
  if (v === null || v === undefined || v === "") return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "Apr 29, 2026" */
export function formatDate(v: DateInput): string {
  const d = toDate(v);
  return d ? DATE_FMT.format(d) : "—";
}

/** "Apr 29, 2026 · 14:32" */
export function formatDateTime(v: DateInput): string {
  const d = toDate(v);
  return d ? `${DATE_FMT.format(d)} · ${TIME_FMT.format(d)}` : "—";
}

/** "Apr 2026" */
export function formatMonthYear(v: DateInput): string {
  const d = toDate(v);
  return d ? MONTH_YEAR_FMT.format(d) : "—";
}

/** "4s ago" / "2 min ago" / "3 h ago" / "Yesterday" / "5 days ago" / "Apr 12" (>6 days). */
export function formatRelative(v: DateInput, now: Date = new Date()): string {
  const d = toDate(v);
  if (!d) return "—";
  const diffS = Math.round((now.getTime() - d.getTime()) / 1000);
  const future = diffS < 0;
  const s = Math.abs(diffS);
  const wrap = (x: string) => (future ? `in ${x}` : `${x} ago`);
  if (s < 60) return wrap(`${s}s`);
  if (s < 3600) return wrap(`${Math.floor(s / 60)} min`);
  if (s < 86400) return wrap(`${Math.floor(s / 3600)} h`);
  const days = Math.floor(s / 86400);
  if (days === 1) return future ? "Tomorrow" : "Yesterday";
  if (days <= 6) return wrap(`${days} days`);
  return d.getFullYear() === now.getFullYear() ? DATE_NOYEAR_FMT.format(d) : DATE_FMT.format(d);
}

const DAY_LINE_FMT = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric" });

/** "Thursday · October 9" — dashboard greeting line. */
export function formatDayLine(v: DateInput = new Date()): string {
  const d = toDate(v);
  return d ? DAY_LINE_FMT.format(d).replace(",", " ·") : "—";
}
