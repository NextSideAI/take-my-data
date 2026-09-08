// Client-side mirror of the server's src/lib/sanitize.ts.
//
// The server re-runs the same rules on whatever it receives and its result is the
// one that counts. Keeping a copy here means the preview you see locally is what
// the server will store, and nothing sensitive has to leave the machine to find
// out what would be redacted.

/** Order matters: vendor-specific patterns first, generic KEY=value last. */
const RULES = [
  { name: "private-key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, replace: "<private-key>" },
  { name: "anthropic", re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g, replace: "<secret>" },
  { name: "openai", re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g, replace: "<secret>" },
  { name: "github", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/g, replace: "<secret>" },
  { name: "github-pat", re: /\bgithub_pat_[A-Za-z0-9_]{60,}\b/g, replace: "<secret>" },
  { name: "aws", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, replace: "<secret>" },
  { name: "slack", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, replace: "<secret>" },
  { name: "google", re: /\bAIza[0-9A-Za-z_-]{35}\b/g, replace: "<secret>" },
  { name: "stripe", re: /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g, replace: "<secret>" },
  { name: "odrh", re: /\bodrh_[A-Za-z0-9]{20,}\b/g, replace: "<secret>" },
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, replace: "<jwt>" },
  { name: "bearer", re: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/g, replace: "$1 <secret>" },
  {
    name: "kv-secret",
    re: /\b((?:api[_-]?key|secret(?:[_-]?key)?|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|password|passwd|pwd|client[_-]?secret|private[_-]?key|DATABASE_URL|SESSION_SECRET)\s*[:=]\s*["']?)([^\s"'`,;]{6,})/gi,
    replace: (_m, k) => `${k}<secret>`,
  },
  { name: "conn-string", re: /\b(postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s"'`]+/gi, replace: "$1://<redacted>" },
  { name: "email", re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, replace: "<email>" },
  { name: "kr-rrn", re: /\b\d{6}-[1-4]\d{6}\b/g, replace: "<rrn>" },
  { name: "kr-phone", re: /\b01[016789]-?\d{3,4}-?\d{4}\b/g, replace: "<phone>" },
  { name: "intl-phone", re: /\+\d{1,3}[ -]?\d{1,4}[ -]?\d{3,4}[ -]?\d{3,4}\b/g, replace: "<phone>" },
  { name: "card", re: /\b(?:\d[ -]?){13,19}\b/g, replace: (m) => (luhn(m) ? "<card>" : m) },
  { name: "ipv4", re: /\b(?!127\.0\.0\.1\b|0\.0\.0\.0\b)(?:\d{1,3}\.){3}\d{1,3}\b/g, replace: "<ip>" },
  // Tool inputs are JSON strings, so backslashes come doubled ("C:\\Users\\x"). Match both.
  { name: "win-home", re: /([A-Za-z]:\\{1,2}Users\\{1,2})[^\\\s"']+/g, replace: "$1<user>" },
  { name: "win-home-fwd", re: /([A-Za-z]:\/Users\/)[^/\s"']+/g, replace: "$1<user>" },
  { name: "posix-home", re: /(\/(?:home|Users)\/)[^/\s"']+/g, replace: "$1<user>" },
  { name: "system-reminder", re: /<system-reminder>[\s\S]*?<\/system-reminder>/g, replace: "" },
];

function luhn(raw) {
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 13) return false;
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

export function redactText(text, report) {
  let out = text;
  for (const rule of RULES) {
    let hits = 0;
    out = out.replace(rule.re, (...args) => {
      hits++;
      const m = args[0];
      const groups = args.slice(1, -2);
      return typeof rule.replace === "function"
        ? rule.replace(m, ...groups)
        : rule.replace.replace(/\$(\d)/g, (_s, i) => groups[Number(i) - 1] ?? "");
    });
    if (hits && report) report[rule.name] = (report[rule.name] ?? 0) + hits;
  }
  return out;
}

/** Tool results are usually whole files. Keep a slice, never count them for score. */
export const TOOL_RESULT_CAP = 2_000;

export function sanitizeSession(input) {
  const report = {};
  const transcript = [];

  for (const t of input.transcript) {
    if (t.role !== "user" && t.role !== "assistant" && t.role !== "tool") continue;

    let content = redactText(String(t.content ?? ""), report).trim();
    if (t.role === "tool" && content.length > TOOL_RESULT_CAP) {
      content = `${content.slice(0, TOOL_RESULT_CAP)}\n…[truncated ${content.length - TOOL_RESULT_CAP} chars]`;
    }

    const turn = { role: t.role, content };
    if (t.ts) turn.ts = String(t.ts);

    if (t.role === "assistant") {
      const thinking = t.thinking ? redactText(String(t.thinking), report).trim() : "";
      if (thinking) turn.thinking = thinking;
      if (Array.isArray(t.toolUses) && t.toolUses.length) {
        turn.toolUses = t.toolUses.map((u) => ({
          name: String(u.name ?? "").slice(0, 100),
          input: redactText(String(u.input ?? ""), report).slice(0, 4_000),
        }));
      }
    }

    if (!turn.content && !turn.thinking && !turn.toolUses?.length) continue;
    transcript.push(turn);
  }

  const meta = {};
  for (const [k, v] of Object.entries(input.meta ?? {})) {
    if (["cwd", "gitBranch", "user", "home", "hostname"].includes(k)) continue;
    meta[k] = typeof v === "string" ? redactText(v, report).slice(0, 500) : v;
  }

  return {
    session: { sessionId: input.sessionId ? String(input.sessionId).slice(0, 100) : undefined, transcript, meta },
    report,
  };
}

// ── measurement (same approximations as the server) ──────────────────────────

export function estimateTokens(text) {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    if ((c >= 0xac00 && c <= 0xd7af) || (c >= 0x3040 && c <= 0x30ff) || (c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3000 && c <= 0x303f)) {
      cjk++;
    } else if (!/\s/.test(ch)) {
      other++;
    }
  }
  return Math.round(cjk / 1.5 + other / 4);
}

export function usableTokensOf(transcript) {
  let sum = 0;
  for (const t of transcript) {
    if (t.role === "tool") continue;
    sum += estimateTokens(t.content);
    if (t.thinking) sum += estimateTokens(t.thinking);
    for (const u of t.toolUses ?? []) sum += estimateTokens(u.input);
  }
  return sum;
}

export function turnsOf(transcript) {
  return transcript.filter((t) => t.role === "user" || t.role === "assistant").length;
}

export function repeatRatioOf(transcript) {
  const lines = [];
  for (const t of transcript) {
    if (t.role === "tool") continue;
    for (const raw of `${t.content}\n${t.thinking ?? ""}`.split("\n")) {
      const line = raw.trim();
      if (line.length > 20) lines.push(line);
    }
  }
  if (lines.length < 5) return 0;
  const unique = new Set(lines).size;
  return 1 - unique / lines.length;
}

export function semanticCheck(transcript) {
  const reasons = [];
  const users = transcript.filter((t) => t.role === "user");
  const assistants = transcript.filter((t) => t.role === "assistant");

  if (users.length === 0) reasons.push("no user turns");
  if (assistants.length === 0) reasons.push("no assistant turns");

  const assistantChars = assistants.reduce((n, t) => n + t.content.length + (t.thinking?.length ?? 0), 0);
  if (assistantChars < 200) reasons.push("assistant text too short");

  const hasWork =
    assistants.some((t) => (t.toolUses?.length ?? 0) > 0) ||
    assistants.some((t) => (t.thinking?.length ?? 0) > 0) ||
    assistantChars >= 1_000;
  if (!hasWork) reasons.push("no tool use, thinking, or substantial answer");

  const ratio = repeatRatioOf(transcript);
  if (ratio > 0.6) reasons.push(`repeat ratio ${ratio.toFixed(2)}`);

  return { pass: reasons.length === 0, reasons };
}

export function canonicalTranscript(transcript) {
  return JSON.stringify(transcript.map((t) => [t.role, t.content, t.thinking ?? "", (t.toolUses ?? []).map((u) => [u.name, u.input])]));
}

// ── scoring mirror ───────────────────────────────────────────────────────────

export const MIN_TURNS = 3;
export const MIN_TOKENS = 500;
export const MAX_REPEAT_RATIO = 0.6;

export function measure(transcript) {
  const semantic = semanticCheck(transcript);
  return {
    turns: turnsOf(transcript),
    usableTokens: usableTokensOf(transcript),
    repeatRatio: repeatRatioOf(transcript),
    semanticPass: semantic.pass,
    reasons: semantic.reasons,
  };
}

/** Local pre-gate. The server applies the same thresholds; this just avoids wasting the hourly quota. */
export function gateOf(m) {
  if (m.repeatRatio > MAX_REPEAT_RATIO) return "LOW_QUALITY";
  if (m.turns < MIN_TURNS || m.usableTokens < MIN_TOKENS) return "TOO_SMALL";
  return null;
}

/** Points for one session: usable tokens × weight (1.0 pass / 0.7 fail) ÷ 1000. */
export function estimatePoints(m) {
  return Math.round((m.usableTokens * (m.semanticPass ? 100 : 70)) / 1000) / 100;
}
