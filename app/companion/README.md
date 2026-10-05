# `app/companion/` — Companion web

The UI a Device runs to work on a Workstation: the **Workstation UI bundle**
of `docs/superpowers/specs/2026-09-27-companion-design.md`. A SvelteKit static
build that imports the desktop's components and logic modules as they are and
reaches the Workstation through one channel. Read ADR 0003 (the Companion
drives the desktop app) and ADR 0005 (each Workstation serves the UI it
speaks) first; `CONTEXT.md` has the words.

## Why it lives inside `app/`

There is no `package.json` here, on purpose. Everything resolves from
`app/node_modules` by walking up, so the bundle is built with the desktop's
own svelte under the desktop's own lockfile. The two have to be one commit
(ADR 0005), and a second dependency tree would be a second version of
everything the desktop's components were compiled against.

`$lib` is the desktop's library (`kit.files.lib` → `../src/lib`), which is
what lets every desktop module's `$lib/<folder>/<name>` import resolve
unchanged. The bundle's own code is `$companion` → `src/companion`.

## Commands

From `app/`:

```
npm run companion:dev      # dev server on :1430, against the Demo Workstation
npm run companion:test     # vitest, seam 2
npm run companion:check    # svelte-check, the desktop's library included
npm run companion:build    # the static bundle, in companion/build
npm run companion:preview  # serve that build on :1431
```

`companion:preview` reads the build when it STARTS. Rebuild, then restart it,
or it keeps serving the chunks it found the first time.

## The channel

`src/companion/channel/`. A closed, versioned set of typed messages, carried
as JSON strings. Every message a bundle sends has an `id` and is answered by
exactly one `result` with that id.

| from the bundle | carries | answered with |
|---|---|---|
| `capabilities` | — | `{ version, messages, workstation: { id, name, demo }, landing? }` |
| `invoke` | `cmd`, `args` | the command's value, or its error |
| `listen` | `event` | nothing, once the listener is registered |
| `unlisten` | `listener` (the `listen`'s id) | nothing |
| `open-external` | `url` | nothing, once opened |
| `return-to-hub` | — | nothing |

| to the bundle | carries |
|---|---|
| `result` | `id`, `ok`, then `value` or `error` (+ `code: "unsupported"`) |
| `event` | `listener`, `event`, `payload` |

Neither end throws on what it is handed. A type an end does not know is
answered `unsupported` when it carries an id and dropped when it does not; an
unknown field is ignored. A bundle asks `capabilities` before using anything
beyond the core set (`invoke`, `result`, `listen`, `event`, `unlisten`), and an
end that cannot answer the question is taken to carry exactly that set — so a
shell older than its bundle costs a button, never the page.

`landing` is optional and read only by a bundle that knows it: where the
shell wants the bundle to land, when it opened it for an inbox item — the
item's workspace and its target, a session or a card (`readLanding`). The
shell hands it over in the first `capabilities` answer and never again.
The bundle opens the terminal of the session the item names, where the
workspace still holds it; otherwise the card the item names, over its
workspace's board, or that board on the card whose agent is the session it
names (`landingCard`) — outlined on the board until the human goes somewhere
else.

**The shell's side of the contract** (companion-19, `app/companion-shell/`):
put an object at `window.gavinChannel` with `postMessage(string)` and an
`onmessage` the page will set, called with `{ data: string }`. That is the
shape Android's `addWebMessageListener` injects, origin gate included; the iOS
shell declares the same object over its script-message handler. With no such
object the page hosts a Demo Workstation of its own, which is how the bundle
runs in a desktop browser. The shell answers `capabilities`, `open-external`
and `return-to-hub` itself and carries the rest to the one Workstation the
visit reaches.

The shell hosts the bundle to three findings of the device-keys spike
(`docs/research/2026-09-28-companion-device-keys.md`, on branch
`spike/companion-device-keys` (38b6f289) until it merges), all three measured,
and its `scripts/probe.sh` checks them on a Simulator and an emulator:

- The bundle is never loaded inside the shell's own Capacitor webview, **not
  even in an iframe**: Capacitor iOS's `bridge` handler answers every frame.
- On iOS the channel's handler is visible to frames inside the bundle, so the
  shell has to refuse anything that is not the main frame.
- On Android the bundle's webview needs a process of its own
  (`android:process`, with `WebView.setDataDirectorySuffix` before the first
  webview), or it shares a renderer with the shell. The channel then crosses
  processes.

## The remote shim

`src/companion/remote/`. The build resolves every Tauri module the desktop
imports to a file here (`kit.alias` in `svelte.config.js`), so none of Tauri's
own JS ships. `seam/tauriModules.test.ts` fails when the desktop imports one
this list does not cover.

| module | here | what it does |
|---|---|---|
| `@tauri-apps/api/core` | `core.ts` | `invoke` → the channel. Refuses layout-saving and `plugin:` commands before the wire. |
| `@tauri-apps/api/event` | `event.ts` | `listen` → the channel. `emit` is refused: events travel one way. |
| `@tauri-apps/api/window` | `window.ts` | The window's label is `"companion"`. See below. |
| `@tauri-apps/plugin-opener` | `opener.ts` | `openUrl` → `open-external`. |
| `@tauri-apps/plugin-notification` | `plugins/notification.ts` | Never granted: notifications are the shell's push. |
| `@tauri-apps/plugin-clipboard-manager` | `plugins/clipboard.ts` | The page's own clipboard. |
| `@tauri-apps/plugin-dialog` | `plugins/dialog.ts` | Answers as a picker the human closed. |
| `@tauri-apps/plugin-os` | `plugins/os.ts` | Declines; the desktop reads that as "cannot be told". |

## The three rules, and what holds each

**The Companion keeps its own view state.** `state/viewState.ts`, stored on the
Device under `gavin.companion.view.<workstation id>`. The open workspace is
mirrored into `layoutState.activeWorkspaceId` in memory, so the desktop's
modules agree about which workspace is open, and written nowhere else.

**It never sends a layout-saving command.** `remote/remoteRole.ts` names them
(`set_workspaces_state`, `set_file_tabs`, `set_board_tabs`, `set_card_tabs`) and
`core.ts` refuses them before the channel. `seam/layoutSaving.test.ts` holds the
refusal; `state/workstation.test.ts` drives a whole visit and reads the wire;
`seam/bundleSources.test.ts` keeps the bundle from importing `layoutState`'s
actions at all. That list stands in for the Remote role command table until
companion-12 lands it in the protocol crate — reconcile the two then.

**It never runs a rail.** This is the one that bites. The desktop's scheduler
is not only `startScheduler`: every fetch, refresh and push of a workspace's
orchestration ticks by hand, gated only by `runsRailsFor`, which asks whose
window this is — and outside Tauri the desktop answers `"main"`, the window
that does run them. So a bundle that loaded a rail merely to draw it would run
it beside the desk. `window.ts` gives the bundle a label no desktop window has,
which turns every one of the desktop's own gates to "not here".
`seam/railScheduler.test.ts` loads a rail that is owed work and reads the wire;
`seam/railSchedulerControl.test.ts` runs the same state as `"main"` and watches
it act, which is what makes the silence mean something. `seam/rails.test.ts`
drives every rail action with the scheduler's two doors watched, and fails
if either opens.

For the same reason the bundle does **not** call `layoutState.bootstrap()`.
That bootstrap is the desk's: it starts every duty that must run in one place
(the launch queue, auto-resume, the reclaim of idle sessions) and repairs the
desk's layout as it goes, saving what it repaired. `state/workstation.ts` stands
in its place and fills the same stores through the desktop's own loaders.

## The Demo Workstation

`src/companion/demo/`. The Workstation's end of the channel, answering from
sample data — the thing App Review explores, and the suites' only fixture.

- `sampleData.ts` — the machine: two projects and a Scratchpad, typed against
  the desktop's own wire types. Its cards are files (`sampleCards.ts`), and
  its trees are what a scan of them reads (`cardFiles.ts`, the daemon's own
  parse and writers in `gavin.rs`, cut down).
- `railCommands.ts` — a workspace's orchestration: the plan and run-state
  writes, with the daemon's guard on taking a live step off the plan, and a
  desk that ticks after each one -- launching a rail's card steps on a page
  of the rail's own, marking them done as their cards reach Done, moving the
  rail on -- and announces what it wrote as `orchestration-written`, as a
  desk's host does. It ticks as time passes too (`advance`), so a card moved
  to Done from the phone moves its rail on.
- `cardCommands.ts` — a board's and a card's commands over those files: a
  write edits one, then the trees are read again and pushed as
  `gavin-tree-changed`, and a watched file is said to have changed, exactly
  as a Workstation's watchers do. Done files a card under `done/`,
  archiving under `archive/`, nested tasks travel with their plan, and a
  binding or rail step that named the old path follows it.
- `commands.ts` — one answer per desktop command name, each typed as what
  `backend.ts` says that command returns. A command with no entry is answered
  with an error and recorded in `demo.unanswered()`.
- `activity.ts` — a loop of what agents do, so the demo changes while someone
  watches. The page advances it on a timer; a suite advances it by hand.
- `sessions.ts` and `transcripts.ts` — the terminals. Each sample session has
  a screen with history behind it and a script for what is typed into it: an
  agent waits in its input box (bracketed paste on), asks in a numbered menu
  and takes the digit, or works until Esc; the Scratchpad's shell knows `ls`,
  `cd`, `seq`, `git status`. `create_session` opens a shell or an agent and
  places it as a tab on its workspace's Agents page, as the desk places a
  Device's session (companion-16); `kill_session` ends one and closes its
  tab the way the desk would, with `session-exited` then
  `workspaces-synced`. The demo's turn verdict is a rule
  over its own screens shaped as TypeSafe's answer, so the desktop's parser
  and policy read it.
- `workstation.ts` — the endpoint. Refuses what the Remote role is refused,
  as a real Workstation's daemon does.

`seam/desktopBootstrap.test.ts` runs the desktop's real bootstrap against it
and fails on any command left unanswered. When a surface needs a command the
demo lacks, that is where it shows.

## Terminals (companion-26)

A workspace opens on three surfaces, Board, Rails and Sessions
(`state/viewState.ts` remembers which). Sessions lists the workspace's own agent and every page's
terminals in the desk's tab order, with the desk's names and badges
(`surfaces/sessionList.ts`), and starts a New agent or a New terminal the way
the desk does (`state/sessions.ts`: the same `resolvedAgentFor`, profile and
failure patterns). Placing that session as a tab is the desk's
(companion-16); until it does, the phone lists what it started under
"Started from this phone". A session is ended from its terminal, behind the
desk's own confirm (`AppDialog` is mounted on the page).

The terminal is the desk's `TerminalPane` over the desk's terminal registry,
on xterm.js 6.1 (6.0's touch scrolling is broken on iOS). Typing follows the
typing prototype (ticket 01; its findings are comments on `companion.md`):

- **Compose by default.** A line goes as a paste and then Enter, in one
  `write_input`; the paste markers only while the program has bracketed paste
  on (`surfaces/terminalInput.ts`). An empty line is a bare Enter.
- **Quick replies.** Whether the agent is asking is the bell or the turn
  verdict (`verdictAsksQuietly`); what the answers are is read off the screen
  (`surfaces/quickReplies.ts`): a numbered menu's digits, an arrow menu walked
  then Enter, `(y/n)` as lines, canned words only for a question in prose.
  They scroll sideways; Esc and ^C stay pinned.
- **Raw one tap away.** Esc, Tab, a latched Ctrl, the arrows (application
  cursor mode followed), and a More row. The latch reaches the soft keyboard's
  own typing through the registry's `setInputTransform`, the one place a
  terminal's typing is sent.
- **The keyboard.** The page sizes itself to the visual viewport
  (`surfaces/viewport.ts`), so the terminal refits and the PTY is told its new
  size when the keyboard comes and goes.

The desk takes a verdict whenever an agent it ran goes quiet, but keeps it in
its own webview. The phone asks for its own, through the desk's own driver and
under all of its gates, for the one session on screen (`state/turn.ts`). A
list row therefore shows a prose question as waiting only once its terminal
has been opened on the phone.

A terminal is let go when the phone leaves it: every open one is a
`pty-output` listener, and that event carries every session's output, so each
kept terminal is Relay traffic for screens nobody sees. Reopening repaints
from the Workstation's screen model, history included. The event is still
per Workstation rather than per session, so the one open terminal hears all
of them; narrowing that is a protocol change of its own.

`seam/typing.test.ts` drives the dock's own sends against the Demo
Workstation, with a real xterm fed from the wire as the phone's screen
(`testing/phoneScreen.ts`).

## The board and its cards (companion-27)

The board draws the desktop's own `BoardCard` with no workspace id, which is
the card the desk draws in previews — no Run, no session jump, no drag — with
the card's agent and the decisions and tests waiting on the human as badges
under it. A tap opens the card, or the nested task it landed on, as a page
over the board (`ViewState.page`, remembered on the Device); closing it goes
back to the board on that card's column (`returnedFrom`). The bar above the
columns files a new card and opens the workspace's PRD.

The card page (`surfaces/PhoneCard.svelte`, over `surfaces/phoneCard.ts`)
leads with the desk's own session bar (`cardSituation`, `cardSessionBar`),
cut to the actions a Device can take: jump to the agent, run, resume, run
again. Several agents, a develop run and ending a stray process stay at the
desk. Under it: the title, the column, what waits on the human — the
Decisions tab's own `DecisionsItemRow`, fitted to a finger where it lives —
the checklist without those items (they are answered, not ticked), the
body, the plan's tasks, and Archive or Restore. A card whose file moves is
found again by its name under the same `plans/`, and the view follows it.

Every action is the desk's, called from `state/cards.ts`:

- **Move** asks what the board's drag asks before a plan takes its tasks
  into `done/` (`guardCompletion`). **Rename** writes the title; the file
  keeps its name. **Tick** is the guarded `set_checklist_item`, and a
  refusal reads the card again.
- **Answer, pass, fail** are the Decisions tab's `answerHumanItem`, confirm
  and message to the card's agent included.
- **Archive** is the card menu's `executeArchive`, handed an ender of the
  phone's own: the card's live agents are stopped at the Workstation, and a
  desk tab showing the card is left to the desk.
- **New card** is the composer's `buildCreatePlanArgs`, read as reviewed
  (the human typed it) and placed at the end of its column.
- **Run** is the desk's one launch flow (`cardRunActions.ts`), first-run
  review and all, with `DEVICE_LAUNCH_HOST` in place of the desk's
  (`CardLaunchHost`): a live agent is shown in the phone's terminal rather
  than by moving the desk's tabs, the launch wall refuses rather than
  queueing into a queue only the desk's window drains, and the session is
  the desk's to place — as a labelled tab on the workspace's Agents page
  (companion-16). The phone only notes it started it.
- **The PRD** is read, and kept current while it is open, from the path the
  desk's PRD tab edits (`resolvePrdPath`).

`seam/cards.test.ts` drives each of these against the Demo Workstation and
reads every command they send.

## Rails (companion-28)

A workspace's third surface, between Board and Sessions: each rail's state
and the one press that moves it -- Start while idle with work left, Pause
while running, Resume once paused -- with Reset for a paused or finished
rail, and its stages and steps (`surfaces/phoneRails.ts`, the desk's own
joins). A running step opens its agent's terminal; any other opens its card.
Edit opens one rail for changing: its name, a card added as a stage of its
own or into a stage, a group's mode, a stage moved up or down or taken off,
a step taken off, the rail deleted. Every write is the desk's own action
from `orchestrationState.ts` (`state/rails.ts`), with the desk's confirms
for a delete, a group and a reset.

**Start arms; the desk runs.** `startRail` and `resumeRail` write the rail's
run row and then ask for a pass of the scheduler, which in the bundle is
gated shut -- so each is one `set_rail_run` on the wire and nothing more.
The desk's host announces a Device's orchestration write to the desk's
windows as `orchestration-written`, the event they tell each other with
(`forwarding::announce_orchestration_written`), and the window that runs the
workspace's rails re-reads and ticks. It announces every window's writes to
the Devices under the same event, and the bundle re-reads on it -- and on
`orchestration-changed`, an agent's write -- through the desk's own debounced
re-read (`rereadAfterOtherWindowWrote`), so the phone watches the desk run
what it armed. A card added into the stage a rail is running is started the
same way: by the desk.

## What is here, and what is not

The workspace list, one workspace's board and its cards (above), its rails,
and its sessions and terminals. An inbox item lands on its card, or on the terminal
of the session it names. How this bundle reaches a phone — built and signed
by the desktop build, served by the Workstation, verified and cached by the
shell — is the shell's README's ("Served bundles").

Git, files and settings are the cards that follow (companion-29 and -30),
each extending the Demo Workstation to match.
