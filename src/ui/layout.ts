/** Chat area geometry. One place to change margins and wrap width. */
import { termWidth } from "./ansi.js";

/** ~30px at a typical terminal cell width. */
export const PAD_LEFT = 3;
/** ~80px — a wider right gutter keeps long lines off the edge. */
const PAD_RIGHT_WIDE = 9;

export function fullWidth(): number {
  return termWidth();
}

/**
 * The right gutter is a nicety; on a narrow terminal the content matters more,
 * so it collapses rather than squeezing lines into an unreadable column.
 */
export function padRight(): number {
  return fullWidth() >= 90 ? PAD_RIGHT_WIDE : 2;
}

/** Width available to chat content between the margins. */
export function contentWidth(): number {
  return Math.max(30, fullWidth() - PAD_LEFT - padRight());
}

/**
 * The status rows under the composer reach the band's right edge, not the chat
 * gutter: they are about the line you are typing on, and a row that stops eight
 * cells short of the band above it reads as a stray paragraph instead of chrome.
 */
export function statusWidth(): number {
  return Math.max(30, fullWidth() - PAD_LEFT - 3);
}

/**
 * The cells of a composer row the text itself gets: the row is "› " after the
 * left margin, inside a band one column short of the terminal edge, and two
 * more cells stay clear on the right. A last glyph butting against the band's
 * edge reads as clipped rather than filled.
 */
export function bandTextWidth(): number {
  return Math.max(10, fullWidth() - PAD_LEFT - 5);
}

export const indent = " ".repeat(PAD_LEFT);

/** Prefixes a line with the left margin. */
export function pad(s = ""): string {
  return indent + s;
}

/** "just now", "12m ago", "5h ago", "3d ago", then a plain date. */
export function fmtAgo(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(ts).toLocaleDateString();
}

/** "6m 33s", "42s", "1h 04m". */
export function fmtDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m < 60) return `${m}m ${String(s).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, "0")}m`;
}
