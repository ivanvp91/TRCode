/** Gemini uses the documented public API with an AI Studio key. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'trcode-gemini-api-'));
process.env.TRCODE_HOME = tempHome;
delete process.env.TOKENROUTER_API_KEY;
delete process.env.TR_API_KEY;
delete process.env.TRCODE_MODEL;
const { saveConfig } = await import('../dist/config.js');
const registry = await import('../dist/provider/registry.js');
const creds = await import('../dist/provider/credentials.js');
const { loginProvider } = await import('../dist/ui/login.js');
const client = await import('../dist/provider/client.js');
for (const provider of registry.providers()) provider.importFrom = undefined;
const def = registry.providerById('gemini');
assert.equal(def.oauth, undefined);
assert.equal(def.modes.oauth, undefined);
assert.equal(def.importFrom, undefined);
assert.equal(def.modes.apikey.baseUrl, 'https://generativelanguage.googleapis.com/v1beta/openai');

const calls = [];
const server = http.createServer(async (req, res) => {
  let text = '';
  for await (const chunk of req) text += chunk;
  const body = text ? JSON.parse(text) : undefined;
  calls.push({ url: req.url, headers: req.headers, body });
  if (req.headers.authorization !== 'Bearer ai-studio-key') { res.writeHead(401); return res.end('{"error":{"message":"Invalid API key"}}'); }
  if (req.url === '/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ data: [{ id: 'gemini-3.8-flash', object: 'model', owned_by: 'google' }] }));
  }
  if (req.url === '/chat/completions') {
    if (body.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Hello' } }] }) + '\n\n');
      res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 1 } }) + '\n\n');
      return res.end('data: [DONE]\n\n');
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ choices: [{ message: { content: 'Hello' }, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 1 } }));
  }
  res.writeHead(404).end();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  const base = `http://127.0.0.1:${server.address().port}`;
  saveConfig({ apiKey: '', providers: { gemini: { baseUrl: base } } });
  const login = await loginProvider(def, { key: 'ai-studio-key', exclusive: async () => { throw new Error('Unexpected browser-login selection'); } });
  assert.equal(login.connected, true);
  assert.equal(login.usable, true);
  assert.equal(creds.readCredentials('gemini').mode, 'apikey');
  assert.equal(registry.modeFor('gemini'), 'apikey');
  const request = { model: 'gemini:gemini-3.8-flash', messages: [{ role: 'user', content: 'Hello' }] };
  assert.equal((await client.complete(request)).content, 'Hello');
  const events = [];
  for await (const event of client.streamChat(request)) events.push(event);
  assert.equal(events.filter(e => e.type === 'text').map(e => e.text).join(''), 'Hello');
  assert.equal(events.at(-1).type, 'done');
  assert.ok(calls.every(call => /^trcode\//.test(call.headers['user-agent'])));
  assert.ok(calls.every(call => call.url === '/models' || call.url === '/chat/completions'));
  assert.ok(calls.filter(call => call.body).every(call => Array.isArray(call.body.messages) && call.body.project === undefined && call.body.request === undefined));
  console.log('PASS Gemini key login, model catalog, completions and streaming use public API shapes');

  saveConfig({ providers: { gemini: { baseUrl: 'https://cloudcode-pa.googleapis.com/v1internal', headers: { 'User-Agent': 'GeminiCLI/old' } } } });
  const migrated = await registry.resolveAuth('gemini');
  assert.equal(migrated.baseUrl, def.modes.apikey.baseUrl);
  assert.equal(migrated.headers['User-Agent'], undefined);
  console.log('PASS retired Code Assist endpoint and client impersonation overrides are ignored');

  const realFetch = globalThis.fetch;
  let network = 0;
  globalThis.fetch = async () => { network++; throw new Error('Legacy Gemini OAuth must not access the network'); };
  try {
    for (const expiresAt of [Date.now() + 3600_000, Date.now() - 3600_000]) {
      creds.writeCredentials('gemini', { mode: 'oauth', accessToken: 'old-cli-token', refreshToken: 'old-cli-refresh', expiresAt });
      assert.equal(registry.modeFor('gemini'), null);
      await assert.rejects(registry.resolveAuth('gemini'), /auth login --provider gemini --key/);
      assert.equal(await registry.renewRejectedToken('gemini'), false);
    }
    assert.equal((await loginProvider(def, { mode: 'oauth' })).connected, false);
    assert.equal(network, 0);
  } finally { globalThis.fetch = realFetch; }
  console.log('PASS legacy CLI sessions and explicit OAuth login are rejected without network access');
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(tempHome, { recursive: true, force: true });
}
console.log('Gemini public API checks passed.');
