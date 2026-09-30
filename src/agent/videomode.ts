/**
 * Video mode: the session stops being a coding session and becomes a video
 * studio. Two models share the work — a text model (the "prompt model") reads
 * the request, looks at attached images, writes the shot description and calls
 * generate_video; the video model (Seedance, Veo, Kling… on OpenRouter) turns
 * that description into the clip.
 *
 * The state is per process on purpose: every generation is paid, so a mode
 * that silently came back on after a restart would be a trap. The two model
 * choices are remembered in the config, since picking them is the tedious part.
 */
import { loadConfig } from "../config.js";
import { mediaModelId, parseMediaId } from "../tools/mediamodels.js";

/** One row of OpenRouter's GET /videos/models, trimmed to what is used. */
export interface VideoModelInfo {
  id: string;
  name?: string;
  description?: string;
  supported_resolutions?: string[] | null;
  supported_aspect_ratios?: string[] | null;
  supported_sizes?: string[] | null;
  supported_durations?: number[] | null;
  supported_frame_images?: string[] | null;
  generate_audio?: boolean | null;
  seed?: boolean | null;
  pricing_skus?: Record<string, string> | null;
}

interface VideoModeState {
  active: boolean;
  /** Session model before the mode switched to the prompt model. */
  previousModel?: string;
  /** Capabilities of the video model, when the listing could be read. */
  caps?: VideoModelInfo;
}

const state: VideoModeState = { active: false };

export function isVideoMode(): boolean {
  return state.active;
}

export function enterVideoMode(opts: { previousModel: string; caps?: VideoModelInfo }): void {
  state.active = true;
  state.previousModel = opts.previousModel;
  state.caps = opts.caps;
}

/** Leaves the mode; returns the model the session ran on before it. */
export function leaveVideoMode(): string | undefined {
  const prev = state.previousModel;
  state.active = false;
  state.previousModel = undefined;
  state.caps = undefined;
  return prev;
}

export function setVideoCaps(caps: VideoModelInfo | undefined): void {
  state.caps = caps;
}

/** The video model generate_video uses, with its provider: "openrouter:bytedance/seedance-2.5". */
export function videoModelId(): string {
  return mediaModelId("video");
}

/** The text model that writes video prompts; empty means the session's own. */
export function videoPromptModelId(): string {
  return loadConfig().videoPromptModel || "";
}

/** "4–15 s", "480p, 720p" … — a capability list as one short phrase. */
export function capsLine(m: VideoModelInfo): string {
  const bits: string[] = [];
  const d = m.supported_durations?.filter((x) => Number.isFinite(x)) ?? [];
  if (d.length) bits.push(d.length > 3 ? `${Math.min(...d)}–${Math.max(...d)} s` : `${d.join("/")} s`);
  if (m.supported_resolutions?.length) bits.push(m.supported_resolutions.join("/"));
  if (m.supported_aspect_ratios?.length) bits.push(m.supported_aspect_ratios.join(" "));
  if (m.supported_frame_images?.length) bits.push(`frames: ${m.supported_frame_images.join("+")}`);
  if (m.generate_audio) bits.push("audio");
  return bits.join(" · ");
}

/** Cheapest per-second price the listing states, for the picker hint. */
export function priceLine(m: VideoModelInfo): string {
  const skus = Object.entries(m.pricing_skus ?? {});
  const perSec = skus
    .filter(([k]) => /duration_seconds/.test(k) && !/reference/.test(k))
    .map(([, v]) => Number(v))
    .filter((v) => Number.isFinite(v) && v > 0);
  if (perSec.length) return `from $${Math.min(...perSec).toFixed(2)}/s`;
  const cents = skus.find(([k]) => /cents_per_second/.test(k));
  if (cents) return `$${(Number(cents[1]) / 100).toFixed(2)}/s`;
  return skus.length ? "token-priced" : "";
}

/**
 * The system-prompt section for the lead agent while the mode is on. Absent
 * otherwise, so a coding session pays nothing for the feature.
 */
export function videoModeSection(): string {
  if (!state.active) return "";
  const id = videoModelId();
  const { providerId, model } = parseMediaId(id);
  // Capabilities come from OpenRouter's listing; other hosts publish none.
  const caps = providerId === "openrouter" && state.caps?.id === model ? state.caps : undefined;
  const lines = [
    "Video mode is on. Every user message is a request for a video, not a coding task. " +
      "Your job is to turn it into the best prompt this video model can take, then call generate_video.",
    `Video model: ${id}${caps?.name ? ` (${caps.name})` : ""}.`,
  ];
  if (caps) {
    const spec = [
      caps.supported_durations?.length ? `duration (s): ${caps.supported_durations.join(", ")}` : "",
      caps.supported_resolutions?.length ? `resolution: ${caps.supported_resolutions.join(", ")}` : "",
      caps.supported_aspect_ratios?.length ? `aspect_ratio: ${caps.supported_aspect_ratios.join(", ")}` : "",
      caps.supported_frame_images?.length ? `frame images: ${caps.supported_frame_images.join(", ")}` : "frame images: not supported",
      caps.generate_audio ? "generates audio" : "",
    ].filter(Boolean);
    lines.push(`Supported values — use only these: ${spec.join("; ")}.`);
    const price = priceLine(caps);
    if (price) lines.push(`Price: ${price}.`);
  }
  lines.push(
    "",
    "How to work:",
    "- A request clear enough to shoot goes straight to generate_video; the user confirms the cost before anything runs. Ask one short question only when something essential is missing and has no sensible default.",
    "- Write the prompt in English as a shot description: subject and its look, action, setting, camera (shot size, angle, movement), lighting, style or genre, mood, and sound when the model makes audio. Concrete visible details, no abstractions.",
    "- For clips longer than about 6 seconds, write timed beats: \"0–4s: …; 4–9s: …; 9–15s: …\". Keep one continuous scene or clearly ordered cuts.",
    "- Pass only parameters the model supports; leave out what the user did not care about.",
    "- Attached images: look at them with read_image first. Pass one as first_frame/last_frame only when it should literally open or close the clip; a logo, character or style reference is described in words instead.",
    "- The video model cannot open links (YouTube and the like), reuse existing footage or audio, or edit a video. Say so in one line and recreate the idea from a description.",
    "- Video providers often refuse real logos, trademarks and real people. If a job fails on content policy, rewrite the prompt with a generic look and retry once, telling the user what changed.",
    "- On an invalid-parameter error, switch to a supported value from the list above and retry once.",
    "- After success, give the file path and the final prompt, so the user can ask for a variation.",
  );
  return `<video-mode>\n${lines.join("\n")}\n</video-mode>`;
}
