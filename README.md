# take-my-data

A [Claude Code](https://claude.com/claude-code) skill that donates your own reasoning sessions to
**[OpenDataReasoningHub](https://opendatareasoninghub.org)** — an open dataset of agentic coding
conversations, with an individual and team leaderboard.

- Secrets, tokens, emails, phone numbers, card numbers, home-directory usernames and
  `<system-reminder>` blocks are **redacted on your machine** before anything is sent.
  The server runs the same rules again and only counts what survives.
- Tool outputs (file contents, command output) are truncated to 2,000 chars and never scored.
- You see a preview and must say **yes** before upload. Nothing is sent otherwise.
- You can withdraw any donation later; the points are reversed and the transcript is purged.

## Install

Either:

```bash
npx skills add linda1476/take-my-data
```

or clone it straight into your personal skills folder:

```bash
git clone https://github.com/linda1476/take-my-data ~/.claude/skills/take-my-data
```

Requires Node 18+. No dependencies.

## Use

In Claude Code, from the project whose sessions you want to donate:

```
/take-my-data            # current project's sessions
/take-my-data all        # every project on this machine
/take-my-data withdraw 123
```

Claude runs the script, shows you the sanitized preview, asks for consent, uploads, and hands
you a completion-card link with your score and rank change.

### Without Claude Code

The script is a plain CLI:

```bash
node scripts/donate.mjs login          # GitHub device-code login → ~/.odrh/tokens.json
node scripts/donate.mjs preview        # scan, sanitize, measure — uploads nothing
node scripts/donate.mjs dump 1         # read one sanitized transcript in full
node scripts/donate.mjs donate --yes --pick 1,2
node scripts/donate.mjs withdraw 123
```

`--all` scans every project, `--include-active` includes files modified in the last 10 minutes
(normally skipped as still-running sessions), `--origin http://localhost:3000` targets a local hub
(`ODRH_ORIGIN` works too).

## What gets uploaded

For each session: the sanitized transcript (`user` / `assistant` / `tool` turns, with assistant
`thinking` and `toolUses` inputs), plus model name, harness version and timestamps. **Not**
uploaded: working directory, git branch, hostname, username, raw tool outputs beyond the cap,
subagent (sidechain) transcripts, slash-command echoes.

Sessions are deduplicated by `sha256("claude_code:" + sessionId)`; the same file can only be
credited once, to whoever donated it first.

## License of the data you donate

Uploading dedicates the sanitized sessions to the public domain under
**[CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/)**. The preview prints this, the
consent question repeats it, and the upload records the license id per donation. The sessions are
then published in the hub's open dataset (<https://opendatareasoninghub.org/dataset>) — with your
GitHub handle as `contributor` unless your account is set to anonymous. Withdrawing removes the
session from every future download and lists its hash in the dataset manifest.

The skill fetches the current license from `GET /api/dataset` so the text you see is the one the
hub enforces; if it ever changes, old clients are refused with `license_required` instead of
silently uploading under a text you didn't read.

## Scoring

| | |
| --- | --- |
| per session | usable tokens × weight ÷ 1000 pt (weight 1.0 if the semantic check passes, else 0.7) |
| minimum | 3 turns, 500 usable tokens, repeat ratio ≤ 60 % |
| bonuses | first accepted donation +50 pt · founding member (first 100, GitHub ≥ 30 days) +300 pt |
| limits | 50 requests / hour per account (≤5 sessions each) · 5 rejections in a row locks donations for 24 h |

Full rules and the API for other harnesses: <https://opendatareasoninghub.org/donate>

## Layout

```
SKILL.md                 what Claude does (procedure + hard rules)
scripts/donate.mjs       the CLI
scripts/lib/sanitize.mjs redaction + measurement, mirrors the server
scripts/lib/transcript.mjs Claude Code JSONL → transcript
scripts/lib/api.mjs      device-flow login, token store, HTTP
.claude-plugin/          plugin/marketplace manifests (experimental)
```

## 한국어

Claude Code 세션을 [OpenDataReasoningHub](https://opendatareasoninghub.org)에 기부하는 스킬입니다.
비밀·개인정보·경로의 사용자명은 **내 컴퓨터에서 먼저 지워지고**, 미리보기를 본 뒤 "예"라고 해야만
올라갑니다. 언제든 철회할 수 있습니다.

```bash
git clone https://github.com/linda1476/take-my-data ~/.claude/skills/take-my-data
```

그다음 Claude Code에서 `/take-my-data`.

## License

MIT
