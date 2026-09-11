---
order: 2048
title: [feat] the notify and email rail tools are macOS-only
status: Done
---
Two builtin rail tools in `app/src/lib/orchestrationTools.ts` are
AppleScript:

- `builtin:notify` — `osascript -e 'display notification …'`
- `builtin:send-email` — an AppleScript block driving Mail.app

On Linux both fail at the step with `osascript: command not found`. That
is visible rather than silent, and both descriptions already say
"macOS", so the Linux port (`feat-linux-port.md`) deliberately left them
alone rather than quietly changing what a shipped tool does to existing
rails.

What a fix has to decide, which is why this is a card and not a patch:

- `notify-send` is the Linux equivalent and is not always installed
  (`libnotify-bin`). A tool whose whole job is to tell you something
  must not fail quietly when it cannot.
- There is no Mail.app equivalent at all. `xdg-email` opens a composer
  and does not send; sending needs an SMTP account gavin does not have.
  So the email tool may be macOS-only on purpose, in which case the
  honest thing is for the tool list to say so per platform instead of
  offering a step that cannot run.
- Either way a tool's body is a string the human can already edit, so
  the decision is about what the DEFAULT should be, and about whether
  the picker should hide a tool this machine cannot run.

## The decision

**`builtin:notify` gets a portable body, and stays a shell tool.** Its
kind moves `command` → `script` (a branch needs more than one line) and
the body tries `osascript` first, then `notify-send`, then fails loudly
naming what to install. osascript FIRST so macOS behaviour is unchanged
byte for byte — §7.1 of the tools spec already ruled that a shipped tool
must not quietly do something different under an unchanged name, and a
mac with Homebrew's `notify-send` on it would otherwise get a different
notifier than it got yesterday. `script` rather than `command` also keeps
the Tools tab's Run button live: the kinds that cannot run alone are the
completion rules, and `script` is not one of them.

Rejected: making it a `gavin` action over the app's own notification
plugin (`core/notifications.ts`). It is tempting — gavin already sends
desktop notifications on every platform Tauri supports, with no external
binary, so Linux's "is libnotify installed" question disappears. But it
changes what the tool does on the platform where it already works, its
body stops being source the human can read and edit, and a `gavin` tool
is not runnable standalone, so the Tools tab's Run button on "Send a
notification" would go dark. Three regressions to fix one platform.

**No notifier found is a LOUD failure**: the body echoes the message to
the step's terminal, names `libnotify-bin`, and exits 1. Same visible
non-zero exit Linux gets today, with a sentence that says what to do.

**`builtin:send-email` stays macOS-only and says so structurally.** There
is no equivalent to send through, as the card reasoned. So `Tool` gets an
optional `platforms` field (built-ins only, never on the wire — `toRecord`
builds its fields explicitly and `duplicateTool` drops it, because a copy
is the human's to re-point).

**The picker does NOT hide it.** Both surfaces already have a posture for
"a tool you cannot place right now", and it is the same one: the drawer
draws a blocked tool inert with the reason on the row (`toolsBlocked`),
and the Tools tab refuses to filter rows at all — "a filter by kind means
the human who switches a tool to Loop-until watches it vanish from the
list they are standing in". Hiding would also take Duplicate away from the
one built-in a Linux human most wants to re-point at their own mailer. So:
listed, inert, with `“Send an email (Mail.app)” runs only on macOS.` on
it — one sentence, reused as the stall reason when a stored step reaches
it, so a rail authored on a mac explains itself rather than dying on
`osascript: command not found`.

**Windows is out of scope, deliberately.** Neither notifier exists under
Git Bash, so notify lands in the loud-failure branch there. The routes
that would work are a tray balloon that blocks the step for five seconds
or a WinRT toast that needs a registered AppUserModelID and shows nothing
at all without one — a silent failure, which is the thing this card
forbids. That belongs to the Windows port, not here.

- [x] `core/platform.ts`: add `currentPlatform()` — `"macos" | "linux" | "windows" | null`, null meaning "could not be told" (outside a Tauri window) so nothing is ever gated on a guess. `isMacSync` derives from it, keeping its cache-once and retry-after-throw behaviour.
- [x] `orchestrationTools.ts`: optional `platforms` on `Tool`, `toolPlatformBlockedReason(tool, platform)`, `builtin:send-email` marked `["macos"]`, `duplicateTool` drops the field.
- [x] `builtin:notify`: portable body (osascript → notify-send → loud failure), kind `script`, description that names both notifiers.
- [x] `OrchestrationDrawer.svelte`: a platform-blocked tool row is disabled, carries the reason, and gets no `data-orch-tool` so it cannot be dragged either.
- [x] Standalone runs: `runBlockedReason` returns the platform reason (right after `cannotRunAloneReason` — nothing the human can do changes either), and `launch()` refuses with the same sentence for the path that bypasses the button.
- [x] `executeToolLaunch`: stall a platform-blocked step with that reason instead of launching a session that cannot work.
- [x] Amend §7 of `docs/superpowers/specs/2026-08-21-orchestration-tools-design.md` — it currently states both tools are macOS-only as a fact.
- [x] `cargo test --workspace`, `cd app && npm test && npm run check && npm run build`, plus a static pre-flight grep of the exact strings the change relies on.

## Verified

- `cargo test --workspace`: 1143 passed, 0 failed (no `gavin::tests` flakiness this run).
- `cd app && npm test`: 243 files, 5410 tests, all passing. `npm run check`: 0 errors
  (36 warnings, all pre-existing and in files this change does not touch).
  `npm run build`: clean.
- The notify body's three branches, run for real against fake PATHs: with a
  `notify-send` on PATH and no osascript it calls `notify-send -- "gavin" "…"`
  and exits 0; with neither it prints the message and the `libnotify-bin` line
  to stderr and exits 1; on this mac the branch resolves to osascript. The
  suite also `bash -n`s every shipped body, with parameters carrying spaces.
- Static pre-flight (no suite re-runs): one definition of the sentence
  (`orchestrationTools.ts:234`) and four consumers — drawer row, `runBlockedReason`,
  `launch()`, `executeToolLaunch`; `platforms: [` appears once in the whole app,
  on the mailer; `platforms` appears nowhere in `crates/protocol` or
  `crates/daemon`, so there is no wire field and no compat gate to keep.
- Found and fixed on the way: `orchestration.test.ts`'s TOOLS fixture still
  called `builtin:notify` a `command`. Green either way — it is a local
  fixture — but a stale copy of a shipped fact is the next reader's trap.

**Not done, and not this card's:** the visible surface. Nobody has looked at a
disabled Send-an-email row on a Linux machine, and the owner's eyes are the only
thing that can. Nothing is committed; the tree carries 14 modified files and
one new test.
