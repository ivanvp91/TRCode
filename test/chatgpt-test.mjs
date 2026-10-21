/** Official ChatGPT registration, signed identity, consent and Responses wire. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'trcode-chatgpt-'));
process.env.TRCODE_HOME = tempHome;
delete process.env.TOKENROUTER_API_KEY;
delete process.env.TR_API_KEY;
delete process.env.TRCODE_MODEL;
const creds = await import('../dist/provider/credentials.js');
const siwc = await import('../dist/provider/chatgpt.js');
const registry = await import('../dist/provider/registry.js');
const { saveConfig } = await import('../dist/config.js');
for (const provider of registry.providers()) provider.importFrom = undefined;

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'signing-key', alg: 'RS256', use: 'sig' };
const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const ed = crypto.generateKeyPairSync('ed25519');
const extraKeys = [
  { ...ec.publicKey.export({ format: 'jwk' }), kid: 'ec-key', alg: 'ES256', use: 'sig' },
  { ...ed.publicKey.export({ format: 'jwk' }), kid: 'ed-key', alg: 'EdDSA', use: 'sig' },
];
const issuer = 'https://auth.openai.com';
const scope = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const sign = (claims, algorithm = 'RS256') => {
  const kid = algorithm === 'ES256' ? 'ec-key' : algorithm === 'EdDSA' ? 'ed-key' : jwk.kid;
  const key = algorithm === 'ES256' ? { key: ec.privateKey, dsaEncoding: 'ieee-p1363' } : algorithm === 'EdDSA' ? ed.privateKey : privateKey;
  const data = [JSON.stringify({ alg: algorithm, kid }), JSON.stringify(claims)].map(x => Buffer.from(x).toString('base64url')).join('.');
  return data + '.' + crypto.sign(algorithm === 'EdDSA' ? null : 'sha256', Buffer.from(data), key).toString('base64url');
};
const attempts = new Map();
const requests = [];
let pageCount = 0;
let refreshCount = 0;
let revokeCount = 0;
let failExchange = false;
let refreshFailure;
let responseMode = 'completed';
let revokeFailure = false;
const api = http.createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  const params = Object.fromEntries(new URLSearchParams(body));
  requests.push({ url: req.url, headers: req.headers, body, params });
  const send = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json', 'x-request-id': 'req-mock' }); res.end(JSON.stringify(data)); };
  if (req.url === '/jwks') return send(200, { keys: [jwk, ...extraKeys] });
  if (req.url === '/discovery') return send(200, { issuer, revocation_endpoint: issuer + '/revoke' });
  if (req.url === '/revoke') { revokeCount++; res.writeHead(revokeFailure ? 503 : 200); return res.end(); }
  if (req.url === '/token') {
    assert.match(req.headers['content-type'], /application\/x-www-form-urlencoded/);
    if (params.grant_type === 'refresh_token') {
      refreshCount++;
      if (refreshFailure) return send(400, { error: refreshFailure });
      return send(200, { token_type: 'Bearer', access_token: 'refreshed-' + refreshCount, refresh_token: 'rotated-' + refreshCount, expires_in: 900 });
    }
    if (failExchange) { failExchange = false; return send(400, { error: 'invalid_grant' }); }
    const attempt = attempts.get(params.code);
    if (!attempt) return send(400, { error: 'invalid_grant' });
    const claims = { iss: issuer, aud: params.client_id, sub: attempt.subject ?? 'user-one', nonce: attempt.query.get('nonce'), exp: Date.now() / 1000 + 3600, email: 'person@example.test', ...attempt.claims };
    let idToken = sign(claims, attempt.algorithm);
    if (attempt.badSignature) {
      const parts = idToken.split('.');
      parts[2] = Buffer.alloc(256).toString('base64url');
      idToken = parts.join('.');
    }
    return send(200, { token_type: 'Bearer', access_token: 'access-' + params.code + '-' + params.client_id, refresh_token: 'refresh-' + params.code, expires_in: 900, id_token: idToken, scope: attempt.scope ?? scope });
  }
  if (req.url === '/models') return send(200, { models: [
    { slug: req.headers.authorization?.includes('second') ? 'gpt-second' : 'gpt-first', display_name: 'Available model', visibility: 'list' },
    { slug: 'hidden-model', visibility: 'hide' }, { slug: 'internal-model' },
  ] });
  if (req.url === '/responses') {
    if (responseMode === 'http-limit') return send(429, { error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'App allowance reached', param: 'model' } });
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'x-request-id': 'req-stream' });
    const event = item => res.write(`event: ${item.type}\ndata: ${JSON.stringify(item)}\n\n`);
    event({ type: 'response.output_text.delta', delta: 'Done' });
    if (responseMode === 'failed') event({ type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'App allowance reached', param: 'model' } } });
    else if (responseMode === 'incomplete') event({ type: 'response.incomplete', response: { status: 'incomplete' } });
    else if (responseMode !== 'truncated') event({ type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 10, output_tokens: 2 } } });
    return res.end();
  }
  send(404, {});
});
await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${api.address().port}`;
const endpoints = { oauth: { ...siwc.CHATGPT_OAUTH, authorizeUrl: base + '/authorize', tokenUrl: base + '/token', loginTimeoutMs: 3000 }, issuer, jwksUrl: base + '/jwks', discoveryUrl: base + '/discovery' };
const pages = [];
async function login(options = {}, behavior = {}) {
  return siwc.loginChatgpt({ ...options, onUrl: rawUrl => {
    const url = new URL(rawUrl);
    pages.push(url);
    const id = 'code-' + (++pageCount);
    const clientId = url.searchParams.get('client_id') === 'dynamic_agent_client' ? (behavior.clientId ?? 'oaiapp_trcode-' + pageCount) : url.searchParams.get('client_id');
    attempts.set(id, { query: url.searchParams, subject: options.profile?.subject, ...behavior });
    const callback = new URL(url.searchParams.get('redirect_uri'));
    callback.searchParams.set('state', behavior.wrongState ? 'wrong' : url.searchParams.get('state'));
    if (behavior.denied) callback.searchParams.set('error', 'access_denied');
    else callback.searchParams.set('code', id);
    if (!behavior.omitClientId && url.searchParams.get('client_id') === 'dynamic_agent_client') callback.searchParams.set('client_id', clientId);
    if (behavior.callbackClientId) callback.searchParams.set('client_id', behavior.callbackClientId);
    void fetch(callback).catch(() => {});
  } }, endpoints);
}

try {
  const first = await login();
  assert.equal(first.issuer, issuer);
  assert.equal(first.subject, 'user-one');
  assert.equal(first.email, 'person@example.test');
  assert.ok(first.clientId.startsWith('oaiapp_trcode-'));
  assert.equal(first.hostId, siwc.chatgptHostId());
  assert.equal(siwc.chatgptPlanEnabled(first), true);
  assert.equal(pages[0].searchParams.get('agent_name_hint'), 'TRCode');
  assert.equal(pages[0].searchParams.get('resource'), 'https://api.openai.com/v1');
  assert.equal(pages[0].searchParams.get('ext_agent_host_id'), first.hostId);
  assert.equal(pages[0].searchParams.get('code_challenge_method'), 'S256');
  assert.ok(pages[0].searchParams.get('nonce'));
  let exchange = requests.find(r => r.params.grant_type === 'authorization_code');
  assert.equal(exchange.params.client_id, first.clientId);
  assert.equal(exchange.params.resource, 'https://api.openai.com/v1');
  assert.equal(exchange.params.redirect_uri, pages[0].searchParams.get('redirect_uri'));
  assert.equal(crypto.createHash('sha256').update(exchange.params.code_verifier).digest('base64url'), pages[0].searchParams.get('code_challenge'));
  assert.equal(exchange.params.client_secret, undefined);
  assert.match(exchange.headers['user-agent'], /^trcode\//);
  const pointer = fs.readFileSync(path.join(tempHome, 'auth', 'openai.json'), 'utf8');
  assert.ok(!pointer.includes(first.accessToken));
  assert.equal(creds.readCredentials('openai').accessToken, first.accessToken);
  if (process.platform !== 'win32') assert.equal(fs.statSync(creds.chatgptProfilePath(first.clientId)).mode & 0o777, 0o600);
  console.log('PASS dynamic registration, PKCE, signed identity and protected profile');

  for (const behavior of [
    { badSignature: true }, { claims: { iss: 'https://attacker.test' } }, { claims: { aud: 'another-client' } },
    { claims: { nonce: 'another-attempt' } }, { claims: { exp: Date.now() / 1000 - 1 } },
    { claims: { sub: '' } }, { claims: { aud: [first.clientId, 'another'], azp: 'another' } },
    { omitClientId: true }, { wrongState: true }, { wrongState: true, denied: true },
  ]) {
    await assert.rejects(login({}, behavior));
    assert.equal(creds.readCredentials('openai').accessToken, first.accessToken);
  }
  await assert.rejects(login({ profile: first }, { subject: 'another-person' }), /different account/);
  await assert.rejects(login({ profile: first }, { callbackClientId: 'another-client' }), /different client/);
  console.log('PASS signature, issuer, audience, expiry, nonce, state and account mismatch rejection');

  const returned = await login({ profile: first });
  const returningPage = pages.at(-1);
  assert.equal(returningPage.searchParams.get('client_id'), first.clientId);
  assert.equal(returningPage.searchParams.get('agent_name_hint'), null);
  assert.equal(returningPage.searchParams.get('id_token_hint'), first.idToken);
  assert.equal(returningPage.searchParams.get('ext_agent_host_id'), first.hostId);
  assert.equal(new URL(siwc.publicChatgptLoginUrl(returningPage.toString())).searchParams.get('id_token_hint'), null);
  assert.equal(returned.clientId, first.clientId);
  assert.notEqual(returningPage.searchParams.get('nonce'), pages[0].searchParams.get('nonce'));
  assert.notEqual(returningPage.searchParams.get('code_challenge'), pages[0].searchParams.get('code_challenge'));
  console.log('PASS returning registration and redacted browser hints');

  failExchange = true;
  const retry = await login();
  assert.notEqual(pages.at(-2).searchParams.get('client_id'), pages.at(-1).searchParams.get('client_id'));
  assert.equal(pages.at(-1).searchParams.get('client_id'), retry.clientId);
  assert.equal(pages.at(-1).searchParams.get('agent_name_hint'), null);
  console.log('PASS invalid_grant restarts authorization using the retained issued client');

  const noPlan = await login({}, { scope: 'openid profile email offline_access' });
  assert.equal(siwc.chatgptPlanEnabled(noPlan), false);
  assert.equal(registry.modeFor('openai'), null);
  const beforeDisabled = requests.length;
  await assert.rejects(registry.resolveAuth('openai'), /plan usage is not enabled/);
  assert.equal(requests.length, beforeDisabled);
  assert.ok(creds.savedChatgptProfiles().some(p => p.clientId === noPlan.clientId));
  console.log('PASS identity-only sign-in is retained without inference permission');

  creds.selectChatgptProfile(first.clientId);
  const [refreshedA, refreshedB] = await Promise.all([
    siwc.refreshChatgpt(returned, true, endpoints), siwc.refreshChatgpt(returned, true, endpoints),
  ]);
  assert.equal(refreshCount, 1);
  assert.equal(refreshedA.accessToken, refreshedB.accessToken);
  assert.equal(refreshedA.refreshToken, 'rotated-1');
  assert.ok(refreshedA.scopes.includes(siwc.CHATGPT_SCOPE));
  const refresh = requests.find(r => r.params.grant_type === 'refresh_token');
  assert.equal(refresh.params.client_id, first.clientId);
  assert.equal(refresh.params.resource, 'https://api.openai.com/v1');
  assert.equal(refresh.params.scope, undefined);
  assert.equal(creds.readCredentials('openai').accessToken, refreshedA.accessToken);
  console.log('PASS serialized rotation and atomic profile refresh');

  const second = await login({}, { clientId: 'oaiapp_second', subject: 'user-two' });
  const models = await import('../dist/provider/models.js');
  const client = await import('../dist/provider/client.js');
  saveConfig({ apiKey: '', providers: { openai: { baseUrl: base } } });
  const secondModels = await models.fetchModels({ force: true });
  assert.deepEqual(secondModels.filter(m => m.id.startsWith('openai:')).map(m => m.id), ['openai:gpt-second']);
  creds.selectChatgptProfile(first.clientId);
  const firstModels = await models.fetchModels({ force: true });
  assert.deepEqual(firstModels.filter(m => m.id.startsWith('openai:')).map(m => m.id), ['openai:gpt-first']);
  creds.selectChatgptProfile(second.clientId);
  assert.ok(models.cachedModels().some(m => m.id === 'openai:gpt-second'));
  assert.ok(!models.cachedModels().some(m => m.id === 'openai:gpt-first'));
  console.log('PASS account selection, visible model filtering and separate catalogs');

  const request = {
    model: 'openai:gpt-second', conversationId: 'session-one',
    messages: [{ role: 'system', content: 'Project rules' }, { role: 'user', content: 'Read a file' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call-1', content: 'File contents' }],
    tools: [{ name: 'read', description: 'Read a local file', parameters: { type: 'object', properties: {} } }],
  };
  assert.equal((await client.complete(request)).content, 'Done');
  const call = requests.filter(r => r.url === '/responses').at(-1);
  const body = JSON.parse(call.body);
  assert.equal(body.store, false);
  assert.equal(body.stream, true);
  assert.equal(body.instructions, 'Project rules');
  assert.equal(body.tools[0].type, 'namespace');
  assert.equal(body.tools[0].name, 'trcode');
  assert.equal(body.tools[0].tools[0].name, 'read');
  assert.equal(body.input.find(item => item.type === 'function_call').namespace, 'trcode');
  assert.equal(body.max_output_tokens, undefined);
  assert.match(call.headers['user-agent'], /^trcode\//);
  assert.equal(call.headers.originator, undefined);
  assert.equal(call.headers['openai-beta'], undefined);
  assert.equal(call.headers['chatgpt-account-id'], undefined);
  for (const mode of ['truncated', 'incomplete', 'failed', 'http-limit']) {
    responseMode = mode;
    const count = requests.filter(r => r.url === '/responses').length;
    await assert.rejects(client.complete(request), err => {
      if (mode === 'failed' || mode === 'http-limit') {
        assert.equal(err.status, 429);
        assert.match(err.body, /subscription_sharing_usage_limit_exceeded/);
        assert.match(err.message, /settings\/usage/);
        assert.ok(err.requestId);
      } else assert.match(err.message, /without response.completed/);
      return true;
    });
    assert.equal(requests.filter(r => r.url === '/responses').length, count + 1);
  }
  responseMode = 'completed';
  console.log('PASS public Responses contract, namespaces and failed/interrupted stream handling');

  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, init) => realFetch(String(url) === issuer + '/revoke' ? base + '/revoke' : url, init);
  try {
    const out = await siwc.logoutChatgpt(endpoints);
    assert.deepEqual(out, { disconnected: true, revoked: true });
    assert.equal(creds.readCredentials('openai'), null);
    const saved = creds.readChatgptProfile(second.clientId);
    assert.equal(saved.clientId, second.clientId);
    assert.equal(saved.accessToken, '');
    assert.equal(saved.idToken, undefined);
    assert.equal(creds.readChatgptProfile(first.clientId).accessToken, refreshedA.accessToken);
    const revoke = requests.find(r => r.url === '/revoke');
    assert.equal(revoke.params.token_type_hint, 'refresh_token');
    assert.equal(revoke.params.client_id, second.clientId);
    assert.equal(revokeCount, 1);
    const again = await login({ profile: saved });
    assert.equal(again.clientId, second.clientId);
    assert.equal(pages.at(-1).searchParams.get('id_token_hint'), null);
    revokeFailure = true;
    const offlineOut = await siwc.logoutChatgpt(endpoints);
    assert.equal(offlineOut.revoked, false);
    assert.equal(creds.readCredentials('openai'), null);
    assert.equal(revokeCount, 3);
  } finally { globalThis.fetch = realFetch; }
  console.log('PASS session revocation, retained registration and honest offline logout result');

  creds.selectChatgptProfile(first.clientId);
  refreshFailure = 'invalid_grant';
  await assert.rejects(siwc.refreshChatgpt(refreshedA, true, endpoints), err => err.code === 'invalid_grant');
  assert.equal(creds.readChatgptProfile(first.clientId).accessToken, '');
  assert.equal(creds.readChatgptProfile(first.clientId).clientId, first.clientId);
  console.log('PASS terminal refresh failure clears tokens but keeps the registration');

  for (const algorithm of ['ES256', 'EdDSA']) {
    const signed = await login({}, { algorithm });
    assert.equal(siwc.chatgptPlanEnabled(signed), true);
  }
  console.log('PASS EC and Ed25519 ID token signatures');
} finally {
  api.closeAllConnections();
  await new Promise(resolve => api.close(resolve));
  fs.rmSync(tempHome, { recursive: true, force: true });
}
console.log('ChatGPT official integration checks passed.');
