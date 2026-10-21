/**
 * OAuth 2.0, in the two shapes a terminal can log in with.
 *
 * Device Authorization Grant (RFC 8628) is the one terminals prefer: ask for a
 * code, show the user a URL to open on any device, poll until they approve. No
 * redirect URI, no local callback server, no browser needed on the machine
 * running the CLI — which is the point when the CLI is on a remote box over ssh.
 *
 * Authorization Code + PKCE is the shape hosts without a device grant speak
 * (OpenAI's ChatGPT sign-in among them). It needs a loopback listener for the
 * single redirect, so the browser has to open on the same machine — or the URL
 * has to be carried over and the callback waited out here.
 *
 * RFC 8628 specifies form-encoded bodies, but several hosts only accept JSON,
 * so each request tries form first and falls back once. Costs one round-trip
 * on a host that wants JSON, and only on the first call — the encoding can
 * also be declared outright when a host is known to want one.
 */
import crypto from "node:crypto";
import http from "node:http";
import type { Credentials } from "./credentials.js";

export interface DeviceFlowConfig {
  kind?: "device";
  /** Body encoding the token endpoint expects. RFC 8628 says form. */
  encoding?: Encoding;
  clientId: string;
  deviceAuthUrl: string;
  tokenUrl: string;
  scope?: string;
  /** Sent on the OAuth calls themselves; some hosts gate on it. */
  headers?: Record<string, string>;
  /** Extra fields for the device-code request, beyond client_id and scope. */
  params?: Record<string, string>;
}

export interface WebFlowConfig {
  kind: "web";
  clientId: string;
  authorizeUrl: string;
  tokenUrl: string;
  /** Loopback URL the host redirects to; its port is the one we listen on. */
  redirectUri: string;
  /**
   * Further loopback ports the host also has on its redirect allow-list, tried
   * in order when the first one is taken (the ChatGPT sign-in falls back to 1457).
   */
  fallbackRedirectUris?: string[];
  scope?: string;
  /**
   * Sent beside the client id on the token calls. Installed-app clients still
   * carry one — Google refuses an exchange without it, and it is not secret by
   * design (it ships in the client's own binary).
   */
  clientSecret?: string;
  /** Body encoding of the code exchange. RFC 6749 says form. */
  encoding?: Encoding;
  /** Body encoding of the refresh call, when the host differs from exchange. */
  refreshEncoding?: Encoding;
  /** Sent on the OAuth calls themselves; some hosts gate on it. */
  headers?: Record<string, string>;
  /** Extra query parameters on the authorize URL, beyond the standard set. */
  params?: Record<string, string>;  /**
   * The header that names the account a token acts for, on a host that serves
   * several and refuses a request naming none. The value is read out of the
   * token itself (accountClaim) and carried in Credentials.orgId.
   */
  accountHeader?: string;
  /** Where that account sits in a token: a claim, then a field inside it. */
  accountClaim?: { claim: string; field: string };
  /** How long to wait for the browser. Five minutes when unset. */
  loginTimeoutMs?: number;
}

export type Encoding = "form" | "json";

export type FlowConfig = DeviceFlowConfig | WebFlowConfig;

export interface DeviceCode {
  deviceCode: string;
  userCode: string;
  /** Page the user opens and types the code into. */
  verificationUri: string;
  /** Same page with the code pre-filled, when the host offers one. */
  verificationUriComplete?: string;
  /** Epoch ms after which the code is dead. */
  expiresAt: number;
  /** Seconds to wait between polls, per the host. */
  interval: number;
}

export class OAuthError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "OAuthError";
  }
}

async function postForm(
  url: string,
  params: Record<string, string>,
  headers: Record<string, string> = {},
  encoding: Encoding = "form",
): Promise<any> {
  const form = { body: new URLSearchParams(params).toString(), contentType: "application/x-www-form-urlencoded" };
  const json = { body: JSON.stringify(params), contentType: "application/json" };
  // The declared encoding goes first. A host that wants JSON answers a form
  // post with a normal OAuth error, which reads as "bad grant" and stops the
  // retry below — so guessing wrong is not recoverable, and is not guessed.
  const attempts = encoding === "json" ? [json, form] : [form, json];

  let last: { status: number; text: string } | null = null;
  for (const attempt of attempts) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": attempt.contentType, Accept: "application/json", ...headers },
      body: attempt.body,
    });
    const text = await res.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }

    // A standard OAuth error body is a real answer, not a reason to re-encode.
    if (json?.error) {
      throw new OAuthError(String(json.error_description ?? json.error), String(json.error));
    }
    if (res.ok && json) return json;
    last = { status: res.status, text };
    // 415/400 with no OAuth error body reads as "wrong encoding" — try JSON.
    if (res.status !== 400 && res.status !== 415) break;
  }
  throw new OAuthError(
    `HTTP ${last?.status ?? 0} from ${url}${last?.text ? ` — ${last.text.slice(0, 200)}` : ""}`,
    "http_error",
  );
}

export async function requestDeviceCode(cfg: DeviceFlowConfig): Promise<DeviceCode> {
  const params: Record<string, string> = { client_id: cfg.clientId, ...cfg.params };
  if (cfg.scope) params.scope = cfg.scope;
  const json = await postForm(cfg.deviceAuthUrl, params, cfg.headers, cfg.encoding);

  const deviceCode = String(json.device_code ?? json.deviceCode ?? "");
  const userCode = String(json.user_code ?? json.userCode ?? "");
  const uri = String(json.verification_uri ?? json.verificationUri ?? json.verification_url ?? "");
  if (!deviceCode || !uri) {
    throw new OAuthError("The host did not return a device code", "bad_response");
  }
  const expiresIn = Number(json.expires_in ?? json.expiresIn ?? 600);
  const complete = json.verification_uri_complete ?? json.verificationUriComplete ?? undefined;
  return {
    deviceCode,
    userCode,
    // Some hosts answer with paths ("/console/device") rather than URLs; they
    // are relative to the host that issued the code.
    verificationUri: absolute(uri, cfg.deviceAuthUrl),
    verificationUriComplete: complete ? absolute(String(complete), cfg.deviceAuthUrl) : undefined,
    expiresAt: Date.now() + expiresIn * 1000,
    // RFC 8628 says 5s when the host stays silent.
    interval: Math.max(1, Number(json.interval ?? 5)),
  };
}

function absolute(uri: string, base: string): string {
  try {
    return new URL(uri, base).toString();
  } catch {
    return uri;
  }
}

function toCredentials(json: any, source: string): Credentials {
  const accessToken = String(json.access_token ?? json.accessToken ?? "");
  if (!accessToken) throw new OAuthError("No access token in the response", "bad_response");
  const expiresIn = Number(json.expires_in ?? json.expiresIn ?? 0);
  // Hosts that issue JWTs sometimes state no lifetime at all; the token then
  // carries its own `exp`, which is the same answer one decode away. The id
  // token is what the host stamps, so it is read when the access one is opaque.
  const exp = Number(jwtClaims(accessToken)?.exp ?? jwtClaims(json.id_token)?.exp ?? 0);
  return {
    mode: "oauth",
    accessToken,
    refreshToken: json.refresh_token ?? json.refreshToken ?? undefined,
    expiresAt: expiresIn > 0 ? Date.now() + expiresIn * 1000 : exp > 0 ? exp * 1000 : undefined,
    // Set when the user picked a workspace on the approval page.
    orgId: json.org_id ?? undefined,
    source,
  };
}

/**
 * Polls until the user approves. `onWait` is called before each sleep so the
 * caller can keep a spinner honest about how long is left.
 */
export async function pollForToken(
  cfg: DeviceFlowConfig,
  device: DeviceCode,
  opts: { onWait?: (secondsLeft: number) => void; signal?: AbortSignal } = {},
): Promise<Credentials> {
  let interval = device.interval;
  for (;;) {
    if (opts.signal?.aborted) throw new OAuthError("Cancelled", "cancelled");
    if (Date.now() >= device.expiresAt) {
      throw new OAuthError("The code expired before it was approved", "expired_token");
    }
    opts.onWait?.(Math.max(0, Math.round((device.expiresAt - Date.now()) / 1000)));
    await sleep(interval * 1000, opts.signal);

    try {
      const json = await postForm(
        cfg.tokenUrl,
        {
          client_id: cfg.clientId,
          device_code: device.deviceCode,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        },
        cfg.headers,
        cfg.encoding,
      );
      return toCredentials(json, "device flow");
    } catch (err) {
      if (!(err instanceof OAuthError)) throw err;
      // The two codes that mean "keep going"; everything else is terminal.
      if (err.code === "authorization_pending") continue;
      if (err.code === "slow_down") {
        interval += 5;
        continue;
      }
      throw err;
    }
  }
}

/** PKCE (RFC 7636): the secret we keep, its hash on the wire, and a state to match. */
export function makePkce(): { verifier: string; challenge: string; state: string } {
  const b64url = (b: Buffer) => b.toString("base64url");
  const verifier = b64url(crypto.randomBytes(64));
  return {
    verifier,
    challenge: b64url(crypto.createHash("sha256").update(verifier).digest()),
    state: b64url(crypto.randomBytes(32)),
  };
}

/** The page the user is sent to, with the parameters every PKCE host expects. */
export function authorizeUrl(
  cfg: WebFlowConfig,
  pkce: { challenge: string; state: string },
  redirectUri: string = cfg.redirectUri,
): string {
  const url = new URL(cfg.authorizeUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", cfg.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  if (cfg.scope) url.searchParams.set("scope", cfg.scope);
  url.searchParams.set("code_challenge", pkce.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", pkce.state);
  for (const [key, value] of Object.entries(cfg.params ?? {})) url.searchParams.set(key, value);
  return url.toString();
}

export interface WebLoginOptions {
  /** Called once the listener is up, with the page the browser should open. */
  onUrl?: (url: string) => void;
  signal?: AbortSignal;
}

/**
 * The whole browser round-trip: listen on the loopback port the redirect names,
 * hand the URL back for the caller to print, wait for that one redirect, trade
 * the code, and read the account out of the token when the host names it there.
 */
export async function webLogin(cfg: WebFlowConfig, opts: WebLoginOptions = {}): Promise<Credentials> {
  const pkce = makePkce();
  // The host allow-lists these ports, and its own CLI may hold the first one.
  let listener: { code: Promise<string>; close: () => void; redirectUri: string } | null = null;
  let lastError: unknown;
  for (const uri of [cfg.redirectUri, ...(cfg.fallbackRedirectUris ?? [])]) {
    try {
      listener = await callbackServer(uri, pkce.state);
      break;
    } catch (err) {
      lastError = err;
    }
  }
  if (!listener) throw lastError;
  try {
    opts.onUrl?.(authorizeUrl(cfg, pkce, listener.redirectUri));
    const code = await withDeadline(listener.code, opts.signal, cfg.loginTimeoutMs ?? 5 * 60_000);
    return await exchangeCode(cfg, code, pkce.verifier, listener.redirectUri);
  } finally {
    listener.close();
  }
}

async function exchangeCode(
  cfg: WebFlowConfig,
  code: string,
  verifier: string,
  redirectUri: string,
): Promise<Credentials> {
  const json = await postForm(
    cfg.tokenUrl,
    {
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: cfg.clientId,
      ...(cfg.clientSecret ? { client_secret: cfg.clientSecret } : {}),
      code_verifier: verifier,
    },
    cfg.headers,
    cfg.encoding,
  );
  return withAccount(cfg, toCredentials(json, "browser login"), json);
}

/** The account a token acts for, for hosts that keep it in the token and not in a list. */
function withAccount(cfg: WebFlowConfig, creds: Credentials, json: any): Credentials {
  const claim = cfg.accountClaim;
  if (!claim) return creds;
  const claims = jwtClaims(json?.id_token) ?? jwtClaims(creds.accessToken);
  const group = claims?.[claim.claim];
  if (!group || typeof group !== "object") return creds;
  const id = (group as Record<string, unknown>)[claim.field];
  if (typeof id !== "string" || !id) return creds;
  const plan = (group as Record<string, unknown>).chatgpt_plan_type;
  return { ...creds, orgId: id, orgName: typeof plan === "string" ? plan : undefined };
}

/** The payload of a JWT, unverified — the host signed it, and we only read it. */
export function jwtClaims(token: string | undefined): any {
  const part = String(token ?? "").split(".")[1];
  if (!part) return undefined;
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
}

/**
 * A one-shot loopback listener for the redirect. It answers whatever arrives on
 * its path — a stray request from a browser prefetch gets a 404 and no verdict —
 * and settles on the first callback that carries a code or an error.
 */
function callbackServer(
  redirectUri: string,
  state: string,
): Promise<{ code: Promise<string>; close: () => void; redirectUri: string }> {
  // A host whose allow-list takes any loopback port (Google's installed-app
  // clients) states the redirect as a template; the port is chosen by binding
  // to 0, and the real one is what goes into the authorize URL.
  const dynamic = redirectUri.includes("{port}");
  const target = new URL(redirectUri.replace("{port}", "0"));
  const port = Number(target.port || (target.protocol === "https:" ? 443 : 80));
  const host = target.hostname || "127.0.0.1";
  const path = target.pathname || "/";

  let settle!: (err: Error | null, code?: string) => void;
  const code = new Promise<string>((resolve, reject) => {
    settle = (err, value) => (err ? reject(err) : resolve(String(value)));
  });
  // Closing a login that never finished must not surface as an unhandled rejection.
  code.catch(() => {});
  let answered = false;

  const server = http.createServer((req, res) => {
    const got = new URL(req.url ?? "/", `http://${req.headers.host ?? target.host}`);
    if (got.pathname !== path) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("not found");
      return;
    }
    const failure = got.searchParams.get("error");
    const returned = got.searchParams.get("code");
    const seen = got.searchParams.get("state");
    const ok = !failure && Boolean(returned) && seen === state;
    res
      .writeHead(ok ? 200 : 400, { "Content-Type": "text/html; charset=utf-8" })
      .end(resultPage(ok, failure));
    if (answered) return;
    answered = true;
    if (failure) settle(new OAuthError(got.searchParams.get("error_description") ?? failure, failure));
    else if (seen !== state) settle(new OAuthError("The approval came back for another login attempt", "state_mismatch"));
    else if (!returned) settle(new OAuthError("The approval carried no code", "bad_response"));
    else settle(null, returned);
  });

  return new Promise((resolve, reject) => {
    server.once("error", (err: NodeJS.ErrnoException) => {
      reject(
        new OAuthError(
          err.code === "EADDRINUSE"
            ? `Port ${port} is busy — another login, or the vendor's own CLI, is listening there`
            : `Could not listen on ${target.host}: ${err.message}`,
          "listen_failed",
        ),
      );
    });
    server.listen(dynamic ? 0 : port, host, () => {
      const bound = server.address();
      const actualPort = bound && typeof bound === "object" ? bound.port : port;
      resolve({
        code,
        redirectUri: redirectUri.replace("{port}", String(actualPort)),
        close: () => {
          settle(new OAuthError("Cancelled", "cancelled"));
          try {
            server.close();
          } catch {
            /* already closed */
          }
        },
      });
    });
  });
}

function resultPage(ok: boolean, failure: string | null): string {
  const title = ok ? "Signed in" : "Sign-in failed";
  const body = ok
    ? "You can close this tab and return to the terminal."
    : `The login did not complete${failure ? ` (${escapeHtml(failure)})` : ""}. Return to the terminal and try again.`;
  return `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui;padding:3rem"><h1>${title}</h1><p>${body}</p></body>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch] ?? ch);
}

/** Rejects with the timeout's own error once the deadline passes. */
function withDeadline<T>(p: Promise<T>, signal: AbortSignal | undefined, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let timer: NodeJS.Timeout;
    const finish = (fn: () => void) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = () => finish(() => reject(new OAuthError("Cancelled", "cancelled")));
    timer = setTimeout(
      () => finish(() => reject(new OAuthError("The approval did not arrive in time", "expired_token"))),
      timeoutMs,
    );
    timer.unref?.();
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    p.then((v) => finish(() => resolve(v)), (err) => finish(() => reject(err)));
  });
}

export async function refreshToken(cfg: FlowConfig, creds: Credentials): Promise<Credentials> {
  if (!creds.refreshToken) throw new OAuthError("No refresh token — log in again", "no_refresh_token");
  const params: Record<string, string> = {
    client_id: cfg.clientId,
    grant_type: "refresh_token",
    refresh_token: creds.refreshToken,
    ...(cfg.kind === "web" && cfg.clientSecret ? { client_secret: cfg.clientSecret } : {}),
  };
  // The browser flow states its scope once and renews under it; a host that
  // only takes JSON on this call says so with refreshEncoding. The ChatGPT
  // backend renews without a scope at all.
  const json =
    cfg.kind === "web"
      ? await postForm(cfg.tokenUrl, params, cfg.headers, cfg.refreshEncoding ?? cfg.encoding)
      : await postForm(cfg.tokenUrl, params, cfg.headers, cfg.encoding);
  const next = toCredentials(json, creds.source ?? "refresh");
  // Hosts that rotate refresh tokens send a new one; the rest expect the old
  // one to keep working, and dropping it here would end the session early.
  // The workspace was chosen at login and outlives the token it came with.
  return {
    ...next,
    refreshToken: next.refreshToken ?? creds.refreshToken,
    orgId: next.orgId ?? creds.orgId,
    orgName: next.orgId && next.orgId !== creds.orgId ? undefined : creds.orgName,
  };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new OAuthError("Cancelled", "cancelled"));
      },
      { once: true },
    );
  });
}
