/**
 * Measures what we actually put on the wire across a tool-heavy session,
 * with history trimming on and off. Answers "did the token fix help?" with
 * bytes rather than opinion.
 */
import http from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const PORT = Number(process.env.MEASURE_PORT || 8899);
const TOOL_OUTPUT = "x".repeat(24000); // a big file read, repeated each step
const STEPS = 12; // tool rounds before the model answers

let sizes = [];

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url.endsWith("/models")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        object: "list",
        data: [{ id: "measure-model", owned_by: "mock", context_window: 1000000, supported_endpoint_types: ["openai"], tags: "Text" }],
      }),
    );
    return;
  }

  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    sizes.push(Buffer.byteLength(body, "utf8"));
    const payload = JSON.parse(body || "{}");
    const toolRounds = (payload.messages ?? []).filter((m) => m.role === "tool").length;

    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    const chunk = (delta, finish = null) => ({ choices: [{ index: 0, delta, finish_reason: finish }] });

    if (toolRounds < STEPS) {
      // Keep asking for the same big file so history grows step by step.
      send(chunk({ role: "assistant", content: "" }));
      send(
        chunk({
          tool_calls: [
            { index: 0, id: `c${toolRounds}`, type: "function", function: { name: "read", arguments: '{"path":"big.txt"}' } },
          ],
        }),
      );
      send(chunk({}, "tool_calls"));
    } else {
      for (const piece of "Готово.".match(/.{1,3}/g)) send(chunk({ content: piece }));
      send(chunk({}, "stop"));
    }
    send({ ...chunk({}), usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } });
    res.write("data: [DONE]\n\n");
    res.end();
  });
});

await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

const root = path.resolve("./.measure");
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(root, { recursive: true });
fs.writeFileSync(path.join(root, "big.txt"), TOOL_OUTPUT);

function run(budget) {
  sizes = [];
  const home = path.join(root, `home-${budget}`);
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(
    path.join(home, "config.json"),
    JSON.stringify({
      baseUrl: `http://127.0.0.1:${PORT}/v1`,
      apiKey: "sk-test",
      model: "measure-model",
      maxRequestTokens: budget,
      permissions: { read: "allow", write: "deny", shell: "deny", network: "deny", agent: "allow" },
    }),
  );
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.resolve("dist/index.js"), "-p", "прочитай big.txt много раз"], {
      cwd: root,
      stdio: ["pipe", "ignore", "ignore"],
      env: { ...process.env, TRCODE_HOME: home },
    });
    child.on("exit", () => resolve(sizes.slice()));
    setTimeout(() => child.kill("SIGKILL"), 60000);
  });
}

const budgets = [0, 40000];
const runs = [];
for (const b of budgets) runs.push([b, await run(b)]);

server.close();

const sum = (a) => a.reduce((x, y) => x + y, 0);
const kb = (n) => (n / 1024).toFixed(0) + " КБ";
const row = (name, a) =>
  `${name.padEnd(26)} запросов ${String(a.length).padStart(2)}  ·  суммарно ${kb(sum(a)).padStart(9)}  ·  самый большой ${kb(Math.max(...a)).padStart(8)}`;

const base = sum(runs[0][1]);
for (const [b, a] of runs) {
  const pct = Math.round((1 - sum(a) / base) * 100);
  console.log(row(b === 0 ? "без ограничения" : `порог ${b/1000}k токенов`, a) + "  ·  экономия " + String(pct).padStart(3) + "%");
}
fs.rmSync(root, { recursive: true, force: true });
