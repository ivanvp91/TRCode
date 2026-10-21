/** Official Sign in with ChatGPT for locally run open-source clients. */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { configDir, ensureDir, VERSION } from "../config.js";
import {
  activeChatgptClientId, chatgptProfilePath, clearChatgptTokens, clearCredentials, isStale, readChatgptProfile,
  readCredentials, saveChatgptProfile, writeCredentials, type Credentials,
} from "./credentials.js";
import { authorizeUrl, callbackServer, makePkce, OAuthError, postForm, withDeadline, type WebFlowConfig, type WebLoginOptions } from "./oauth.js";

export const CHATGPT_SCOPE = "chatgpt.tokens.use.direct";
const RESOURCE = "https://api.openai.com/v1";
const ISSUER = "https://auth.openai.com";
const USER_AGENT = `trcode/${VERSION}`;

export const CHATGPT_OAUTH: WebFlowConfig = {
  kind: "web",
  clientId: "dynamic_agent_client",
  authorizeUrl: `${ISSUER}/api/accounts/authorize`,
  tokenUrl: `${ISSUER}/api/accounts/oauth/token`,
  redirectUri: "http://127.0.0.1:{port}/auth/callback",
  scope: `openid profile email offline_access resource.invoke ${CHATGPT_SCOPE}`,
  params: { resource: RESOURCE },
  headers: { "User-Agent": USER_AGENT },
};

export interface ChatgptEndpoints {
  oauth: WebFlowConfig;
  issuer: string;
  jwksUrl: string;
  discoveryUrl: string;
}

const ENDPOINTS: ChatgptEndpoints = {
  oauth: CHATGPT_OAUTH,
  issuer: ISSUER,
  jwksUrl: `${ISSUER}/.well-known/jwks.json`,
  discoveryUrl: `${ISSUER}/.well-known/openid-configuration`,
};

/** Never accept legacy Codex tokens as registrations for this app. */
export function isChatgptRegistration(creds: Credentials | null): boolean {
  return Boolean(creds?.mode === "oauth" && creds.clientId && creds.clientId !== "dynamic_agent_client"
    && creds.hostId && creds.issuer === ISSUER && creds.subject);
}

export function chatgptPlanEnabled(creds: Credentials | null): boolean {
  return isChatgptRegistration(creds) && Boolean(creds?.accessToken && creds.scopes?.includes(CHATGPT_SCOPE));
}

export function chatgptHostId(): string {
  const file = path.join(ensureDir(path.join(configDir(), "auth")), "openai-host-id");
  const valid = (value: string) => /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (!valid(existing)) throw new Error("Invalid ChatGPT host ID; restore its original value before signing in.");
    return existing;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const value = `urn:uuid:${crypto.randomUUID()}`;
  try { fs.writeFileSync(file, value + "\n", { flag: "wx", mode: 0o600 }); }
  catch (err) { if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err; return chatgptHostId(); }
  return value;
}

async function jsonGet(url: string): Promise<any> {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new OAuthError(`Identity service returned HTTP ${res.status}`, "identity_unavailable");
  return res.json();
}

/** Verify the signature before reading any account identity from the payload. */
async function verifiedIdentity(token: unknown, clientId: string, nonce: string | undefined, endpoints: ChatgptEndpoints): Promise<any> {
  if (typeof token !== "string") throw new OAuthError("Missing OpenAI ID token", "invalid_id_token");
  const parts = token.split(".");
  if (parts.length !== 3) throw new OAuthError("Malformed OpenAI ID token", "invalid_id_token");
  let header: any;
  try { header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")); }
  catch { throw new OAuthError("Malformed OpenAI ID token header", "invalid_id_token"); }
  if (!["RS256", "ES256", "EdDSA"].includes(header.alg) || !header.kid || header.crit) {
    throw new OAuthError("Unsupported OpenAI ID token signature", "invalid_id_token");
  }
  const jwks = await jsonGet(endpoints.jwksUrl);
  const expectedType = header.alg === "RS256" ? "RSA" : header.alg === "ES256" ? "EC" : "OKP";
  const jwk = jwks.keys?.find((key: any) => key.kid === header.kid && key.kty === expectedType
    && (!key.alg || key.alg === header.alg) && (!key.use || key.use === "sig")
    && (!key.key_ops || key.key_ops.includes("verify")));
  if (!jwk) throw new OAuthError("OpenAI signing key was not found", "invalid_id_token");
  let verified = false;
  try {
    const key = crypto.createPublicKey({ key: jwk, format: "jwk" });
    verified = crypto.verify(header.alg === "EdDSA" ? null : "sha256", Buffer.from(`${parts[0]}.${parts[1]}`),
      { key, dsaEncoding: "ieee-p1363", padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(parts[2], "base64url"));
  } catch { /* invalid key or signature */ }
  if (!verified) throw new OAuthError("OpenAI ID token signature is invalid", "invalid_id_token");
  let claims: any;
  try { claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")); }
  catch { throw new OAuthError("Malformed OpenAI ID token claims", "invalid_id_token"); }
  const now = Date.now() / 1000;
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== endpoints.issuer || !audience.includes(clientId)
    || (audience.length > 1 && claims.azp !== clientId) || (claims.azp && claims.azp !== clientId)
    || typeof claims.exp !== "number" || claims.exp <= now
    || (claims.nbf !== undefined && (typeof claims.nbf !== "number" || claims.nbf > now + 30))
    || (claims.iat !== undefined && (typeof claims.iat !== "number" || claims.iat > now + 30))
    || typeof claims.sub !== "string" || !claims.sub || (nonce !== undefined && claims.nonce !== nonce)) {
    throw new OAuthError("OpenAI ID token identity, audience, expiry or nonce is invalid", "invalid_id_token");
  }
  return claims;
}

function tokens(json: any, previous?: Credentials): Pick<Credentials, "accessToken" | "refreshToken" | "expiresAt" | "scopes"> {
  if (typeof json.access_token !== "string" || !json.access_token || String(json.token_type ?? "Bearer").toLowerCase() !== "bearer"
    || !Number.isFinite(Number(json.expires_in)) || Number(json.expires_in) <= 0) {
    throw new OAuthError("Incomplete OpenAI token response", "bad_response");
  }
  return {
    accessToken: json.access_token,
    refreshToken: typeof json.refresh_token === "string" && json.refresh_token ? json.refresh_token : previous?.refreshToken,
    expiresAt: Date.now() + Number(json.expires_in) * 1000,
    scopes: typeof json.scope === "string" ? json.scope.split(/\s+/).filter(Boolean) : previous?.scopes ?? [],
  };
}

/** The URL printed in terminals must never expose a retained ID token. */
export function publicChatgptLoginUrl(url: string): string {
  const publicUrl = new URL(url);
  publicUrl.searchParams.delete("id_token_hint");
  return publicUrl.toString();
}

/** Only activates a registration after its returned identity has been verified. */
export async function loginChatgpt(
  opts: WebLoginOptions & { profile?: Credentials; enablePlan?: boolean } = {},
  endpoints: ChatgptEndpoints = ENDPOINTS,
): Promise<Credentials> {
  const hostId = chatgptHostId();
  const previous = opts.profile;
  if (previous?.hostId && previous.hostId !== hostId) throw new OAuthError("This ChatGPT registration belongs to another host. Add a new account here.", "host_mismatch");
  let clientId = previous?.clientId ?? "dynamic_agent_client";
  // An expired authorization code is never replayed; start one fresh attempt.
  for (let attempt = 0; ; attempt++) {
    const pkce = makePkce();
    const nonce = crypto.randomBytes(32).toString("base64url");
    const listener = await callbackServer(endpoints.oauth.redirectUri, pkce.state);
    try {
      const dynamic = clientId === "dynamic_agent_client";
      const cfg: WebFlowConfig = {
        ...endpoints.oauth, clientId,
        params: {
          ...endpoints.oauth.params, resource: RESOURCE, ext_agent_host_id: hostId, nonce,
          ...(dynamic ? { agent_name_hint: "TRCode" } : {}),
          ...(!dynamic && previous?.idToken ? { id_token_hint: previous.idToken } : {}),
          ...(!dynamic && previous?.email ? { login_hint: previous.email } : {}),
          ...(opts.enablePlan ? { prompt: "consent" } : {}),
        },
      };
      opts.onUrl?.(authorizeUrl(cfg, pkce, listener.redirectUri));
      const callback = await withDeadline(listener.code, opts.signal, cfg.loginTimeoutMs ?? 5 * 60_000);
      if (opts.signal?.aborted) throw new OAuthError("Cancelled", "cancelled");
      if ((dynamic && (!callback.clientId || callback.clientId === "dynamic_agent_client"))
        || (!dynamic && callback.clientId && callback.clientId !== clientId)) {
        throw new OAuthError("ChatGPT returned an incomplete or different client registration", "client_mismatch");
      }
      clientId = callback.clientId ?? clientId;
      // Retain the issued registration on code-exchange failures; no tokens or
      // unverified identity are made active by saving this pending record.
      if (!previous && !readChatgptProfile(clientId)) saveChatgptProfile({ mode: "oauth", accessToken: "", clientId, hostId, issuer: endpoints.issuer });
      const json = await postForm(cfg.tokenUrl, {
        grant_type: "authorization_code", client_id: clientId, code: callback.code,
        code_verifier: pkce.verifier, redirect_uri: listener.redirectUri, resource: RESOURCE,
      }, cfg.headers);
      const identity = await verifiedIdentity(json.id_token, clientId, nonce, endpoints);
      const expected = previous ?? readChatgptProfile(clientId);
      if (expected?.subject && (identity.sub !== expected.subject || identity.iss !== expected.issuer)) {
        throw new OAuthError("ChatGPT returned a different account. Add it as a new account instead.", "account_mismatch");
      }
      const creds: Credentials = {
        mode: "oauth", ...tokens(json), clientId, hostId, issuer: identity.iss, subject: identity.sub,
        email: typeof identity.email === "string" ? identity.email : undefined,
        idToken: json.id_token, source: "Sign in with ChatGPT (TRCode)",
      };
      if (opts.signal?.aborted) throw new OAuthError("Cancelled", "cancelled");
      return writeCredentials("openai", creds);
    } catch (err) {
      if ((err as OAuthError).code !== "invalid_grant" || attempt >= 1) throw err;
    } finally { listener.close(); }
  }
}

/** Lock the canonical profile across CLI processes before rotating its token. */
async function withProfileLock<T>(creds: Credentials, run: () => Promise<T>): Promise<T> {
  const file = `${chatgptProfilePath(creds.clientId!)}.lock`;
  ensureDir(path.dirname(file));
  const deadline = Date.now() + 30_000;
  const owner = `${process.pid}:${crypto.randomUUID()}`;
  for (;;) {
    try { fs.writeFileSync(file, owner, { flag: "wx", mode: 0o600 }); break; }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      try {
        const pid = Number(fs.readFileSync(file, "utf8").split(":")[0]);
        if (pid > 0) process.kill(pid, 0);
      } catch (check) {
        if ((check as NodeJS.ErrnoException).code === "ESRCH") { try { fs.unlinkSync(file); } catch { /* another waiter */ } continue; }
      }
      if (Date.now() >= deadline) throw new OAuthError("Another process is refreshing this ChatGPT account. Try again shortly.", "refresh_busy");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  try { return await run(); }
  finally { try { if (fs.readFileSync(file, "utf8") === owner) fs.unlinkSync(file); } catch { /* already removed */ } }
}

export async function refreshChatgpt(creds: Credentials, force = false, endpoints: ChatgptEndpoints = ENDPOINTS): Promise<Credentials> {
  if (!isChatgptRegistration(creds)) throw new OAuthError("Sign in with ChatGPT using TRCode's own registration.", "invalid_client");
  return withProfileLock(creds, async () => {
    const current = readChatgptProfile(creds.clientId!) ?? creds;
    if (!current.accessToken || !current.refreshToken) throw new OAuthError("Sign in with ChatGPT again.", "no_refresh_token");
    if (current.accessToken !== creds.accessToken || (!force && !isStale(current))) return current;
    try {
      const json = await postForm(endpoints.oauth.tokenUrl, {
        grant_type: "refresh_token", client_id: current.clientId!, refresh_token: current.refreshToken, resource: RESOURCE,
      }, endpoints.oauth.headers);
      if (json.id_token) {
        const identity = await verifiedIdentity(json.id_token, current.clientId!, undefined, endpoints);
        if (identity.sub !== current.subject || identity.iss !== current.issuer) throw new OAuthError("ChatGPT refreshed a different account", "account_mismatch");
      }
      const next = { ...current, ...tokens(json, current), idToken: json.id_token ?? current.idToken };
      saveChatgptProfile(next);
      return next;
    } catch (err) {
      if (["invalid_grant", "invalid_refresh_token", "token_expired", "refresh_token_expired", "refresh_token_invalidated", "refresh_token_reused"].includes((err as OAuthError).code)) clearChatgptTokens(current);
      throw err;
    }
  });
}

/** Signing out revokes this registration's renewable session, then clears it locally. */
export async function logoutChatgpt(endpoints: ChatgptEndpoints = ENDPOINTS): Promise<{ disconnected: boolean; revoked: boolean }> {
  const creds = readCredentials("openai");
  if (!creds) return { disconnected: clearCredentials("openai"), revoked: true };
  if (creds.mode !== "oauth") return { disconnected: clearCredentials("openai"), revoked: true };
  if (!isChatgptRegistration(creds)) return { disconnected: clearCredentials("openai"), revoked: false };
  const result = await withProfileLock(creds, async () => {
    const current = readChatgptProfile(creds.clientId!) ?? creds;
    let revoked = !current.refreshToken;
    if (current.refreshToken) {
      try {
        const discovery = await jsonGet(endpoints.discoveryUrl);
        const revocation = new URL(discovery.revocation_endpoint);
        if (revocation.origin !== new URL(endpoints.issuer).origin) throw new Error("Unexpected OpenAI revocation endpoint");
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const res = await fetch(revocation, { method: "POST", signal: AbortSignal.timeout(15_000),
              headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": USER_AGENT },
              body: new URLSearchParams({ token: current.refreshToken!, token_type_hint: "refresh_token", client_id: current.clientId! }),
            });
            if (res.status === 200) { revoked = true; break; }
            if (res.status < 500) break;
          } catch { /* retry once, then clear locally with an explicit warning */ }
          if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 250));
        }
      } catch { /* discovery unavailable: remote revocation remains unconfirmed */ }
    }
    clearChatgptTokens(current);
    return { disconnected: true, revoked };
  });
  if (activeChatgptClientId() === creds.clientId) clearCredentials("openai");
  return result;
}
