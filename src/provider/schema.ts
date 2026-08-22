/** Wire-shape fixes for tool schemas that some hosts insist on. */

/**
 * Fills in `required` on every object schema that omits it. xAI answers 400 —
 * "Provider returned error", with nothing more to go on — to a function whose
 * parameters have no `required` list, which is how a tool with only optional
 * arguments is naturally written. An empty list says exactly what the missing
 * key already meant, so every other host reads the same schema as before.
 */
export function normalizeToolSchema<T>(schema: T): T {
  if (Array.isArray(schema)) return schema.map((v) => normalizeToolSchema(v)) as unknown as T;
  if (!schema || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema as Record<string, unknown>)) out[k] = normalizeToolSchema(v);
  if (out.type === "object" && out.properties && !Array.isArray(out.required)) out.required = [];
  return out as T;
}
