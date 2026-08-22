/**
 * Connecting a provider, shared by `trc auth login --provider X` and /login.
 *
 * Both paths need the same three-step dance — pick subscription or key, run
 * the device flow, then prove the credential works — and the REPL additionally
 * has to hand the keyboard over while it happens, which is what `exclusive` is
 * for.
 */
import { spawn } from "node:child_process";
import { saveConfig } from "../config.js";
import { verifyProvider } from "../provider/client.js";
import { clearCredentials, importVendorCredentials, writeCredentials } from "../provider/credentials.js";
import { fetchModels } from "../provider/models.js";
import { pollForToken, requestDeviceCode } from "../provider/oauth.js";
import { modeConfig, qualifyModelId, rememberBaseUrl, type ProviderDef } from "../provider/registry.js";
import { c } from "./ansi.js";
import { choose } from "./choice.js";
import { askLine } from "./prompt.js";
import { pick } from "./picker.js";
import { error, hint, info, line, padded, Spinner, success, warn } from "./render.js";
import { askSecret } from "./secret.js";
import { t } from "../i18n.js";

export interface LoginOptions {
  /** Force a path instead of asking. */
  mode?: "oauth" | "apikey";
  /** Ignore a session left by the vendor's own CLI and authorize again. */
  fresh?: boolean;
  /** Key supplied on the command line instead of typed. */
  key?: string;
  /**
   * Host for this provider, saved as config → providers.<id>.baseUrl. Only
   * providers whose endpoint is per-account need it; the rest have one host.
   */
  baseUrl?: string;
  /**
   * Runs an interactive read while the caller suspends its own input handling.
   * The REPL owns stdin and must step aside; the plain CLI does not.
   */
  exclusive?: <T>(fn: () => Promise<T>) => Promise<T>;
}

export interface LoginResult {
  /** A credential is stored and the host did not reject it. */
  connected: boolean;
  /** The host is also willing to serve requests — a lapsed plan is not. */
  usable: boolean;
}

export async function loginProvider(def: ProviderDef, opts: LoginOptions = {}): Promise<LoginResult> {
  const exclusive: <T>(fn: () => Promise<T>) => Promise<T> = opts.exclusive ?? ((fn) => fn());
  const canOAuth = Boolean(def.oauth && def.modes.oauth);
  const canKey = Boolean(def.modes.apikey);

  let mode = opts.mode;
  if (!mode) {
    if (canOAuth && canKey) {
      line();
      padded(c.bold(t(`Connect ${def.label}`, `Подключение ${def.label}`)));
      hint(t("subscription — sign in with your account, quota comes from the plan", "подписка — вход в аккаунт, квота из тарифа"));
      hint(t("API key      — pay per token on the developer platform", "ключ API     — оплата за токены на платформе разработчика"));
      mode = await exclusive<"oauth" | "apikey">(() =>
        choose<"oauth" | "apikey">(
          [
            { value: "oauth" as const, label: t("Subscription", "Подписка"), key: "s" },
            { value: "apikey" as const, label: t("API key", "Ключ API"), key: "a" },
          ],
          { fallback: "oauth" },
        ),
      );
    } else mode = canOAuth ? "oauth" : "apikey";
  }

  if (mode === "apikey") {
    if (!canKey) {
      error(t(`${def.label} has no API-key endpoint configured.`, `У ${def.label} не настроен эндпоинт для ключа API.`));
      return FAILED;
    }
    // A host that differs per account is asked for before the key: a wrong one
    // answers 404 to everything, and the credential is not what was wrong.
    if (opts.baseUrl) {
      rememberBaseUrl(def.id, opts.baseUrl);
    } else if ((def.hosts?.length || def.hostHint) && process.stdin.isTTY) {
      const url = await chooseHost(def, exclusive);
      if (url === null) {
        error(t("Cancelled.", "Отменено."));
        return FAILED;
      }
      if (url) rememberBaseUrl(def.id, url);
    }
    const key = (opts.key ?? (await exclusive(() => askSecret(`  ${def.keyHint}: `)))).trim();
    if (!key) {
      error(t("No key entered.", "Ключ не введён."));
      return FAILED;
    }
    writeCredentials(def.id, { mode: "apikey", accessToken: key, source: "pasted key" });
  } else {
    if (!def.oauth) {
      error(t(`${def.label} does not support OAuth.`, `${def.label} не поддерживает OAuth.`));
      return FAILED;
    }
    // A login the vendor's own CLI already performed is the same login.
    const inherited = opts.fresh ? null : def.importFrom && importVendorCredentials(def.importFrom);
    if (inherited) {
      writeCredentials(def.id, inherited);
      info(t(`Reusing the ${def.label} CLI session from ${inherited.source}.`, `Переиспользую сессию ${def.label} CLI из ${inherited.source}.`));
    } else if (!(await deviceLogin(def))) {
      return FAILED;
    }
  }

  const check = await verifyProvider(def.id);
  if (!check.ok) {
    // A rejected token is worth deleting; a lapsed plan is not — the login
    // itself worked, and asking the user to repeat it would fix nothing.
    if (check.status === 401 || check.status === 403) {
      clearCredentials(def.id);
      error(t(`${def.label} rejected the credential: ${check.detail}`, `${def.label} отклонил учётные данные: ${check.detail}`));
      // A key is issued for one of this vendor's products and refused by the
      // others, and the refusal says nothing about that. Name the host it was
      // tried against, so the next attempt can change it rather than the key.
      if (def.hosts?.length) {
        const host = modeConfig(def.id, "apikey")?.baseUrl;
        hint(
          t(
            `Tried against ${host}. A key belongs to one host here — if it is for another product, run /login ${def.id} again and pick that host.`,
            `Пробовал на ${host}. Ключ здесь привязан к одному серверу — если он от другого продукта, наберите /login ${def.id} снова и выберите нужный.`,
          ),
        );
      }
      return FAILED;
    }
    warn(t(`${def.label} is connected, but not serving requests: ${check.detail}`, `${def.label} подключён, но запросы не обслуживает: ${check.detail}`));
    hint(t(`The credential is saved. Disconnect with: trc auth logout --provider ${def.id}`, `Учётные данные сохранены. Отключить: trc auth logout --provider ${def.id}`));
    // Connected all the same: the models are known, and switching to it is the
    // user's call — a lapsed plan is fixed on the vendor's site, not here.
    await announceModels(def);
    return { connected: true, usable: false };
  }
  success(t(`${def.label} connected — ${check.detail}`, `${def.label} подключён — ${check.detail}`));
  await announceModels(def);
  return { connected: true, usable: true };
}

const FAILED: LoginResult = { connected: false, usable: false };

/**
 * Which host to talk to, for the providers that have several. Returns the URL
 * to pin, "" to keep the current one, or null when the user backed out.
 *
 * A list rather than a text field: the URLs are long, region-shaped and easy
 * to mistype, and picking the wrong one is only reported later as a 401 that
 * blames the key. The listed hosts are the products; anything else is typed.
 */
export async function chooseHost(
  def: ProviderDef,
  exclusive: <T>(fn: () => Promise<T>) => Promise<T>,
): Promise<string | null> {
  const current = modeConfig(def.id, "apikey")?.baseUrl ?? "";
  if (!def.hosts?.length) {
    const typed = await exclusive(() => askLine(def.hostHint ?? "Host URL", current));
    return typed === null ? null : typed.trim() === current ? "" : typed.trim();
  }

  const CUSTOM = "__custom";
  const items = def.hosts.map((h) => ({
    value: h.url ?? CUSTOM,
    label: h.label,
    hint: h.url ?? h.note ?? "",
    badge: h.url && h.url === current ? c.brightGreen("current") : h.url ? h.note ?? "" : "",
  }));
  const picked = await exclusive(() =>
    pick({ title: t(`${def.label} — host`, `${def.label} — сервер`), items, initial: current }),
  );
  if (picked === null) return null;
  if (picked !== CUSTOM) return picked === current ? "" : picked;

  const typed = await exclusive(() => askLine(def.hostHint ?? "Host URL", current));
  return typed === null ? null : typed.trim() === current ? "" : typed.trim();
}

async function deviceLogin(def: ProviderDef): Promise<boolean> {
  let code;
  try {
    code = await requestDeviceCode(def.oauth!);
  } catch (err) {
    error(t(`Could not start the ${def.label} login: ${(err as Error).message}`, `Не удалось начать вход в ${def.label}: ${(err as Error).message}`));
    return false;
  }

  const url = code.verificationUriComplete ?? code.verificationUri;
  line();
  padded(t(`Open ${c.brightCyan(url)}`, `Откройте ${c.brightCyan(url)}`));
  if (code.userCode) padded(t(`and enter the code ${c.bold(code.userCode)}`, `и введите код ${c.bold(code.userCode)}`));
  line();
  openBrowser(url);

  const sp = new Spinner(t("waiting for approval", "жду подтверждения"));
  sp.start();
  try {
    writeCredentials(def.id, await pollForToken(def.oauth!, code));
    return true;
  } catch (err) {
    error(t(`${def.label} login failed: ${(err as Error).message}`, `Вход в ${def.label} не удался: ${(err as Error).message}`));
    return false;
  } finally {
    sp.stop();
  }
}

/** Names the models that just became available, and an alias to reach them. */
async function announceModels(def: ProviderDef): Promise<void> {
  const catalog = await fetchModels({ force: true });
  const mine = catalog.filter((m) => m.id.startsWith(`${def.id}:`));
  if (!mine.length) {
    warn(t(`${def.label} returned no model list — name one explicitly, e.g. -m ${qualifyModelId(def.id, "<model>")}`, `${def.label} не вернул список моделей — укажите явно, например -m ${qualifyModelId(def.id, "<модель>")}`));
    return;
  }
  const primary = mine[0].id;
  saveConfig({ aliases: { [def.id]: primary } });
  hint(t(`Models: ${mine.slice(0, 6).map((m) => m.id).join(", ")}${mine.length > 6 ? "…" : ""}`, `Модели: ${mine.slice(0, 6).map((m) => m.id).join(", ")}${mine.length > 6 ? "…" : ""}`));
  hint(t(`Use it with: /model ${def.id}   (alias for ${primary})`, `Использовать: /model ${def.id}   (алиас для ${primary})`));
}

/**
 * How to hand a URL to the desktop, per platform.
 *
 * Split out from the spawn so it can be tested: an OAuth URL is mostly query
 * parameters, and getting them to survive the shell is the whole difficulty.
 */
export function browserCommand(url: string, platform: string = process.platform): { cmd: string; args: string[] } {
  if (platform === "win32") {
    // cmd.exe re-parses its command line after Node has quoted it, and `&` is
    // its statement separator: an unescaped one truncates the URL at the first
    // parameter — the authorize page then reports a missing client_id, and cmd
    // tries to run the rest as a command.
    return { cmd: "cmd", args: ["/c", "start", "", url.replace(/&/g, "^&")] };
  }
  if (platform === "darwin") return { cmd: "open", args: [url] };
  return { cmd: "xdg-open", args: [url] };
}

function openBrowser(url: string): void {
  try {
    const { cmd, args } = browserCommand(url);
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.unref();
  } catch {
    /* headless box or no opener — the printed URL is the fallback */
  }
}
