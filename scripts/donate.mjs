#!/usr/bin/env node
// take-my-data — donate Claude Code sessions to OpenDataReasoningHub.
//
//   node scripts/donate.mjs login [--dev <handle>]
//   node scripts/donate.mjs preview [--all] [--pick 1,3] [--include-active] [--limit 20]
//   node scripts/donate.mjs dump <n>
//   node scripts/donate.mjs donate --yes [--all] [--pick 1,3]
//   node scripts/donate.mjs withdraw <donation-id>
//   node scripts/donate.mjs whoami | logout
//
// Nothing is uploaded without `donate --yes`. The skill (SKILL.md) only passes
// --yes after the human has seen the preview and explicitly agreed.

import { parseArgs } from "node:util";
import { CLIENT, api, clearToken, devLogin, deviceLogin, loadToken, resolveOrigin } from "./lib/api.mjs";
import { estimatePoints, gateOf, measure, sanitizeSession } from "./lib/sanitize.mjs";
import { HARNESS, listSessionFiles, parseSessionFile, projectKey, projectsDir, sessionHash } from "./lib/transcript.mjs";

const ACTIVE_WINDOW_MS = 10 * 60 * 1000; // a file touched in the last 10 min is probably still running
const MAX_SESSIONS_PER_REQUEST = 5;
const MAX_REQUEST_BYTES = 5 * 1024 * 1024; // server cap is 6MB; leave headroom

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    all: { type: "boolean", default: false },
    yes: { type: "boolean", default: false },
    pick: { type: "string" },
    origin: { type: "string" },
    "include-active": { type: "boolean", default: false },
    limit: { type: "string", default: "20" },
    json: { type: "boolean", default: false },
    dev: { type: "string" },
    label: { type: "string" },
    help: { type: "boolean", short: "h", default: false },
  },
});

const [command = "preview", ...rest] = positionals;
const origin = resolveOrigin(flags.origin);
const out = (...a) => console.log(...a);
const err = (...a) => console.error(...a);

function fmt(n) {
  return Number(n).toLocaleString("en-US");
}
function pad(s, w, right = false) {
  s = String(s);
  const width = [...s].reduce((n, ch) => n + (/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 2 : 1), 0);
  const fill = " ".repeat(Math.max(0, w - width));
  return right ? fill + s : s + fill;
}
function ellipsis(s, n) {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}
function summarizeRedactions(report) {
  const entries = Object.entries(report).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return "—";
  return entries
    .slice(0, 3)
    .map(([k, v]) => `${k}×${v}`)
    .join(" ")
    .concat(entries.length > 3 ? " …" : "");
}
function parsePick(pick) {
  if (!pick) return null;
  const set = new Set();
  for (const part of String(pick).split(",")) {
    const m = part.trim().match(/^(\d+)(?:-(\d+))?$/);
    if (!m) continue;
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    for (let i = a; i <= b; i++) set.add(i);
  }
  return set;
}

async function requireToken() {
  const entry = await loadToken(origin);
  if (!entry?.token) {
    err(`Not logged in to ${origin}. Run:  node scripts/donate.mjs login`);
    process.exit(2);
  }
  return entry;
}

/** Find, parse, sanitize and measure candidate sessions. Nothing leaves the machine except hash checks. */
async function collect({ withCheck }) {
  const limit = Math.max(1, Number(flags.limit) || 20);
  const files = await listSessionFiles({ all: flags.all, cwd: process.cwd() });
  const now = Date.now();
  const items = [];
  let n = 0;

  for (const file of files) {
    if (n >= limit) break;
    const item = { file, status: "new" };
    items.push(item);
    n++;

    if (now - file.mtimeMs < ACTIVE_WINDOW_MS && !flags["include-active"]) {
      item.status = "active";
      continue;
    }
    let parsed;
    try {
      parsed = await parseSessionFile(file.path);
    } catch (e) {
      item.status = "unreadable";
      item.error = e.message;
      continue;
    }
    if (!parsed) {
      item.status = "empty";
      continue;
    }
    const { session, report } = sanitizeSession(parsed);
    item.session = session;
    item.report = report;
    item.hash = sessionHash(session.sessionId);
    item.measured = measure(session.transcript);
    item.points = estimatePoints(item.measured);
    item.gate = gateOf(item.measured);
    item.firstUser = session.transcript.find((t) => t.role === "user")?.content ?? "";
    if (item.gate) item.status = item.gate === "TOO_SMALL" ? "too small" : "low quality";
  }

  if (withCheck) {
    const entry = await loadToken(origin);
    const candidates = items.filter((i) => i.status === "new");
    if (entry?.token && candidates.length) {
      const res = await api(origin, "/api/donations/check", {
        method: "POST",
        token: entry.token,
        body: { hashes: candidates.map((i) => i.hash) },
      });
      if (res.status === 401) {
        err("Stored token was rejected (401). Run login again.");
      } else if (res.ok && Array.isArray(res.data?.known)) {
        const known = new Set(res.data.known);
        for (const i of candidates) if (known.has(i.hash)) i.status = "donated";
      }
    } else if (!entry?.token) {
      for (const i of candidates) i.status = "new?"; // can't check duplicates without a token
    }
  }
  return items;
}

function printTable(items) {
  const scope = flags.all ? `all projects under ${projectsDir()}` : `${projectsDir()}/${projectKey(process.cwd())}`;
  out(`Scanning ${scope}`);
  out("");
  out(
    [pad("#", 3, true), pad("session", 10), pad("date", 10), pad("turns", 5, true), pad("tokens", 9, true), pad("pass", 4), pad("est.pt", 8, true), pad("redacted", 26), "status"].join("  "),
  );
  items.forEach((it, idx) => {
    const m = it.measured;
    const date = new Date(it.file.mtimeMs).toISOString().slice(0, 10);
    out(
      [
        pad(idx + 1, 3, true),
        pad((it.session?.sessionId ?? it.file.path.split(/[\\/]/).pop()).slice(0, 8) + "…", 10),
        pad(date, 10),
        pad(m ? m.turns : "", 5, true),
        pad(m ? fmt(m.usableTokens) : "", 9, true),
        pad(m ? (m.semanticPass ? "✓" : "✗") : "", 4),
        pad(m ? it.points.toFixed(2) : "", 8, true),
        pad(it.report ? summarizeRedactions(it.report) : "", 26),
        it.status + (it.error ? ` (${it.error})` : ""),
      ].join("  "),
    );
  });
  out("");
  for (const [idx, it] of items.entries()) {
    if (it.status === "new" || it.status === "new?") out(`  ${pad(idx + 1, 3, true)}  "${ellipsis(it.firstUser, 90)}"`);
  }
}

function selectable(items) {
  const pick = parsePick(flags.pick);
  return items
    .map((it, idx) => ({ it, n: idx + 1 }))
    .filter(({ it, n }) => (it.status === "new" || it.status === "new?") && (!pick || pick.has(n)));
}

async function cmdPreview() {
  const entry = await loadToken(origin);
  out(`take-my-data ${CLIENT.version} · ${origin} · ${entry?.handle ? `logged in as ${entry.handle}` : "not logged in"}`);
  const items = await collect({ withCheck: true });
  if (!items.length) {
    out("No Claude Code sessions found for this project. Try --all, or run from the project directory.");
    return;
  }
  printTable(items);
  const chosen = selectable(items);
  const tokens = chosen.reduce((n, { it }) => n + it.measured.usableTokens, 0);
  const pts = chosen.reduce((n, { it }) => n + it.points, 0);
  out("");
  if (!chosen.length) {
    out("Nothing new to donate.");
  } else {
    out(`Ready: ${chosen.length} session(s), ~${fmt(tokens)} tokens, est. ${pts.toFixed(2)} pt (+50 pt first-donation bonus if this is your first).`);
    out(`Inspect one in full:   node scripts/donate.mjs dump <n>`);
    out(`Upload after consent:  node scripts/donate.mjs donate --yes${flags.all ? " --all" : ""} --pick ${chosen.map((c) => c.n).join(",")}`);
  }
  if (items.some((i) => i.status === "active")) out(`(sessions modified in the last 10 minutes are skipped; add --include-active to include them)`);
  if (flags.json) out(JSON.stringify({ origin, items: items.map(({ file, ...rest }) => ({ path: file.path, ...rest, session: undefined })) }, null, 2));
}

async function cmdDump() {
  const n = Number(rest[0]);
  if (!n) {
    err("usage: dump <n>   (n from the preview table)");
    process.exit(2);
  }
  const items = await collect({ withCheck: false });
  const it = items[n - 1];
  if (!it?.session) {
    err(`#${n} has no parsed transcript (status: ${it?.status ?? "missing"})`);
    process.exit(2);
  }
  out(`# ${it.session.sessionId}  (${it.file.path})`);
  out(`# turns ${it.measured.turns} · tokens ${fmt(it.measured.usableTokens)} · semantic ${it.measured.semanticPass ? "pass" : `fail: ${it.measured.reasons.join("; ")}`} · redactions ${JSON.stringify(it.report)}`);
  out(`# meta ${JSON.stringify(it.session.meta)}`);
  out("");
  for (const t of it.session.transcript) {
    out(`── ${t.role.toUpperCase()} ${t.ts ? `(${t.ts})` : ""}`);
    if (t.thinking) out(`[thinking]\n${t.thinking}\n`);
    if (t.content) out(t.content);
    for (const u of t.toolUses ?? []) out(`[tool_use ${u.name}] ${u.input}`);
    out("");
  }
}

async function cmdDonate() {
  const entry = await requireToken();
  if (!flags.yes) {
    err("Refusing to upload without --yes. Show the preview to the user and get explicit consent first.");
    process.exit(2);
  }
  const items = await collect({ withCheck: true });
  const chosen = selectable(items);
  if (!chosen.length) {
    out("Nothing new to donate.");
    return;
  }

  // batch by count and by size
  const batches = [];
  let cur = [];
  let curBytes = 0;
  for (const c of chosen) {
    const bytes = Buffer.byteLength(JSON.stringify(c.it.session));
    if (cur.length && (cur.length >= MAX_SESSIONS_PER_REQUEST || curBytes + bytes > MAX_REQUEST_BYTES)) {
      batches.push(cur);
      cur = [];
      curBytes = 0;
    }
    cur.push(c);
    curBytes += bytes;
  }
  if (cur.length) batches.push(cur);

  out(`Uploading ${chosen.length} session(s) in ${batches.length} request(s) to ${origin} as ${entry.handle ?? "you"}…`);
  const results = [];
  for (const batch of batches) {
    const res = await api(origin, "/api/donations", {
      method: "POST",
      token: entry.token,
      body: { harness: HARNESS, client: CLIENT, sessions: batch.map((c) => c.it.session) },
    });
    const r = res.data ?? {};
    const label = batch.map((c) => `#${c.n}`).join(",");
    results.push({ batch: batch.map((c) => c.n), http: res.status, ...r });

    if (res.status === 401) {
      err(`  ${label}: token rejected (401). Run login again.`);
      break;
    }
    if (r.status === "accepted") {
      out(`  ✓ ${label}: +${r.points} pt  →  ${origin}${r.url}`);
      const u = r.rank?.user;
      if (u?.after) out(`      you: ${u.before ? `${fmt(u.before)} → ` : ""}${fmt(u.after)} overall`);
      const t = r.rank?.team;
      if (t?.after) out(`      ${t.name}: ${t.before ? `${fmt(t.before)} → ` : ""}${fmt(t.after)} among teams`);
    } else if (r.status === "rejected") {
      out(`  ✗ ${label}: rejected ${r.code}${r.detail ? ` (${r.detail})` : ""}`);
    } else if (r.status === "rate_limited") {
      out(`  ⏸ ${label}: rate limited — retry in ${Math.ceil((r.retryAfterSec ?? 3600) / 60)} min. Stopping.`);
      break;
    } else if (r.status === "locked") {
      out(`  ⏸ ${label}: donations locked until ${r.until}. Stopping.`);
      break;
    } else {
      out(`  ? ${label}: HTTP ${res.status} ${JSON.stringify(r).slice(0, 300)}`);
      if (res.status >= 500) break;
    }
  }
  if (flags.json) out(JSON.stringify({ origin, results }, null, 2));
}

async function cmdWithdraw() {
  const id = Number(rest[0]);
  if (!id) {
    err("usage: withdraw <donation-id>");
    process.exit(2);
  }
  const entry = await requireToken();
  const res = await api(origin, `/api/donations/${id}`, { method: "DELETE", token: entry.token });
  if (res.ok) out(`Withdrawn donation #${id}. Points reversed in the ledger; transcript purged; the session stays claimed so it can't be re-uploaded.`);
  else if (res.status === 404) err(`Donation #${id} is not yours or is not in accepted state.`);
  else err(`HTTP ${res.status} ${JSON.stringify(res.data)}`);
}

async function cmdLogin() {
  if (flags.dev) {
    const r = await devLogin(origin, flags.dev);
    out(`Logged in to ${origin} as ${r.handle} (dev login).`);
    return;
  }
  const r = await deviceLogin(origin, { label: flags.label });
  out(`Logged in to ${origin} as ${r.handle}. Token stored in ~/.odrh/tokens.json`);
}

async function cmdWhoami() {
  const entry = await requireToken();
  const res = await api(origin, "/api/me", { token: entry.token });
  if (!res.ok) {
    err(`HTTP ${res.status} — token may be revoked. Run login again.`);
    process.exit(2);
  }
  const me = res.data;
  out(`${origin}: ${me.handle}${me.anonymous ? " (anonymous)" : ""}${me.team_id ? ` · team #${me.team_id}` : ""}`);
}

async function cmdLogout() {
  await clearToken(origin);
  out(`Removed stored token for ${origin}.`);
}

function help() {
  out(`take-my-data ${CLIENT.version} — donate Claude Code sessions to ${origin}

  login [--dev <handle>]                  GitHub device-code login (stores a token in ~/.odrh)
  preview [--all] [--pick 1,3] [--limit N] [--include-active]
                                          Find, sanitize and measure sessions. Uploads nothing.
  dump <n>                                Print the full sanitized transcript of preview row n
  donate --yes [--all] [--pick 1,3]       Upload. Requires --yes (explicit user consent).
  withdraw <id>                           Take down one of your donations
  whoami | logout

  --origin <url> / ODRH_ORIGIN            Talk to a different hub (e.g. http://localhost:3000)
  --json                                  Append machine-readable output`);
}

const commands = { preview: cmdPreview, list: cmdPreview, dump: cmdDump, donate: cmdDonate, withdraw: cmdWithdraw, login: cmdLogin, whoami: cmdWhoami, logout: cmdLogout, help };

try {
  if (flags.help || !commands[command]) help();
  else await commands[command]();
} catch (e) {
  err(`error: ${e.message}`);
  process.exit(1);
}
