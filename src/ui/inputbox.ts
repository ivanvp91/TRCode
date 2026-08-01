/** Composition of the two status rows drawn under the input frame. */
import { c, width } from "./ansi.js";
import { contentWidth } from "./layout.js";
import { fmtTokens } from "../usage.js";
import type { EditorStatus } from "./editor.js";

export interface StatusInfo {
  /** "yolo" when permissions are bypassed. */
  mode?: string;
  model: string;
  effort: string;
  /** This model rejected the reasoning parameter, so it is being dropped. */
  effortIgnored?: boolean;
  cwdLabel: string;
  contextUsed: number;
  contextWindow: number;
  /** Shown when the window size is a guess rather than reported. */
  contextEstimated: boolean;
  hint?: string;
}

export function composeStatus(s: StatusInfo): EditorStatus {
  const ratio = s.contextWindow ? s.contextUsed / s.contextWindow : 0;
  const pct = Math.round(ratio * 100);
  const pctText = ratio > 0.8 ? c.red(`${pct}%`) : ratio > 0.6 ? c.yellow(`${pct}%`) : c.brightGreen(`${pct}%`);
  const context =
    c.gray("context: ") +
    pctText +
    c.gray(` (${fmtTokens(s.contextUsed)}/${fmtTokens(s.contextWindow)}${s.contextEstimated ? "?" : ""})`);

  const head = [
    s.mode ? c.brightYellow(s.mode) : "",
    c.brightCyan(s.model),
    c.gray("thinking: ") +
      (s.effort === "off"
        ? c.dim("off")
        : s.effortIgnored
          ? c.dim(s.effort + " (unsupported)")
          : c.brightMagenta(s.effort)),
  ]
    .filter(Boolean)
    .join("  ");

  const hint = c.dim(s.hint ?? "/ for commands · Ctrl+Enter for newline · Esc to interrupt");

  // The path is the only elastic part: shrink it from the left, then drop it.
  const w = contentWidth();
  const room = w - width(head) - width(hint) - 4;
  let cwdText = s.cwdLabel;
  if (room < 10) cwdText = "";
  else if (cwdText.length > room) cwdText = "…" + cwdText.slice(-(room - 1));

  return {
    left: cwdText ? head + "  " + c.dim(cwdText) : head,
    hint,
    context,
  };
}
