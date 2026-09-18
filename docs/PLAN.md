# Plan: @aegis/be-rcon — shared BattlEye RCON protocol client

Follows MasterThread `standards/sessions/session_plan_standard.md`. Do one session per fresh
conversation, opened in this repo's folder.

## Goal (from README)

Canonical, shared BattlEye RCON protocol client for The AEGIS Directive's DayZ agents, extracted
once `aegis-services/admin-bot` and `claude-agents/packages/chat-ai` had independent
from-scratch implementations. Consumer repos include it as a git submodule at
`packages/be-rcon`. Scope is deliberately narrow: only logic genuinely identical in intent between
the two original implementations lives here (CRC32, payload layout, packet types, the persistent
client). Nothing DayZ-server-specific, chat-specific, or admin-specific belongs in this repo —
that stays in the consumer repos.

## Current state (from README, as of PR #6/#3 history)

- Framing (`'B' 'E' <crc32 LE> 0xFF <type> <data>`) is live-confirmed correct against AEGIS
  Chernarus (2026-09-13/14); the former "known disagreement" with admin-bot's old leading `0xFF`
  is settled.
- Sequence numbers must start at 0 — a fix landed after PR #3 merged, so it did not reach `main`
  until a follow-up change.
- Keepalive and server-message-ack behavior are implemented and tested (`test/protocol.test.js`,
  `test/client.test.js`, run via `npm test`).
- One open item is tracked externally, in `aegis-core/docs/OUTSTANDING.md`, not duplicated here.

## Backlog first

None — no open PRs on this repo as of this session. This PLAN.md itself is Session 0; no prior
plan document existed.

## Open decisions

None recorded in the repo. Any future scope question (e.g. whether a third consumer should adopt
this package, or whether protocol coverage should expand) is an owner/architecture call, not a
default this document should invent.

---

## Session 1: Update PLAN.md to the standard shape (infrastructure / meta-task)

- **Read:** `standards/sessions/PLAN_template.md` (the exact shape this file now follows)
- **Do:** Add the `## Status` table (this PR itself is Session 0) and the Session 1 section (as a
  placeholder, since this repo's current state is stable and no work is queued for Session 1 yet)
- **Out of scope:** Any consumer-repo changes (the submodule in admin-bot and chat-ai are
  independent PRs)
- **Done when:** PR merged, Status table reflects Session 1 placeholder or queued work
- **Model:** (default Sonnet 5)

---

## Status

| Session | PR | State |
|---|---|---|
| 0 | [#7](https://github.com/yodatech1988/be-rcon/pull/7) | done — PLAN.md added |
| 1 | | not started |
