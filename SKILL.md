---
name: take-my-data
description: Donate the user's Claude Code reasoning sessions to OpenDataReasoningHub (opendatareasoninghub.org). Sanitizes secrets/PII locally, shows a preview, requires explicit consent, then uploads and reports score and rank changes. Use when the user runs /take-my-data, asks to donate or contribute their sessions/transcripts, or wants to withdraw a donation.
---

# take-my-data

You are helping the user donate their own Claude Code sessions as open reasoning data.
Everything runs through one script that lives next to this file:

```
node "<SKILL_DIR>/scripts/donate.mjs" <command> [flags]
```

`<SKILL_DIR>` is the directory containing this SKILL.md (typically `~/.claude/skills/take-my-data`).
Node 18+ is required; there are no dependencies.

## Arguments

`$ARGUMENTS` may be empty or one of:

| argument | meaning |
| --- | --- |
| *(empty)* | sessions of the **current project** only |
| `all` | sessions of every project on this machine |
| `withdraw <id>` | take down donation `<id>` |
| `status` / `whoami` | show who is logged in |
| `login` | (re)authenticate |
| `dump <n>` | print the full sanitized text of preview row `n` |

Anything else: treat it as free-text intent and pick the closest command.

## Procedure

1. **Check login.** Run `whoami`. If it exits non-zero, run `login` and relay the printed
   `Open <url>` / `Enter <code>` lines to the user verbatim. The command blocks until they approve
   in the browser. If the server answers `auth_not_configured`, stop and tell the user this hub
   has no GitHub login yet.

2. **Preview.** Run `preview` (add `--all` for the `all` argument). Show the user the table
   *as printed* plus the one-line first-message excerpts, and summarize in your own words:
   - how many sessions are ready, total tokens and estimated points
   - what was redacted (the `redacted` column) and that tool outputs are truncated and unscored
   - which rows were skipped and why (active / too small / low quality / already donated)

3. **Ask for consent — and wait.** The question must name the license the preview printed, e.g.
   "Upload these N sessions to opendatareasoninghub.org? They will be dedicated to the public domain
   under CC0 1.0 and published in the open dataset (with your GitHub handle unless your account is
   anonymous)." Offer `dump <n>` if they want to read one in full first. Do **not** proceed on
   silence, on "ok" to something else, or on a previous conversation's approval. If they want to
   exclude rows, re-run `preview` and use `--pick 1,3` in the next step to name only the approved rows.

4. **Upload only after an explicit yes.** Run `donate --yes --pick <rows>` (plus `--all` if used
   in the preview). Relay each result line: points, the completion-card URL, and rank changes.
   `rejected DUPLICATE` means someone (possibly the user, elsewhere) already donated that session;
   `rate_limited` means the hourly cap (10 uploads) was reached — say when to retry.

5. **Withdraw** (`withdraw <id>`): confirm the id with the user, run it, relay the result.
   Withdrawal reverses the points in the ledger and purges the transcript; the session hash stays
   claimed so it cannot be re-uploaded.

## Hard rules

- Never pass `--yes` without an explicit, current confirmation from the user in this conversation,
  given after they saw the license line. The upload echoes that license id; if the hub answers
  `license_required`, the license changed — show the new one and ask again, never retry silently.
- Never edit the transcripts, the sanitizer, or the hash before upload to change the score.
- Never paste the raw (unsanitized) session logs into the conversation; use `dump <n>`, which prints
  the sanitized version.
- The token lives in `~/.odrh/tokens.json`. Never print it.
- Use `--origin <url>` (or `ODRH_ORIGIN`) only if the user asked to target a different hub.

## Scoring, briefly (so you can answer questions)

- One session = sanitized usable tokens × weight ÷ 1000 points; weight 1.0 if the semantic check
  passes, 0.7 otherwise. Tool results are never counted.
- Minimum to be accepted: 3 conversation turns and 500 usable tokens; repeat ratio ≤ 60 %.
- First accepted donation: +50 pt. Founding member (first 100, GitHub account ≥ 30 days): +300 pt.
- Each session is credited once, to whoever donated it first.
- Contributions are recorded against the team the user is in **at that moment**; moving teams later
  does not move past points.
