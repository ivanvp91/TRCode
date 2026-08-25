/**
 * The UI library: saved design mockups, ready to be pulled into a request as a
 * design reference.
 *
 * An entry is a folder under `~/.trcode/ui-library/<slug>/`:
 *   entry.json  — name, category, keywords, source, when it was added
 *   design.md   — the design brief the model reads: palette, type, spacing,
 *                 motion, components. Written by the agent during capture.
 *
 * Storage mirrors skills (loader.ts) on purpose: same config-dir habit, one
 * JSON sidecar instead of frontmatter, because the fields are read by code —
 * matching runs on keywords — and not only by the model.
 */
import fs from "node:fs";
import path from "node:path";
import { configDir } from "../config.js";

export interface UiEntry {
  /** Short unique slug, also the folder name: "saas-dark". */
  slug: string;
  /** Human label shown in listings: "SaaS · dark". */
  title: string;
  /** One line about the style, shown in the picker. */
  summary: string;
  /**
   * Words a "нарисуй дизайн …" request is matched on — what the user would
   * actually type: saas, dashboard, terminal, landing, dark…
   */
  keywords: string[];
  /** Where the mockup came from, if it was captured from a site. */
  source?: string;
  addedAt: number;
}

/** Reads entry.json tolerantly: a corrupt file skips, it does not crash. */
function readEntry(dir: string): UiEntry | null {
  try {
    // A BOM in front of the brace is legal for a text file and fatal for
    // JSON.parse; strip it instead of dropping the whole entry.
    const raw = JSON.parse(fs.readFileSync(path.join(dir, "entry.json"), "utf8").replace(/^\uFEFF/, "")) as Partial<UiEntry>;
    if (!raw.slug || !raw.title) return null;
    return {
      slug: String(raw.slug),
      title: String(raw.title),
      summary: String(raw.summary ?? ""),
      keywords: Array.isArray(raw.keywords) ? raw.keywords.map(String).map((k) => k.toLowerCase()).filter(Boolean) : [],
      source: raw.source ? String(raw.source) : undefined,
      addedAt: Number(raw.addedAt ?? 0),
    };
  } catch {
    return null;
  }
}

export function uiLibraryDir(): string {
  return path.join(configDir(), "ui-library");
}

export function entryDir(slug: string): string {
  return path.join(uiLibraryDir(), slug);
}

/** Every saved mockup, oldest first; a broken entry costs nothing but itself. */
export function listEntries(): UiEntry[] {
  let names: string[];
  try {
    names = fs.readdirSync(uiLibraryDir());
  } catch {
    return [];
  }
  const out: UiEntry[] = [];
  for (const n of names.sort()) {
    const e = readEntry(path.join(uiLibraryDir(), n));
    if (e && e.slug === n) out.push(e);
  }
  return out;
}

export function getEntry(slug: string): { entry: UiEntry; brief: string } | null {
  const dir = entryDir(slug);
  const entry = readEntry(dir);
  if (!entry) return null;
  try {
    return { entry, brief: fs.readFileSync(path.join(dir, "design.md"), "utf8") };
  } catch {
    return null;
  }
}

export function slugify(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9а-я_-]+/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return slug || `entry-${Date.now()}`;
}

/**
 * Writes an entry, refusing to overwrite silently — the caller decides whether
 * an existing folder means an error or a rename prompt.
 */
export function saveEntry(entry: UiEntry, brief: string): string {
  const dir = entryDir(entry.slug);
  if (fs.existsSync(path.join(dir, "entry.json"))) throw new Error(`already exists: ${entry.slug}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "entry.json"), JSON.stringify(entry, null, 2) + "\n");
  fs.writeFileSync(path.join(dir, "design.md"), brief.trimEnd() + "\n");
  return dir;
}

export function deleteEntry(slug: string): boolean {
  const dir = entryDir(slug);
  if (!fs.existsSync(path.join(dir, "entry.json"))) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}
