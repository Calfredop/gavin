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
| `capabilities` | — | `{ version, messages, workstation: { id, name, demo } }` |
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

**The shell's side of the contract** (companion-19): put an object at
`window.gavinChannel` with `postMessage(string)` and an `onmessage` the page
will set, called with `{ data: string }`. That is the shape Android's
`addWebMessageListener` injects, origin gate included. With no such object the
page hosts a Demo Workstation of its own, which is how the bundle runs in a
desktop browser.

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
it act, which is what makes the silence mean something.

For the same reason the bundle does **not** call `layoutState.bootstrap()`.
That bootstrap is the desk's: it starts every duty that must run in one place
(the launch queue, auto-resume, the reclaim of idle sessions) and repairs the
desk's layout as it goes, saving what it repaired. `state/workstation.ts` stands
in its place and fills the same stores through the desktop's own loaders.

## The Demo Workstation

`src/companion/demo/`. The Workstation's end of the channel, answering from
sample data — the thing App Review explores, and the suites' only fixture.

- `sampleData.ts` — the machine: two projects and a Scratchpad, typed against
  the desktop's own wire types.
- `commands.ts` — one answer per desktop command name, each typed as what
  `backend.ts` says that command returns. A command with no entry is answered
  with an error and recorded in `demo.unanswered()`.
- `activity.ts` — a loop of what agents do, so the demo changes while someone
  watches. The page advances it on a timer; a suite advances it by hand.
- `workstation.ts` — the endpoint. Refuses what the Remote role is refused,
  as a real Workstation's daemon does.

`seam/desktopBootstrap.test.ts` runs the desktop's real bootstrap against it
and fails on any command left unanswered. When a surface needs a command the
demo lacks, that is where it shows.

## What is here, and what is not

The first surface: the workspace list and one workspace's board, to read. The
board draws the desktop's own `BoardCard` with no workspace id, which is the
card the desk draws in previews — no Run, no session jump, no drag.

Opening a card, acting on one, sessions and terminals, rails, Git, files and
settings are the cards that follow (companion-26 to -30), each extending the
Demo Workstation to match.
