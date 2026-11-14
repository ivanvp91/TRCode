/** Wire-shape fixes for tool schemas that some hosts insist on. */

/**
 * Fills in `required` on every object schema that omits it. xAI answers 400 —
 * "Provider returned error", with nothing more to go on — to a function whose
 * parameters have no `required` list, which is how a tool with only optional
 * arguments is naturally written. An empty list says exactly what the missing
 * key already meant, so every other host reads the same schema as before.
 */
/**
 * A function call's `arguments` has to be a JSON object on the wire. Models do
 * emit fragments: Meta's Muse cuts a call off mid-object, and any turn stopped
 * at the output limit leaves half of one in the history. A strict host answers
 * 400 — "`arguments` must be valid JSON" — to every later step that replays it,
 * so the turn can never recover on its own. The model already read the parse
 * error in the tool result, so the history keeps the raw text and only the wire
 * gets the empty object.
 */
export function wireToolArgs(raw: string | null | undefined): string {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return "{}";
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return text;
  } catch {
    // Not JSON at all — falls through to the empty object.
  }
  return "{}";
}

export function normalizeToolSchema<T>(schema: T): T {
  if (Array.isArray(schema)) return schema.map((v) => normalizeToolSchema(v)) as unknown as T;
  if (!schema || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema as Record<string, unknown>)) out[k] = normalizeToolSchema(v);
  if (out.type === "object" && out.properties && !Array.isArray(out.required)) out.required = [];
  return out as T;
}
