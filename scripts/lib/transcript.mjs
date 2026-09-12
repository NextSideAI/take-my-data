// Claude Code, Codex, Pi and OpenCode session logs -> the transcript shape the server accepts.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const HARNESS = "claude_code"; // sessionHash()의 기존 기본값
export const HARNESSES = ["claude_code", "codex", "pi", "opencode"];

const HARNESS_ALIASES = new Map([
  ["claude", "claude_code"], ["claude-code", "claude_code"], ["claude_code", "claude_code"],
  ["codex", "codex"], ["pi", "pi"], ["opencode", "opencode"], ["open-code", "opencode"],
]);

export function normalizeHarnesses(value) {
  if (!value) return [...HARNESSES];
  const result = [];
  for (const raw of String(value).split(",")) {
    const harness = HARNESS_ALIASES.get(raw.trim().toLowerCase());
    if (!harness) throw new Error(`unknown harness: ${raw.trim()} (use ${HARNESSES.join(", ")})`);
    if (!result.includes(harness)) result.push(harness);
  }
  return result;
}

export function harnessLabel(harness) {
  return { claude_code: "Claude", codex: "Codex", pi: "Pi", opencode: "OpenCode" }[harness] ?? harness;
}

export function claudeDir() { return process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"); }
export function codexDir() { return process.env.CODEX_HOME || join(homedir(), ".codex"); }
export function piDir() { return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"); }

export function projectsDir(harness = HARNESS) {
  if (harness === "claude_code") return join(claudeDir(), "projects");
  if (harness === "codex") return join(codexDir(), "sessions");
  if (harness === "pi") return process.env.PI_CODING_AGENT_SESSION_DIR || join(piDir(), "sessions");
  return "OpenCode session store";
}

export function projectKey(cwd) { return resolve(cwd).replace(/[^A-Za-z0-9]/g, "-"); }

/** Dedupe key: sha256("<harness>:" + sessionId). */
export function sessionHash(sessionId, harness = HARNESS) {
  return createHash("sha256").update(`${harness}:${sessionId}`).digest("hex");
}

function samePath(a, b) {
  if (!a || !b) return false;
  const aa = resolve(a).replace(/[\\/]+$/, "");
  const bb = resolve(b).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? aa.toLowerCase() === bb.toLowerCase() : aa === bb;
}

async function jsonlFiles(root) {
  const files = [];
  async function walk(dir) {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        const s = await stat(path);
        files.push({ path, mtimeMs: s.mtimeMs, size: s.size });
      }
    }
  }
  await walk(root);
  return files;
}

async function firstJsonLine(path) {
  const input = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      try { return JSON.parse(line); } catch { return null; }
    }
  } finally {
    lines.close();
    input.destroy();
  }
  return null;
}

function isCodexSubagent(source, threadSource) {
  return threadSource === "subagent" || source === "subagent"
    || Boolean(source && typeof source === "object" && (source.subagent || source.subAgent));
}

async function listClaudeFiles({ all, cwd }) {
  const root = projectsDir("claude_code");
  const dirs = all
    ? await readdir(root, { withFileTypes: true }).then((xs) => xs.filter((x) => x.isDirectory()).map((x) => join(root, x.name))).catch(() => [])
    : [join(root, projectKey(cwd))];
  const files = [];
  for (const dir of dirs) {
    let names = [];
    try { names = await readdir(dir); } catch { continue; }
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const path = join(dir, name);
      const s = await stat(path);
      files.push({ path, project: basename(dir), mtimeMs: s.mtimeMs, size: s.size, harness: "claude_code" });
    }
  }
  return files;
}

async function listCodexFiles({ all, cwd }) {
  const roots = [join(codexDir(), "sessions"), join(codexDir(), "archived_sessions")];
  const files = (await Promise.all(roots.map(jsonlFiles))).flat();
  const activeIds = new Set([process.env.CODEX_THREAD_ID, process.env.CODEX_SESSION_ID].filter(Boolean));
  const result = [];
  for (const file of files) {
    const header = await firstJsonLine(file.path);
    const meta = header?.type === "session_meta" ? header.payload ?? {} : {};
    if (isCodexSubagent(meta.source, meta.thread_source)) continue;
    if (!all && !samePath(meta.cwd, cwd)) continue;
    const sessionId = meta.id ?? meta.session_id;
    result.push({ ...file, sessionId, project: meta.cwd, harness: "codex", active: activeIds.has(sessionId) });
  }
  return result;
}

async function listPiFiles({ all, cwd }) {
  const files = await jsonlFiles(projectsDir("pi"));
  const result = [];
  for (const file of files) {
    const header = await firstJsonLine(file.path);
    if (header?.type !== "session") continue;
    if (!all && !samePath(header.cwd, cwd)) continue;
    result.push({ ...file, project: header.cwd, harness: "pi" });
  }
  return result;
}

function parseJsonOutput(stdout) {
  const text = String(stdout ?? "").trim();
  try { return JSON.parse(text); } catch {
    const starts = [text.indexOf("["), text.indexOf("{")].filter((n) => n >= 0).sort((a, b) => a - b);
    for (const start of starts) {
      try { return JSON.parse(text.slice(start)); } catch { /* 다음 JSON 시작점 시도 */ }
    }
    throw new Error("OpenCode returned non-JSON output");
  }
}

async function runOpenCode(args, { allowMissing = false } = {}) {
  let command = "opencode";
  if (process.platform === "win32") {
    try {
      const found = await execFileAsync("where.exe", ["opencode"], { encoding: "utf8", windowsHide: true });
      const paths = found.stdout.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
      command = paths.find((x) => x.toLowerCase().endsWith(".exe")) ?? paths[0];
      if (!command) throw Object.assign(new Error("not found"), { code: "ENOENT" });
    } catch (error) {
      if (allowMissing) return null;
      throw new Error("OpenCode executable was not found in PATH");
    }
  }
  try {
    const options = { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, windowsHide: true };
    let result;
    if (process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command)) {
      if (args.some((arg) => !/^[A-Za-z0-9_.:,/=-]+$/.test(arg))) throw new Error("unsafe OpenCode argument");
      const line = `call "${command}" ${args.join(" ")}`;
      result = await execFileAsync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", line], options);
    } else {
      result = await execFileAsync(command, args, options);
    }
    return result.stdout;
  } catch (error) {
    if (allowMissing && error.code === "ENOENT") return null;
    throw new Error(`OpenCode command failed: ${String(error.stderr || error.message).trim()}`);
  }
}

function timeMs(value) {
  const n = Number(value);
  if (Number.isFinite(n)) return n < 10_000_000_000 ? n * 1000 : n;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function listOpenCodeFiles({ all, cwd, limit }) {
  const stdout = await runOpenCode(["session", "list", "--max-count", String(Math.max(limit * 4, 100)), "--format", "json"], { allowMissing: true });
  if (stdout == null) return [];
  const parsed = parseJsonOutput(stdout);
  const sessions = Array.isArray(parsed) ? parsed : parsed.sessions ?? parsed.data ?? [];
  return sessions
    .filter((s) => s && !s.parentID && !s.parentId)
    .filter((s) => all || samePath(s.directory ?? s.path?.cwd ?? s.location?.directory, cwd))
    .map((s) => ({
      path: `opencode:${s.id}`, sessionId: s.id,
      project: s.directory ?? s.path?.cwd ?? s.location?.directory,
      mtimeMs: timeMs(s.time?.updated ?? s.updated ?? s.time?.created ?? s.created ?? s.updatedAt ?? s.createdAt),
      size: 0, harness: "opencode", info: s,
    }));
}

export async function listSessionFiles({ all = false, cwd = process.cwd(), harnesses = HARNESSES, limit = 20 } = {}) {
  const selected = normalizeHarnesses(Array.isArray(harnesses) ? harnesses.join(",") : harnesses);
  const lists = [];
  if (selected.includes("claude_code")) lists.push(listClaudeFiles({ all, cwd }));
  if (selected.includes("codex")) lists.push(listCodexFiles({ all, cwd }));
  if (selected.includes("pi")) lists.push(listPiFiles({ all, cwd }));
  if (selected.includes("opencode")) lists.push(listOpenCodeFiles({ all, cwd, limit }));
  return (await Promise.all(lists)).flat().sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limit);
}

function isLocalNoise(text) {
  const t = text.trim();
  if (!t) return true;
  return /^<(command-name|command-message|local-command-stdout|local-command-caveat|bash-input|bash-stdout|bash-stderr)>/.test(t)
    || t === "[Request interrupted by user]" || t === "[Request interrupted by user for tool use]";
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((b) => {
    if (typeof b === "string") return b;
    if (!b || typeof b !== "object") return "";
    return b.text ?? b.content ?? "";
  }).filter(Boolean).join("\n");
  if (content == null) return "";
  return JSON.stringify(content);
}

function jsonText(value) {
  if (typeof value === "string") return value;
  if (value == null) return "";
  try { return JSON.stringify(value); } catch { return String(value); }
}

function appendAssistant(transcript, { content = "", thinking = "", toolUse, ts } = {}) {
  let turn = transcript[transcript.length - 1];
  if (!turn || turn.role !== "assistant") {
    turn = { role: "assistant", content: "", toolUses: [], ts };
    transcript.push(turn);
  }
  if (content) turn.content += (turn.content ? "\n" : "") + content;
  if (thinking) turn.thinking = (turn.thinking ? `${turn.thinking}\n` : "") + thinking;
  if (toolUse) turn.toolUses.push(toolUse);
}

function cleanAssistantTurns(transcript) {
  for (const turn of transcript) {
    if (turn.role !== "assistant") continue;
    if (!turn.thinking) delete turn.thinking;
    if (!turn.toolUses?.length) delete turn.toolUses;
  }
}

async function parseClaudeSession(path) {
  const raw = await readFile(path, "utf8");
  const transcript = [];
  let sessionId, model, version, cwd, first, last;
  let events = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.isSidechain || (e.type !== "user" && e.type !== "assistant")) continue;
    sessionId ??= e.sessionId; version ??= e.version; cwd ??= e.cwd;
    if (e.timestamp) { first ??= e.timestamp; last = e.timestamp; }
    const m = e.message;
    if (!m) continue;
    events++;
    if (e.type === "user") {
      if (e.isMeta) continue;
      if (Array.isArray(m.content)) {
        const texts = [];
        for (const b of m.content) {
          if (b?.type === "text") texts.push(b.text ?? "");
          else if (b?.type === "tool_result") transcript.push({ role: "tool", content: textOf(b.content), ts: e.timestamp });
        }
        const text = texts.join("\n");
        if (!isLocalNoise(text)) transcript.push({ role: "user", content: text, ts: e.timestamp });
      } else {
        const text = textOf(m.content);
        if (!isLocalNoise(text)) transcript.push({ role: "user", content: text, ts: e.timestamp });
      }
      continue;
    }
    if (m.model) model = m.model;
    const blocks = Array.isArray(m.content) ? m.content : [{ type: "text", text: textOf(m.content) }];
    const turn = { role: "assistant", content: "", thinking: "", toolUses: [], ts: e.timestamp };
    for (const b of blocks) {
      if (b?.type === "text") turn.content += (turn.content ? "\n" : "") + (b.text ?? "");
      else if (b?.type === "thinking") turn.thinking += (turn.thinking ? "\n" : "") + (b.thinking ?? "");
      else if (b?.type === "tool_use") turn.toolUses.push({ name: String(b.name ?? ""), input: JSON.stringify(b.input ?? {}) });
    }
    const prev = transcript[transcript.length - 1];
    if (prev?.role === "assistant") {
      if (turn.content) prev.content += (prev.content ? "\n" : "") + turn.content;
      if (turn.thinking) prev.thinking = (prev.thinking ? `${prev.thinking}\n` : "") + turn.thinking;
      prev.toolUses.push(...turn.toolUses);
    } else transcript.push(turn);
  }
  cleanAssistantTurns(transcript);
  if (!transcript.length) return null;
  return { sessionId: sessionId ?? basename(path, ".jsonl"), transcript, meta: { harness: "claude_code", model, harnessVersion: version, startedAt: first, endedAt: last, events }, cwd };
}

function contentBlocksText(blocks, allowed) {
  return (Array.isArray(blocks) ? blocks : []).filter((b) => b && allowed.includes(b.type)).map((b) => b.text ?? "").filter(Boolean).join("\n");
}

async function parseCodexSession(path) {
  const raw = await readFile(path, "utf8");
  const transcript = [], fallback = [];
  let meta = {}, model, first, last;
  let events = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const ts = e.timestamp;
    if (ts) { first ??= ts; last = ts; }
    if (e.type === "session_meta") {
      meta = e.payload ?? {};
      if (isCodexSubagent(meta.source, meta.thread_source)) return null;
      continue;
    }
    if (e.type === "turn_context") { model = e.payload?.model ?? model; continue; }
    if (e.type === "event_msg") {
      const p = e.payload ?? {};
      if (p.type === "user_message" && !isLocalNoise(String(p.message ?? ""))) fallback.push({ role: "user", content: String(p.message ?? ""), ts });
      else if (p.type === "agent_message") appendAssistant(fallback, { content: String(p.message ?? ""), ts });
      else if (p.type === "agent_reasoning") appendAssistant(fallback, { thinking: String(p.text ?? p.message ?? ""), ts });
      continue;
    }
    if (e.type !== "response_item") continue;
    const p = e.payload ?? {};
    events++;
    if (p.type === "message" && p.role === "user") {
      const content = contentBlocksText(p.content, ["input_text", "text"]);
      if (!isLocalNoise(content)) transcript.push({ role: "user", content, ts });
    } else if (p.type === "message" && p.role === "assistant") {
      appendAssistant(transcript, { content: contentBlocksText(p.content, ["output_text", "text"]), ts });
    } else if (p.type === "reasoning") {
      const thinking = [contentBlocksText(p.summary, ["summary_text", "text"]), contentBlocksText(p.content, ["reasoning_text", "text"])].filter(Boolean).join("\n");
      if (thinking) appendAssistant(transcript, { thinking, ts });
    } else if (p.type === "function_call" || p.type === "custom_tool_call") {
      appendAssistant(transcript, { toolUse: { name: String(p.name ?? p.type), input: jsonText(p.arguments ?? p.input ?? {}) }, ts });
    } else if (p.type === "function_call_output" || p.type === "custom_tool_call_output") {
      transcript.push({ role: "tool", content: jsonText(p.output), ts });
    } else if (p.type === "web_search_call") {
      appendAssistant(transcript, { toolUse: { name: "web_search", input: jsonText(p.action ?? {}) }, ts });
    }
  }
  const chosen = transcript.some((t) => t.role === "user") ? transcript : fallback;
  cleanAssistantTurns(chosen);
  if (!chosen.length) return null;
  return {
    sessionId: meta.id ?? meta.session_id ?? basename(path, ".jsonl"), transcript: chosen,
    meta: { harness: "codex", model, modelProvider: meta.model_provider, harnessVersion: meta.cli_version, source: typeof meta.source === "string" ? meta.source : undefined, startedAt: meta.timestamp ?? first, endedAt: last, events }, cwd: meta.cwd,
  };
}

function piActiveBranch(entries) {
  const nodes = entries.filter((e) => e?.id);
  if (!nodes.length) return [];
  const byId = new Map(nodes.map((e) => [e.id, e]));
  const branch = [];
  let node = nodes[nodes.length - 1];
  const seen = new Set();
  while (node && !seen.has(node.id)) {
    seen.add(node.id); branch.push(node); node = node.parentId ? byId.get(node.parentId) : null;
  }
  return branch.reverse();
}

async function parsePiSession(path) {
  const raw = await readFile(path, "utf8");
  const rows = raw.split("\n").filter((x) => x.trim()).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  const header = rows.find((e) => e.type === "session") ?? {};
  const branch = piActiveBranch(rows.filter((e) => e.type !== "session"));
  const transcript = [];
  let model, provider, last = header.timestamp;
  for (const e of branch) {
    if (e.timestamp) last = e.timestamp;
    if (e.type === "model_change") { model = e.modelId ?? e.model ?? model; provider = e.provider ?? provider; continue; }
    if (e.type !== "message" || !e.message) continue;
    const m = e.message, ts = e.timestamp ?? m.timestamp;
    if (m.role === "user") {
      const content = textOf(m.content);
      if (!isLocalNoise(content)) transcript.push({ role: "user", content, ts });
    } else if (m.role === "assistant") {
      model = m.model ?? model; provider = m.provider ?? provider;
      const blocks = Array.isArray(m.content) ? m.content : [{ type: "text", text: textOf(m.content) }];
      const turn = { role: "assistant", content: "", thinking: "", toolUses: [], ts };
      for (const b of blocks) {
        if (b?.type === "text") turn.content += (turn.content ? "\n" : "") + (b.text ?? "");
        else if (b?.type === "thinking") turn.thinking += (turn.thinking ? "\n" : "") + (b.thinking ?? b.text ?? "");
        else if (b?.type === "toolCall" || b?.type === "tool_use") turn.toolUses.push({ name: String(b.name ?? ""), input: jsonText(b.arguments ?? b.input ?? {}) });
      }
      transcript.push(turn);
    } else if (m.role === "toolResult" || m.role === "tool") transcript.push({ role: "tool", content: textOf(m.content), ts });
  }
  cleanAssistantTurns(transcript);
  if (!transcript.length) return null;
  return { sessionId: header.id ?? basename(path, ".jsonl").split("_").at(-1), transcript, meta: { harness: "pi", model, modelProvider: provider, sessionVersion: header.version, startedAt: header.timestamp, endedAt: last, events: branch.length }, cwd: header.cwd };
}

export function parseOpenCodeExport(data, file = {}) {
  const info = data.info ?? data.session ?? file.info ?? {};
  const messages = data.messages ?? data.data?.messages ?? [];
  const transcript = [];
  let model, provider, first, last;
  for (const wrapped of messages) {
    const m = wrapped.info ?? wrapped.message ?? wrapped;
    const parts = wrapped.parts ?? m.parts ?? [];
    const created = m.time?.created ?? m.createdAt;
    const ts = created ? new Date(timeMs(created)).toISOString() : undefined;
    if (ts) { first ??= ts; last = ts; }
    if (m.role === "user") {
      const content = parts.filter((p) => p?.type === "text" && !p.synthetic && !p.ignored).map((p) => p.text ?? "").filter(Boolean).join("\n");
      if (!isLocalNoise(content)) transcript.push({ role: "user", content, ts });
      model = m.model?.modelID ?? m.modelID ?? model; provider = m.model?.providerID ?? m.providerID ?? provider;
      continue;
    }
    if (m.role !== "assistant") continue;
    model = m.modelID ?? m.model?.modelID ?? model; provider = m.providerID ?? m.model?.providerID ?? provider;
    const turn = { role: "assistant", content: "", thinking: "", toolUses: [], ts };
    const toolOutputs = [];
    for (const p of parts) {
      if (!p || p.ignored) continue;
      if (p.type === "text" && !p.synthetic) turn.content += (turn.content ? "\n" : "") + (p.text ?? "");
      else if (p.type === "reasoning") turn.thinking += (turn.thinking ? "\n" : "") + (p.text ?? "");
      else if (p.type === "tool") {
        turn.toolUses.push({ name: String(p.tool ?? "tool"), input: jsonText(p.state?.input ?? p.input ?? {}) });
        const output = p.state?.output ?? p.output;
        if (output != null && output !== "") toolOutputs.push({ role: "tool", content: jsonText(output), ts });
      }
    }
    transcript.push(turn, ...toolOutputs);
  }
  cleanAssistantTurns(transcript);
  if (!transcript.length) return null;
  return { sessionId: info.id ?? file.sessionId, transcript, meta: { harness: "opencode", model, modelProvider: provider, harnessVersion: info.version, startedAt: first, endedAt: last, events: messages.length }, cwd: info.directory ?? file.project };
}

async function parseOpenCodeSession(file) {
  if (!/^ses_[A-Za-z0-9_-]+$/.test(file.sessionId ?? "")) throw new Error("invalid OpenCode session id");
  return parseOpenCodeExport(parseJsonOutput(await runOpenCode(["export", file.sessionId])), file);
}

/** Parse one listed session. Returns null when it holds no conversation. */
export async function parseSessionFile(fileOrPath) {
  const file = typeof fileOrPath === "string" ? { path: fileOrPath, harness: "claude_code" } : fileOrPath;
  if (file.harness === "codex") return parseCodexSession(file.path);
  if (file.harness === "pi") return parsePiSession(file.path);
  if (file.harness === "opencode") return parseOpenCodeSession(file);
  return parseClaudeSession(file.path);
}
