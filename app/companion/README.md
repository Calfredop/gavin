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

The lockfile is only half of that: what gets built is what is INSTALLED,
and in a checkout shared by many sessions the two part when a commit bumps
the lockfile and nobody reinstalls. `companion:build` and `companion:dev`
therefore run `check-install.mjs` first, which refuses while any package in
`app/node_modules` is not at the version `app/package-lock.json` pins
(`npm install` in `app/` puts it right). Without it the xterm 6.1 bump that
makes a swipe scroll the terminal on iOS shipped as 6.0.0 for eight days.

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
| `result` | `id`, `ok`, then `value` or `error` (+ `code: "unsupported"` or `"unreachable"`) |
| `event` | `listener`, `event`, `payload` |
| `connection` | `state: "up"`, or `state: "down"` and `reason`: `unreachable`, `asleep` or `desktop-app-not-running` |

Neither end throws on what it is handed. A type an end does not know is
answered `unsupported` when it carries an id and dropped when it does not; an
unknown field is ignored. A bundle asks `capabilities` before using anything
beyond the core set (`invoke`, `result`, `listen`, `event`, `unlisten`), and an
end that cannot answer the question is taken to carry exactly that set — so a
shell older than its bundle costs a button, never the page.

`connection` is the one message nobody asked for, and so carries no id: the
shell says it each time its connection to the Workstation goes down or comes
back up (`visit/connectionState.ts`, from the hub's state in `hub/live.ts`),
and never before the bundle has said something, since until then there is no
way to reach it. A bundle assumes up until told otherwise. An older bundle
drops it as a type it does not know; an older shell never sends it, and the
bundle shows each failure as before. A call the shell could not carry -- no
connection, one that dropped or went quiet, a desktop app the daemon could not
ask -- is answered with `code: "unreachable"`, which is how the bundle tells
an error about the outage from the Workstation's own.

The bundle's side is `state/reachability.ts`. While down, the page says so in
one line above the screen, and an error that only says the Workstation could
not be reached is not repeated under it (`shownError`). On the way back up,
every open surface re-runs its own load once, through the desktop's own
in-flight guards (`onReconnect`: Git's `recoverGit`, the board's and a card's
`recoverBoard`, `recoverRails`, the folder Files shows), clearing the
reachability errors it showed first; `state/workstation.ts` reads the
workspaces and the sessions' statuses again, since the pushes sent meanwhile
reached nobody. A git failure or any other refusal of the Workstation's own
stays. An open terminal is not repainted: leaving it and opening it again
does that. `seam/reconnect.test.ts` drops and restores the Demo
Workstation's connection (`reach`) with each surface open, and reads the wire.

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
layout actions at all — only its stores, and the settings writers that end in
`set_workspace_settings`, a workspace's config.toml or an app-wide setting's
own command, which the same suite reads to hold them there. That list stands
in for the Remote role command table until companion-12 lands it in the
protocol crate — reconcile the two then.

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
  parse and writers in `gavin.rs`, cut down). `sampleProjects.ts` is the two
  projects' other files and Git histories: atlas-api mid-task (a change
  staged, one not, a file untracked, a commit not pushed, a finished branch
  to merge, a branch only on origin), field-notes clean. The cards sit in
  the same disk, so a card the phone writes is a change on the Git surface.
- `railCommands.ts` — a workspace's orchestration: the plan and run-state
  writes, with the daemon's guard on taking a live step off the plan, and a
  desk that ticks after each one -- launching a rail's card steps on a page
  of the rail's own, marking them done as their cards reach Done, moving the
  rail on -- and announces what it wrote as `orchestration-written`, as a
  desk's host does. It ticks as time passes too (`advance`), so a card moved
  to Done from the phone moves its rail on.
- `cardCommands.ts` — a board's and a card's commands over those files: a
  write edits one, then reports through `watches.ts` like every other write
  -- the trees read again and pushed as `gavin-tree-changed`, a watched file
  said to have changed, exactly as a Workstation's watchers do. Done files a
  card under `done/`, archiving under `archive/`, nested tasks travel with
  their plan, and a binding or rail step that named the old path follows it.
- `commands.ts` — one answer per desktop command name, each typed as what
  `backend.ts` says that command returns. A command with no entry is answered
  with an error and recorded in `demo.unanswered()`. The Git tab's commands
  are `gitCommands.ts`, over `repo.ts` (enough git for status, diffs,
  staging, commits, branches, a merge and a push, refusals in git's words;
  a merge that would conflict is refused whole); the Files tab's and the
  editor's are `fileCommands.ts`. Both keep the host's fences, and both
  report through `watches.ts`: `file-changed` and `git-changed` reach only
  what is watched, as on a desk. A file saved in Files is a change in Git.
  The Workstation's app-wide settings are `settingsCommands.ts` (each write
  announced as `app-settings-synced`, as the host announces it), and the
  workspaces as Workstation data are `workspaceCommands.ts`: each one's
  settings, `add_workspace`, the home folder, and setting gavin up in a
  folder. The home folder holds `code/weather-station`, a project no
  workspace works in yet, for adding one to find.
- `activity.ts` — a loop of what agents do, so the demo changes while someone
  watches. The page advances it on a timer; a suite advances it by hand. Each
  lap puts back only what it moved — the two scripted agents and the two
  scripted cards — so what a visitor changed (a session, a card, a setting, a
  saved file, a workspace added) stays.
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

A workspace's surfaces include Board, Rails and Sessions
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
for a delete, a group and a reset. The editor's selects take the column and
cut a long card title short rather than widening the page, and draw their
own box, since WebKit sizes a native select to its font whatever
`min-height` says; `surfaces/railEditorFit.test.ts` holds that, the 44px
controls and the 16px name field.

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

**Organize and Reorganize start an agent, not a rail.** Organize with agent
sits beside New rail, and a rail's editor offers Reorganize with agent: each
is the desk's own request (`requestOrganize`, `requestRailReorganize`), the
same prompt and the same one run per workspace, recorded in the workspace's
settings so a second press on either side shows the run instead of starting
another (`agentPresses`, over `orchestrationAgent.ts`'s rules). What the desk
does to its own tabs and queue is handed in as the phone's
(`OrchestrationLaunchHost`): the card run's wall and placing
(`DEVICE_LAUNCH_HOST`), and the run's terminal opened here. A press the desk
would refuse says why rather than going dead, since a phone has no tooltip.

## What is here, and what is not

The workspace list, with the Workstation's settings behind the gear in its
header and **Add a workspace…** under it; and eight surfaces for an open
workspace, switched by the strip under the header (`SurfaceTabs`, which
scrolls sideways where a phone is too narrow for all eight, and counts the
agents waiting on the human on Sessions). The view remembers which, where
Files was, and a settings screen left open, on the Device — never a
half-finished add — and the next workspace opens on the surface last chosen.

**Board**, its cards, **Rails** and **Sessions** with their terminals are
above. An inbox item lands on its card, or on the terminal of the session it
names.

**Decisions** and **Review** (`PhoneItems.svelte` over `phoneItems.ts`): the
cards owed a `Decision:` or a `Human test:`, each item answered in place with
the desk's own row (`DecisionsItemRow`, `answerHumanItem`), and a card's name
opening it over the list, which Back returns to. The lists are the desk's:
Decisions is `decisionsList` with no sessions or rails handed in — a waiting
agent is the Sessions surface's, a rail's gate the Rails surface's — and
Review is `humanTestList` without the diff beside it. Each head carries the
desk's **Clean stale decisions** / **Clean stale tests** (`requestCleanStale`,
the same confirm and prompt), started as Organize is (`DEVICE_AGENT_HOST`):
refused at a full machine rather than queued, the session the desk's to place,
the run opened in the phone's terminal. A press it cannot make says why.

**Git** (`PhoneGit*.svelte` over `phoneGit.ts`): the branch and where it
stands, Fetch, Pull and Push, the op bar with its progress, the error and
merge-in-progress banners; Changes (stage, unstage, a file's diff as a page of
its own, the commit box) and Branches (switch, merge after a question, a new
branch, a branch only the remote has). The state and every action are the
desktop's `gitState.ts`, and the op bar, file rows, commit box and diff lines
are the desktop's components. The desk's `GitHubView` is not: its columns,
section folds, diff layout and worktree choice are saved with
`setGitViewPrefs`, which is the desk's layout — so the phone always reads the
workspace's root checkout.

**Files** (`PhoneFiles.svelte` over `phoneFiles.ts`): one folder at a time
over the desktop's tree state (`fileTree.ts`), and a file opened in the
desktop's own `FileEditor`, which reads, autosaves and watches as at the desk,
with `canOpenExternally={false}`. What the desk hands to another application
(a picture, a binary) the phone says it cannot show. No create, rename or
trash yet.

**Settings** (`PhoneWorkspaceSettings.svelte`), per workspace: its name,
colour and folder; terminal size; auto commit and review; one **Agents** hub
(This agent | Customs | Complexity | Fallback | Pause) with the desk's tab
shell and Customs editor — workspace locals are `local:` profiles; then
unattended recovery and notifications. Every write is ticket 04's
`set_workspace_settings`, through the desktop's own setters — or, for the
agent, its folder's config.toml, as the desk writes it — and never the layout
(ADR 0006). **The Workstation's settings** (`PhoneAppSettings.svelte`): theme,
terminal, cards, git tracking, the same **Agents** hub (Defaults | Customs |
Complexity | Fallback | Pause) over app-wide `customProfiles`, and the memory
wall. Both are the desk's stores, writers and option lists (`phoneSettings.ts`
has what the phone decides differently); what the desk's two panels have beyond
them is the desk's alone — Updates, the daemon, remote access, Devices,
Headroom and TypeSafe; the sidebar and hub-tab rows, which are its layout;
switching an agent, which moves files and re-runs setup; and picking a folder.
A write that fails is said on the screen (`saveSetting`), not in the desk's
whole-window overlay.

Every app-wide setter on the host announces `app-settings-synced`, and every
desk window and every Device re-reads its settings on another writer's change
(`loadAppSettings`). A Device's writes are announced under the origin
`companion` (`forwarding::FORWARDED_ORIGIN`, from a header `dispatch` sets):
under the desk window's own label, the one that dispatched the call would
drop it as its own echo and never show what the phone did.

**Adding a workspace** (`PhoneAddWorkspace.svelte` over
`phoneAddWorkspace.ts`): the Workstation's disk a folder at a time from its
home folder (`home_dir`), through the Files surface's `list_directory` with the
top of the disk as its root, dotfiles left out. A folder a workspace already
works in offers to open it; any other is added named for itself, after the
desk's own question — set gavin up there (and track its files in git?), or add
it as it is. The add is `add_workspace`: settings alone, an id the Workstation
mints, no pages — what the desk's + makes. Every desk window hears it as
`workspaces-synced` and arms the watch on its folder
(`watchRootedWorkspaces` now watches each workspace's root once, not once per
window).

Where a desktop component was wrong for a thumb it became responsive where it
lives, under media queries a window with a mouse never matches: `GitFileRow`
shows its actions without hover and at a fingertip's size, `GitCommitBox` and
`CodeMirrorView` keep text at 16px so iOS does not zoom into a field,
`FileEditor`'s mode switch is thumb-sized, and at a phone's width
`GitDiffUnified` wraps long lines and `MarkdownToolbar` scrolls in one row.
`ColourPicker`'s swatches and `FallbackChainEditor`'s controls are
fingertip-sized, and `ComplexityTable` stacks each level's controls at a
phone's width.

Fields are the exception: no component sizes its own for the phone. iOS
zooms the whole page into a text field under 16px the moment it takes focus,
and leaves it zoomed after the keyboard goes, so `surfaces/phone.css` puts
one floor under every `input` typed into, `textarea` and `select` the bundle
draws: `max(16px, 1em) !important`. A component's own size cannot undercut
it, and `rem` would not have: the desktop's root is the bare `monospace`,
13px. `seam/fieldFontSize.test.ts` holds the floor and that nothing shipped
out-ranks it. CodeMirror's editor is no field to that rule (it is
contenteditable, its gutter sized with it), so `CodeMirrorView` keeps its own.
The viewport meta leaves pinch zoom alone: `maximum-scale=1` would stop the
zoom too, at the cost of a reader's own zoom.

The desktop's Git actions name every op with `crypto.randomUUID`, which a
page has only in a secure context; `remote/randomUUID.ts` gives the page one
where the shell's origin (iOS's `gavin-bundle://`) may not count as secure.

`seam/gitActions.test.ts`, `seam/fileActions.test.ts`,
`seam/settingsActions.test.ts` and `seam/addWorkspace.test.ts` hold each
action's channel traffic, and hold everything those surfaces send against the
daemon's own Remote role table (`testing/remoteTable.ts` reads
`protocol::remote_command_table`). Seam 1 holds the same line from the
daemon's side: `device_wire.rs` has the workspace-settings commands and
`add_workspace` reach the desk, and the layout saves refused before it.

How this bundle reaches a phone — built and signed by the desktop build,
served by the Workstation, verified and cached by the shell — is the shell's
README's ("Served bundles").
