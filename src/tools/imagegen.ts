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
import path from "node:path";
import fsp from "node:fs/promises";
import { inspectGeneratedImage } from "./mediaquality.js";
import type { ToolDef, ToolResult } from "../types.js";
import { fetchListing, imageDataUrl, mediaAuth, requestJson, readBounded, withTimeout, openRouterBase, GENERATE_TIMEOUT_MS } from "./media.js";
import { prepareMedia, updateMedia, mediaOutputPath, saveMedia, checkMediaOutput, finishMedia } from "./mediaworkspace.js";
import { imageDimensions, sniffImage, IMAGE_EXT } from "./image.js";
import { mediaAvailable, mediaModelId, parseMediaId, providerServes } from "./mediamodels.js";


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
  for (const r of rows) capsCache.set(`${openRouterBase()}:${r.id}`, r);
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
 * rejected before a paid submission. Required quality/format choices must
 * not disappear silently; a value outside a stated list names valid values.
 */
function fitParams(
  args: Record<string, any>,
  caps: ImageModelInfo | undefined,
  accepts?: readonly string[],
): { body: Record<string, unknown> } | { error: string } {
  const body: Record<string, unknown> = {};
  const params = caps?.supported_parameters;
  for (const key of FORWARDED) {
    const raw = args[key];
    if (raw === undefined || raw === null || raw === "") continue;
    const numeric = key === "n" || key === "seed";
    const value = numeric ? Number(raw) : String(raw);
    if (numeric && (!Number.isSafeInteger(value) || (key === "n" && ((value as number) < 1 || (value as number) > 16)))) return { error: `${key} must be an integer${key === "n" ? " between 1 and 16" : ""}` };
    if (accepts && !accepts.includes(key)) {
      return { error: `${key} is not supported by this provider. Remove it or select a model that supports it before generating.` };
    }
    if (!params) {
      body[key] = value;
      continue;
    }
    const spec = params[key];
    if (!spec) {
      return { error: `${key} is not supported by ${caps!.id}. Remove it or choose another model before generating.` };
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
  return { body };
}

/**
 * Built per registry rebuild: the description names the model /image chose
 * and, once OpenRouter's listing has been read, the values it accepts.
 */
export function makeGenerateImageTool(): ToolDef {
  const current = imageModelId();
  const { providerId, model: wire } = parseMediaId(current);
  const caps = providerId === "openrouter" ? capsCache.get(`${openRouterBase()}:${wire}`) : undefined;
  const edits = caps ? caps.architecture?.input_modalities?.includes("image") : providerId !== "zai";
  const known = ACCEPTS[providerId];
  const tool: ToolDef = {
    name: "generate_image",
    risk: "network",
    paidMedia: true,
    description:
      `Draws an image with ${wire} (on ${providerId}) and saves it to disk. ` +
      "Use it when the user asks for a picture, illustration, logo, icon, mockup or edit of an image. Paid: one call per request unless asked for variants. " +
      "Write the prompt yourself in English: subject, composition, style or medium, colours, lighting, mood; put any text that must appear in the image in quotes. " +
      (caps
        ? `Supported by ${wire}: ${specLine(caps) || "no options"}. `
        : known
          ? `This host takes: ${known.join(", ")}; unsupported options are rejected before payment. `
          : "Pass only supported options; unsupported ones are rejected before payment. ") +
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
        out: { type: "string", description: "Optional export path. Default: image-<timestamp>.<actual-format> in the current directory" },
        workspace: { type: "string", description: "Workspace returned by prepare_media_workspace; scene output stays inside it" },
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
      const conflict = checkMediaOutput(args.out, ctx.cwd, Number(args.n) || 1);
      if (conflict) return { output: conflict, isError: true };
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
      const inputSources: string[] = [];
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
          inputSources.push(url.url);
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
      ctx.signal.throwIfAborted();
      const work = await prepareMedia(ctx, "image", current, args, inputSources);
      ctx.emit(`media workspace ${work.dir}`);

      let auth;
      try {
        auth = await mediaAuth(providerId);
      } catch (err) {
        return { output: (err as Error).message, isError: true };
      }

      const started = Date.now();
      await updateMedia(work, { status: "submitting" });
      ctx.billMedia?.(current, undefined, work.manifest.id);
      let res: ImagesResponse;
      try {
        res = await requestJson<ImagesResponse>(
          `${auth.baseUrl}${route}`,
          { method: "POST", headers: { ...auth.headers, "Content-Type": "application/json" }, body: JSON.stringify(body) },
          ctx.signal,
          GENERATE_TIMEOUT_MS,
          140_000_000,
        );
      } catch (err) {
        await updateMedia(work, { status: "submission_unknown", error: (err as Error).message });
        if (ctx.signal.aborted) return { output: "Interrupted.", isError: true };
        return { output: `Image generation failed: ${(err as Error).message}`, isError: true };
      }
      ctx.billMedia?.(current, res.usage?.cost, work.manifest.id);
      await updateMedia(work, { status: "generated", cost: res.usage?.cost });
      // Keep the paid response for recovery, even if decoding/export fails.
      await fsp.writeFile(path.join(work.tmp, "generated-response.json"), JSON.stringify(res), { flag: "wx", mode: 0o600 });

      const items = (Array.isArray(res.data) ? res.data : []).filter((d) => d.b64_json || d.url);
      if (!items.length) return { output: `No image in the response: ${JSON.stringify(res).slice(0, 300)}`, isError: true };

      const saved: string[] = [];
      const qa: Record<string, unknown>[] = [];
      for (let i = 0; i < items.length; i++) {
        const d = items[i];
        let buf: Buffer;
        let mime = d.media_type;
        try {
          if (d.b64_json) buf = Buffer.from(d.b64_json.replace(/^data:[^,]+,/, ""), "base64");
          else {
            // Result links are pre-signed CDN URLs: they never get the key.
            const r = await fetch(d.url!, { signal: withTimeout(ctx.signal, GENERATE_TIMEOUT_MS) });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            mime ??= r.headers.get("content-type")?.split(";")[0];
            buf = await readBounded(r);
          }
        } catch (err) {
          await updateMedia(work, { status: "download_failed", saved, error: (err as Error).message });
          return { output: `Image ${i + 1} could not be read: ${(err as Error).message}. Workspace: ${work.dir}. Already saved: ${saved.join(", ") || "none"}`, isError: true };
        }
        const type = sniffImage(buf);
        if (!type || (type !== "image/svg+xml" && !imageDimensions(buf))) {
          await updateMedia(work, { status: "invalid_result", saved });
          return { output: `Invalid image ${i + 1} from provider. Workspace: ${work.dir}`, isError: true };
        }
        try {
          qa.push(await inspectGeneratedImage(buf, args));
        } catch (err) {
          await updateMedia(work, { status: "invalid_result", saved, error: (err as Error).message });
          return { output: `Image ${i + 1} failed decoding: ${(err as Error).message}. Paid response retained in ${work.tmp}`, isError: true };
        }
        const file = mediaOutputPath(work, args.out, IMAGE_EXT[type], ctx.cwd, i, items.length);
        try { await saveMedia(file, buf, work, ctx.signal); }
        catch (err) {
          await updateMedia(work, { status: "save_failed", saved, error: (err as Error).message });
          return { output: `Image save failed: ${(err as Error).message}. Workspace: ${work.dir}. Already saved: ${saved.join(", ") || "none"}`, isError: true };
        }
        saved.push(file);
      }
      const warnings = qa.flatMap((row) => row.warnings as string[]);
      await updateMedia(work, { status: warnings.length ? "quality_mismatch" : "completed", saved, qa });
      const where = (await finishMedia(work)) ? "" : `\nWorkspace: ${work.dir}`;

      const cost = typeof res.usage?.cost === "number" ? ` · $${res.usage.cost.toFixed(3)}` : "";
      const secs = ((Date.now() - started) / 1000).toFixed(0);
      const revised = items.find((d) => d.revised_prompt)?.revised_prompt;
      return {
        output: `Saved ${saved.join(", ")} (${wire} on ${providerId}, ${secs}s${cost}).${where}` + (revised ? `\nRevised prompt: ${revised}` : "") + (warnings.length ? `\nResult does not meet the requested constraints: ${warnings.join("; ")}. Do not regenerate without approval.` : ""),
        isError: warnings.length > 0,
        display: `${saved.map((f) => path.basename(f)).join(", ")}${cost}`,
      };
    },
  };
  return tool;
}
