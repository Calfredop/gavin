---
title: [fix] an npm-installed agent CLI is run through cmd.exe, which eats its arguments
status: To Do
priority: medium
complexity: simple
---
Found 2026-09-22 on
[feat-windows-port-on-a-windows-machine](./feat-windows-port-on-a-windows-machine.md)
§2, by running the thing rather than reading it.

`shell::command_with_windows_shim` rewrites the first word of every emitted
command line by searching PATH × **PATHEXT**. PATHEXT carries no empty entry,
so an npm-installed CLI — which ships `<name>` (an extensionless `#!/bin/sh`
shim), `<name>.cmd` and `<name>.ps1` side by side — matches on `.cmd`; the npm
global directory holds no `node.exe`+`index.js` pair, so
`resolve_bundled_node_entry` answers `None` and the line becomes `<name>.cmd
…`. MSYS `sh` runs a `.cmd` by handing it to `cmd.exe`, and cmd.exe re-parses
the command line it is given.

**That inverts the reason the shell route was chosen over PowerShell.** The
parent card's Shell decision rests on "inside `sh.exe` the extensionless npm
shim is the one that wins". It does win — measured here against npm's real
three-file layout, synthesised on PATH rather than argued:

```
$ sh -c "faketool one two"        # faketool, faketool.cmd, faketool.ps1 on PATH
POSIX-SHIM ran, args=[one two]
```

The daemon simply never lets `sh` make that choice.

## What it costs: an `&` with no whitespace splits the line, and the tail runs

MSYS quotes an argument for `cmd.exe` only when it contains whitespace. One
that carries a cmd metacharacter but no space is handed over bare:

```
$ sh -c "showone.cmd 'a&b'"       # showone.cmd is: @echo off / echo ONE=[%1]
ONE=[a]
'b' is not recognized as an internal or external command
```

`%1` lost half its value, and `b` ran as a command. The same argument through
the extensionless shim arrives whole, along with every other metacharacter:

```
$ sh -c "argecho 'a&b' 'c^d' 'pct%PATH%pct' 'two words'"
[a&b]
[c^d]
[pct%PATH%pct]
[two words]
```

An argument that *does* contain whitespace survives the split but arrives with
its double quotes embedded in `%1`/`%*`; npm's own `.cmd` hands `%*` to node,
whose CRT strips them again, so that half is survivable.

The argument in question is an agent's prompt. The line the daemon emitted for
the session that found this:

```
sh.exe -c "claude.exe --model 'opus[1m]' --session-id … '<the whole prompt>'"
```

`claude` is a winget `.exe` on this machine, so it takes the `.exe` arm and
none of this reaches it. `codex`, `gemini` and `opencode` are the npm ones —
exactly the CLIs §2 could not test, because they are not installed.

**Exit codes are not affected.** Measured both arms: a `.cmd` exiting 42
reports 42 back through `sh`, so the tool-failure epilogue's re-raise is safe
either way. The defect is argument fidelity and nothing else.

## The fix

Try the **extensionless** PATH match before the PATHEXT ones: if
`dir.join(word)` exists, leave the command alone and let `sh` exec the POSIX
shim itself.

It must not regress the case the rewrite was added for. Cursor Agent ships
only `cursor-agent.cmd`/`.ps1` with no extensionless sibling —
`%LOCALAPPDATA%\cursor-agent` holds exactly those two plus `agent.cmd`/`.ps1`
— so it still falls through to PATHEXT, still matches `.cmd`, and still takes
the bundled-node arm, which avoids `cmd.exe` altogether. Both halves measured
live today:

```
$ sh -c "cursor-agent --version"                          → command not found (127)
$ sh -c "CURSOR_INVOKED_AS='cursor-agent.ps1' '…/node.exe' '…/index.js' --version"
2026.09.10-fd3934a                                        → 0
```

Tests to add beside `shell::tests`, which already stubs `exists` and
`node_entry`: an extensionless shim beside a `.cmd` is left alone; a `.cmd`
with no extensionless sibling still rewrites; the cursor bundled-node arm is
untouched.

## Reproduced against a real agent CLI, same day

The repro above uses a synthesised shim, which is enough to show the
mechanism but invites the reply "no real CLI behaves like that". So the three
missing CLIs were installed into a **sandboxed npm prefix** — `npm install -g
--prefix <scratch> @openai/codex @google/gemini-cli opencode-ai`, which writes
npm's ordinary three-file layout without touching `%APPDATA%\npm` — and the
prefix put on PATH. `@openai/codex` 0.155.1, the profile gavin launches as
`codex`:

```
$ sh -c "codex --version 'x&whoami'"        # POSIX shim road
codex-cli 0.155.1                            → 0, nothing else ran

$ sh -c "codex.cmd --version 'x&whoami'"    # the road gavin's rewrite emits
codex-cli 0.155.1
calfr                                        → 0, and `whoami` EXECUTED
```

That is arbitrary command execution out of an argument, through the shim of a
CLI this product ships a profile for. It needs the `&` to carry no
whitespace: with a space either side, MSYS quotes the argument and cmd.exe
keeps it whole (the quotes then arrive literally inside `%*`, which node
strips again). So the reachable shape is a single word containing `&` — a URL
with query parameters, a `foo&&bar`, a branch name — not a sentence.

All three CLIs start correctly on both roads otherwise (`codex` 0.155.1,
`gemini` 0.60.0, `opencode` 1.18.32, each exit 0 bare and via `.cmd`), so
this is the only thing the `.cmd` detour costs.

## Blast radius

Unreachable on this machine **as it stands** — `%APPDATA%\npm` does not
exist, so no npm CLI is on the real PATH and every profile that would hit
this cannot launch at all. It becomes reachable the moment someone runs
`npm i -g` for `codex`, `gemini` or `opencode`, which is the ordinary way to
install them and what
[feat-windows-port-on-a-windows-machine](./feat-windows-port-on-a-windows-machine.md)
§2 asks the owner to do. **Fix this before that install, not after.**
