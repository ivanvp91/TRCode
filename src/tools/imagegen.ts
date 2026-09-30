/**
 * Image generation, on whichever provider hosts the model /image chose.
 *
 * Unlike video there is no mode: /image picks the model once, and from then
 * on generate_image is simply one of the chat's tools — the session's own
 * model decides when a picture is wanted and writes the prompt. With no image
 * model chosen the tool is not offered at all, so a coding session pays
 * nothing for it.
 *
 * OpenRouter has its own POST /images and a listing of what each model takes;
 * TokenRouter, xAI and Z.AI speak OpenAI's /images/generations. Either way
 * the call is synchronous (seconds) and images come back as base64 or links.
 */
import fsp from "node:fs/promises";
import path from "node:path";
import type { ToolDef, ToolResult } from "../types.js";
import { fetchListing, imageDataUrl, mediaAuth, requestJson, resolvePath, stamp } from "./media.js";
import { mediaAvailable, mediaModelId, parseMediaId, providerServes } from "./mediamodels.js";

const GENERATE_TIMEOUT_MS = 5 * 60_000;

type Param = { type: "enum"; values: (string | number)[] } | { type: "range"; min?: number; max?: number } | { type?: string };

/** One row of OpenRouter's GET /images/models, trimmed to what is used. */
export interface ImageModelInfo {
  id: string;
  name?: string;
  description?: string;
  created?: number;
  architecture?: { input_modalities?: string[]; output_modalities?: string[] };
  supported_parameters?: Record<string, Param>;
}

interface ImagesResponse {
  data?: { b64_json?: string; url?: string; media_type?: string; revised_prompt?: string }[];
  usage?: { cost?: number };
}

/** Parameters the tool forwards when the model takes them. */
const FORWARDED = ["aspect_ratio", "resolution", "size", "quality", "output_format", "background", "n", "seed"] as const;

/** What each OpenAI-shaped host is known to accept; the rest is left out with a note. */
const ACCEPTS: Record<string, readonly string[]> = {
  tokenrouter: FORWARDED,
  xai: ["aspect_ratio", "resolution", "n"],
  zai: ["size", "quality"],
};

/** The chosen image model with its provider ("openrouter:…"); empty when none. */
export function imageModelId(): string {
  return mediaModelId("image");
}

/** The tool is offered only with a chosen model on a connected host. */
export function imageGenAvailable(): boolean {
  return mediaAvailable("image");
}

/** Filled whenever the listing is read, so a tool build can describe the model. */
const capsCache = new Map<string, ImageModelInfo>();

export async function fetchImageModels(refresh = false): Promise<ImageModelInfo[]> {
  const rows = await fetchListing<ImageModelInfo>("/images/models", refresh);
  for (const r of rows) capsCache.set(r.id, r);
  return rows;
}

/** "1:1 16:9 · 1K/2K · n≤4 · edits" — what the picker shows beside a model. */
export function imageCapsLine(m: ImageModelInfo): string {
  const p = m.supported_parameters ?? {};
  const bits: string[] = [];
  const en = (k: string) => {
    const v = p[k];
    return v && v.type === "enum" && "values" in v ? v.values.filter((x) => x !== "auto").join(k === "aspect_ratio" ? " " : "/") : "";
  };
  if (en("aspect_ratio")) bits.push(en("aspect_ratio"));
  if (en("resolution")) bits.push(en("resolution"));
  const n = p.n;
  if (n && n.type === "range" && "max" in n && n.max && n.max > 1) bits.push(`n≤${n.max}`);
  if (m.architecture?.input_modalities?.includes("image")) bits.push("edits");
  if (en("output_format").includes("svg")) bits.push("svg");
  return bits.join(" · ");
}

/** Supported values as one line for the model to choose from. */
function specLine(m: ImageModelInfo): string {
  return Object.entries(m.supported_parameters ?? {})
    .map(([k, v]) => {
      if (v.type === "enum" && "values" in v) return `${k}: ${v.values.join(", ")}`;
      if (v.type === "range" && ("min" in v || "max" in v)) return `${k}: ${v.min ?? ""}–${v.max ?? ""}`;
      return k;
    })
    .join("; ");
}

/**
 * Checks the arguments against what the model takes. Unknown parameters are
 * dropped with a note rather than refused — the picture is what was asked
 * for, the knob is incidental — but a value outside a stated list is an error
 * the model can fix in one retry.
 */
function fitParams(
  args: Record<string, any>,
  caps: ImageModelInfo | undefined,
  accepts?: readonly string[],
): { body: Record<string, unknown>; dropped: string[] } | { error: string } {
  const body: Record<string, unknown> = {};
  const dropped: string[] = [];
  const params = caps?.supported_parameters;
  for (const key of FORWARDED) {
    const raw = args[key];
    if (raw === undefined || raw === null || raw === "") continue;
    const numeric = key === "n" || key === "seed";
    const value = numeric ? Number(raw) : String(raw);
    if (numeric && !Number.isFinite(value as number)) return { error: `${key} must be a number` };
    if (accepts && !accepts.includes(key)) {
      dropped.push(key);
      continue;
    }
    if (!params) {
      body[key] = value;
      continue;
    }
    const spec = params[key];
    if (!spec) {
      dropped.push(key);
      continue;
    }
    if (spec.type === "enum" && "values" in spec && !spec.values.map(String).includes(String(value))) {
      return { error: `${key}=${value} is not supported by ${caps!.id}; use one of: ${spec.values.join(", ")}` };
    }
    if (spec.type === "range" && typeof value === "number") {
      if (("min" in spec && spec.min !== undefined && value < spec.min) || ("max" in spec && spec.max !== undefined && value > spec.max)) {
        return { error: `${key}=${value} is out of range for ${caps!.id} (${spec.min ?? ""}–${spec.max ?? ""})` };
      }
    }
    body[key] = value;
  }
  return { body, dropped };
}

const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/svg+xml": "svg", "image/gif": "gif" };

/** Where image i of `count` goes: `out` as given for one, numbered for several. */
function targetPath(out: string | undefined, i: number, count: number, ext: string, cwd: string): string {
  if (!out) return resolvePath(`image-${stamp()}${count > 1 ? `-${i + 1}` : ""}.${ext}`, cwd);
  const abs = resolvePath(out, cwd);
  if (/[\\/]$/.test(out)) return path.join(abs, `image-${stamp()}${count > 1 ? `-${i + 1}` : ""}.${ext}`);
  const has = path.extname(abs);
  const base = has ? abs.slice(0, -has.length) : abs;
  return `${base}${count > 1 ? `-${i + 1}` : ""}.${has ? has.slice(1) : ext}`;
}

/** The first bytes say what a file is better than a missing content type. */
function sniffImage(buf: Buffer): string | undefined {
  if (buf.length >= 4 && buf.readUInt32BE(0) === 0x89504e47) return "image/png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (buf.length >= 3 && buf.toString("ascii", 0, 3) === "GIF") return "image/gif";
  if (/^\s*(<\?xml|<svg)/.test(buf.toString("utf8", 0, 64))) return "image/svg+xml";
  return undefined;
}

/**
 * Built per registry rebuild: the description names the model /image chose
 * and, once OpenRouter's listing has been read, the values it accepts.
 */
export function makeGenerateImageTool(): ToolDef {
  const current = imageModelId();
  const { providerId, model: wire } = parseMediaId(current);
  const caps = providerId === "openrouter" ? capsCache.get(wire) : undefined;
  const edits = caps ? caps.architecture?.input_modalities?.includes("image") : providerId !== "zai";
  const known = ACCEPTS[providerId];
  const tool: ToolDef = {
    name: "generate_image",
    risk: "network",
    description:
      `Draws an image with ${wire} (on ${providerId}) and saves it to disk. ` +
      "Use it when the user asks for a picture, illustration, logo, icon, mockup or edit of an image. Paid: one call per request unless asked for variants. " +
      "Write the prompt yourself in English: subject, composition, style or medium, colours, lighting, mood; put any text that must appear in the image in quotes. " +
      (caps
        ? `Supported by ${wire}: ${specLine(caps) || "no options"}. `
        : known
          ? `This host takes: ${known.join(", ")}; anything else is dropped. `
          : "Pass only options the user cared about; unsupported ones are dropped. ") +
      (edits ? "references: images to edit or draw from (local paths or https URLs). " : "This model takes no reference images. ") +
      "To look at the result, call read_image on the saved path.",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "What to draw, as a concrete visual description" },
        aspect_ratio: { type: "string", description: "e.g. 1:1, 16:9, 9:16, 4:3" },
        resolution: { type: "string", description: "e.g. 1K, 2K, 4K" },
        size: { type: "string", description: "Explicit WIDTHxHEIGHT, when the model takes it" },
        quality: { type: "string", description: "e.g. auto, low, medium, high (Z.AI: hd, standard)" },
        output_format: { type: "string", description: "png, jpeg, webp or svg" },
        background: { type: "string", description: "auto, transparent or opaque" },
        n: { type: "integer", description: "How many variants (default 1)" },
        seed: { type: "integer", description: "Seed for reproducibility" },
        references: {
          type: "array",
          items: { type: "string" },
          description: "Reference or source images: local paths or https URLs",
        },
        out: { type: "string", description: "File path, or a directory ending in /, for the result (default ./image-<time>.png)" },
      },
      required: ["prompt"],
    },
    summarize: (a) => {
      const bits = [wire, a.aspect_ratio, a.resolution ?? a.size, a.n > 1 ? `×${a.n}` : "", a.references?.length ? `${a.references.length} ref` : ""].filter(Boolean);
      return `${bits.join(" · ")} — ${String(a.prompt ?? "").slice(0, 60)}`;
    },
    async run(args, ctx): Promise<ToolResult> {
      const prompt = String(args.prompt ?? "").trim();
      if (!prompt) return { output: "prompt is required.", isError: true };
      if (!current) return { output: "No image model chosen. The user picks one with /image.", isError: true };
      if (!providerServes(providerId, "image")) {
        return { output: `${providerId} is not connected with an API key. Run: trc auth login --provider ${providerId}`, isError: true };
      }

      // OpenRouter's listing is public and cached; without it the arguments go as given.
      const info =
        providerId === "openrouter"
          ? await fetchImageModels().then((rows) => rows.find((r) => r.id === wire)).catch(() => undefined)
          : undefined;
      const fitted = fitParams(args, info, info ? undefined : known);
      if ("error" in fitted) return { output: fitted.error, isError: true };
      const body: Record<string, unknown> = { model: wire, prompt, ...fitted.body };

      const refs = Array.isArray(args.references) ? args.references.map(String).filter(Boolean) : args.references ? [String(args.references)] : [];
      let route = providerId === "openrouter" ? "/images" : "/images/generations";
      if (refs.length) {
        if ((info && !info.architecture?.input_modalities?.includes("image")) || providerId === "zai") {
          return { output: `${wire} does not take reference images; describe them in the prompt instead.`, isError: true };
        }
        const urls: string[] = [];
        for (const r of refs) {
          const url = await imageDataUrl(r, ctx.cwd);
          if ("error" in url) return { output: `reference ${r}: ${url.error}`, isError: true };
          urls.push(url.url);
        }
        if (providerId === "xai") {
          // xAI edits on their own route, one source image or several.
          route = "/images/edits";
          if (urls.length === 1) body.image = { url: urls[0], type: "image_url" };
          else body.images = urls.map((url) => ({ url, type: "image_url" }));
        } else if (providerId === "openrouter") {
          body.input_references = urls.map((url) => ({ type: "image_url", image_url: { url } }));
        } else {
          body.image = urls.length === 1 ? urls[0] : urls;
        }
      }

      const preview = `${tool.summarize!(args)}\n(paid ${providerId} image generation)`;
      if (!(await ctx.confirm(tool, args, preview))) return { output: "User rejected the image generation.", isError: true };

      let auth;
      try {
        auth = await mediaAuth(providerId);
      } catch (err) {
        return { output: (err as Error).message, isError: true };
      }

      const started = Date.now();
      let res: ImagesResponse;
      try {
        res = await requestJson<ImagesResponse>(
          `${auth.baseUrl}${route}`,
          { method: "POST", headers: { ...auth.headers, "Content-Type": "application/json" }, body: JSON.stringify(body) },
          ctx.signal,
          GENERATE_TIMEOUT_MS,
        );
      } catch (err) {
        if (ctx.signal.aborted) return { output: "Interrupted.", isError: true };
        return { output: `Image generation failed: ${(err as Error).message}`, isError: true };
      }

      const items = (res.data ?? []).filter((d) => d.b64_json || d.url);
      if (!items.length) return { output: `No image in the response: ${JSON.stringify(res).slice(0, 300)}`, isError: true };

      const saved: string[] = [];
      for (let i = 0; i < items.length; i++) {
        const d = items[i];
        let buf: Buffer;
        let mime = d.media_type;
        try {
          if (d.b64_json) buf = Buffer.from(d.b64_json.replace(/^data:[^,]+,/, ""), "base64");
          else {
            // Result links are pre-signed CDN URLs: they never get the key.
            const r = await fetch(d.url!, { signal: ctx.signal });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            mime ??= r.headers.get("content-type")?.split(";")[0];
            buf = Buffer.from(await r.arrayBuffer());
          }
        } catch (err) {
          return { output: `Image ${i + 1} could not be read: ${(err as Error).message}`, isError: true };
        }
        const type = sniffImage(buf) ?? mime ?? "image/png";
        const file = targetPath(args.out ? String(args.out) : undefined, i, items.length, EXT[type] ?? "png", ctx.cwd);
        await fsp.mkdir(path.dirname(file), { recursive: true });
        await fsp.writeFile(file, buf);
        saved.push(file);
      }

      const cost = typeof res.usage?.cost === "number" ? ` · $${res.usage.cost.toFixed(3)}` : "";
      const secs = ((Date.now() - started) / 1000).toFixed(0);
      const note = fitted.dropped.length ? ` Ignored (not supported by ${wire}): ${fitted.dropped.join(", ")}.` : "";
      const revised = items.find((d) => d.revised_prompt)?.revised_prompt;
      return {
        output: `Saved ${saved.join(", ")} (${wire} on ${providerId}, ${secs}s${cost}).${note}` + (revised ? `\nRevised prompt: ${revised}` : ""),
        display: `${saved.map((f) => path.basename(f)).join(", ")}${cost}`,
      };
    },
  };
  return tool;
}
