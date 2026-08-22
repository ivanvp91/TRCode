/**
 * OAuth 2.0 Device Authorization Grant (RFC 8628).
 *
 * The flow terminals use: ask for a code, show the user a URL to open on any
 * device, poll until they approve. No redirect URI, no local callback server,
 * no browser needed on the machine running the CLI — which is the point when
 * the CLI is on a remote box over ssh.
 *
 * RFC 8628 specifies form-encoded bodies, but several hosts only accept JSON,
 * so each request tries form first and falls back once. Costs one round-trip
 * on a host that wants JSON, and only on the first call — the encoding can
 * also be declared outright when a host is known to want one.
 */
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
}

export type Encoding = "form" | "json";

export type FlowConfig = DeviceFlowConfig;

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
  const params: Record<string, string> = { client_id: cfg.clientId };
  if (cfg.scope) params.scope = cfg.scope;
  const json = await postForm(cfg.deviceAuthUrl, params, cfg.headers, cfg.encoding);

  const deviceCode = String(json.device_code ?? json.deviceCode ?? "");
  const userCode = String(json.user_code ?? json.userCode ?? "");
  const uri = String(json.verification_uri ?? json.verificationUri ?? json.verification_url ?? "");
  if (!deviceCode || !uri) {
    throw new OAuthError("The host did not return a device code", "bad_response");
  }
  const expiresIn = Number(json.expires_in ?? json.expiresIn ?? 600);
  return {
    deviceCode,
    userCode,
    verificationUri: uri,
    verificationUriComplete: json.verification_uri_complete ?? json.verificationUriComplete ?? undefined,
    expiresAt: Date.now() + expiresIn * 1000,
    // RFC 8628 says 5s when the host stays silent.
    interval: Math.max(1, Number(json.interval ?? 5)),
  };
}

function toCredentials(json: any, source: string): Credentials {
  const accessToken = String(json.access_token ?? json.accessToken ?? "");
  if (!accessToken) throw new OAuthError("No access token in the response", "bad_response");
  const expiresIn = Number(json.expires_in ?? json.expiresIn ?? 0);
  return {
    mode: "oauth",
    accessToken,
    refreshToken: json.refresh_token ?? json.refreshToken ?? undefined,
    expiresAt: expiresIn > 0 ? Date.now() + expiresIn * 1000 : undefined,
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

export async function refreshToken(cfg: FlowConfig, creds: Credentials): Promise<Credentials> {
  if (!creds.refreshToken) throw new OAuthError("No refresh token — log in again", "no_refresh_token");
  const json = await postForm(
    cfg.tokenUrl,
    { client_id: cfg.clientId, grant_type: "refresh_token", refresh_token: creds.refreshToken },
    cfg.headers,
    cfg.encoding,
  );
  const next = toCredentials(json, creds.source ?? "refresh");
  // Hosts that rotate refresh tokens send a new one; the rest expect the old
  // one to keep working, and dropping it here would end the session early.
  return { ...next, refreshToken: next.refreshToken ?? creds.refreshToken };
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
