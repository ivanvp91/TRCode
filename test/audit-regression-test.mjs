/** Regression checks for the audit. Owned temp files and local HTTP only. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import crypto from "node:crypto";
import sharp from "sharp";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { PNG, MP4 } from "./media-fixtures.mjs";
const ownedChildren = [];
const realSpawn = childProcess.spawn;
childProcess.spawn = (command, ...args) => { const child = realSpawn(command, ...args); ownedChildren.push({ command, child }); return child; };
syncBuiltinESMExports();

const home = fs.mkdtempSync(path.join(os.tmpdir(), "trcode-regression-"));
const project = path.join(home, "project");
fs.mkdirSync(project);
process.env.TRCODE_HOME = path.join(home, "config");
process.env.HOME = home; process.env.USERPROFILE = home;
for (const name of ["TOKENROUTER_API_KEY", "TR_API_KEY", "TOKENROUTER_BASE_URL"]) delete process.env[name];
const { saveConfig, sessionsDir } = await import("../dist/config.js");
const { writeCredentials } = await import("../dist/provider/credentials.js");
const { __runProgramForTests: runProgram } = await import("../dist/tools/codemode.js");
const { readTool, writeTool, editTool } = await import("../dist/tools/files.js");
const { resolveInside } = await import("../dist/tools/fsutil.js");
const { readImageTool } = await import("../dist/tools/image.js");
const { collectAudio, makeGenerateAudioTool } = await import("../dist/tools/audiogen.js");
const { makeGenerateImageTool } = await import("../dist/tools/imagegen.js");
const { makeGenerateVideoTool, makeResumeMediaTool } = await import("../dist/tools/video.js");
const { prepareMediaTool, sweepMediaTmp } = await import("../dist/tools/mediaworkspace.js");
const { markTurn, recordWrite, rewindFiles } = await import("../dist/session/checkpoint.js");
const { Session } = await import("../dist/session/session.js");
const { PermissionBroker } = await import("../dist/ui/permissions.js");
const { UsageTracker, historyTokens } = await import("../dist/usage.js");
const { runAgent } = await import("../dist/agent/loop.js");
const { App } = await import("../dist/ui/repl.js");
const { grepTool } = await import("../dist/tools/search.js");
const { runOrchestration } = await import("../dist/agent/orchestrator.js");

const requests = [];
let mode = "valid";
let transient = 0;
let counter = 0;
let base;
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    const data = body ? JSON.parse(body) : null;
    requests.push({ method: req.method, url: req.url, data, auth: req.headers.authorization });
    const json = (status, value) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
    if (data?.model === "audit-orchestration") {
      const planner = data.messages?.[0]?.content?.includes("planner of an agent system");
      const user = data.messages?.findLast((m) => m.role === "user")?.content ?? "";
      if (!planner && user.includes("dependency-fails")) return json(400, { error: { message: "deliberate dependency failure" } });
      const plan = mode === "cycle-plan" ? { steps: [{ id: "a", prompt: "first", deps: ["b"], writes: false }, { id: "b", prompt: "second", deps: ["a"], writes: true }] } :
        { steps: [{ id: "s1", prompt: mode === "loop-plan" ? "dependency-loops" : "dependency-fails", deps: [], writes: false }, { id: "s2", prompt: "dependent writer", deps: ["s1"], writes: true }] };
      if (planner && !data.stream) return json(200, { choices: [{ message: { role: "assistant", content: JSON.stringify(plan) }, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 4, total_tokens: 6, cost: 0.1 } });
      res.writeHead(200, { "content-type": "text/event-stream" });
      const delta = planner ? { content: JSON.stringify(plan) } : user.includes("dependency-loops") ? { content: "Still working", tool_calls: [{ index: 0, id: `read-${counter++}`, type: "function", function: { name: "audit_read", arguments: "{}" } }] } : { content: "unexpected writer" };
      res.write(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: planner || !user.includes("dependency-loops") ? "stop" : "tool_calls" }], usage: planner ? { prompt_tokens: 2, completion_tokens: 4, total_tokens: 6, cost: 0.1 } : undefined })}\n\n`);
      return res.end("data: [DONE]\n\n");
    }
    if (req.url === "/v1/images/generations") return json(200, { data: [{ b64_json: (mode === "bad-image" ? PNG.subarray(0, 30) : PNG).toString("base64") }], usage: { cost: 0.5 } });
    if (req.url === "/v1/videos/generations") return json(200, { request_id: `job-${++counter}` });
    if (/^\/v1\/videos\/job-/.test(req.url)) {
      if (transient-- > 0) return json(503, { error: "temporary outage" });
      return json(200, { status: "done", video: { url: `${base}/clip` }, usage: { cost: 0.25 } });
    }
    if (req.url === "/clip") {
      res.writeHead(200, { "content-type": mode === "html" ? "text/html" : "video/mp4" });
      return res.end(mode === "html" ? "<html>not a clip</html>" : MP4);
    }
    if (req.url === "/v1/chat/completions") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const sse = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      if (data.model === "audit-text") {
        sse({ choices: [{ delta: { tool_calls: Array.from({ length: 5 }, (_, i) => ({ index: i, id: `call-${i}`, type: "function", function: { name: "audit_action", arguments: "{}" } })) } }] });
        sse({ choices: [{ delta: {}, finish_reason: "tool_calls" }] });
      } else {
        sse({ choices: [{ delta: { audio: { data: Buffer.from([255, 248, 0, 0]).toString("base64"), transcript: mode === "text-drift" ? "different words" : "test" } } }] });
        sse({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { cost: 0.1 } });
      }
      return res.end("data: [DONE]\n\n");
    }
    json(404, { error: "unknown route" });
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
base = `http://127.0.0.1:${server.address().port}`;
saveConfig({ apiKey: "owned-key", baseUrl: `${base}/v1`, providers: { xai: { baseUrl: `${base}/v1` } }, imageModel: "tokenrouter:audit-image", audioModel: "tokenrouter:audit-audio", videoModel: "xai:grok-imagine-video-1.5" });
writeCredentials("xai", { mode: "apikey", accessToken: "owned-key" });
const ctx = (extra = {}) => ({ cwd: project, signal: new AbortController().signal, depth: 0, confirm: async () => true, emit() {}, readFiles: new Set(), ...extra });
const deps = { confirmShell: async () => false, confirmWeb: async () => false };
let passed = 0;
let failed = 0;
const test = async (name, run) => { try { await run(); passed++; console.log(`  ok   ${name}`); } catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e.stack}`); } };
const posts = () => requests.filter((r) => r.method === "POST").length;
const manifestFor = (output) => {
  const match = /Workspace: ([^\n]+?)(?:\. Resume|$)/.exec(output);
  assert.ok(match, output);
  return { dir: match[1], manifest: JSON.parse(fs.readFileSync(path.join(match[1], "manifest.json"), "utf8")) };
};

try {
  fs.writeFileSync(path.join(project, "a.txt"), "alpha"); fs.writeFileSync(path.join(project, "b.txt"), "beta");
  await test("CORE-01 concurrent SDK replies reach the right promises", async () => {
    const signal = AbortSignal.timeout(5000);
    const result = await runProgram('return await Promise.all([sdk.fs.read("a.txt"), sdk.fs.read("b.txt")])', ctx({ signal }), deps);
    assert.ok(result.ok, result.output); assert.deepEqual(JSON.parse(result.output), ["alpha", "beta"]);
  });
  await test("CORE-02 documented sdk.glob alias works", async () => { const r = await runProgram('return await sdk.glob("*.txt")', ctx(), deps); assert.ok(r.ok, r.output); assert.ok(JSON.parse(r.output).includes("a.txt")); });
  await test("CORE-03 code-mode writes honor rejection", async () => {
    let asks = 0;
    const r = await runProgram('return await sdk.fs.write("denied.txt", "x")', ctx({ confirm: async () => { asks++; return false; } }), deps);
    assert.equal(r.ok, false); assert.equal(asks, 1); assert.equal(fs.existsSync(path.join(project, "denied.txt")), false);
  });
  await test("CORE-03 code-mode cannot overwrite unread files", async () => { const r = await runProgram('return await sdk.fs.write("a.txt", "x")', ctx(), deps); assert.equal(r.ok, false); assert.equal(fs.readFileSync(path.join(project, "a.txt"), "utf8"), "alpha"); });
  await test("CORE-04 native imports cannot write outside the SDK", async () => { const out = path.join(home, "escape.txt"); const r = await runProgram(`const fs = await import('node:fs/promises'); await fs.writeFile(${JSON.stringify(out)}, 'escape'); return true;`, ctx(), deps); assert.equal(r.ok, false); assert.equal(fs.existsSync(out), false); });
  await test("CORE-04 process secrets and Function constructor are unavailable", async () => { let r = await runProgram('return typeof process', ctx(), deps); assert.equal(r.output, "undefined"); r = await runProgram('return ({}).constructor.constructor("return process")()', ctx(), deps); assert.equal(r.ok, false); });
  await test("CORE-05 user edits made during approval survive", async () => {
    const file = path.join(project, "race.txt"); fs.writeFileSync(file, "before");
    const r = await writeTool.run({ path: "race.txt", content: "agent" }, ctx({ readFiles: new Set([file]), confirm: async () => { fs.writeFileSync(file, "user edit"); return true; } }));
    assert.ok(r.isError); assert.equal(fs.readFileSync(file, "utf8"), "user edit");
  });
  await test("CORE-05 parallel commits reject a stale preview", async () => {
    const file = path.join(project, "parallel.txt"); fs.writeFileSync(file, "old"); let arrived = 0; let release; const gate = new Promise((r) => { release = r; });
    const shared = ctx({ readFiles: new Set([file]), confirm: async () => { if (++arrived === 2) release(); await gate; return true; } });
    const results = await Promise.all(["one", "two"].map((content) => writeTool.run({ path: "parallel.txt", content }, shared)));
    assert.equal(results.filter((r) => !r.isError).length, 1); assert.equal(results.filter((r) => r.isError).length, 1);
  });
  await test("CORE-06 names beginning with two dots stay usable", async () => { assert.equal(resolveInside(project, "..valid.txt"), path.join(project, "..valid.txt")); });
  await test("CORE-07 junction escapes are refused", async () => {
    const outside = path.join(home, "outside"); fs.mkdirSync(outside); fs.symlinkSync(outside, path.join(project, "junction"), process.platform === "win32" ? "junction" : "dir");
    assert.throws(() => resolveInside(project, "junction/missing/escape.txt"), /outside/); assert.equal(fs.existsSync(path.join(outside, "missing")), false);
  });
  await test("CORE-08 failed checkpoint backup never becomes a deletion", async () => {
    const s = new Session({ cwd: project, model: "m", id: "backup-failure" }); const file = path.join(project, "checkpoint.txt"); fs.writeFileSync(file, "original"); markTurn(s, "edit");
    const dest = path.join(sessionsDir(project), `${s.id}.files`, "blobs", crypto.createHash("sha1").update("original").digest("hex"));
    const real = fs.writeFileSync; fs.writeFileSync = (file, ...args) => { if (file === dest) throw new Error("simulated ENOSPC"); return real(file, ...args); };
    try { assert.throws(() => recordWrite(s, { path: file, before: "original", after: "changed", tool: "write" }), /backup failed/); } finally { fs.writeFileSync = real; }
    fs.writeFileSync(file, "changed"); const r = rewindFiles(s, 1); assert.equal(fs.readFileSync(file, "utf8"), "changed"); assert.deepEqual(r.failed, ["checkpoint.txt"]); assert.equal(r.deleted.length, 0);
  });
  await test("CORE-09 CRLF replacement does not duplicate carriage returns", async () => { const file = path.join(project, "crlf.txt"); fs.writeFileSync(file, "one\r\ntwo\r\n"); const r = await editTool.run({ path: "crlf.txt", old_string: "two", new_string: "second\r\nthird" }, ctx({ readFiles: new Set([file]) })); assert.ok(!r.isError, r.output); assert.equal(fs.readFileSync(file, "utf8"), "one\r\nsecond\r\nthird\r\n"); });
  await test("CORE-10 completed code-mode child processes actually exit", async () => { assert.ok(ownedChildren.filter((p) => p.command === process.execPath).every(({ child }) => child.exitCode !== null || child.signalCode !== null)); });
  await test("partial reads stream large files and retain only the requested lines", async () => { const file = path.join(project, "large.txt"); fs.writeFileSync(file, "abcdefghij\n".repeat(100000)); const r = await readTool.run({ path: file, offset: 99999, limit: 2 }, ctx()); assert.ok(!r.isError, r.output); assert.match(r.output, /99999\tabcdefghij/); assert.match(r.output, /100000\tabcdefghij/); assert.ok(r.output.length < 200); });
  await test("CORE-11 abort stops the queued tool batch", async () => {
    const ac = new AbortController(); let actions = 0;
    const tool = { name: "audit_action", risk: "write", description: "owned action", parameters: { type: "object" }, run: async () => { actions++; ac.abort(); return { output: "done" }; } };
    const r = await runAgent({ model: "audit-text", systemPrompt: "test", messages: [{ role: "user", content: "test" }], tools: [tool], toolContext: ctx({ signal: ac.signal }), catalog: [], usage: new UsageTracker(), maxSteps: 1, signal: ac.signal, toolConcurrency: 1 });
    await new Promise((r) => setTimeout(r, 30)); assert.equal(r.stoppedBecause, "aborted"); assert.equal(actions, 1);
  });
  await test("CORE-12 footer reacts to a model change with unchanged history", async () => { const app = new App({ cwd: project, model: "audit-small" }); app.catalog = [{ id: "audit-small", contextWindow: 32000 }, { id: "audit-large", contextWindow: 1000000 }]; app.session.messages = [{ role: "user", content: "test" }]; assert.equal(app.status().contextWindow, 32000); app.session.model = "audit-large"; assert.equal(app.status().contextWindow, 1000000); });
  await test("MEDIA-01 GIF dimensions use little endian", async () => { const gif = Buffer.alloc(10); gif.write("GIF89a"); gif.writeUInt16LE(256, 6); gif.writeUInt16LE(128, 8); fs.writeFileSync(path.join(project, "dims.gif"), gif); const r = await readImageTool.run({ path: "dims.gif", describe: false }, ctx()); assert.match(r.output, /256×128/); });
  await test("MEDIA-02 home paths expand correctly", async () => { fs.writeFileSync(path.join(home, "home.png"), PNG); const r = await readImageTool.run({ path: "~/home.png" }, ctx()); assert.ok(!r.isError, r.output); assert.equal(r.images[0].mime, "image/png"); });
  await test("MEDIA-03 known PCM16 cannot be confused with an MP3 signature", async () => { const r = await makeGenerateAudioTool().run({ text: "test" }, ctx()); assert.ok(!r.isError, r.output); const file = /Saved (.+?\.wav)/.exec(r.output)[1]; const wav = fs.readFileSync(file); assert.equal(wav.toString("ascii", 0, 4), "RIFF"); assert.deepEqual([...wav.subarray(44)], [255, 248, 0, 0]); });
  await test("MEDIA-04 EOF without a completion marker is an error", async () => { const res = new Response('data: {"choices":[{"delta":{"audio":{"data":"AQIDBA=="}}}]}\n\n', { headers: { "content-type": "text/event-stream" } }); await assert.rejects(collectAudio(res), /completion marker/); });
  await test("MEDIA-04 final SSE line and separately padded base64 chunks work", async () => { const res = new Response('data: {"choices":[{"delta":{"audio":{"data":"AQI="}}}]}\r\n\r\ndata: {"choices":[{"delta":{"audio":{"data":"AwQ="}}}]}\n\ndata: [DONE]', { headers: { "content-type": "text/event-stream" } }); assert.deepEqual([...(await collectAudio(res)).audio], [1, 2, 3, 4]); });
  await test("MEDIA-04 malformed SSE is surfaced", async () => { await assert.rejects(collectAudio(new Response('data: {broken}\n\ndata: [DONE]\n', { headers: { "content-type": "text/event-stream" } }))); });
  await test("MEDIA-04 valid multiline SSE events decode correctly", async () => { const res = new Response('data: {"choices":\ndata: [{"delta":{"audio":{"data":"AQI="}}}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } }); assert.deepEqual([...(await collectAudio(res)).audio], [1, 2]); });
  await test("MEDIA-04 finish_reason=length cannot publish truncated speech", async () => { await assert.rejects(collectAudio(new Response('data: {"choices":[{"delta":{"audio":{"data":"AQI="}},"finish_reason":"length"}]}\n\ndata: [DONE]\n', { headers: { "content-type": "text/event-stream" } })), /did not complete/); });
  await test("MEDIA-05 filename follows the decoded format", async () => { const r = await makeGenerateImageTool().run({ prompt: "test", out: "wrong.jpg" }, ctx()); assert.ok(!r.isError, r.output); assert.equal(fs.existsSync(path.join(project, "wrong.jpg")), false); assert.equal(fs.existsSync(path.join(project, "wrong.png")), true); });
  await test("MEDIA-06 simultaneous generations own distinct workspace folders", async () => {
    const results = await Promise.all([1, 2].map(() => makeGenerateImageTool().run({ prompt: "test" }, ctx()))); for (const r of results) assert.ok(!r.isError, r.output);
    const paths = results.map((r) => /Saved (.+?\.png)/.exec(r.output)[1]); assert.notEqual(paths[0], paths[1]);
    for (const file of paths) { assert.equal(path.dirname(file), project); assert.ok(fs.existsSync(file)); }
    assert.equal(fs.existsSync(path.join(project, ".tmp")), false, "finished one-off scratch folders are removed");
  });
  await test("output conflicts are rejected before another paid POST", async () => { const n = posts(); const r = await makeGenerateImageTool().run({ prompt: "test", out: "wrong.png" }, ctx()); assert.ok(r.isError); assert.equal(posts(), n); });
  await test("MEDIA-07 invalid video duration is rejected before payment", async () => { const n = posts(); for (const duration of [-1.5, 0, "6", 301]) { const r = await makeGenerateVideoTool().run({ prompt: "test", duration }, ctx()); assert.ok(r.isError); } assert.equal(posts(), n); });
  await test("MEDIA-08 unsupported seed is rejected before payment", async () => { const n = posts(); const r = await makeGenerateVideoTool().run({ prompt: "test", seed: 42 }, ctx()); assert.ok(r.isError); assert.equal(posts(), n); });
  await test("MEDIA-08 and MEDIA-13 audio=false and last_frame reach xAI 1.5", async () => { const r = await makeGenerateVideoTool({ pollMs: 1 }).run({ prompt: "test", generate_audio: false, last_frame: "~/home.png" }, ctx()); assert.ok(!r.isError, r.output); const post = requests.findLast((r) => r.url === "/v1/videos/generations"); assert.equal(post.data.generate_audio, false); assert.match(post.data.last_frame.url, /^data:image\/png/); });
  await test("MEDIA-09 HTTP 200 HTML never becomes a finished MP4", async () => { mode = "html"; const r = await makeGenerateVideoTool({ pollMs: 1 }).run({ prompt: "test" }, ctx()); assert.ok(r.isError); const { dir, manifest } = manifestFor(r.output); assert.equal(manifest.status, "download_failed"); assert.equal(path.dirname(path.dirname(dir)), project); assert.equal(fs.readdirSync(dir).some((f) => f.endsWith(".mp4")), false); mode = "valid"; });
  await test("MEDIA-10 transient polling 503 is retried without another POST", async () => { transient = 1; const n = posts(); const r = await makeGenerateVideoTool({ pollMs: 1 }).run({ prompt: "test" }, ctx()); assert.ok(!r.isError, r.output); assert.equal(posts(), n + 1); });
  await test("video Esc preserves the job; resume does not pay again", async () => {
    const ac = new AbortController(); const r = await makeGenerateVideoTool({ pollMs: 1 }).run({ prompt: "test" }, ctx({ signal: ac.signal, emit: (s) => { if (s.includes("submitted")) ac.abort(); } }));
    assert.ok(r.isError); const { dir, manifest } = manifestFor(r.output); assert.equal(manifest.status, "waiting_stopped"); const n = posts();
    const resumed = await makeResumeMediaTool({ pollMs: 1 }).run({ workspace: dir }, ctx()); assert.ok(!resumed.isError, resumed.output); assert.equal(posts(), n);
    assert.equal(fs.existsSync(dir), false, "completed resume removes its scratch folder"); assert.match(resumed.output, /Saved .*video-.*.mp4/); assert.equal(posts(), n);
  });
  await test("image recovery restores retained bytes without another paid call", async () => { const ws = /Media workspace: (.+)/.exec((await prepareMediaTool.run({ kind: "image" }, ctx())).output)[1]; const r = await makeGenerateImageTool().run({ prompt: "test", workspace: ws }, ctx()); assert.ok(!r.isError, r.output); const { dir, manifest } = manifestFor(r.output); fs.unlinkSync(manifest.saved[0]); const n = posts(); const recovered = await makeResumeMediaTool().run({ workspace: dir }, ctx()); assert.ok(!recovered.isError, recovered.output); assert.ok(fs.readFileSync(manifest.saved[0]).equals(PNG)); assert.equal(posts(), n); });
  await test("audio recovery restores the exact retained WAV without payment", async () => { const ws = /Media workspace: (.+)/.exec((await prepareMediaTool.run({ kind: "audio" }, ctx())).output)[1]; const r = await makeGenerateAudioTool().run({ text: "test", workspace: ws }, ctx()); assert.ok(!r.isError, r.output); const { dir, manifest } = manifestFor(r.output); const old = fs.readFileSync(manifest.saved[0]); fs.unlinkSync(manifest.saved[0]); const n = posts(); const recovered = await makeResumeMediaTool().run({ workspace: dir }, ctx()); assert.ok(!recovered.isError, recovered.output); assert.ok(fs.readFileSync(manifest.saved[0]).equals(old)); assert.equal(posts(), n); });
  await test("speech transcript drift is reported instead of claiming exact delivery", async () => { mode = "text-drift"; const r = await makeGenerateAudioTool().run({ text: "test" }, ctx()); assert.ok(r.isError); assert.match(r.output, /transcript differs/); mode = "valid"; });
  await test("MEDIA-11 large image metadata does not transfer pixels", async () => { const file = path.join(project, "large.png"); const buf = Buffer.alloc(1_600_001); PNG.copy(buf); fs.writeFileSync(file, buf); const r = await readImageTool.run({ path: file, describe: false }, ctx()); assert.ok(!r.isError, r.output); assert.equal(r.images, undefined); });
  await test("large noisy images get bounded decodable previews", async () => { const file = path.join(project, "noise.png"); await sharp(crypto.randomBytes(1500 * 1500 * 3), { raw: { width: 1500, height: 1500, channels: 3 } }).png().toFile(file); const r = await readImageTool.run({ path: file }, ctx()); assert.ok(!r.isError, r.output); const buf = Buffer.from(r.images[0].data, "base64"); assert.ok(buf.length <= 1_600_000); const m = await sharp(buf).metadata(); assert.ok(m.width < 1500); });
  await test("crop inspects details without modifying the source", async () => { const r = await readImageTool.run({ path: "~/home.png", crop: { left: 0, top: 0, width: 4, height: 4 } }, ctx()); assert.ok(!r.isError, r.output); assert.match(r.output, /Preview 4×4/); assert.ok(fs.readFileSync(path.join(home, "home.png")).equals(PNG)); });
  await test("MEDIA-12 generic network allowance cannot authorize paid media", async () => { saveConfig({ permissions: { network: "allow", paidMedia: "ask" } }); const b = new PermissionBroker({ interactive: false }); assert.equal(await b.confirm(makeGenerateImageTool(), {}), false); assert.equal(await b.confirm(makeGenerateAudioTool(), {}), false); assert.equal(await b.confirm(makeGenerateVideoTool(), {}), false); });
  await test("paid-media authorization remains explicit and configurable", async () => { saveConfig({ permissions: { paidMedia: "allow" } }); assert.equal(await new PermissionBroker({ interactive: false }).confirm(makeGenerateImageTool(), {}), true); });
  await test("rejected or aborted approval never submits a media job", async () => { const n = posts(); const r = await makeGenerateImageTool().run({ prompt: "test" }, ctx({ confirm: async () => false })); assert.ok(r.isError); const ac = new AbortController(); await assert.rejects(makeGenerateVideoTool().run({ prompt: "test" }, ctx({ signal: ac.signal, confirm: async () => { ac.abort(); return true; } }))); assert.equal(posts(), n); });
  await test("image header alone is insufficient; actual decoding is required", async () => { mode = "bad-image"; const r = await makeGenerateImageTool().run({ prompt: "test" }, ctx()); assert.ok(r.isError, r.output); mode = "valid"; });
  await test("image constraints are checked after generation", async () => { const r = await makeGenerateImageTool().run({ prompt: "test", size: "1024x1024" }, ctx()); assert.ok(r.isError); assert.match(r.output, /received 16x9/); });
  await test("prepare_media creates a .tmp workspace that exit sweeps away", async () => { const n = posts(); const r = await prepareMediaTool.run({ kind: "video", title: "test" }, ctx()); const ws = /Media workspace: (.+)/.exec(r.output)[1]; assert.equal(path.dirname(ws), path.join(project, ".tmp")); assert.ok(fs.existsSync(path.join(ws, "manifest.json"))); assert.equal(posts(), n); sweepMediaTmp(); assert.equal(fs.existsSync(ws), false); });
  await test("exit sweep keeps a folder that still holds an unfinished paid job", async () => { const ac = new AbortController(); const r = await makeGenerateVideoTool({ pollMs: 1 }).run({ prompt: "test" }, ctx({ signal: ac.signal, emit: (s) => { if (s.includes("submitted")) ac.abort(); } })); assert.ok(r.isError); const { dir } = manifestFor(r.output); sweepMediaTmp(); assert.ok(fs.existsSync(path.join(dir, "manifest.json"))); const resumed = await makeResumeMediaTool({ pollMs: 1 }).run({ workspace: dir }, ctx()); assert.ok(!resumed.isError, resumed.output); assert.equal(fs.existsSync(dir), false); });
  await test("media billing uses one reconciled actual bill per job", async () => { const u = new UsageTracker(); u.recordMedia("media", undefined, "one"); assert.equal(u.totals().priceUnknown, true); u.recordMedia("media", 0.75, "one"); u.recordMedia("media", 0.75, "one"); assert.equal(u.totals().requests, 1); assert.equal(u.totals().priceUnknown, false); assert.equal(u.totals().costUsd, 0.75); const v = UsageTracker.fromJSON(u.toJSON()); v.recordMedia("media", 0.75, "one"); assert.equal(v.totals().requests, 1); });
  await test("provider billed cost overrides a token estimate", async () => { const u = new UsageTracker(); u.record("model", { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20, cost: 1.25 }, [{ id: "model", pricing: { input: 1, output: 1 } }]); assert.equal(u.totals().costUsd, 1.25); });
  await test("vision context estimate is independent of base64 compression", async () => { assert.equal(historyTokens([{ role: "user", content: "", images: [{ data: "a".repeat(2_000_000), mime: "image/png" }] }]), 2048); });
  await test("session saving is atomic and a damaged current file recovers", async () => { const s = new Session({ cwd: project, model: "m" }); s.add({ role: "user", content: "first" }); s.save(); s.add({ role: "assistant", content: "second" }); s.save(); assert.equal(s.saveError, null); fs.writeFileSync(s.file(), "{broken"); const restored = Session.load(project, s.id); assert.ok(restored); assert.equal(restored.messages[0].content, "first"); });
  await test("catastrophic grep expressions have an execution deadline", async () => { const file = path.join(project, "backtracking.txt"); fs.writeFileSync(file, "a".repeat(20000) + "!"); const start = Date.now(); const r = await grepTool.run({ path: file, pattern: "(a+)+$" }, ctx()); assert.ok(r.isError); assert.ok(Date.now() - start < 1500); });
  const orchestrationApp = () => {
    saveConfig({ subagentMode: { tokenrouter: "session" } });
    const app = new App({ cwd: project, model: "audit-orchestration", autoApprove: true });
    app.catalog = [{ id: "audit-orchestration", chatCapable: true }];
    app.effortOverride = "off";
    app.tools = [{ name: "audit_read", risk: "read", description: "read", parameters: { type: "object" }, run: async () => ({ output: "owned test result" }) }];
    return app;
  };
  for (const scenario of ["cycle-plan", "failed-plan", "loop-plan"]) await test(`orchestration ${scenario} never runs a dependent writer`, async () => {
    mode = scenario; const n = requests.length; const app = orchestrationApp(); await runOrchestration(app, "owned regression task");
    const calls = requests.slice(n).filter((r) => r.data?.model === "audit-orchestration");
    assert.ok(calls.length > 0);
    assert.ok(!calls.some((r) => r.data.messages?.some((m) => m.role === "user" && String(m.content).startsWith("dependent writer"))));
    if (scenario === "cycle-plan") { assert.equal(calls.length, 1); assert.equal(app.usage.totals().requests, 1); }
    if (scenario === "failed-plan") assert.equal(calls.length, 2);
    if (scenario === "loop-plan") assert.ok(calls.length >= 5);
    assert.equal(app.session.orchestration.status, "failed");
    if (scenario !== "cycle-plan") assert.equal(app.session.orchestration.statuses.s2, "skipped");
    mode = "valid";
  });
} finally {
  childProcess.spawn = realSpawn; syncBuiltinESMExports();
  server.closeAllConnections(); await new Promise((r) => server.close(r));
  // Leave a failed run's owned artifacts for diagnosis; clean successful runs.
  if (!failed) fs.rmSync(home, { recursive: true, force: true });
}
console.log(`\n${passed} passed, ${failed} failed${failed ? `; artifacts: ${home}` : ""}`);
process.exitCode = failed ? 1 : 0;
