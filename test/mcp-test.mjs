/**
 * MCP client against a real subprocess speaking the stdio protocol: handshake,
 * paginated tool listing, the config-level filters, calls (errors, images,
 * structured content, progress), resources, `tools/list_changed`, schema
 * compaction, and how a dead server degrades.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "trc-mcp-"));
process.env.TRCODE_HOME = HOME;

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(here, "mock-mcp-server.mjs");

// A minimal but complete server: paginated tools, resources, templates,
// list_changed, progress, images and structured content.
fs.writeFileSync(
  SERVER,
  `
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
let listedLate = false;
const GET_QUOTE = { name: "get_quote", description: "Quote for a symbol",
  inputSchema: { type: "object", properties: { symbol: { type: "string", description: "Ticker" } }, required: ["symbol"] } };
const LIST_MARKETS = { name: "list_markets", description: "All markets", inputSchema: { type: "object", properties: {} } };
const LATE = { name: "late_tool", description: "Appeared later", inputSchema: { type: "object", properties: {} } };
console.error("mock-mcp: starting up"); // stderr must never break framing
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const reply = (result) => send({ jsonrpc: "2.0", id: msg.id, result });
  if (msg.method === "initialize") {
    reply({ protocolVersion: "2025-06-18", capabilities: { tools: { listChanged: true }, resources: {} },
      serverInfo: { name: "mock-tv", version: "1.0.0" } });
  } else if (msg.method === "tools/list") {
    if (!msg.params?.cursor) reply({ tools: [GET_QUOTE], nextCursor: "page-2" });
    else reply({ tools: listedLate ? [LIST_MARKETS, LATE] : [LIST_MARKETS] });
  } else if (msg.method === "resources/list") {
    reply({ resources: [{ uri: "file:///mock/readme.md", name: "README", mimeType: "text/markdown" }] });
  } else if (msg.method === "resources/templates/list") {
    reply({ resourceTemplates: [{ uriTemplate: "file:///mock/{name}", name: "file" }] });
  } else if (msg.method === "resources/read") {
    reply({ contents: [{ uri: msg.params.uri, mimeType: "text/plain", text: "resource body" }] });
  } else if (msg.method === "tools/call") {
    const { name, arguments: args } = msg.params;
    const token = msg.params?._meta?.progressToken;
    if (args?.symbol === "BOOM") {
      reply({ isError: true, content: [{ type: "text", text: "no such symbol" }] });
    } else if (args?.symbol === "IMG") {
      reply({ content: [{ type: "image", data: PNG, mimeType: "image/png" }, { type: "text", text: "chart attached" }] });
    } else if (args?.symbol === "STRUCT") {
      reply({ content: [{ type: "text", text: "done" }], structuredContent: { price: 42, symbol: "AAPL" } });
    } else if (args?.symbol === "PROG") {
      if (token) send({ jsonrpc: "2.0", method: "notifications/progress",
        params: { progressToken: token, progress: 5, total: 10, message: "halfway" } });
      reply({ content: [{ type: "text", text: "progress done" }] });
    } else if (args?.symbol === "LATE") {
      listedLate = true;
      send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
      reply({ content: [{ type: "text", text: "a new tool appeared" }] });
    } else {
      reply({ content: [{ type: "text", text: name + ":" + JSON.stringify(args) }] });
    }
  } else if (msg.id !== undefined) {
    // Anything else (server/discover on a legacy server) is a method error.
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } });
  }
});
`,
);

const {
  McpClient,
  mcpServerConfigs,
  mcpToolDefs,
  connectMcpServers,
  stopMcpServers,
  mcpClients,
  untrustedProjectServers,
  trustProjectServers,
} = await import("../dist/mcp/client.js");
const { compactSchema } = await import("../dist/mcp/schema.js");

let passed = 0;
let failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) { passed++; console.log("  ok   " + name); }
  else { failed++; console.log("  FAIL " + name + (detail ? "\n       " + detail : "")); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const node = process.execPath;

// ── handshake and listing ────────────────────────────────────────────────────
{
  const client = new McpClient("tv", { command: node, args: [SERVER] });
  await client.start();
  check("connects and reads the server name", client.state === "ready" && client.detail === "mock-tv", `${client.state} ${client.detail}`);
  check("negotiated a protocol version", Boolean(client.protocolVersion), client.protocolVersion);
  check("follows pagination and lists both tools", client.tools.map((t) => t.name).join(",") === "get_quote,list_markets", client.tools.map((t) => t.name).join(","));

  const res = await client.callTool("get_quote", { symbol: "AAPL" });
  check("a call echoes through", res.output === 'get_quote:{"symbol":"AAPL"}' && !res.isError, res.output);

  const err = await client.callTool("get_quote", { symbol: "BOOM" });
  check("isError from the server is carried over", err.isError === true && /no such symbol/.test(err.output), err.output);

  const img = await client.callTool("get_quote", { symbol: "IMG" });
  check("image blocks become attachments", img.images?.length === 1 && img.images[0].mime === "image/png", JSON.stringify(img.images));
  check("the text around the image is kept", /chart attached/.test(img.output), img.output);

  const structured = await client.callTool("get_quote", { symbol: "STRUCT" });
  check("structuredContent rides along as JSON", /```json/.test(structured.output) && /"price": 42/.test(structured.output), structured.output);

  let sawProgress = null;
  await client.callTool("get_quote", { symbol: "PROG" }, { onProgress: (p) => (sawProgress = p) });
  check("progress notifications reach the caller", sawProgress?.progress === 5 && sawProgress?.message === "halfway", JSON.stringify(sawProgress));

  check("resources are listed", client.resources.length === 1 && client.resources[0].uri === "file:///mock/readme.md", JSON.stringify(client.resources));
  check("resource templates are listed", client.resourceTemplates.length === 1, JSON.stringify(client.resourceTemplates));
  const read = await client.readResource("file:///mock/readme.md");
  check("a resource reads as text", read.output === "resource body" && !read.isError, read.output);

  // The server adds a tool and says so; the client re-lists without /mcp reload.
  await client.callTool("get_quote", { symbol: "LATE" });
  await sleep(900);
  check("tools/list_changed refreshes the catalog", client.tools.some((t) => t.name === "late_tool"), client.tools.map((t) => t.name).join(","));

  client.stop();
  const dead = await client.callTool("get_quote", { symbol: "AAPL" });
  check("a stopped server answers with an error, not a hang", dead.isError === true, dead.output);
}

// ── the tools filter ─────────────────────────────────────────────────────────
{
  const client = new McpClient("tv", { command: node, args: [SERVER], tools: ["get_quote"] });
  await client.start();
  check("config filter hides unlisted tools", client.tools.length === 1 && client.tools[0].name === "get_quote");
  client.stop();
}

// ── protocol modes: auto falls back, strict does not ─────────────────────────
{
  const auto = new McpClient("tv", { command: node, args: [SERVER], protocol: "auto" });
  await auto.start();
  check(
    "protocol auto falls back to initialize",
    auto.state === "ready" && auto.protocolVersion === "2025-06-18",
    `${auto.state} ${auto.protocolVersion} ${auto.detail}`,
  );
  auto.stop();

  const strict = new McpClient("tv", { command: node, args: [SERVER], protocol: "2026-07-28" });
  await strict.start();
  check(
    "a modern-only client refuses a legacy server",
    strict.state === "failed" && /server\/discover/.test(strict.detail),
    `${strict.state} ${strict.detail}`,
  );
}

// ── schemas are compacted to a budget ────────────────────────────────────────
{
  const huge = {
    type: "object",
    properties: {
      query: { type: "string", description: "x".repeat(8000) },
      nested: { type: "object", properties: { a: { type: "object", properties: { b: { type: "object", properties: { c: { type: "string" } } } } } } },
    },
    $defs: { Thing: { type: "object", properties: { id: { type: "string" } } } },
    required: ["query"],
  };
  const small = compactSchema(huge, 500);
  check("an oversized schema comes back under budget", JSON.stringify(small).length <= 500, String(JSON.stringify(small).length));
  check("compaction keeps the callable shape", small.properties?.query?.type === "string" && small.required?.includes("query"), JSON.stringify(small));
  check("compaction drops the descriptions first", !("description" in (small.properties?.query ?? {})), JSON.stringify(small.properties?.query));
  const tiny = compactSchema({ type: "object", properties: { a: { type: "string" } } }, 5000);
  check("a small schema is left alone", tiny.properties.a.type === "string");
}

// ── a broken command fails, not hangs ────────────────────────────────────────
{
  const client = new McpClient("bad", { command: node, args: ["-e", "process.exit(3)"] });
  await client.start();
  check("a dying server reports failed", client.state === "failed", client.state);
  check("the failure names the exit", /exited/.test(client.detail), client.detail);
}

// ── registry: config merge, tool defs, resource tools ────────────────────────
{
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), "trc-mcp-proj-"));
  fs.mkdirSync(path.join(proj, ".trcode"));
  fs.writeFileSync(
    path.join(proj, ".trcode", "mcp.json"),
    JSON.stringify({ mcpServers: { tv: { command: node, args: [SERVER] } } }),
  );
  const configs = mcpServerConfigs(proj);
  check("project mcp.json is picked up", Boolean(configs.tv), JSON.stringify(configs));

  // A repository's server is a command it wants run here: nothing starts
  // until the user approves that exact config for this folder.
  check("a project server waits for trust", untrustedProjectServers(proj).includes("tv"), JSON.stringify(untrustedProjectServers(proj)));
  connectMcpServers(proj, () => {});
  check("an untrusted project server is not started", !mcpClients().some((c) => c.id === "tv"), mcpClients().map((c) => c.id).join(","));
  trustProjectServers(proj);
  check("trusting clears the wait", untrustedProjectServers(proj).length === 0, JSON.stringify(untrustedProjectServers(proj)));
  fs.writeFileSync(
    path.join(proj, ".trcode", "mcp.json"),
    JSON.stringify({ mcpServers: { tv: { command: node, args: [SERVER, "--changed"] } } }),
  );
  check("an edited config needs trust again", untrustedProjectServers(proj).includes("tv"));
  fs.writeFileSync(
    path.join(proj, ".trcode", "mcp.json"),
    JSON.stringify({ mcpServers: { tv: { command: node, args: [SERVER] } } }),
  );

  await new Promise((resolve) => connectMcpServers(proj, resolve));
  const defs = mcpToolDefs();
  const serverDefs = defs.filter((d) => d.name.startsWith("mcp__tv__"));
  check("tool defs use the mcp__ prefix", serverDefs.some((d) => d.name === "mcp__tv__get_quote"), defs.map((d) => d.name).join(","));
  check("unclassified MCP effects require write permission", serverDefs.every((d) => d.risk === "write"));
  check("the schema passes through", serverDefs[0].parameters?.properties?.symbol?.type === "string");
  check(
    "resource readers join the registry",
    defs.some((d) => d.name === "read_mcp_resource") && defs.some((d) => d.name === "list_mcp_resources"),
    defs.map((d) => d.name).join(","),
  );

  // run() must ask permission first and honour a refusal.
  const refused = await serverDefs[0].run({ symbol: "AAPL" }, {
    cwd: proj, signal: new AbortController().signal, depth: 0,
    confirm: async () => false, emit: () => {}, readFiles: new Set(),
  });
  check("a refused call does not reach the server", refused.isError === true && /rejected/.test(refused.output), refused.output);

  const allowed = await serverDefs[0].run({ symbol: "MSFT" }, {
    cwd: proj, signal: new AbortController().signal, depth: 0,
    confirm: async () => true, emit: () => {}, readFiles: new Set(),
  });
  check("an allowed call goes through", allowed.output === 'get_quote:{"symbol":"MSFT"}', allowed.output);

  const readTool = defs.find((d) => d.name === "read_mcp_resource");
  const resource = await readTool.run({ server: "tv", uri: "file:///mock/readme.md" }, {
    cwd: proj, signal: new AbortController().signal, depth: 0,
    confirm: async () => true, emit: () => {}, readFiles: new Set(),
  });
  check("read_mcp_resource reads through the server", resource.output === "resource body", resource.output);

  stopMcpServers();
  fs.rmSync(proj, { recursive: true, force: true });
}

// ── deferred tool loading: find_mcp_tools instead of every schema ───────────
{
  const { saveConfig } = await import("../dist/config.js");
  saveConfig({ mcpToolSearch: true });
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), "trc-mcp-find-"));
  fs.mkdirSync(path.join(proj, ".trcode"));
  fs.writeFileSync(
    path.join(proj, ".trcode", "mcp.json"),
    JSON.stringify({ mcpServers: { tv: { command: node, args: [SERVER] } } }),
  );
  trustProjectServers(proj);
  await new Promise((resolve) => connectMcpServers(proj, resolve));
  const defs = mcpToolDefs();
  check(
    "search mode hides the schemas and offers the finder",
    !defs.some((d) => d.name === "mcp__tv__get_quote") && defs.some((d) => d.name === "find_mcp_tools"),
    defs.map((d) => d.name).join(","),
  );
  const finder = defs.find((d) => d.name === "find_mcp_tools");
  const exposed = [];
  const found = await finder.run({ query: "quote" }, {
    cwd: proj, signal: new AbortController().signal, depth: 0,
    confirm: async () => true, emit: () => {}, readFiles: new Set(),
    exposeTools: (list) => exposed.push(...list),
  });
  check("the search names the matching tool", /get_quote/.test(found.output), found.output);
  check("the match joins the running request", exposed.some((d) => d.name === "mcp__tv__get_quote"), exposed.map((d) => d.name).join(","));
  check("and stays in the registry for later turns", mcpToolDefs().some((d) => d.name === "mcp__tv__get_quote"));

  saveConfig({ mcpToolSearch: false });
  stopMcpServers();
  fs.rmSync(proj, { recursive: true, force: true });
}

// ── approval: a read-only tool may run without asking ────────────────────────
{
  const READONLY = path.join(here, "mock-mcp-readonly.mjs");
  fs.writeFileSync(
    READONLY,
    `
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
rl.on("line", (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: { capabilities: { tools: {} }, serverInfo: { name: "ro" } } });
  else if (msg.method === "tools/list") send({ jsonrpc: "2.0", id: msg.id, result: { tools: [
    { name: "peek", description: "Read only", annotations: { readOnlyHint: true },
      inputSchema: { type: "object", properties: {} } } ] } });
  else if (msg.method === "tools/call") send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "peeked" }] } });
});
`,
  );
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), "trc-mcp-ro-"));
  fs.mkdirSync(path.join(proj, ".trcode"));
  fs.writeFileSync(
    path.join(proj, ".trcode", "mcp.json"),
    JSON.stringify({
      mcpServers: {
        ro: { command: node, args: [READONLY], approval: "auto" },
        ro2: { command: node, args: [READONLY] },
      },
    }),
  );
  trustProjectServers(proj);
  await new Promise((resolve) => {
    let left = 2;
    connectMcpServers(proj, () => {
      if (--left === 0) resolve();
    });
  });
  const defs = mcpToolDefs();
  const trusting = defs.find((d) => d.name === "mcp__ro__peek");
  const asking = defs.find((d) => d.name === "mcp__ro2__peek");
  check("a read-only tool with approval auto is risk read", trusting?.risk === "read", String(trusting?.risk));
  check("the same tool asks by default", asking?.risk === "network", String(asking?.risk));

  stopMcpServers();
  fs.rmSync(proj, { recursive: true, force: true });
  fs.rmSync(READONLY, { force: true });
}

// ── a reply cut in the middle of a letter, a ping, a roots request ──────────
// A pipe delivers whatever it has: a Cyrillic letter split across two reads
// came out as U+FFFD when each chunk was decoded on its own. And a server's own
// requests — ping, roots/list — need real answers, not "method not found".
{
  const SPLIT = path.join(here, "mock-mcp-split.mjs");
  fs.writeFileSync(
    SPLIT,
    `
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
const asked = {};
rl.on("line", async (line) => {
  const msg = JSON.parse(line);
  if (msg.result !== undefined || msg.error !== undefined) { asked[msg.id] = msg; return; }
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "split" } } });
    send({ jsonrpc: "2.0", id: "p1", method: "ping" });
    send({ jsonrpc: "2.0", id: "r1", method: "roots/list" });
  } else if (msg.method === "tools/list") {
    send({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "hello", inputSchema: { type: "object" } }, { name: "asked", inputSchema: { type: "object" } }] } });
  } else if (msg.method === "tools/call" && msg.params.name === "asked") {
    send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: JSON.stringify(asked) }] } });
  } else if (msg.method === "tools/call") {
    const buf = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "Привет, мир" }] } }) + "\\n");
    const at = buf.indexOf(Buffer.from("Привет")) + 1;
    process.stdout.write(buf.subarray(0, at));
    await new Promise((r) => setTimeout(r, 50));
    process.stdout.write(buf.subarray(at));
  }
});
`,
  );
  const client = new McpClient("split", { command: node, args: [SPLIT] });
  client.root = HOME;
  await client.start();
  const res = await client.callTool("hello", {});
  check("a letter split across two reads arrives whole", res.output === "Привет, мир", JSON.stringify(res.output));
  const asked = JSON.parse((await client.callTool("asked", {})).output);
  check("a ping is answered with an empty result", asked.p1 && asked.p1.result && !asked.p1.error, JSON.stringify(asked.p1));
  check(
    "roots/list answers with the workspace",
    Array.isArray(asked.r1?.result?.roots) && asked.r1.result.roots[0]?.uri?.startsWith("file:"),
    JSON.stringify(asked.r1),
  );
  await client.close();
  fs.rmSync(SPLIT, { force: true });
}

fs.rmSync(SERVER, { force: true });
fs.rmSync(HOME, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
