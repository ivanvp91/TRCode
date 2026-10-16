/**
 * Video generation, on whichever provider hosts the chosen model.
 *
 * Video models (Seedance, Veo, Kling…) are not chat models: they never answer
 * /chat/completions. The chat model writes the prompt and calls this tool,
 * which submits a job, polls until it settles and downloads the clip next to
 * the project. Every host has its own shape for that, so each gets a small
 * adapter; the loop around them — confirm, wait, honour Esc, save — is one.
 *
 * Every call costs real money and takes minutes, so it asks first (like a
 * shell command) and honours Esc while waiting.
 */
import path from "node:path";
import fsp from "node:fs/promises";
import type { VideoModelInfo } from "../agent/videomode.js";
import { DEFAULT_PROVIDER } from "../provider/registry.js";
import type { ToolDef, ToolResult, ToolContext } from "../types.js";
import { apiMessage, downloadTo, fetchListing, findUrl, imageDataUrl, mediaAuth, requestJson, resolvePath, sleep, stamp } from "./media.js";
import { DEFAULT_VIDEO_MODEL, mediaAvailable, mediaModelId, parseMediaId, providerServes } from "./mediamodels.js";
import { prepareMedia, updateMedia, mediaOutputPath, checkMediaOutput, finishMedia, mediaWork, type MediaWorkspace } from "./mediaworkspace.js";
import { resolveInside } from "./fsutil.js";

export { DEFAULT_VIDEO_MODEL, apiMessage };

/** Generation takes 1–5 minutes; past this the job is left running server-side. */
const MAX_WAIT_MS = 20 * 60_000;

export interface VideoToolOptions {
  /** Delay between status checks. Tests shrink it. */
  pollMs?: number;
}

/** The tool is offered when the chosen (or default) video model's host is connected. */
export function videoAvailable(): boolean {
  return mediaAvailable("video");
}

/**
 * OpenRouter's video catalogue, with what each model accepts. Public, so it
 * needs no key; read once per process and re-read on demand.
 */
export function fetchVideoModels(refresh = false): Promise<VideoModelInfo[]> {
  return fetchListing<VideoModelInfo>("/videos/models", refresh);
}

interface VideoArgs {
  model: string;
  prompt: string;
  duration?: number;
  resolution?: string;
  aspect_ratio?: string;
  generate_audio?: boolean;
  seed?: number;
  first?: string;
  last?: string;
  references?: string[];
}

type PollState = { state: "running" | "done" | "failed"; status: string; url?: string; urlNeedsKey?: boolean; error?: string; cost?: number };

interface Job {
  id: string;
  pollUrl?: string;
  poll(signal: AbortSignal): Promise<PollState>;
}

type Auth = { baseUrl: string; headers: Record<string, string> };

const json = (auth: Auth) => ({ ...auth.headers, "Content-Type": "application/json" });

/** Per-host submit and poll. Each returns a job whose poll() reads one status. */
const ADAPTERS: Record<string, (a: VideoArgs, auth: Auth, signal: AbortSignal) => Promise<Job>> = {
  async openrouter(a, auth, signal) {
    const body: Record<string, unknown> = { model: a.model, prompt: a.prompt };
    if (a.duration !== undefined) body.duration = a.duration;
    if (a.resolution) body.resolution = a.resolution;
    if (a.aspect_ratio) body.aspect_ratio = a.aspect_ratio;
    if (a.generate_audio !== undefined) body.generate_audio = a.generate_audio;
    if (a.seed !== undefined) body.seed = a.seed;
    const frames = [
      a.first && { type: "image_url", image_url: { url: a.first }, frame_type: "first_frame" },
      a.last && { type: "image_url", image_url: { url: a.last }, frame_type: "last_frame" },
    ].filter(Boolean);
    if (frames.length) body.frame_images = frames;
    if (a.references?.length) body.input_references = a.references.map((url) => ({ type: "image_url", image_url: { url } }));
    const j = await requestJson<any>(`${auth.baseUrl}/videos`, { method: "POST", headers: json(auth), body: JSON.stringify(body) }, signal);
    if (!j?.id) throw new Error(`no job id: ${JSON.stringify(j).slice(0, 300)}`);
    const pollUrl = j.polling_url || `${auth.baseUrl}/videos/${j.id}`;
    return {
      id: j.id,
      pollUrl,
      async poll(sig) {
        if (new URL(pollUrl).origin !== new URL(auth.baseUrl).origin) throw new Error("Refusing polling URL outside the configured API host");
        const s = await requestJson<any>(pollUrl, { headers: auth.headers }, sig);
        const status = String(s.status ?? "");
        if (status === "completed") {
          return { state: "done", status, url: s.unsigned_urls?.[0] || `${auth.baseUrl}/videos/${j.id}/content?index=0`, urlNeedsKey: !s.unsigned_urls?.[0], cost: s.usage?.cost };
        }
        if (["failed", "cancelled", "expired"].includes(status)) return { state: "failed", status, error: errorText(s.error) };
        return { state: "running", status };
      },
    };
  },

  // new-api's unified task API: POST /video/generations, GET …/{task_id}.
  async [DEFAULT_PROVIDER](a, auth, signal) {
    const meta: Record<string, unknown> = {};
    if (a.aspect_ratio) meta.aspect_ratio = a.aspect_ratio;
    if (a.resolution) meta.resolution = a.resolution;
    if (a.generate_audio !== undefined) meta.generate_audio = a.generate_audio;
    if (a.last) meta.image_tail = a.last;
    const body: Record<string, unknown> = { model: a.model, prompt: a.prompt };
    if (a.duration !== undefined) body.duration = a.duration;
    if (a.seed !== undefined) body.seed = a.seed;
    if (a.first) body.image = a.first;
    if (Object.keys(meta).length) body.metadata = meta;
    const j = await requestJson<any>(`${auth.baseUrl}/video/generations`, { method: "POST", headers: json(auth), body: JSON.stringify(body) }, signal);
    const id = j?.task_id ?? j?.id ?? j?.data?.task_id ?? j?.data?.id;
    if (!id) throw new Error(`no task id: ${JSON.stringify(j).slice(0, 300)}`);
    return {
      id: String(id),
      async poll(sig) {
        const s = await requestJson<any>(`${auth.baseUrl}/video/generations/${id}`, { headers: auth.headers }, sig);
        const d = s?.data && typeof s.data === "object" && !Array.isArray(s.data) ? s.data : s;
        const status = String(d.status ?? s.status ?? "").toLowerCase();
        if (["success", "succeeded", "completed", "complete", "done"].includes(status)) {
          const url = findUrl(d) ?? findUrl(s);
          return url
            ? { state: "done", status, url }
            : { state: "done", status, url: `${auth.baseUrl}/videos/${id}/content`, urlNeedsKey: true };
        }
        if (["failure", "failed", "error", "cancelled", "canceled", "expired"].includes(status)) {
          return { state: "failed", status, error: errorText(d.fail_reason ?? d.error ?? s.error ?? s.message) };
        }
        return { state: "running", status: status || "queued" };
      },
    };
  },

  async xai(a, auth, signal) {
    const body: Record<string, unknown> = { model: a.model, prompt: a.prompt };
    if (a.duration !== undefined) body.duration = a.duration;
    if (a.aspect_ratio) body.aspect_ratio = a.aspect_ratio;
    if (a.resolution) body.resolution = a.resolution;
    if (a.first) body.image = { url: a.first };
    if (a.last) body.last_frame = { url: a.last };
    if (a.generate_audio !== undefined) body.generate_audio = a.generate_audio;
    if (a.references?.length) body.reference_images = a.references.map((url) => ({ url }));
    const j = await requestJson<any>(`${auth.baseUrl}/videos/generations`, { method: "POST", headers: json(auth), body: JSON.stringify(body) }, signal);
    const id = j?.request_id ?? j?.id;
    if (!id) throw new Error(`no request id: ${JSON.stringify(j).slice(0, 300)}`);
    return {
      id: String(id),
      async poll(sig) {
        const s = await requestJson<any>(`${auth.baseUrl}/videos/${id}`, { headers: auth.headers }, sig);
        const status = String(s.status ?? "").toLowerCase();
        if (status === "done" || status === "completed") return { state: "done", status, url: s.video?.url ?? findUrl(s), cost: s.usage?.cost };
        if (status === "failed" || status === "expired") return { state: "failed", status, error: errorText(s.error ?? s.message) };
        return { state: "running", status: status || "pending" };
      },
    };
  },

  async zai(a, auth, signal) {
    const body: Record<string, unknown> = { model: a.model, prompt: a.prompt };
    if (a.duration !== undefined) body.duration = a.duration;
    // Z.AI sizes are pixels; a "1920x1080" given as resolution is one of them.
    if (a.resolution && /^\d+x\d+$/.test(a.resolution)) body.size = a.resolution;
    if (a.generate_audio !== undefined) body.with_audio = a.generate_audio;
    if (a.first) body.image_url = a.first;
    const j = await requestJson<any>(`${auth.baseUrl}/videos/generations`, { method: "POST", headers: json(auth), body: JSON.stringify(body) }, signal);
    const id = j?.id ?? j?.task_id;
    if (!id) throw new Error(`no task id: ${JSON.stringify(j).slice(0, 300)}`);
    return {
      id: String(id),
      async poll(sig) {
        const s = await requestJson<any>(`${auth.baseUrl}/async-result/${id}`, { headers: auth.headers }, sig);
        const status = String(s.task_status ?? s.status ?? "").toUpperCase();
        if (status === "SUCCESS") return { state: "done", status, url: s.video_result?.[0]?.url ?? findUrl(s) };
        if (status === "FAIL" || status === "FAILED") return { state: "failed", status, error: errorText(s.error ?? s.message) };
        return { state: "running", status: status || "PROCESSING" };
      },
    };
  },
};

/**
 * Built per registry rebuild rather than once: the description names the
 * video model chosen with /video, and a model asked for one thing while told
 * about another picks the parameters of the wrong one.
 */
export function makeGenerateVideoTool(opts: VideoToolOptions = {}): ToolDef {
  const pollMs = opts.pollMs ?? 10_000;
  const current = mediaModelId("video");
  const { providerId, model: wire } = parseMediaId(current);
  const seedanceHelp =
    current === DEFAULT_VIDEO_MODEL
      ? "Seedance 2.5: duration 4–30 s, resolution 480p/720p, aspect_ratio 16:9, 4:3, 1:1, 3:4, 9:16, 21:9; audio is generated unless disabled. "
      : "";
  const tool: ToolDef = {
    name: "generate_video",
    risk: "network",
    paidMedia: true,
    description:
      `Generates a video with ${wire} (on ${providerId}) and saves it as an mp4. ` +
      "Paid and slow (minutes): call it only when the user asked for a video, once per request. " +
      "Write the prompt yourself in English: subject, action, setting, camera movement, lighting, style, mood — concrete and visual, one scene. " +
      seedanceHelp +
      "Pass only parameters the model supports; omitted ones take the provider's defaults. " +
      "first_frame/last_frame animate from/to a given image (local path or https URL).",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "What the video shows, written as a visual scene description" },
        duration: { type: "integer", description: "Length in seconds" },
        resolution: { type: "string", description: "Resolution, e.g. 480p, 720p, 1080p (Z.AI: 1920x1080)" },
        aspect_ratio: { type: "string", description: "Aspect ratio, e.g. 16:9, 9:16, 1:1" },
        generate_audio: { type: "boolean", description: "Generate a soundtrack, where the model can" },
        seed: { type: "integer", description: "Optional seed for reproducibility" },
        first_frame: { type: "string", description: "Image the video starts from: local path or https URL" },
        last_frame: { type: "string", description: "Image the video ends on: local path or https URL" },
        references: { type: "array", items: { type: "string" }, description: "Reference images for a model supporting reference-to-video" },
        out: { type: "string", description: "Optional export path. Default: video-<timestamp>.mp4 in the current directory" },
        workspace: { type: "string", description: "Workspace returned by prepare_media_workspace" },
      },
      required: ["prompt"],
    },
    summarize: (a) => {
      const bits = [wire, a.duration ? `${a.duration}s` : "", a.resolution, a.aspect_ratio].filter(Boolean);
      return `${bits.join(" · ")} — ${String(a.prompt ?? "").slice(0, 60)}`;
    },
    async run(args, ctx): Promise<ToolResult> {
      const prompt = String(args.prompt ?? "").trim();
      if (!prompt) return { output: "prompt is required.", isError: true };
      const conflict = checkMediaOutput(args.out, ctx.cwd);
      if (conflict) return { output: conflict, isError: true };
      const adapter = ADAPTERS[providerId];
      if (!adapter) return { output: `Video generation is not supported on ${providerId}.`, isError: true };
      if (!providerServes(providerId, "video")) {
        return { output: `${providerId} is not connected with an API key. Run: trc auth login --provider ${providerId}`, isError: true };
      }

      const a: VideoArgs = { model: wire, prompt };
      if (args.duration != null) {
        if (!Number.isSafeInteger(args.duration) || args.duration <= 0 || args.duration > 300) return { output: "duration must be a positive integer in seconds (maximum 300)", isError: true };
        a.duration = args.duration;
      }
      if (args.resolution) a.resolution = String(args.resolution);
      if (args.aspect_ratio) a.aspect_ratio = String(args.aspect_ratio);
      if (typeof args.generate_audio === "boolean") a.generate_audio = args.generate_audio;
      if (Number.isInteger(args.seed)) a.seed = args.seed;
      else if (args.seed != null) return { output: "seed must be an integer", isError: true };
      if (args.generate_audio != null && typeof args.generate_audio !== "boolean") return { output: "generate_audio must be boolean", isError: true };
      if (providerId === "xai" && a.seed !== undefined) return { output: "seed is not supported by xAI video; remove it before generating.", isError: true };
      if (providerId === "zai" && (args.last_frame || a.seed !== undefined || a.aspect_ratio)) return { output: "Z.AI video does not support last_frame, seed or aspect_ratio through this adapter.", isError: true };
      if (providerId === "zai" && a.resolution && !/^\d+x\d+$/.test(a.resolution)) return { output: "Z.AI resolution must be WIDTHxHEIGHT", isError: true };
      if (providerId === "xai" && args.last_frame && !/grok-imagine-video-1\.5/.test(wire)) return { output: "last_frame requires grok-imagine-video-1.5", isError: true };
      if (providerId === "openrouter") {
        const caps = await fetchVideoModels().then((rows) => rows.find((m) => m.id === wire)).catch(() => undefined);
        if (caps) {
          for (const [key, values] of [["duration", caps.supported_durations], ["resolution", caps.supported_resolutions], ["aspect_ratio", caps.supported_aspect_ratios]] as const) {
            const value = a[key];
            if (value != null && values?.length && !(values as readonly unknown[]).includes(value)) return { output: `${key}=${value} is unsupported; use ${values.join(", ")}`, isError: true };
          }
          for (const frame of ["first_frame", "last_frame"]) if (args[frame] && caps.supported_frame_images && !caps.supported_frame_images.includes(frame)) return { output: `${frame} is unsupported by ${wire}`, isError: true };
          if (a.seed !== undefined && caps.seed === false) return { output: `seed is unsupported by ${wire}`, isError: true };
          if (a.generate_audio !== undefined && caps.generate_audio === false) return { output: `generate_audio is unsupported by ${wire}`, isError: true };
        }
      }
      for (const [key, slot] of [["first_frame", "first"], ["last_frame", "last"]] as const) {
        if (!args[key]) continue;
        const url = await imageDataUrl(String(args[key]), ctx.cwd);
        if ("error" in url) return { output: `${key}: ${url.error}`, isError: true };
        a[slot] = url.url;
      }
      if (args.references != null) {
        if (!Array.isArray(args.references) || args.references.length > 7) return { output: "references must contain at most 7 image paths", isError: true };
        if (!["openrouter", "xai"].includes(providerId) || (providerId === "xai" && !/grok-imagine-video-1\.5/.test(wire))) return { output: `references are unsupported by ${wire} on ${providerId}`, isError: true };
        a.references = [];
        for (const ref of args.references) {
          const result = await imageDataUrl(String(ref), ctx.cwd);
          if ("error" in result) return { output: result.error, isError: true };
          a.references.push(result.url);
        }
      }

      const preview = `${tool.summarize!(args)}\n(paid ${providerId} video generation)`;
      if (!(await ctx.confirm(tool, args, preview))) return { output: "User rejected the video generation.", isError: true };
      ctx.signal.throwIfAborted();
      const work = await prepareMedia(ctx, "video", current, args, [a.first, a.last, ...(a.references ?? [])].filter((s): s is string => Boolean(s)));
      ctx.emit(`media workspace ${work.dir}`);

      let auth: Auth;
      try {
        auth = await mediaAuth(providerId);
      } catch (err) {
        return { output: (err as Error).message, isError: true };
      }

      let job: Job;
      try {
        await updateMedia(work, { status: "submitting", providerId, baseUrl: auth.baseUrl });
        ctx.billMedia?.(current, undefined, work.manifest.id);
        job = await adapter(a, auth, ctx.signal);
      } catch (err) {
        await updateMedia(work, { status: "submission_unknown", error: (err as Error).message });
        return { output: `Submit failed: ${(err as Error).message}. Workspace: ${work.dir}. The provider may still be processing it; do not automatically submit again.`, isError: true };
      }
      await updateMedia(work, { status: "running", jobId: job.id, pollUrl: job.pollUrl });
      ctx.emit(`video job ${job.id} submitted (${wire})`);
      return await waitAndSave(job, work, auth, ctx, pollMs);
    },
  };
  return tool;
}

async function waitAndSave(job: Job, work: MediaWorkspace, auth: Auth, ctx: ToolContext, pollMs: number): Promise<ToolResult> {
  const started = Date.now();
  let last = "";
  let retries = 0;
  let st: PollState;
  const resume = `Workspace: ${work.dir}. Resume with resume_media; do not generate again.`;
  for (;;) {
    if (Date.now() - started > MAX_WAIT_MS) { await updateMedia(work, { status: "waiting_timeout" }); return { output: `Job ${job.id} still running. ${resume}`, isError: true }; }
    try {
      await sleep(pollMs, ctx.signal);
      st = await job.poll(ctx.signal);
      retries = 0;
    } catch (err) {
      if (ctx.signal.aborted) { await updateMedia(work, { status: "waiting_stopped" }); return { output: `Stopped waiting; job ${job.id} may still finish. ${resume}`, isError: true }; }
      if (/HTTP (429|5\d\d)|fetch failed|timeout|network|socket/i.test((err as Error).message) && retries++ < 5) {
        ctx.emit(`Temporary polling failure; retry ${retries}/5 (job ${job.id})`);
        try { await sleep(Math.min(30_000, pollMs * 2 ** retries), ctx.signal); } catch { /* next iteration records cancellation */ }
        continue;
      }
      await updateMedia(work, { status: "polling_failed", error: (err as Error).message });
      return { output: `Polling failed: ${(err as Error).message} (job ${job.id}). ${resume}`, isError: true };
    }
    if (st.status !== last) { last = st.status; ctx.emit(`video ${st.status} · ${Math.round((Date.now() - started) / 1000)}s`); }
    if (st.state === "failed") { await updateMedia(work, { status: "failed", error: st.error }); return { output: `Video generation ${st.status}: ${st.error} (job ${job.id}). Workspace: ${work.dir}`, isError: true }; }
    if (st.state === "done") break;
  }
  await updateMedia(work, { status: "ready", cost: st.cost });
  ctx.billMedia?.(work.manifest.model, st.cost, work.manifest.id);
  await updateMedia(work, { billed: true });
  if (!st.url) return { output: `Job ${job.id} finished without a video URL. ${resume}`, isError: true };
  const out = mediaOutputPath(work, work.manifest.parameters?.out, "mp4", ctx.cwd);
  let bytes: number;
  try {
    const apiOrigin = new URL(auth.baseUrl).origin;
    const onApi = new URL(st.url).origin === apiOrigin;
    bytes = await downloadTo(st.url, out, onApi ? auth.headers : undefined, ctx.signal, work.tmp);
  } catch (err) {
    await updateMedia(work, { status: "download_failed", error: (err as Error).message });
    return { output: `Video ready but download failed: ${(err as Error).message}. ${resume}`, isError: true };
  }
  await updateMedia(work, { status: "completed", saved: [out] });
  const where = (await finishMedia(work)) ? "" : ` Workspace: ${work.dir}`;
  const cost = typeof st.cost === "number" ? ` · $${st.cost.toFixed(3)}` : "";
  return { output: `Saved ${out} (${(bytes / 1_048_576).toFixed(1)} MB, ${work.manifest.model}${cost}).${where}`, display: `${path.basename(out)}${cost}` };
}

/** Reconstruct a poll operation from the journal. This never issues a POST. */
async function pollRecorded(provider: string, id: string, auth: Auth, signal: AbortSignal, pollUrl?: string): Promise<PollState> {
  const encoded = encodeURIComponent(id);
  const route = provider === DEFAULT_PROVIDER ? `/video/generations/${encoded}` : provider === "zai" ? `/async-result/${encoded}` : `/videos/${encoded}`;
  const url = pollUrl ?? `${auth.baseUrl}${route}`;
  if (new URL(url).origin !== new URL(auth.baseUrl).origin) throw new Error("Refusing polling URL outside the configured API host");
  const s = await requestJson<any>(url, { headers: auth.headers }, signal);
  const d = s.data && typeof s.data === "object" && !Array.isArray(s.data) ? s.data : s;
  const status = String(d.task_status ?? d.status ?? s.status ?? "queued").toLowerCase();
  if (["failed", "fail", "failure", "error", "cancelled", "canceled", "expired"].includes(status)) return { state: "failed", status, error: errorText(d.error ?? d.fail_reason ?? s.message) };
  if (["done", "success", "succeeded", "completed", "complete"].includes(status)) {
    const result = d.unsigned_urls?.[0] ?? d.video?.url ?? d.video_result?.[0]?.url ?? findUrl(d);
    return { state: "done", status, cost: d.usage?.cost, url: result ?? (provider === "openrouter" ? `${auth.baseUrl}/videos/${encoded}/content?index=0` : provider === DEFAULT_PROVIDER ? `${auth.baseUrl}/videos/${encoded}/content` : undefined) };
  }
  return { state: "running", status };
}
export function makeResumeMediaTool(opts: VideoToolOptions = {}): ToolDef {
  const tool: ToolDef = {
    name: "resume_media", risk: "write",
    description: "Recover image/audio results or resume waiting/downloading an existing video job from its media workspace. Never submits another paid generation. Returns existing results if already completed. out can choose another export destination after a file conflict.",
    parameters: { type: "object", properties: { workspace: { type: "string" }, out: { type: "string" } }, required: ["workspace"] },
    async run(args, ctx) {
      const dir = resolveInside(ctx.cwd, String(args.workspace));
      const manifest = JSON.parse(await fsp.readFile(path.join(dir, "manifest.json"), "utf8"));
      if (manifest.version !== 1 || !["video", "audio", "image"].includes(manifest.kind)) return { output: "Not a valid media workspace", isError: true };
      if (["completed", "quality_mismatch"].includes(manifest.status) && !args.out && manifest.saved?.length && (await Promise.all(manifest.saved.map((p: string) => fsp.stat(p).then((s) => s.isFile()).catch(() => false)))).every(Boolean)) return { output: `Already saved: ${manifest.saved.join(", ")}`, isError: manifest.status === "quality_mismatch" };
      if (!(await ctx.confirm(tool, args))) return { output: "Resume rejected", isError: true };
      ctx.signal.throwIfAborted();
      const work = mediaWork(dir, manifest, ctx.cwd);
      if (manifest.kind !== "video") {
        const { recoverLocalMedia } = await import("./mediarecover.js");
        return await recoverLocalMedia(work, ctx, args.out);
      }
      if (!manifest.jobId) return { output: "Workspace has no recoverable video job id", isError: true };
      const auth = await mediaAuth(manifest.providerId);
      if (manifest.baseUrl !== auth.baseUrl) return { output: "Provider API host changed since submission; restore the original host to resume.", isError: true };
      if (args.out) { manifest.parameters ??= {}; manifest.parameters.out = String(args.out); }
      const job: Job = { id: manifest.jobId, poll: (signal) => pollRecorded(manifest.providerId, manifest.jobId, auth, signal, manifest.pollUrl) };
      return await waitAndSave(job, work, auth, ctx, opts.pollMs ?? 10_000);
    },
  };
  return tool;
}

function errorText(err: unknown): string {
  if (!err) return "no reason given";
  if (typeof err === "string") return err;
  const msg = (err as { message?: unknown }).message;
  return typeof msg === "string" ? msg : JSON.stringify(err).slice(0, 300);
}
