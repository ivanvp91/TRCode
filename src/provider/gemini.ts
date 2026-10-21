/**
 * Gemini through Google's Code Assist API, the host Gemini CLI itself uses.
 *
 * This is not the public Gemini API: requests go to cloudcode-pa.googleapis.com
 * under the OAuth client of the CLI, wrapped in {model, project, request} and
 * streamed as SSE frames of {response: {candidates, usageMetadata}}. The public
 * key path is a different provider mode entirely (the OpenAI-compatible shim),
 * and this adapter exists only for the account login.
 *
 * Tools are function declarations, tool results are functionResponse parts, and
 * Gemini has no call ids of its own — ours are synthesized so the rest of the
 * client (pair repair, trim, replay) keeps working on the same history shape.
 */
import type { Message, StreamEvent, ToolCall, ToolDef, Usage } from "../types.js";
import { normalizeToolSchema } from "./schema.js";

const CODE_ASSIST = "https://cloudcode-pa.googleapis.com/v1internal";
/** What Gemini CLI reports as its client; the host reads it when deciding access. */
const CLIENT_METADATA = {
  ideType: "IDE_UNSPECIFIED",
  platform: "PLATFORM_UNSPECIFIED",
  pluginType: "GEMINI",
};

export interface GeminiRequest {
  model: string;
  /** Code Assist project; absent only before onboarding has completed. */
  project?: string;
  messages: Message[];
  tools?: ToolDef[];
  maxTokens?: number;
  temperature?: number;
}

function argsObject(raw: string | undefined): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Our chat-shaped history → Gemini contents. Consecutive parts of the same role
 * are merged: Gemini wants one turn per role, and a tool round produces several
 * function responses in a row.
 */
export function toGeminiContents(messages: Message[]): {
  systemInstruction?: { parts: { text: string }[] };
  contents: { role: "user" | "model"; parts: Record<string, unknown>[] }[];
} {
  const system: string[] = [];
  const contents: { role: "user" | "model"; parts: Record<string, unknown>[] }[] = [];
  const push = (role: "user" | "model", parts: Record<string, unknown>[]) => {
    if (!parts.length) return;
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts.push(...parts);
    else contents.push({ role, parts });
  };

  for (const m of messages) {
    if (m.meta?.hidden) continue;
    if (m.role === "system") {
      if (m.content) system.push(String(m.content));
      continue;
    }
    if (m.role === "tool") {
      push("user", [
        {
          functionResponse: {
            name: m.name || "tool",
            response: { output: String(m.content ?? "") },
          },
        },
      ]);
      continue;
    }
    if (m.role === "assistant") {
      const parts: Record<string, unknown>[] = [];
      if (m.content) parts.push({ text: String(m.content) });
      for (const tc of m.tool_calls ?? []) {
        const call: Record<string, unknown> = { functionCall: { name: tc.function.name, args: argsObject(tc.function.arguments) } };
        if (tc.signature) call.thoughtSignature = tc.signature;
        parts.push(call);
      }
      push("model", parts);
      continue;
    }
    const parts: Record<string, unknown>[] = [{ text: String(m.content ?? "") }];
    for (const img of m.images ?? []) parts.push({ inlineData: { mimeType: img.mime, data: img.data } });
    push("user", parts);
  }

  return system.length ? { systemInstruction: { parts: [{ text: system.join("\n\n") }] }, contents } : { contents };
}

/** The request body Code Assist expects: model and project beside the payload. */
export function buildGeminiBody(req: GeminiRequest): Record<string, unknown> {
  const { systemInstruction, contents } = toGeminiContents(req.messages);
  const request: Record<string, unknown> = { contents };
  if (systemInstruction) request.systemInstruction = systemInstruction;
  if (req.tools?.length) {
    request.tools = [
      {
        functionDeclarations: req.tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: normalizeToolSchema(t.parameters),
        })),
      },
    ];
  }
  if (req.maxTokens || req.temperature !== undefined) {
    request.generationConfig = {
      ...(req.maxTokens ? { maxOutputTokens: req.maxTokens } : {}),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    };
  }
  return {
    model: req.model,
    ...(req.project ? { project: req.project } : {}),
    request,
  };
}

function usageOf(u: any): Usage | undefined {
  if (!u) return undefined;
  const input = Number(u.promptTokenCount ?? 0);
  const output = Number(u.candidatesTokenCount ?? 0);
  return {
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: Number(u.totalTokenCount ?? input + output),
    cached_tokens: Number(u.cachedContentTokenCount ?? 0) || undefined,
    reasoning_tokens: Number(u.thoughtsTokenCount ?? 0) || undefined,
  };
}

/** SAFETY / RECITATION are refusals, not truncation; the caller reports them as a stop. */
function finishOf(reason: string | undefined): string {
  if (!reason) return "";
  if (reason === "MAX_TOKENS") return "length";
  return "stop";
}

interface Parsed {
  content: string;
  toolCalls: ToolCall[];
  usage?: Usage;
  finishReason: string;
  reasoning: string;
}

/** One Code Assist response (streamed frame or a whole reply) → our events. */
class GeminiReading {
  private text = "";
  private thought = "";
  private calls = new Map<string, { name: string; args: string; signature?: string }>();
  private finish = "";
  private usage: Usage | undefined;

  take(frame: any): StreamEvent[] {
    const response = frame?.response ?? frame ?? {};
    const out: StreamEvent[] = [];

    for (const candidate of response.candidates ?? []) {
      for (const part of candidate?.content?.parts ?? []) {
        if (typeof part?.text === "string" && part.text) {
          if (part.thought) {
            this.thought += part.text;
            out.push({ type: "reasoning", text: part.text });
          } else {
            this.text += part.text;
            out.push({ type: "text", text: part.text });
          }
        }
        const call = part?.functionCall;
        if (call?.name) {
          const args = JSON.stringify(call.args ?? {});
          const key = `${call.name}\u0000${args}`;
          if (!this.calls.has(key)) {
            this.calls.set(key, {
              name: String(call.name),
              args,
              ...(typeof part.thoughtSignature === "string" ? { signature: part.thoughtSignature } : {}),
            });
          }
        }
      }
      if (candidate?.finishReason) this.finish = finishOf(String(candidate.finishReason));
    }
    if (response.usageMetadata) this.usage = usageOf(response.usageMetadata) ?? this.usage;
    return out;
  }

  result(): Parsed {
    const toolCalls = [...this.calls.values()].map((c, i) => ({
      id: `gemini_call_${i}`,
      type: "function" as const,
      function: { name: c.name, arguments: c.args },
      ...(c.signature ? { signature: c.signature } : {}),
    }));
    return {
      content: this.text,
      toolCalls,
      usage: this.usage,
      finishReason: toolCalls.length ? "tool_calls" : this.finish || "stop",
      reasoning: this.thought,
    };
  }
}

/** Streaming SSE frames → our events. */
export class GeminiStreamParser {
  private reading = new GeminiReading();

  handle(frame: any): StreamEvent[] {
    return this.reading.take(frame);
  }

  result(): { toolCalls: ToolCall[]; usage?: Usage; finishReason: string; content: string; reasoning: string } {
    return this.reading.result();
  }
}

/** Non-streaming reply → text and calls, for utility completions. */
export function parseGeminiResult(json: any): {
  content: string;
  toolCalls: ToolCall[];
  usage?: Usage;
  finishReason: string;
} {
  const reading = new GeminiReading();
  reading.take(json);
  const { content, toolCalls, usage, finishReason } = reading.result();
  return { content, toolCalls, usage, finishReason };
}

async function call(url: string, token: string, body?: unknown, signal?: AbortSignal): Promise<any> {
  const res = await fetch(url, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "User-Agent": `GeminiCLI/0.30.0 (trcode)`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Code Assist ${res.status}: ${text.slice(0, 300)}`);
  }
  return text ? JSON.parse(text) : {};
}

function projectOf(value: any): string | undefined {
  if (typeof value === "string" && value) return value;
  if (value && typeof value === "object" && typeof value.id === "string") return value.id;
  return undefined;
}

/**
 * The Code Assist project a token acts for, and the tier it landed on.
 *
 * A paid account already has one. An account without a project is onboarded to
 * its default tier — the same two calls Gemini CLI makes on first run — because
 * a request without a project is refused.
 */
export async function discoverProject(
  accessToken: string,
  opts: { signal?: AbortSignal; onWait?: (attempt: number) => void; baseUrl?: string } = {},
): Promise<{ projectId?: string; tier?: string }> {
  const base = opts.baseUrl ?? CODE_ASSIST;
  const load = await call(`${base}:loadCodeAssist`, accessToken, { metadata: CLIENT_METADATA }, opts.signal);
  const tier = load?.paidTier?.id ?? load?.currentTier?.id;
  const existing = projectOf(load?.cloudaicompanionProject);
  if (existing) return { projectId: existing, tier };

  const allowed = Array.isArray(load?.allowedTiers) ? load.allowedTiers : [];
  const chosen = allowed.find((t: any) => t?.isDefault) ?? allowed[0] ?? { id: "legacy" };
  let operation = await call(
    `${base}:onboardUser`,
    accessToken,
    { tierId: chosen.id, metadata: CLIENT_METADATA },
    opts.signal,
  );
  for (let attempt = 0; attempt < 12 && operation?.name && !operation?.done; attempt++) {
    opts.onWait?.(attempt + 1);
    await new Promise((r) => setTimeout(r, 5000));
    operation = await call(`${base}/${operation.name}`, accessToken, undefined, opts.signal);
  }
  return {
    projectId: projectOf(operation?.response?.cloudaicompanionProject),
    tier: chosen.id ?? tier,
  };
}
