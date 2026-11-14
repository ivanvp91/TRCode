/**
 * Several credentials per provider, each with a name, and rotation between
 * them.
 *
 * A plan's quota is spent per account, not per machine: the week a subscription
 * runs dry is exactly when a second key would have kept the session going. So
 * every provider gets a book of named accounts beside its credential file, one
 * of them active — the one requests carry — and the client moves to the next
 * when a host refuses the active one.
 *
 * The book is a companion to `<provider>.json`, never its replacement: the
 * active account's credential is written there, so every existing reader
 * (resolveAuth, verifyProvider, `trc auth status`) keeps working unchanged and
 * a book that is lost or unreadable simply means one account.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { configDir, ensureDir, saveConfig, ROUTER_PROVIDER } from "../config.js";
import {
  readChatgptProfile,
  selectChatgptProfile,
  writeCredentials,
  writeProtectedJson,
  type Credentials,
} from "./credentials.js";

/** One saved credential: a key or a subscription login. */
export interface AccountEntry {
  id: string;
  /** What the user called it — "work", "personal", the account's email. */
  name: string;
  /**
   * The credential itself. Absent for a ChatGPT account, whose tokens live in
   * its own profile file and are only pointed at from here.
   */
  creds?: Credentials;
  profileId?: string;
  addedAt: number;
  /** Last time this account carried a request. */
  usedAt?: number;
}

interface AccountBook {
  active: string | null;
  accounts: AccountEntry[];
}

function authDir(): string {
  return ensureDir(path.join(configDir(), "auth"));
}

function bookPath(provider: string): string {
  return path.join(authDir(), `${provider}.accounts.json`);
}

function readBook(provider: string): AccountBook {
  try {
    const raw = JSON.parse(fs.readFileSync(bookPath(provider), "utf8"));
    const accounts: AccountEntry[] = Array.isArray(raw?.accounts)
      ? raw.accounts.filter((a: AccountEntry) => a && typeof a.id === "string" && typeof a.name === "string")
      : [];
    const active = typeof raw?.active === "string" && accounts.some((a) => a.id === raw.active) ? raw.active : accounts[0]?.id ?? null;
    return { active, accounts };
  } catch {
    return { active: null, accounts: [] };
  }
}

function writeBook(provider: string, book: AccountBook): void {
  if (!book.accounts.length) {
    try {
      fs.unlinkSync(bookPath(provider));
    } catch {
      /* never existed */
    }
    return;
  }
  writeProtectedJson(bookPath(provider), book);
}

/**
 * What makes two credentials the same account. A key is its own identity; a
 * ChatGPT login is its registration; other subscription logins are named by
 * whatever the id token carried, falling back to the refresh token — the one
 * part of an OAuth session that the host does not rotate on every request.
 */
function identityOf(creds: Credentials): string {
  if (creds.mode === "apikey") return `key:${creds.accessToken}`;
  if (creds.clientId) return `chatgpt:${creds.clientId}`;
  if (creds.issuer && creds.subject) return `oauth:${creds.issuer}:${creds.subject}`;
  if (creds.email) return `oauth:${creds.email}`;
  return `oauth:${creds.refreshToken ?? creds.accessToken}`;
}

function entryIdentity(entry: AccountEntry): string {
  if (entry.profileId) return `chatgpt:${entry.profileId}`;
  return entry.creds ? identityOf(entry.creds) : `id:${entry.id}`;
}

/** "sk-abc…7f3a" — enough to tell two keys apart, not enough to leak one. */
export function maskSecret(token: string): string {
  if (token.length <= 10) return token.slice(0, 3) + "…";
  return `${token.slice(0, 6)}…${token.slice(-4)}`;
}

/** A default name, so an account is never anonymous in the list. */
function defaultName(creds: Credentials, taken: AccountEntry[]): string {
  const base = creds.mode === "apikey" ? "Key" : "Account";
  const suffix = creds.email ?? creds.orgName;
  if (suffix) return suffix;
  let n = taken.length + 1;
  while (taken.some((a) => a.name === `${base} ${n}`)) n++;
  return `${base} ${n}`;
}

/** Writes the active credential where every reader already looks for it. */
function storeActive(provider: string, creds: Credentials): void {
  if (provider === ROUTER_PROVIDER) {
    saveConfig({ apiKey: creds.accessToken });
    return;
  }
  writeCredentials(provider, creds);
}

function credsOf(provider: string, entry: AccountEntry): Credentials | null {
  if (entry.profileId) return readChatgptProfile(entry.profileId);
  if (entry.creds) return entry.creds;
  return null;
}

/** The accounts on file, in the order they were added. */
export function accountsOf(provider: string): AccountEntry[] {
  return readBook(provider).accounts;
}

export function activeAccountId(provider: string): string | null {
  return readBook(provider).active;
}

export function activeAccount(provider: string): AccountEntry | null {
  const book = readBook(provider);
  return book.accounts.find((a) => a.id === book.active) ?? null;
}

/** The token (or profile) an account carries, for display and for checks. */
export function accountCreds(provider: string, entry: AccountEntry): Credentials | null {
  return credsOf(provider, entry);
}

/**
 * Adds a credential to the book — or updates the one it already is — names it
 * and makes it active. This is what a login calls, and what the caller hands
 * the name typed into the dialog.
 */
export function registerAccount(provider: string, creds: Credentials, name?: string): AccountEntry {
  const book = readBook(provider);
  const identity = identityOf(creds);
  const existing = book.accounts.find((a) => entryIdentity(a) === identity);
  const entry: AccountEntry =
    existing ??
    ({
      id: crypto.randomBytes(4).toString("hex"),
      name: name?.trim() || defaultName(creds, book.accounts),
      addedAt: Date.now(),
    } as AccountEntry);

  if (name?.trim()) entry.name = name.trim();
  // A ChatGPT login is a pointer: its tokens are the profile's business.
  if (provider === "openai" && creds.mode === "oauth" && creds.clientId) {
    entry.profileId = creds.clientId;
    delete entry.creds;
  } else {
    entry.creds = creds;
    delete entry.profileId;
  }
  entry.usedAt = Date.now();
  if (!existing) book.accounts.push(entry);
  book.active = entry.id;
  writeBook(provider, book);
  storeActive(provider, creds);
  return entry;
}

/**
 * Keeps the active account's copy current after a token refresh, and gives a
 * provider that has no book yet its first entry. Called wherever a credential
 * is written outside an explicit login.
 */
export function storeCredential(provider: string, creds: Credentials): Credentials {
  const book = readBook(provider);
  const active = book.accounts.find((a) => a.id === book.active);
  if (active && !active.profileId) {
    active.creds = creds;
    active.usedAt = Date.now();
    writeBook(provider, book);
  } else if (!active) {
    registerAccount(provider, creds);
  }
  storeActive(provider, creds);
  return creds;
}

/** Makes a stored account the one requests carry. */
export function activateAccount(provider: string, id: string): AccountEntry | null {
  const book = readBook(provider);
  const entry = book.accounts.find((a) => a.id === id);
  if (!entry) return null;
  const creds = credsOf(provider, entry);
  if (!creds) return null;
  entry.usedAt = Date.now();
  book.active = entry.id;
  writeBook(provider, book);
  if (entry.profileId) selectChatgptProfile(entry.profileId);
  else storeActive(provider, creds);
  return entry;
}

/** Removes an account; the credential itself is only dropped with the last one. */
export function removeAccount(provider: string, id: string): boolean {
  const book = readBook(provider);
  const index = book.accounts.findIndex((a) => a.id === id);
  if (index === -1) return false;
  const wasActive = book.active === id;
  book.accounts.splice(index, 1);
  if (!book.accounts.length) {
    book.active = null;
    writeBook(provider, book);
    return true;
  }
  if (wasActive) {
    // The next one down takes over, wrapping to the top: a deleted active
    // account must not leave the provider with nothing to send.
    const next = book.accounts[index % book.accounts.length];
    book.active = next.id;
    writeBook(provider, book);
    const creds = credsOf(provider, next);
    if (creds) {
      if (next.profileId) selectChatgptProfile(next.profileId);
      else storeActive(provider, creds);
    }
  } else writeBook(provider, book);
  return true;
}

export function renameAccount(provider: string, id: string, name: string): boolean {
  const book = readBook(provider);
  const entry = book.accounts.find((a) => a.id === id);
  const trimmed = name.trim();
  if (!entry || !trimmed) return false;
  entry.name = trimmed;
  writeBook(provider, book);
  return true;
}

/** Forgets the whole book — logout and a provider that was never connected. */
export function clearAccounts(provider: string): void {
  try {
    fs.unlinkSync(bookPath(provider));
  } catch {
    /* nothing on file */
  }
}

/** True once a provider has more than one credential to choose from. */
export function hasAccounts(provider: string): boolean {
  return readBook(provider).accounts.length > 1;
}
