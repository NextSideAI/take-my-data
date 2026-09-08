// Talking to OpenDataReasoningHub. Token lives in ~/.odrh/tokens.json, keyed by
// origin, so a local dev server and the real site don't share credentials.

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_ORIGIN = "https://opendatareasoninghub.org";
export const CLIENT = { name: "take-my-data", version: "0.2.0" };

/** Used only if the hub can't be reached for its current license. Must match what the hub enforces. */
export const FALLBACK_LICENSE = {
  id: "CC0-1.0",
  name: "CC0 1.0 Universal (Public Domain Dedication)",
  url: "https://creativecommons.org/publicdomain/zero/1.0/",
};

/** The hub publishes the license it requires; the consent line and the upload echo it back verbatim. */
export async function fetchLicense(origin) {
  try {
    const res = await api(origin, "/api/dataset");
    if (res.ok && res.data?.license?.id) return res.data.license;
  } catch {
    // offline or old hub
  }
  return FALLBACK_LICENSE;
}

export function resolveOrigin(flag) {
  return String(flag || process.env.ODRH_ORIGIN || DEFAULT_ORIGIN).replace(/\/+$/, "");
}

const STORE_DIR = join(homedir(), ".odrh");
const STORE = join(STORE_DIR, "tokens.json");

async function readStore() {
  try {
    return JSON.parse(await readFile(STORE, "utf8"));
  } catch {
    return {};
  }
}

async function writeStore(data) {
  await mkdir(STORE_DIR, { recursive: true });
  await writeFile(STORE, JSON.stringify(data, null, 2), { mode: 0o600 });
  try {
    await chmod(STORE, 0o600);
  } catch {
    // Windows: no-op
  }
}

export async function loadToken(origin) {
  if (process.env.ODRH_TOKEN) return { token: process.env.ODRH_TOKEN, handle: null };
  const store = await readStore();
  return store[origin] ?? null;
}

export async function saveToken(origin, entry) {
  const store = await readStore();
  store[origin] = { ...entry, savedAt: new Date().toISOString() };
  await writeStore(store);
}

export async function clearToken(origin) {
  const store = await readStore();
  delete store[origin];
  await writeStore(store);
}

export async function api(origin, path, { method = "GET", token, body } = {}) {
  const headers = { accept: "application/json", "user-agent": `${CLIENT.name}/${CLIENT.version}` };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;

  let res;
  try {
    res = await fetch(origin + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch (error) {
    throw new Error(`cannot reach ${origin}: ${error.message}`);
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    // non-JSON body (proxy error page etc.)
  }
  return { status: res.status, ok: res.ok, data };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * GitHub device flow through the hub. Prints the code, waits for the user to
 * approve in a browser, stores the Bearer token the hub hands back once.
 */
export async function deviceLogin(origin, { label = CLIENT.name, log = console.log } = {}) {
  const start = await api(origin, "/api/auth/device", { method: "POST" });
  if (start.status === 503) {
    throw new Error(`${origin} has GitHub login disabled (auth_not_configured). Ask the operator, or use --dev against a local server.`);
  }
  if (!start.ok || !start.data?.device_code) {
    throw new Error(`device flow failed: HTTP ${start.status} ${JSON.stringify(start.data)}`);
  }
  const { device_code, user_code, verification_uri, expires_in } = start.data;
  let interval = Number(start.data.interval ?? 5);

  log("");
  log(`  Open   ${verification_uri}`);
  log(`  Enter  ${user_code}`);
  log("");
  log(`  Waiting for approval (expires in ${Math.round(expires_in / 60)} min)…`);

  const deadline = Date.now() + expires_in * 1000;
  while (Date.now() < deadline) {
    await sleep(interval * 1000);
    const poll = await api(origin, "/api/auth/device/poll", {
      method: "POST",
      body: { deviceCode: device_code, issueToken: true, label },
    });
    const r = poll.data ?? {};
    if (r.status === "authorized" && r.token) {
      await saveToken(origin, { token: r.token, handle: r.handle });
      return r;
    }
    if (r.status === "slow_down") interval = Number(r.interval ?? interval + 5);
    if (r.status === "expired") throw new Error("the device code expired before it was approved. Run login again.");
    if (!poll.ok && r.status !== "pending") throw new Error(`poll failed: HTTP ${poll.status} ${JSON.stringify(r)}`);
  }
  throw new Error("timed out waiting for approval.");
}

/** Local-only shortcut: a hub started with DEV_LOGIN=1 mints a token for any handle. */
export async function devLogin(origin, handle) {
  const res = await api(origin, "/api/auth/dev", { method: "POST", body: { handle } });
  if (!res.ok || !res.data?.token) throw new Error(`dev login refused: HTTP ${res.status} ${JSON.stringify(res.data)}`);
  await saveToken(origin, { token: res.data.token, handle: res.data.handle });
  return res.data;
}
