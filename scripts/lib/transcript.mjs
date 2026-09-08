// Claude Code session logs → the transcript shape the server accepts.
//
// Claude Code writes one JSONL file per session under
//   ~/.claude/projects/<cwd with every non-alphanumeric char replaced by "-">/<sessionId>.jsonl
// Each line is an event; only `user` and `assistant` events carry conversation.

import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

export const HARNESS = "claude_code";

export function claudeDir() {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

export function projectsDir() {
  return join(claudeDir(), "projects");
}

/** Same encoding Claude Code uses for the per-project folder name. */
export function projectKey(cwd) {
  return resolve(cwd).replace(/[^A-Za-z0-9]/g, "-");
}

/** Dedupe key shared with the server: sha256("claude_code:" + sessionId). */
export function sessionHash(sessionId) {
  return createHash("sha256").update(`${HARNESS}:${sessionId}`).digest("hex");
}

export async function listSessionFiles({ all = false, cwd = process.cwd() } = {}) {
  const root = projectsDir();
  let dirs;
  if (all) {
    try {
      dirs = (await readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => join(root, d.name));
    } catch {
      dirs = [];
    }
  } else {
    dirs = [join(root, projectKey(cwd))];
  }

  const files = [];
  for (const dir of dirs) {
    let names = [];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const path = join(dir, name);
      const s = await stat(path);
      files.push({ path, project: basename(dir), mtimeMs: s.mtimeMs, size: s.size });
    }
  }
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** Slash-command echoes and other local plumbing that never went to the model. */
function isLocalNoise(text) {
  const t = text.trim();
  if (!t) return true;
  return /^<(command-name|command-message|local-command-stdout|local-command-caveat|bash-input|bash-stdout|bash-stderr)>/.test(t)
    || t === "[Request interrupted by user]"
    || t === "[Request interrupted by user for tool use]";
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (typeof b === "string" ? b : b?.type === "text" ? b.text ?? "" : ""))
      .filter(Boolean)
      .join("\n");
  }
  if (content == null) return "";
  return JSON.stringify(content);
}

/**
 * Parse one session file. Returns null when it holds no conversation.
 *
 * Adjacent assistant events are merged: Claude Code writes one event per content
 * block for a single response, and a tool result always sits between two
 * distinct responses, so merging neighbours reconstructs each response exactly.
 */
export async function parseSessionFile(path) {
  const raw = await readFile(path, "utf8");
  const transcript = [];
  let sessionId;
  let model;
  let version;
  let cwd;
  let first;
  let last;
  let events = 0;

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.isSidechain) continue; // subagent transcripts are not the user's conversation
    if (e.type !== "user" && e.type !== "assistant") continue;

    sessionId ??= e.sessionId;
    version ??= e.version;
    cwd ??= e.cwd;
    if (e.timestamp) {
      first ??= e.timestamp;
      last = e.timestamp;
    }
    const m = e.message;
    if (!m) continue;
    events++;

    if (e.type === "user") {
      if (e.isMeta) continue;
      const content = m.content;
      if (Array.isArray(content)) {
        const texts = [];
        for (const b of content) {
          if (!b || typeof b !== "object") continue;
          if (b.type === "text") texts.push(b.text ?? "");
          else if (b.type === "tool_result") transcript.push({ role: "tool", content: textOf(b.content), ts: e.timestamp });
        }
        const t = texts.join("\n");
        if (!isLocalNoise(t)) transcript.push({ role: "user", content: t, ts: e.timestamp });
      } else {
        const t = textOf(content);
        if (!isLocalNoise(t)) transcript.push({ role: "user", content: t, ts: e.timestamp });
      }
      continue;
    }

    // assistant
    if (m.model) model = m.model;
    const blocks = Array.isArray(m.content) ? m.content : [{ type: "text", text: textOf(m.content) }];
    const turn = { role: "assistant", content: "", thinking: "", toolUses: [], ts: e.timestamp };
    for (const b of blocks) {
      if (!b || typeof b !== "object") continue;
      if (b.type === "text") turn.content += (turn.content ? "\n" : "") + (b.text ?? "");
      else if (b.type === "thinking") turn.thinking += (turn.thinking ? "\n" : "") + (b.thinking ?? "");
      else if (b.type === "tool_use") turn.toolUses.push({ name: String(b.name ?? ""), input: JSON.stringify(b.input ?? {}) });
    }

    const prev = transcript[transcript.length - 1];
    if (prev && prev.role === "assistant") {
      if (turn.content) prev.content += (prev.content ? "\n" : "") + turn.content;
      if (turn.thinking) prev.thinking = (prev.thinking ? `${prev.thinking}\n` : "") + turn.thinking;
      prev.toolUses.push(...turn.toolUses);
    } else {
      transcript.push(turn);
    }
  }

  for (const t of transcript) {
    if (t.role === "assistant") {
      if (!t.thinking) delete t.thinking;
      if (!t.toolUses.length) delete t.toolUses;
    }
  }

  if (transcript.length === 0) return null;

  return {
    sessionId: sessionId ?? basename(path, ".jsonl"),
    transcript,
    meta: {
      harness: HARNESS,
      model,
      harnessVersion: version,
      startedAt: first,
      endedAt: last,
      events,
    },
    cwd,
  };
}
