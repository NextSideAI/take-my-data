import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { estimatePoints, gateOf, measure, redactText, sanitizeSession } from "../scripts/lib/sanitize.mjs";
import { listSessionFiles, normalizeHarnesses, parseOpenCodeExport, parseSessionFile, projectKey, sessionHash } from "../scripts/lib/transcript.mjs";

test("redacts vendor keys, kv secrets, PII and home paths", () => {
  const out = redactText(
    [
      "ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789",
      "gh ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD",
      "password: hunter2xx",
      "kim@example.com 010-1234-5678 4111 1111 1111 1111",
      "C:\\Users\\jiwon\\x and C:\\\\Users\\\\jiwon\\\\y and /home/kim/z",
    ].join("\n"),
  );
  assert.doesNotMatch(out, /sk-ant|ghp_|hunter2|example\.com|1234-5678|4111|jiwon|kim\//);
  assert.match(out, /C:\\Users\\<user>\\x/);
  assert.match(out, /C:\\\\Users\\\\<user>\\\\y/);
  assert.match(out, /\/home\/<user>\/z/);
});

test("measurement excludes tool results and gates small sessions", () => {
  const { session } = sanitizeSession({
    sessionId: "s",
    transcript: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "tool", content: "x".repeat(100_000) },
    ],
  });
  const m = measure(session.transcript);
  assert.equal(m.turns, 2);
  assert.ok(m.usableTokens < 10);
  assert.equal(gateOf(m), "TOO_SMALL");
  assert.equal(estimatePoints({ usableTokens: 41_203, semanticPass: true }), 41.2);
  assert.equal(estimatePoints({ usableTokens: 1_000, semanticPass: false }), 0.7);
});

test("hash and project key match the server / Claude Code conventions", () => {
  const expected = createHash("sha256").update("claude_code:abc").digest("hex");
  assert.equal(sessionHash("abc"), expected);
  if (process.platform === "win32") assert.equal(projectKey("C:\\Users\\com\\Desktop\\open"), "C--Users-com-Desktop-open");
  assert.ok(projectKey("/home/x/p").endsWith("-home-x-p"));
  assert.equal(sessionHash("abc", "codex"), createHash("sha256").update("codex:abc").digest("hex"));
  assert.deepEqual(normalizeHarnesses("claude-code,Codex,pi,open-code"), ["claude_code", "codex", "pi", "opencode"]);
});

test("parses Claude Code JSONL: merges assistant blocks, splits tool results, drops noise", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tmd-"));
  const file = join(dir, "abc.jsonl");
  const lines = [
    { type: "summary", summary: "ignored" },
    { type: "user", sessionId: "abc", cwd: "/home/x/p", timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: "<command-name>/model</command-name>" } },
    { type: "user", sessionId: "abc", timestamp: "2026-01-01T00:00:01Z", message: { role: "user", content: "fix the flaky test" } },
    { type: "assistant", sessionId: "abc", timestamp: "2026-01-01T00:00:02Z", message: { role: "assistant", model: "claude-opus-5", content: [{ type: "thinking", thinking: "look at setup" }] } },
    { type: "assistant", sessionId: "abc", timestamp: "2026-01-01T00:00:03Z", message: { role: "assistant", model: "claude-opus-5", content: [{ type: "tool_use", name: "Read", input: { file_path: "/home/x/p/t.ts" } }] } },
    { type: "user", sessionId: "abc", timestamp: "2026-01-01T00:00:04Z", message: { role: "user", content: [{ type: "tool_result", content: "file body" }] } },
    { type: "assistant", sessionId: "abc", isSidechain: true, message: { role: "assistant", content: [{ type: "text", text: "subagent chatter" }] } },
    { type: "assistant", sessionId: "abc", timestamp: "2026-01-01T00:00:05Z", message: { role: "assistant", model: "claude-opus-5", content: [{ type: "text", text: "It's a race; awaited the teardown." }] } },
  ];
  await writeFile(file, lines.map((l) => JSON.stringify(l)).join("\n"));

  const parsed = await parseSessionFile(file);
  assert.equal(parsed.sessionId, "abc");
  assert.deepEqual(
    parsed.transcript.map((t) => t.role),
    ["user", "assistant", "tool", "assistant"],
  );
  assert.equal(parsed.transcript[1].thinking, "look at setup");
  assert.equal(parsed.transcript[1].toolUses[0].name, "Read");
  assert.equal(parsed.transcript[2].content, "file body");
  assert.ok(!JSON.stringify(parsed).includes("subagent chatter"));
  assert.equal(parsed.meta.model, "claude-opus-5");

  const { session } = sanitizeSession(parsed);
  assert.equal(session.meta.cwd, undefined);
  assert.ok(session.transcript[1].toolUses[0].input.includes("<user>"));
});

test("parses Codex rollout without duplicating event messages or including developer prompts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tmd-codex-"));
  const file = join(dir, "rollout.jsonl");
  const rows = [
    { type: "session_meta", timestamp: "2026-01-01T00:00:00Z", payload: { id: "codex-1", cwd: "/work/p", cli_version: "1.2.3", model_provider: "openai", source: "cli" } },
    { type: "turn_context", timestamp: "2026-01-01T00:00:01Z", payload: { model: "gpt-test" } },
    { type: "event_msg", timestamp: "2026-01-01T00:00:02Z", payload: { type: "user_message", message: "duplicate user" } },
    { type: "response_item", timestamp: "2026-01-01T00:00:02Z", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "private instructions" }] } },
    { type: "response_item", timestamp: "2026-01-01T00:00:03Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "fix it" }] } },
    { type: "response_item", timestamp: "2026-01-01T00:00:04Z", payload: { type: "reasoning", summary: [{ type: "summary_text", text: "inspect first" }] } },
    { type: "response_item", timestamp: "2026-01-01T00:00:05Z", payload: { type: "custom_tool_call", name: "exec", input: "{\"cmd\":\"test\"}" } },
    { type: "response_item", timestamp: "2026-01-01T00:00:06Z", payload: { type: "custom_tool_call_output", output: "ok" } },
    { type: "response_item", timestamp: "2026-01-01T00:00:07Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] } },
  ];
  await writeFile(file, rows.map(JSON.stringify).join("\n"));
  const parsed = await parseSessionFile({ path: file, harness: "codex" });
  assert.equal(parsed.sessionId, "codex-1");
  assert.equal(parsed.meta.harness, "codex");
  assert.equal(parsed.meta.model, "gpt-test");
  assert.deepEqual(parsed.transcript.map((t) => t.role), ["user", "assistant", "tool", "assistant"]);
  assert.equal(parsed.transcript[0].content, "fix it");
  assert.equal(parsed.transcript[1].thinking, "inspect first");
  assert.equal(parsed.transcript[1].toolUses[0].name, "exec");
  assert.ok(!JSON.stringify(parsed).includes("private instructions"));
  assert.ok(!JSON.stringify(parsed).includes("duplicate user"));
});

test("marks the current Codex thread active even when its file timestamp is stale", async () => {
  const root = await mkdtemp(join(tmpdir(), "tmd-codex-home-"));
  const dir = join(root, "sessions", "2026", "01", "01");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "rollout-active.jsonl"), JSON.stringify({ type: "session_meta", payload: { id: "active-id", cwd: "/work/p", source: "cli" } }));
  const oldHome = process.env.CODEX_HOME;
  const oldId = process.env.CODEX_SESSION_ID;
  process.env.CODEX_HOME = root;
  process.env.CODEX_SESSION_ID = "active-id";
  try {
    const files = await listSessionFiles({ cwd: "/work/p", harnesses: ["codex"], limit: 10 });
    assert.equal(files.length, 1);
    assert.equal(files[0].active, true);
  } finally {
    if (oldHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldHome;
    if (oldId === undefined) delete process.env.CODEX_SESSION_ID; else process.env.CODEX_SESSION_ID = oldId;
  }
});

test("parses only the active Pi session branch", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tmd-pi-"));
  const file = join(dir, "pi.jsonl");
  const rows = [
    { type: "session", version: 3, id: "pi-1", timestamp: "2026-01-01T00:00:00Z", cwd: "/work/p" },
    { type: "message", id: "a", parentId: null, timestamp: "2026-01-01T00:00:01Z", message: { role: "user", content: "build it" } },
    { type: "message", id: "old", parentId: "a", timestamp: "2026-01-01T00:00:02Z", message: { role: "assistant", content: [{ type: "text", text: "abandoned" }] } },
    { type: "model_change", id: "m", parentId: "a", timestamp: "2026-01-01T00:00:03Z", provider: "test", modelId: "pi-model" },
    { type: "message", id: "b", parentId: "m", timestamp: "2026-01-01T00:00:04Z", message: { role: "assistant", content: [{ type: "thinking", thinking: "plan" }, { type: "toolCall", name: "read", arguments: { path: "x" } }, { type: "text", text: "done" }] } },
    { type: "message", id: "c", parentId: "b", timestamp: "2026-01-01T00:00:05Z", message: { role: "toolResult", content: [{ type: "text", text: "file" }] } },
  ];
  await writeFile(file, rows.map(JSON.stringify).join("\n"));
  const parsed = await parseSessionFile({ path: file, harness: "pi" });
  assert.equal(parsed.meta.model, "pi-model");
  assert.deepEqual(parsed.transcript.map((t) => t.role), ["user", "assistant", "tool"]);
  assert.ok(!JSON.stringify(parsed).includes("abandoned"));
  assert.equal(parsed.transcript[1].toolUses[0].name, "read");
});

test("parses OpenCode export messages, reasoning and tool parts", () => {
  const parsed = parseOpenCodeExport({
    info: { id: "ses_test", directory: "/work/p" },
    messages: [
      { info: { role: "user", time: { created: 1_700_000_000_000 }, model: { providerID: "p", modelID: "m" } }, parts: [{ type: "text", text: "fix it" }, { type: "text", text: "injected", synthetic: true }] },
      { info: { role: "assistant", time: { created: 1_700_000_001_000 }, providerID: "p", modelID: "m" }, parts: [{ type: "reasoning", text: "think" }, { type: "tool", tool: "bash", state: { input: { command: "test" }, output: "passed" } }, { type: "text", text: "done" }] },
    ],
  });
  assert.equal(parsed.meta.harness, "opencode");
  assert.deepEqual(parsed.transcript.map((t) => t.role), ["user", "assistant", "tool"]);
  assert.equal(parsed.transcript[0].content, "fix it");
  assert.equal(parsed.transcript[1].thinking, "think");
  assert.equal(parsed.transcript[1].toolUses[0].name, "bash");
  assert.equal(parsed.transcript[2].content, "passed");
});
