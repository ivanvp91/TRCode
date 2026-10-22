/**
 * MCP over Streamable HTTP: a real server on a loopback port. Covers the
 * handshake, session headers, SSE responses with progress, a session the
 * server forgot (404 → re-initialise → replay), and the 2026-07-28 stateless
 * path (`server/discover` + `_meta` on every request).
 */
import http from "node:http";

const { McpClient } = await import("../dist/mcp/client.js");

let passed = 0;
let failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) { passed++; console.log("  ok   " + name); }
  else { failed++; console.log("  FAIL " + name + (detail ? "\n       " + detail : "")); }
};

/**
 * `modern: false` refuses server/discover, which is what a 2025-era server
 * does; everything else behaves the same either way.
 */
function makeServer(options = {}) {
  const st = {
    modern: options.modern !== false,
    inits: 0,
    deletes: 0,
    validSession: "",
    expired: false,
    seen: [],
  };
  const server = http.createServer((req, res) => {
    if (req.method === "DELETE") {
      st.deletes++;
      res.writeHead(204);
      res.end();
      return;
    }
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      let msg;
      try {
        msg = JSON.parse(body);
      } catch {
        res.writeHead(400);
        res.end();
        return;
      }
      st.seen.push({ method: msg.method, headers: req.headers, params: msg.params });
      const session = String(req.headers["mcp-session-id"] ?? "");
      const handshake = msg.method === "initialize" || msg.method === "server/discover";
      if (session && st.validSession && session !== st.validSession && !handshake) {
        res.writeHead(404);
        res.end("session gone");
        return;
      }
      const reply = (result, headers = {}) => {
        res.writeHead(200, { "Content-Type": "application/json", ...headers });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
      };
      const rpcError = (code, text) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code, message: text } }));
      };
      const eventStream = (events) => {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
        for (const e of events) res.write(`data: ${JSON.stringify(e)}\n\n`);
        res.end();
      };

      if (msg.method === "server/discover") {
        if (!st.modern) return rpcError(-32601, "Method not found");
        return reply({ supportedVersions: ["2026-07-28"], capabilities: { tools: {} }, serverInfo: { name: "http-modern" } });
      }
      if (msg.method === "initialize") {
        // The SDK's stateful servers refuse an initialize that names a session
        // they do not have — the spec says a client re-initialises without one.
        if (options.strictInit && session && session !== st.validSession) {
          res.writeHead(404);
          res.end("session not found");
          return;
        }
        st.inits++;
        st.validSession = `sess-${st.inits}`;
        return reply(
          { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "http-tv" } },
          { "Mcp-Session-Id": st.validSession },
        );
      }
      if (msg.method === "notifications/initialized") {
        res.writeHead(202);
        res.end();
        return;
      }
      if (msg.method === "tools/list") {
        return reply({ tools: [{ name: "echo", description: "Echo", inputSchema: { type: "object", properties: { text: { type: "string" } } } }] });
      }
      if (msg.method === "tools/call") {
        const args = msg.params?.arguments ?? {};
        if (args.text === "EXPIRE" && !st.expired) {
          st.expired = true;
          st.validSession = "gone";
          res.writeHead(404);
          res.end("session gone");
          return;
        }
        if (args.text === "PROG") {
          const token = msg.params?._meta?.progressToken;
          return eventStream([
            { jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: token, progress: 1, total: 2, message: "half" } },
            { jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "done" }] } },
          ]);
        }
        return reply({ content: [{ type: "text", text: "echo:" + String(args.text ?? "") }] });
      }
      reply({});
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, st, url: `http://127.0.0.1:${server.address().port}/mcp` });
    });
  });
}

const close = (server) => new Promise((resolve) => server.close(resolve));
const last = (st, method) => [...st.seen].reverse().find((m) => m.method === method);

// ── handshake, headers, a plain call, DELETE on close ────────────────────────
{
  const { server, st, url } = await makeServer();
  const client = new McpClient("http", { url, bearerToken: "tok", headers: { "X-Custom": "yes" } });
  await client.start();
  check("connects over Streamable HTTP", client.state === "ready" && client.detail === "http-tv", `${client.state} ${client.detail}`);
  check("lists tools", client.tools.map((t) => t.name).join(",") === "echo", client.tools.map((t) => t.name).join(","));

  const res = await client.callTool("echo", { text: "hi" });
  check("a call echoes through", res.output === "echo:hi" && !res.isError, res.output);

  const call = last(st, "tools/call");
  check("the bearer token is sent", call?.headers.authorization === "Bearer tok", String(call?.headers.authorization));
  check("custom headers are sent", call?.headers["x-custom"] === "yes", String(call?.headers["x-custom"]));
  check("the session id is echoed back", call?.headers["mcp-session-id"] === "sess-1", String(call?.headers["mcp-session-id"]));
  check("the client accepts SSE and JSON", /text\/event-stream/.test(String(call?.headers.accept)), String(call?.headers.accept));

  await client.close();
  check("closing deletes the session", st.deletes === 1, String(st.deletes));
  await close(server);
}

// ── an SSE response: progress notification then the result ───────────────────
{
  const { server, url } = await makeServer();
  const client = new McpClient("http", { url });
  await client.start();
  let progress = null;
  const res = await client.callTool("echo", { text: "PROG" }, { onProgress: (p) => (progress = p) });
  check("a streamed result arrives", res.output === "done", res.output);
  check("progress from inside the stream is delivered", progress?.progress === 1 && progress?.message === "half", JSON.stringify(progress));
  await client.close();
  await close(server);
}

// ── the server forgets the session: re-initialise and replay ─────────────────
{
  const { server, st, url } = await makeServer();
  const client = new McpClient("http", { url });
  await client.start();
  const res = await client.callTool("echo", { text: "EXPIRE" });
  check("a 404 session is re-established and the call replayed", res.output === "echo:EXPIRE" && !res.isError, res.output);
  check("the handshake ran twice", st.inits === 2, String(st.inits));
  await client.close();
  await close(server);
}

// The same against a server that refuses a re-initialise carrying the dead id.
{
  const { server, st, url } = await makeServer({ strictInit: true });
  const client = new McpClient("http", { url });
  await client.start();
  const res = await client.callTool("echo", { text: "EXPIRE" });
  check("the new session is asked for without the dead id", res.output === "echo:EXPIRE" && !res.isError, res.output);
  const reinit = st.seen.filter((s) => s.method === "initialize")[1];
  check("the re-initialise carries no session header", reinit && !reinit.headers["mcp-session-id"], JSON.stringify(reinit?.headers ?? {}));
  await client.close();
  await close(server);
}

// ── 2026-07-28: server/discover, no initialize, _meta on every request ───────
{
  const { server, st, url } = await makeServer({ modern: true });
  const client = new McpClient("http", { url, protocol: "auto" });
  await client.start();
  check("auto negotiates the modern revision", client.protocolVersion === "2026-07-28" && client.detail === "http-modern", `${client.protocolVersion} ${client.detail}`);
  check("no initialize is sent in the modern revision", st.inits === 0, String(st.inits));
  const list = last(st, "tools/list");
  check(
    "requests carry the protocol version in _meta",
    list?.params?._meta?.["io.modelcontextprotocol/protocolVersion"] === "2026-07-28",
    JSON.stringify(list?.params),
  );
  const res = await client.callTool("echo", { text: "modern" });
  check("tools still call through", res.output === "echo:modern", res.output);
  await client.close();
  await close(server);
}

// ── insisting on the modern revision against a legacy server fails loudly ────
{
  const { server, st, url } = await makeServer({ modern: false });
  const client = new McpClient("http", { url, protocol: "2026-07-28" });
  await client.start();
  check("a modern-only client reports the discovery failure", client.state === "failed" && /server\/discover/.test(client.detail), `${client.state} ${client.detail}`);
  check("legacy fallback did not run", st.inits === 0, String(st.inits));
  await close(server);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
