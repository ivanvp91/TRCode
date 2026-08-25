/** Composition of the two status rows drawn under the input frame. */
import { c, clipAnsi, width } from "./ansi.js";
import { contentWidth } from "./layout.js";
import { fmtTokens } from "../usage.js";
import { wireModelId } from "../provider/registry.js";
import { t } from "../i18n.js";
import type { EditorStatus } from "./editor.js";

export interface StatusInfo {
  /** "yolo" when permissions are bypassed. */
  mode?: string;
  /**
   * Provider label. Shown next to the model because which subscription pays
   * for a turn is not something to have to infer from an id prefix.
   */
  provider?: string;
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
    c.gray(t("context: ", "контекст: ")) +
    pctText +
    c.gray(` (${fmtTokens(s.contextUsed)}/${fmtTokens(s.contextWindow)}${s.contextEstimated ? "?" : ""})`);

  // With the provider named, the id's routing prefix is noise — "Kimi  k3",
  // not "Kimi  kimi:k3". Only a known prefix is stripped, so a vendor id that
  // happens to contain a colon survives intact.
  const bareModel = wireModelId(s.model);

  const head = [
    s.mode ? c.brightYellow(s.mode) : "",
    s.provider ? c.brightBlue(s.provider) : "",
    c.brightCyan(bareModel),
    c.gray(t("thinking: ", "мышление: ")) +
      (s.effort === "off"
        ? c.dim("off")
        : s.effortIgnored
          ? c.dim(s.effort + t(" (unsupported)", " (не поддерживается)"))
          : c.brightMagenta(s.effort)),
  ]
    .filter(Boolean)
    .join("  ");

  // Esc has nothing to interrupt while the input is idle; the mode toggle is
  // the thing worth advertising here, since it has no other signpost.
  const w = contentWidth();
  let hint = c.dim(s.hint ?? t("/ for commands · Shift+Tab for auto-approve · Ctrl+Enter for newline", "/ — команды · Shift+Tab — без подтверждений · Ctrl+Enter — перенос строки"));

  // A long model id plus the full hint can be wider than the row they share —
  // and a status row that does not fit wraps, which costs the frame above it
  // its row arithmetic. The hint gives way first: the model and the mode are
  // state, the hint is only a reminder of keys that keep working unmentioned.
  // A hint the caller passed is theirs, and is left alone.
  const fits = (h: string) => width(head) + width(h) + 2 <= w;
  if (s.hint === undefined) {
    if (!fits(hint)) hint = c.dim(t("/ for commands · Shift+Tab for auto-approve", "/ — команды · Shift+Tab — без подтверждений"));
    if (!fits(hint)) hint = c.dim(t("/ for commands", "/ — команды"));
    // Even the short form does not fit: the model id is that long. The hint
    // goes rather than the name of the model the turn will be billed to.
    if (!fits(hint)) hint = "";
  } else if (!fits(hint)) {
    // A hint the caller wrote is usually load-bearing — "esc to interrupt" is
    // the only place that key is advertised — so its tail is cut instead.
    hint = clipAnsi(hint, Math.max(0, w - width(head) - 2));
  }

  // The path is the only elastic part: shrink it from the left, then drop it.
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
