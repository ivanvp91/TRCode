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
import type { VideoModelInfo } from "../agent/videomode.js";
import { DEFAULT_PROVIDER } from "../provider/registry.js";
import type { ToolDef, ToolResult } from "../types.js";
import { apiMessage, downloadTo, fetchListing, findUrl, imageDataUrl, mediaAuth, requestJson, resolvePath, sleep, stamp } from "./media.js";
import { DEFAULT_VIDEO_MODEL, mediaAvailable, mediaModelId, parseMediaId, providerServes } from "./mediamodels.js";

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
}

type PollState = { state: "running" | "done" | "failed"; status: string; url?: string; urlNeedsKey?: boolean; error?: string; cost?: number };

interface Job {
  id: string;
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
    const j = await requestJson<any>(`${auth.baseUrl}/videos`, { method: "POST", headers: json(auth), body: JSON.stringify(body) }, signal);
    if (!j?.id) throw new Error(`no job id: ${JSON.stringify(j).slice(0, 300)}`);
    const pollUrl = j.polling_url || `${auth.baseUrl}/videos/${j.id}`;
    return {
      id: j.id,
      async poll(sig) {
        const s = await requestJson<any>(pollUrl, { headers: auth.headers }, sig);
        const status = String(s.status ?? "");
        if (status === "completed") {
          return { state: "done", status, url: s.unsigned_urls?.[0] || `${auth.baseUrl}/videos/${j.id}/content?index=0`, urlNeedsKey: true, cost: s.usage?.cost };
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
    const j = await requestJson<any>(`${auth.baseUrl}/videos/generations`, { method: "POST", headers: json(auth), body: JSON.stringify(body) }, signal);
    const id = j?.request_id ?? j?.id;
    if (!id) throw new Error(`no request id: ${JSON.stringify(j).slice(0, 300)}`);
    return {
      id: String(id),
      async poll(sig) {
        const s = await requestJson<any>(`${auth.baseUrl}/videos/${id}`, { headers: auth.headers }, sig);
        const status = String(s.status ?? "").toLowerCase();
        if (status === "done" || status === "completed") return { state: "done", status, url: s.video?.url ?? findUrl(s) };
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
        out: { type: "string", description: "Where to save the mp4 (default ./video-<time>.mp4)" },
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
      const adapter = ADAPTERS[providerId];
      if (!adapter) return { output: `Video generation is not supported on ${providerId}.`, isError: true };
      if (!providerServes(providerId, "video")) {
        return { output: `${providerId} is not connected with an API key. Run: trc auth login --provider ${providerId}`, isError: true };
      }

      const a: VideoArgs = { model: wire, prompt };
      if (args.duration != null && args.duration !== "" && Number.isFinite(Number(args.duration))) a.duration = Number(args.duration);
      if (args.resolution) a.resolution = String(args.resolution);
      if (args.aspect_ratio) a.aspect_ratio = String(args.aspect_ratio);
      if (typeof args.generate_audio === "boolean") a.generate_audio = args.generate_audio;
      if (Number.isInteger(args.seed)) a.seed = args.seed;
      for (const [key, slot] of [["first_frame", "first"], ["last_frame", "last"]] as const) {
        if (!args[key]) continue;
        const url = await imageDataUrl(String(args[key]), ctx.cwd);
        if ("error" in url) return { output: `${key}: ${url.error}`, isError: true };
        a[slot] = url.url;
      }
      const ignored = a.last && (providerId === "xai" || providerId === "zai") ? " last_frame is not supported here and was left out." : "";

      const preview = `${tool.summarize!(args)}\n(paid ${providerId} video generation)`;
      if (!(await ctx.confirm(tool, args, preview))) return { output: "User rejected the video generation.", isError: true };

      let auth: Auth;
      try {
        auth = await mediaAuth(providerId);
      } catch (err) {
        return { output: (err as Error).message, isError: true };
      }

      let job: Job;
      try {
        job = await adapter(a, auth, ctx.signal);
      } catch (err) {
        return { output: `Submit failed: ${(err as Error).message}`, isError: true };
      }
      ctx.emit(`video job ${job.id} submitted (${wire})`);

      const started = Date.now();
      let last = "";
      let st: PollState;
      for (;;) {
        if (Date.now() - started > MAX_WAIT_MS) {
          return { output: `Still running after ${Math.round(MAX_WAIT_MS / 60_000)} min; job ${job.id} keeps going on ${providerId}.`, isError: true };
        }
        try {
          await sleep(pollMs, ctx.signal);
          st = await job.poll(ctx.signal);
        } catch (err) {
          if (ctx.signal.aborted) return { output: `Stopped waiting; job ${job.id} may still finish on ${providerId}.`, isError: true };
          return { output: `Polling failed: ${(err as Error).message} (job ${job.id})`, isError: true };
        }
        if (st.status !== last) {
          last = st.status;
          ctx.emit(`video ${st.status} · ${Math.round((Date.now() - started) / 1000)}s`);
        }
        if (st.state === "failed") return { output: `Video generation ${st.status}: ${st.error} (job ${job.id})`, isError: true };
        if (st.state === "done") break;
      }
      if (!st.url) return { output: `Job ${job.id} finished but the response names no video URL.`, isError: true };

      const out = resolvePath(String(args.out || `video-${stamp()}.mp4`), ctx.cwd);
      let bytes: number;
      try {
        bytes = await downloadTo(st.url, out, st.urlNeedsKey ? auth.headers : undefined, ctx.signal);
      } catch (err) {
        return { output: `Video ready but download failed: ${(err as Error).message}. URL: ${st.url}`, isError: true };
      }

      const cost = typeof st.cost === "number" ? ` · $${st.cost.toFixed(3)}` : "";
      const secs = Math.round((Date.now() - started) / 1000);
      return {
        output: `Saved ${out} (${(bytes / 1_048_576).toFixed(1)} MB, ${wire} on ${providerId}, generated in ${secs}s${cost}).${ignored}`,
        display: `${path.basename(out)} · ${(bytes / 1_048_576).toFixed(1)} MB${cost}`,
      };
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
