/**
 * Tool schemas come from the server, not from us: an unpruned one rides along
 * in every single request, and its descriptions are text the model is asked to
 * trust from a third party. A byte budget and a series of progressively lossier
 * passes solve it; the idea lives here, small enough to read.
 *
 * The order matters: dropping descriptions loses the most meaning but keeps
 * the shape callable, while dropping `$defs` can leave `$ref`s dangling — so
 * every pass is checked against the budget before the next, harsher one runs.
 */

/** The default; big enough for a real API, small enough not to hurt. */
export const DEFAULT_SCHEMA_MAX_BYTES = 5000;

type Json = Record<string, any>;

const EMPTY_OBJECT: Json = { type: "object", properties: {} };

/**
 * The schema under `maxBytes`, made callable. `{}` and missing properties are
 * both legal MCP shapes but some providers reject them, so an empty object
 * schema is normalised first.
 */
export function compactSchema(schema: unknown, maxBytes = DEFAULT_SCHEMA_MAX_BYTES): Json {
  const base = normalize(schema);
  if (bytes(base) <= maxBytes) return base;

  const passes: ((s: Json) => Json)[] = [stripDescriptions, dropDefs, collapseDeep, pruneCompositions];
  let current = base;
  for (const pass of passes) {
    current = pass(current);
    if (bytes(current) <= maxBytes) return current;
  }
  return EMPTY_OBJECT;
}

export function schemaBytes(schema: unknown): number {
  return bytes(normalize(schema));
}

function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function normalize(schema: unknown): Json {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return { ...EMPTY_OBJECT };
  const copy = JSON.parse(JSON.stringify(schema)) as Json;
  if (copy.type === "object" || copy.properties) {
    if (!copy.properties || typeof copy.properties !== "object") copy.properties = {};
  }
  return copy;
}

function stripDescriptions(schema: Json): Json {
  const walk = (node: any): any => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== "object") return node;
    const out: Json = {};
    for (const [key, value] of Object.entries(node)) {
      if (key === "description" || key === "title" || key === "$comment" || key === "examples") continue;
      out[key] = walk(value);
    }
    return out;
  };
  return walk(schema);
}

/** `$ref`s are replaced with an open object: the call is still explicable. */
function dropDefs(schema: Json): Json {
  const walk = (node: any): any => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== "object") return node;
    if (typeof node.$ref === "string") return { type: "object" };
    const out: Json = {};
    for (const [key, value] of Object.entries(node)) {
      if (key === "$defs" || key === "definitions" || key === "dependentSchemas") continue;
      out[key] = walk(value);
    }
    return out;
  };
  return walk(schema);
}

/** Past depth 3 a property is described by `{}` — the model can still pass a value. */
function collapseDeep(schema: Json, limit = 3): Json {
  const walk = (node: any, depth: number): any => {
    if (Array.isArray(node)) return node.map((v) => walk(v, depth));
    if (!node || typeof node !== "object") return node;
    if (depth > limit) return {};
    const out: Json = {};
    for (const [key, value] of Object.entries(node)) out[key] = walk(value, depth + 1);
    return out;
  };
  return walk(schema, 0);
}

function pruneCompositions(schema: Json): Json {
  const walk = (node: any): any => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== "object") return node;
    const out: Json = {};
    for (const [key, value] of Object.entries(node)) {
      if (key === "allOf" || key === "anyOf" || key === "oneOf" || key === "not") continue;
      out[key] = walk(value);
    }
    return out;
  };
  return walk(schema);
}
