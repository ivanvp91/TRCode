/**
 * MCP client against a real subprocess speaking the stdio protocol: handshake,
 * tool listing, the config-level tool filter, calls (including errors and
 * non-text content), and how a dead server degrades.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "trc-mcp-"));
process.env.TRCODE_HOME = HOME;

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(here, "mock-mcp-server.mjs");

// A minimal MCP server: initialize, tools/list with two tools, tools/call
// that echoes, errors on demand, and returns an image block for one input.
fs.writeFileSync(
  SERVER,
  `
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
console.error("mock-mcp: starting up"); // stderr must never break framing
rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "mock-tv", version: "1.0.0" },
    }});
  } else if (msg.method === "tools/list") {
    send({ jsonrpc: "2.0", id: msg.id, result: { tools: [
      { name: "get_quote", description: "Quote for a symbol",
        inputSchema: { type: "object", properties: { symbol: { type: "string" } }, required: ["symbol"] } },
      { name: "list_markets", description: "All markets", inputSchema: { type: "object", properties: {} } },
    ]}});
  } else if (msg.method === "tools/call") {
    const { name, arguments: args } = msg.params;
    if (args?.symbol === "BOOM") {
      send({ jsonrpc: "2.0", id: msg.id, result: { isError: true, content: [{ type: "text", text: "no such symbol" }] } });
    } else if (args?.symbol === "IMG") {
      send({ jsonrpc: "2.0", id: msg.id, result: { content: [
        { type: "image", data: "abc", mimeType: "image/png" },
        { type: "text", text: "chart attached" },
      ]}});
    } else {
      send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: name + ":" + JSON.stringify(args) }] } });
    }
  }
});
`,
);

const { McpClient, mcpServerConfigs, mcpToolDefs, connectMcpServers, stopMcpServers } = await import(
  "../dist/mcp/client.js"
);

let passed = 0;
let failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) { passed++; console.log("  ok   " + name); }
  else { failed++; console.log("  FAIL " + name + (detail ? "\n       " + detail : "")); }
};

const node = process.execPath;

// ── handshake and listing ────────────────────────────────────────────────────
{
  const client = new McpClient("tv", { command: node, args: [SERVER] });
  await client.start();
  check("connects and reads the server name", client.state === "ready" && client.detail === "mock-tv", `${client.state} ${client.detail}`);
  check("lists both tools", client.tools.map((t) => t.name).join(",") === "get_quote,list_markets");

  const res = await client.callTool("get_quote", { symbol: "AAPL" });
  check("a call echoes through", res.output === 'get_quote:{"symbol":"AAPL"}' && !res.isError, res.output);

  const err = await client.callTool("get_quote", { symbol: "BOOM" });
  check("isError from the server is carried over", err.isError === true && /no such symbol/.test(err.output), err.output);

  const img = await client.callTool("get_quote", { symbol: "IMG" });
  check("non-text content is named, text kept", /image content omitted/.test(img.output) && /chart attached/.test(img.output), img.output);

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

// ── a broken command fails, not hangs ────────────────────────────────────────
{
  const client = new McpClient("bad", { command: node, args: ["-e", "process.exit(3)"] });
  await client.start();
  check("a dying server reports failed", client.state === "failed", client.state);
  check("the failure names the exit", /exited/.test(client.detail), client.detail);
}

// ── registry: config merge and tool defs ─────────────────────────────────────
{
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), "trc-mcp-proj-"));
  fs.mkdirSync(path.join(proj, ".trcode"));
  fs.writeFileSync(
    path.join(proj, ".trcode", "mcp.json"),
    JSON.stringify({ mcpServers: { tv: { command: node, args: [SERVER] } } }),
  );
  const configs = mcpServerConfigs(proj);
  check("project mcp.json is picked up", Boolean(configs.tv), JSON.stringify(configs));

  await new Promise((resolve) => connectMcpServers(proj, resolve));
  const defs = mcpToolDefs();
  check("tool defs use the mcp__ prefix", defs.some((d) => d.name === "mcp__tv__get_quote"), defs.map((d) => d.name).join(","));
  check("defs carry risk network", defs.every((d) => d.risk === "network"));
  check("the schema passes through", defs[0].parameters?.properties?.symbol?.type === "string");

  // run() must ask permission first and honour a refusal.
  const refused = await defs[0].run({ symbol: "AAPL" }, {
    cwd: proj, signal: new AbortController().signal, depth: 0,
    confirm: async () => false, emit: () => {}, readFiles: new Set(),
  });
  check("a refused call does not reach the server", refused.isError === true && /rejected/.test(refused.output), refused.output);

  const allowed = await defs[0].run({ symbol: "MSFT" }, {
    cwd: proj, signal: new AbortController().signal, depth: 0,
    confirm: async () => true, emit: () => {}, readFiles: new Set(),
  });
  check("an allowed call goes through", allowed.output === 'get_quote:{"symbol":"MSFT"}', allowed.output);

  stopMcpServers();
  fs.rmSync(proj, { recursive: true, force: true });
}

fs.rmSync(SERVER, { force: true });
fs.rmSync(HOME, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
