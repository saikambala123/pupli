import { clsx, type ClassValue } from "clsx";

/**
 * Escapes a user-supplied search term so it can be used in a Mongo `$regex`
 * as a literal. Without this, a search box is a regular-expression injection:
 * `(a+)+$` and friends make the server evaluate a catastrophically backtracking
 * pattern against every row in the collection.
 */
export function escapeRegex(input: string) {
  return String(input).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").slice(0, 200);
}
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function initials(name?: string) {
  if (!name) return "Z";
  return name.trim().split(/\s+/).slice(0, 2).map((n) => n[0]?.toUpperCase()).join("");
}

export function formatDate(d?: string | Date | null) {
  if (!d) return "—";
  return new Date(d).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function relativeDate(d?: string | Date | null) {
  if (!d) return "—";
  const diff = Date.now() - new Date(d).getTime();
  const days = Math.floor(diff / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  return formatDate(d);
}

/**
 * A YYYY-MM-DD key in the *local* calendar, not UTC.
 *
 * `toISOString().slice(0,10)` buckets by UTC day. On Vercel the server runs in
 * UTC, so for anyone east of Greenwich an application filed after midnight
 * local time landed on the previous day's square — in IST (UTC+5:30) that is
 * every application submitted between midnight and 05:30.
 */
export function localDateKey(input: string | Date) {
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Groups applications into a 12-week day-by-day activity map, in local time. */
export function buildActivity(dates: (string | Date)[], days = 84) {
  const map = new Map<string, number>();
  dates.forEach((d) => {
    const key = localDateKey(d);
    if (!key) return; // an unparseable date shouldn't create a phantom bucket
    map.set(key, (map.get(key) ?? 0) + 1);
  });
  const out: { date: string; count: number }[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    out.push({ date: localDateKey(d), count: map.get(localDateKey(d)) ?? 0 });
  }
  return out;
}
