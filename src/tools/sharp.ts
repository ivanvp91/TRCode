/**
 * sharp, loaded on first use.
 *
 * A static import made the whole client depend on it at boot: an install that
 * lacks the package — a self-update swaps dist but never node_modules — died
 * with ERR_MODULE_NOT_FOUND before printing a word, and with it went /update,
 * the one way back. Loaded here, a missing sharp costs the image tools alone.
 */
import type Sharp from "sharp";

let loaded: Promise<typeof Sharp> | undefined;

export function loadSharp(): Promise<typeof Sharp> {
  loaded ??= import("sharp").then(
    (m) => m.default,
    (err) => {
      loaded = undefined; // installed later in this process — try again next time
      throw new Error(
        `Image support needs the "sharp" package, which this install lacks (${(err as Error).message.split("\n")[0]}). ` +
          "Run /update, or npm install in the TRCode folder.",
      );
    },
  );
  return loaded;
}
