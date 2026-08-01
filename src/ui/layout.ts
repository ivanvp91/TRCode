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

export const indent = " ".repeat(PAD_LEFT);

/** Prefixes a line with the left margin. */
export function pad(s = ""): string {
  return indent + s;
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
