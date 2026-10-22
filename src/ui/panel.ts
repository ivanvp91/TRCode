/**
 * A panel over the conversation: the command list, drawn as a thing floating
 * above the text rather than as a few more lines of it.
 *
 * One builder for both places the list appears — the idle composer and the
 * turn bar — because a menu that changes its look with the session state is a
 * menu the eye has to re-learn mid-turn.
 */
import { c, clipAnsi, hasColor, width } from "./ansi.js";
import { fullWidth, PAD_LEFT } from "./layout.js";

/** The panel's own background, in the same shade as c.bgModal. */
const BG = "\x1b[48;2;42;45;52m";

/**
 * Wraps rows in a grey border with a faint background.
 *
 * The rows come in with the composer's indent (they are built for it); it is
 * stripped here so the panel decides its own left edge, and the panel covers
 * exactly the input band's columns: from column 1 to one short of the terminal
 * edge. Indented by the margin, it stood three cells in from the band under it
 * and read as a separate box rather than as the band's own list.
 */
export function panelRows(lines: string[], indent = " ".repeat(PAD_LEFT)): string[] {
  if (!lines.length) return [];
  const flat = lines.map((l) => (l.startsWith(indent) ? l.slice(indent.length) : l.trimStart()));
  // The band is fullWidth() - 1 wide and the two borders take a cell each.
  // Sized to its longest row, the panel jumped narrower and wider with every
  // keystroke of the filter. The rows keep their own two-space lead, which
  // puts the arrow under the band's "›" and the names under the typed text.
  const wide = Math.max(20, fullWidth() - 3);
  // A row's own colour codes end with a reset, and a reset clears the panel's
  // background too: the fill after it would be transparent and the panel would
  // stop short of its border. The background is re-asserted after every reset.
  const painted = (l: string): string => {
    const clipped = clipAnsi(l, wide);
    const pad = " ".repeat(Math.max(0, wide - width(clipped)));
    if (!hasColor) return clipped + pad;
    return BG + clipped.replace(/\x1b\[0m/g, "\x1b[0m" + BG) + pad + "\x1b[49m";
  };
  // The border is a step lighter than the band's grey: at the band's own shade
  // it disappeared against a dark terminal, and a panel you cannot see is not
  // a panel.
  const side = c.gray("│");
  const rows: string[] = [];
  rows.push(c.gray("╭" + "─".repeat(wide) + "╮"));
  for (const l of flat) rows.push(side + painted(l) + side);
  rows.push(c.gray("╰" + "─".repeat(wide) + "╯"));
  return rows;
}
