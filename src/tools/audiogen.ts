/**
 * Audio generation: speech from gpt-audio-style models, music from Lyria.
 *
 * Both OpenRouter and TokenRouter serve these through /chat/completions with
 * `modalities: ["text", "audio"]`, and only as a stream: the sound arrives as
 * base64 pieces in `delta.audio.data`, to be joined and decoded. Like
 * /image, there is no mode — /audio picks the model and generate_audio joins
 * the chat's tools.
 *
 * A speech model answers the way a chat model does, so "read this" would get
 * a reply about the text rather than the text. A short system line makes it a
 * voice instead; music models take the prompt as the brief it is.
 */
import path from "node:path";
import fsp from "node:fs/promises";
import type { ToolDef, ToolResult } from "../types.js";
import { apiMessage, mediaAuth, withTimeout, readBounded, GENERATE_TIMEOUT_MS } from "./media.js";
import { prepareMedia, updateMedia, mediaOutputPath, saveMedia, checkMediaOutput, finishMedia } from "./mediaworkspace.js";
import { mediaAvailable, mediaModelId, parseMediaId, providerServes } from "./mediamodels.js";

/** OpenAI's streamed audio is 24 kHz mono 16-bit PCM. */
const PCM_RATE = 24_000;

const VOICES = ["alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse"];

export function audioModelId(): string {
  return mediaModelId("audio");
}

export function audioGenAvailable(): boolean {
  return mediaAvailable("audio");
}

/** Music models compose from a brief; everything else here is a voice. */
export function isMusicModel(model: string): boolean {
  // "udio" only as a name of its own: gpt-audio contains it too.
  return /lyria|music|suno|(^|\/)udio/i.test(model);
}

/** What the bytes are, by their first few; raw PCM has no signature at all. */
export function sniffAudio(buf: Buffer): { ext: string; raw: boolean } {
  const head = buf.toString("latin1", 0, 12);
  if (head.startsWith("RIFF") && head.slice(8, 12) === "WAVE") return { ext: "wav", raw: false };
  const mpeg = buf.length >= 4 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0 && ((buf[1] >> 3) & 3) !== 1 && ((buf[1] >> 1) & 3) !== 0 && (buf[2] >> 4) > 0 && (buf[2] >> 4) < 15 && ((buf[2] >> 2) & 3) !== 3;
  if (head.startsWith("ID3") || mpeg) return { ext: "mp3", raw: false };
  if (head.startsWith("OggS")) return { ext: "ogg", raw: false };
  if (head.startsWith("fLaC")) return { ext: "flac", raw: false };
  if (head.slice(4, 8) === "ftyp") return { ext: "m4a", raw: false };
  return { ext: "wav", raw: true };
}

/** A WAV header in front of raw 16-bit mono PCM, so any player opens it. */
export function wavFromPcm(pcm: Buffer, rate = PCM_RATE): Buffer {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0, "ascii");
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write("WAVE", 8, "ascii");
  h.write("fmt ", 12, "ascii");
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36, "ascii");
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

/**
 * Reads an SSE chat stream, keeping the audio pieces and the transcript. A
 * host that ignores `stream` and answers with one JSON body is read too.
 */
export async function collectAudio(res: Response): Promise<{ audio: Buffer; transcript: string; cost?: number }> {
  const chunks: string[] = [];
  let transcript = "";
  let cost: number | undefined;
  let finished = false;
  let bytes = 0;
  const take = (obj: any) => {
    const choice = obj?.choices?.[0];
    const a = choice?.delta?.audio ?? choice?.message?.audio;
    if (a?.data) {
      bytes += String(a.data).length;
      if (bytes > 140_000_000) throw new Error("Audio exceeds 100 MB");
      chunks.push(String(a.data));
    }
    if (choice?.finish_reason != null) {
      if (choice.finish_reason !== "stop") throw new Error(`Audio did not complete: ${choice.finish_reason}`);
      finished = true;
    }
    if (a?.transcript) transcript += String(a.transcript);
    if (typeof obj?.usage?.cost === "number") cost = obj.usage.cost;
    if (obj?.error) throw new Error(apiMessage(JSON.stringify(obj)));
  };

  const type = res.headers.get("content-type") ?? "";
  if (!type.includes("event-stream")) {
    take(JSON.parse((await readBounded(res, 140_000_000)).toString("utf8")));
    finished = true;
  } else {
    const decoder = new TextDecoder();
    let buf = "";
    let event: string[] = [];
    const dispatch = () => {
      const data = event.join("\n").trim(); event = [];
      if (data === "[DONE]") { finished = true; return; }
      if (data) take(JSON.parse(data));
    };
    const line = (raw: string) => {
      if (!raw) { dispatch(); return; }
      if (!raw.startsWith("data:")) return;
      const data = raw.slice(5).trim();
      event.push(data);
    };
    if (!res.body) throw new Error("Missing audio stream");
    for await (const piece of res.body as unknown as AsyncIterable<Uint8Array>) {
      buf += decoder.decode(piece, { stream: true });
      if (buf.length > 8_000_000) throw new Error("Audio SSE event exceeds 8 MB");
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const raw = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        line(raw);
      }
    }
    buf += decoder.decode();
    if (buf.trim()) line(buf.trim());
    dispatch();
    if (!finished) throw new Error("Audio stream ended before its completion marker; partial audio was not published.");
  }
  // Base64 pieces are not always cut on 4-character boundaries; decode each.
  const audio = Buffer.concat(chunks.map((c) => {
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(c) || c.length % 4 === 1) throw new Error("Invalid base64 audio chunk");
    return Buffer.from(c, "base64");
  }));
  return { audio, transcript, cost };
}

export function makeGenerateAudioTool(): ToolDef {
  const current = audioModelId();
  const { providerId, model: wire } = parseMediaId(current);
  const music = isMusicModel(wire);
  const tool: ToolDef = {
    name: "generate_audio",
    risk: "network",
    paidMedia: true,
    description: music
      ? `Composes music with ${wire} (on ${providerId}) and saves the audio file. Paid: call it when the user asks for music or a jingle. ` +
        "Write the brief in English: genre, mood, tempo, instruments, structure, length; lyrics in quotes if any."
      : `Speaks text aloud with ${wire} (on ${providerId}) and saves the audio file (voice-over, narration, announcement). Paid: call it when the user asks for speech. ` +
        `text is read exactly as given, in its own language. voice: ${VOICES.join(", ")}. instructions set the delivery (tone, pace, emotion, accent).`,
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: music ? "The music brief" : "What to say, word for word" },
        instructions: { type: "string", description: music ? "Extra direction (optional)" : "Delivery: tone, pace, emotion, accent" },
        voice: { type: "string", description: music ? "Unused for music" : `Voice (default alloy): ${VOICES.join(", ")}` },
        out: { type: "string", description: "Optional export path. Default: audio-<timestamp>.<format> in the current directory" },
        workspace: { type: "string", description: "Workspace returned by prepare_media_workspace" },
      },
      required: ["text"],
    },
    summarize: (a) => `${wire}${a.voice ? ` · ${a.voice}` : ""} — ${String(a.text ?? "").slice(0, 60)}`,
    async run(args, ctx): Promise<ToolResult> {
      const text = String(args.text ?? "").trim();
      if (!text) return { output: "text is required.", isError: true };
      const conflict = checkMediaOutput(args.out, ctx.cwd);
      if (conflict) return { output: conflict, isError: true };
      if (!current) return { output: "No audio model chosen. The user picks one with /audio.", isError: true };
      if (!providerServes(providerId, "audio")) {
        return { output: `${providerId} is not connected with an API key. Run: trc auth login --provider ${providerId}`, isError: true };
      }

      const instructions = args.instructions ? String(args.instructions).trim() : "";
      if (!music && args.voice && !VOICES.includes(String(args.voice))) return { output: `Unsupported voice. Use: ${VOICES.join(", ")}`, isError: true };
      const messages = music
        ? [{ role: "user", content: instructions ? `${text}\n\n${instructions}` : text }]
        : [
            {
              role: "system",
              content:
                "You are a voice, not an assistant. Speak the user's text exactly as written, in its language, and nothing else: " +
                "no greeting, no comment, no answer to it." +
                (instructions ? ` Delivery: ${instructions}` : ""),
            },
            { role: "user", content: text },
          ];
      const body: Record<string, unknown> = { model: wire, messages, modalities: ["text", "audio"], stream: true };
      // Speech models need a voice; streamed audio from them is PCM16.
      if (!music) body.audio = { voice: String(args.voice || "alloy"), format: "pcm16" };

      const preview = `${tool.summarize!(args)}\n(paid ${providerId} audio generation)`;
      if (!(await ctx.confirm(tool, args, preview))) return { output: "User rejected the audio generation.", isError: true };
      ctx.signal.throwIfAborted();
      const work = await prepareMedia(ctx, "audio", current, args);
      ctx.emit(`media workspace ${work.dir}`);
      await updateMedia(work, { status: "submitting" });

      let auth;
      try {
        auth = await mediaAuth(providerId);
      } catch (err) {
        await updateMedia(work, { status: "generation_failed", error: (err as Error).message });
        return { output: (err as Error).message, isError: true };
      }

      const started = Date.now();
      ctx.billMedia?.(current, undefined, work.manifest.id);
      let got: Awaited<ReturnType<typeof collectAudio>>;
      try {
        const res = await fetch(`${auth.baseUrl}/chat/completions`, {
          method: "POST",
          headers: { ...auth.headers, "Content-Type": "application/json", Accept: "text/event-stream" },
          body: JSON.stringify(body),
          signal: withTimeout(ctx.signal, GENERATE_TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${apiMessage(await res.text())}`);
        got = await collectAudio(res);
      } catch (err) {
        if (ctx.signal.aborted) return { output: "Interrupted.", isError: true };
        await updateMedia(work, { status: "generation_failed", error: (err as Error).message });
        return { output: `Audio generation failed: ${(err as Error).message}`, isError: true };
      }
      if (!got.audio.length) {
        return { output: `No audio in the response${got.transcript ? `; the model replied: ${got.transcript.slice(0, 300)}` : ""}.`, isError: true };
      }
      ctx.billMedia?.(current, got.cost, work.manifest.id);

      const kind = music ? sniffAudio(got.audio) : { ext: "wav", raw: true };
      if (kind.raw && got.audio.length % 2) return { output: `Invalid PCM16: odd byte count. Workspace: ${work.dir}`, isError: true };
      const bytes = kind.raw ? wavFromPcm(got.audio) : got.audio;
      const recoveryFile = path.join(work.tmp, `generated-audio.${kind.ext}`);
      await fsp.writeFile(recoveryFile, bytes, { flag: "wx" });
      const qa: Record<string, unknown> = { format: kind.ext, byteLength: bytes.length };
      const warnings: string[] = [];
      if (!music) {
        const normalize = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[\p{P}\p{Z}\s]/gu, "");
        qa.transcriptMatches = got.transcript ? normalize(got.transcript) === normalize(text) : null;
        if (qa.transcriptMatches === false) warnings.push("Provider transcript differs from the requested text");
        let peak = 0; let square = 0; let clipped = 0;
        for (let at = 0; at < got.audio.length; at += 2) { const sample = Math.abs(got.audio.readInt16LE(at)); peak = Math.max(peak, sample); square += sample * sample; if (sample >= 32767) clipped++; }
        const samples = got.audio.length / 2;
        qa.sampleRate = PCM_RATE; qa.durationSeconds = samples / PCM_RATE; qa.peak = peak / 32768; qa.rms = Math.sqrt(square / Math.max(samples, 1)) / 32768; qa.clippedFraction = clipped / Math.max(samples, 1);
        if (!peak) warnings.push("Generated speech is silent");
        if (clipped / Math.max(samples, 1) > 0.005) warnings.push("More than 0.5% of PCM samples are clipped");
      }
      await updateMedia(work, { status: "ready", recoveryFile, cost: got.cost, transcript: got.transcript, qa, warnings });
      const out = mediaOutputPath(work, args.out, kind.ext, ctx.cwd);
      // The format is the host's to choose; the name follows what arrived.
      try { await saveMedia(out, bytes, work, ctx.signal); }
      catch (err) {
        await updateMedia(work, { status: "save_failed", error: (err as Error).message });
        return { output: `Audio save failed: ${(err as Error).message}. Workspace: ${work.dir}`, isError: true };
      }
      await updateMedia(work, { status: warnings.length ? "quality_mismatch" : "completed", saved: [out] });
      const where = (await finishMedia(work)) ? "" : `\nWorkspace: ${work.dir}`;

      const secs = kind.raw ? ` · ${(got.audio.length / (PCM_RATE * 2)).toFixed(1)} s of audio` : "";
      const cost = typeof got.cost === "number" ? ` · $${got.cost.toFixed(3)}` : "";
      return {
        output:
          `Saved ${out} (${(bytes.length / 1024).toFixed(0)} KB${secs}, ${wire} on ${providerId}, ${((Date.now() - started) / 1000).toFixed(0)}s${cost}).` +
          (got.transcript ? `\nTranscript: ${got.transcript.slice(0, 500)}` : "") + where +(warnings.length ? `\nQuality checks: ${warnings.join("; ")}. Do not regenerate automatically.` : ""),
        isError: warnings.length > 0,
        display: `${path.basename(out)}${secs}${cost}`,
      };
    },
  };
  return tool;
}
