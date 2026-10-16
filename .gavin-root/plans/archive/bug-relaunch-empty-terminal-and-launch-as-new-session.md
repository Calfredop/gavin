---
order: 2048
kind: plan
title: Re-launch opens an empty terminal when the card's session has no stored command; add "Launch as new session"
status: Done
priority: medium
complexity: moderate
attachments: app/src/lib/cards/cardRunActions.ts
---
## Bug: Re-launch opens a bare shell

Seen on 2026-10-15 in the mandragora workspace. Re-launching the card "Tighten CardTrader troll guard, purge parked prices, verify spikes" (`.gavin-root/plans/fix-cardtrader-troll-guard.md`) opened an empty terminal. The new session was just `/bin/zsh -l` (pid 28246) with no child process.

**Evidence** (`~/Library/Application Support/gavin/kanban.sqlite`):
- `card_sessions` for this card has `command = NULL`, `conversation_id = NULL` and `launch_cwd = ''`.
- All three `card_runs` for the card (1004, 1039, 1040) have `command = NULL`. Run 1004 (2026-10-14 09:53–11:11 UTC) did the real work.
- Across the whole table, 993 of 1030 runs store a full `claude --model … --session-id … '<prompt>'` command. This card's runs are among the ones that don't.
- Likely cause: the card was bound to a tab that was already running (linked), not launched from the card. So no launch command was ever recorded.

**Cause in code:** `relaunchCard` (`app/src/lib/cards/cardRunActions.ts:1113`) replays `binding.command`. When the command is NULL, `withFreshConversationId(...)` gets nothing to rewrite, and `backend.createSession(binding.cwd, fresh.command ?? undefined, …)` creates a session with no command. That session is a login shell. The card is then re-bound to it as if the re-launch had worked. Resume can't help either, because there is no `conversation_id`.

**Fix:** when the binding has no command, `relaunchCard` must not spawn anything. Do one of these:
- fall back to the card's Run path, which composes a fresh prompt from the card, or
- return an error the board shows, such as "This card's session was linked, not launched — use Run / Launch as new session".

The board could also hide or disable Re-launch for a binding with no command.

## Feature: "Launch as new session"

Add a card action that starts a fresh agent session from the card **as it is now**, even when a session is already bound:
- The prompt is composed like Run: the current card file, plus the "already under way, check what's done" note that re-launch adds.
- It does not replay the stored command, which can be stale or missing.
- It replaces the binding with the new session and conversation id, and sets `resumeAttempts: 0` and a fresh `baseSha`.
- It goes through the same gates as Run and Re-launch: developing blocker, SSH blocker, and the launch wall/queue.
- It is available on the desk board and on the companion phone card (`DEVICE_ACTIONS` in `app/companion/src/companion/surfaces/phoneCard.ts`).

This also covers the bug above: it is the action to offer when Re-launch has nothing to replay.

## Checklist

- [x] `relaunchCard`: guard against a NULL/empty `binding.command`. Never spawn a bare shell, and never re-bind the card to one.
  - Refuses with `NOTHING_TO_REPLAY` (`board/kanban.ts`) twice: on the board's `replayable: false` before any gate (so a queued re-launch is never refused into a void), and on the command read back via `backend.cardSession` before spawning (covers a daemon too old to send the flag).
- [x] Hide or disable Re-launch on the board/phone when the binding has no command, with a reason.
  - The daemon's board read now carries `replayable` (computed from the stored command, never the command itself; `CardSession.replayable` in `protocol`, `kanban.rs`). No protocol bump: it is a response field with a default, absent from an older daemon, and absent reads as replayable (`canReplay`).
  - Detail bar + phone card: Re-launch stays drawn but greyed, with the reason as a line under the bar (a disabled button gets no hover). Card menu: Re-launch is left out. The board card's exited hint says "open the card to launch a new session".
- [x] Add a "Launch as new session" action (desk + companion), built on the Run prompt path, that replaces the existing binding.
  - `launchCardAsNewSession` = `launchCard` mode `new-session`: Run's prompt from the card file now + `relaunchNote`, Run's gates (develop, ssh, agent, launch wall as `CardLaunchMode` `new-session`, first-Run review), fresh conversation id, `resumeAttempts: 0`, fresh `baseSha`. Refuses beside a LIVE binding rather than jumping to it or starting a second agent in the same checkout.
  - Detail bar ("Launch as new session", beside Re-launch, enabled whenever the session is not live), card menu (exited binding), phone card (`DEVICE_ACTIONS`, `state/cards.ts` `launch`).
- [x] Tests: re-launch with a command-less binding doesn't spawn and doesn't re-bind; "Launch as new session" replaces the binding with a fresh conversation id.
  - `cardRunActions.test.ts` (both refusal paths; new session: prompt, binding replacement, review gate, live refusal), `cardDetail.test.ts`, `cardMenu.test.ts`, `kanbanState.test.ts`, companion `seam/cards.test.ts`, daemon `kanban::tests::the_board_says_which_bindings_have_a_launch_to_replay`.
- [x] Human test: After a daemon rebuild+restart, open the mandragora card fix-cardtrader-troll-guard.md: the session bar shows Re-launch greyed with the "linked, not launched" line under it, and "Launch as new session" starts a real agent (not a bare zsh) bound to the card; same card on the phone shows both buttons the same way
