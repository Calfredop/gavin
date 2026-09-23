---
order: 9216
kind: task
title: "[fix] .mcp.json carries one absolute gavin-mcp path, and it is now wrong on every machine"
labels: bug, windows
status: Done
priority: urgent
complexity: moderate
---
**Escalated 2026-09-22 (board audit): this is no longer a Mac-only fault.**
The installer move landed (`win/installer-state-dir`, merged as `2bcde943`)
and the binaries now live in `%LOCALAPPDATA%\Programs\Gavin`, so the path
this file carries —

```
C:\Users\calfr\AppData\Local\gavin\gavin-mcp.exe
```

— points at a file that **no longer exists on this Windows machine either**.
Every agent session started in this repo now opens with
`gavin (CONNECTION_CLOSED)` and no `gavin_*` tools at all. That is how this
audit found it: the session doing the audit had to reach the daemon over its
named pipe by hand, and then run the installed `gavin-mcp.exe` itself.

The binary that works is `%LOCALAPPDATA%\Programs\Gavin\gavin-mcp.exe` —
driven directly over stdio it answers `tools/list` with all sixteen tools
and `gavin_get_orchestration` returns the live payload. So nothing is wrong
with the binary, the daemon, or the protocol version; only the path in this
file.

That raises the priority and sharpens the interview below: the file is now
wrong for *both* machines at once, which is the clearest argument available
that no single committed absolute path can serve this checkout. The
immediate repair — re-running the wizard's "Set up / update", tracked as the
last item of
[fix-windows-installer-collides-with-the-daemon](./fix-windows-installer-collides-with-the-daemon.md)
— fixes Windows and re-breaks the Mac, which is exactly the flip-flop
recorded below. Do that to unblock the machine, and land this card so it
stops happening.

---

On the Mac the `gavin` MCP server fails to connect at every session start:

```
gavin (ENOENT): "Executable not found in $PATH: C:\Users\calfr\AppData\Local\gavin\gavin-mcp.exe"
```

so `gavin_name_session`, `gavin_set_plan_field` and every other `gavin_*` tool
is unavailable for the whole session, and agents have to file cards by hand.

**Why.** The checkout's `.mcp.json` is committed, and it carries ONE absolute
path to the binary — whichever machine last ran the wizard's integration
step (`resolve_mcp_binary_path` in `app/src-tauri/src/agent_setup.rs` writes
the `gavin-mcp` that sits beside the running app). The file has flip-flopped
with every machine: `d4191db` (this machine), `030d99f` (the checkout's
debug binary), `b8ba17c` (the Windows install). The same checkout is used
from a Mac and a Windows box, and no single path can be right on both.

**Do.** Make the MCP command machine-independent so the file stops being
re-pointed per machine. Interview first on which shape the human wants:

- a committed launcher the config names by RELATIVE path — e.g.
  `scripts/gavin-mcp` (sh) + `scripts/gavin-mcp.cmd` — that resolves the
  binary at launch per platform (the app install's, else this checkout's
  `target/debug/gavin-mcp`), so `.mcp.json` never carries an absolute path;
  the app's `write_mcp_config_json` / `json_entry` would then write the
  launcher rather than the resolved binary when one exists in the root;
- or keep `.mcp.json` out of the shared file by adding it to `.gitignore`
  and letting each machine's integration step write its own (note the
  checkout is also synced by CloudStation, so an untracked file may still
  travel — the launcher is the safer of the two);
- either way, point the Mac at its real binary now:
  `target/debug/gavin-mcp` exists in this checkout, and a release install
  ships one beside the app.

Whatever lands, `mcp_entry_present` / `remove_mcp_entry` and the wizard's
"re-run integration" must keep working on both platforms, and the tests in
`agent_setup.rs` that pin the written command (`/apps/gavin-mcp`) need
their counterpart for the launcher shape.

---

## Landed 2026-09-23 — the committed launcher shape

Interviewed: the human chose the **relative sh + `.cmd` launcher**, and chose
to apply it to `.cursor/mcp.json` as well.

**What the interview turned up that the card did not know.** `.cursor/mcp.json`
is committed too and carried the mirror image of the same fault —
`/Users/coalpila/CloudStation/Coding/gavin/target/debug/gavin-mcp`, dead on
Windows. The flip-flop spanned two files, not one.

**Verified before designing, not assumed:**

- A *relative* command in `.mcp.json` is spawned fine: `scripts/gavin-mcp.cmd
  — ✔ Connected`.
- **One** command string serves both platforms: `scripts/gavin-mcp — ✔
  Connected` on Windows with only the `.cmd` on disk, because Windows applies
  PATHEXT to a relative command. So the two scripts share one spelling and
  `.mcp.json` needs no per-platform variant.
- A freshly cut worktree has **no `target/` at all**, so "fall back to this
  checkout's debug build" resolves to nothing there. The installed app leads
  the search order; `GAVIN_MCP` is the dev override.

**Shipped.**

- `scripts/gavin-mcp` (sh, mode 100755) and `scripts/gavin-mcp.cmd`. Search
  order, identical in both: `GAVIN_MCP` → app install → this checkout's
  `target/release` then `target/debug` (resolved from the script's own
  directory, so each worktree finds its own) → `gavin-mcp` on PATH → else exit
  1 naming every path tried. Diagnostics go to stderr only; stdout carries
  nothing but the binary's JSON-RPC, verified empty on the failure path.
- Both scripts are LF on disk per `.gitattributes`. The `.cmd` is written as
  single-line statements only — no parenthesised blocks, no `goto` — because
  cmd.exe mis-parses those in an LF-only batch file. Verified parsing and
  answering `initialize`.
- `.mcp.json` and `.cursor/mcp.json` now name `scripts/gavin-mcp`, and both are
  byte-identical to what the writer produces, so a wizard re-run cannot dirty
  them. Pinning that turned up a latent bug: the committed `.cursor/mcp.json`
  was missing the `env` block the stdio dialect emits, so Cursor sessions were
  never passed `GAVIN_SESSION_*` and the tools would have failed closed. Fixed
  in passing.
- `agent_setup.rs`: `mcp_command` picks the launcher over the absolute binary,
  and the writers take a resolved command string instead of a `&Path`.

**A narrowing the card did not ask for, and why.** A relative command is
resolved against the workspace root, so naming one lets the REPO choose what
gavin's own entry executes — and `03-agent-surface.md` states that *gavin's own
writes cannot be redirected*. Keyed only on the launcher's presence, gavin's
setup run would point its entry at a script any cloned repo happened to ship.
`mcp_command` therefore requires **both** the launcher and
`crates/gavin-mcp/Cargo.toml` — a checkout that actually builds the binary,
where the human already trusts the tree enough to compile it. Every other
workspace still gets the absolute binary.

**Tests** (7 new, `cargo test -p app` 508 passed / 0 failed, exit 0):
the launcher is written when the root carries one; the absolute binary is kept
when it does not; every dialect (stdio, opencode's command-array, codex TOML)
names it; `run_integration` end to end; `mcp_entry_present` / `remove_mcp_entry`
still find and strip a launcher entry; a repo that merely ships a launcher gets
**no** relative command; and the repo's own two committed configs are pinned
byte-for-byte against what a setup run writes, so neither an absolute path nor
any other drift can land in them unnoticed. The last two were each confirmed to
go RED when their condition is removed — neither is a dead gate.

**Proof it fixes the reported fault:** `claude mcp list` in the worktree, against
the real committed config — `gavin: scripts/gavin-mcp — ✔ Connected`.

**Not done here.** The work is on `fix/agent-fixes` and unmerged, so the main
checkout still carries the stale path and sessions started there still open
`gavin (CONNECTION_CLOSED)` until it lands. Merging is what unblocks both
machines — no wizard re-run is needed, and none should be done, since that is
the flip-flop this card removes. The Mac half of the launcher could not be
executed from Windows; its control flow was exercised under `sh` (success and
failure paths), but a first run on the Mac is still worth watching.
`docs/security/04-supply-chain.md:208` now reads slightly stale — gavin writes
an absolute path into *every workspace but its own checkout*.
