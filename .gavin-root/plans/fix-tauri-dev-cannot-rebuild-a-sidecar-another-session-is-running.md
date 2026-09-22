---
title: [fix] npm run tauri dev cannot start on Windows while a sibling session runs a sidecar
status: To Do
priority: medium
complexity: simple
---
Found 2026-09-22 on
[feat-windows-port-on-a-windows-machine](./feat-windows-port-on-a-windows-machine.md)
§1, on the first attempt to run the dev loop.

`build.beforeDevCommand` in `app/src-tauri/tauri.conf.json` is

```
cargo build -p gavin-daemon -p gavin-mcp && npm run dev
```

Windows refuses to replace a running executable, so if anything is holding
`target\debug\gavin-mcp.exe` (or `gavin-daemon.exe`) open, the whole command
fails before vite is ever reached:

```
error: failed to remove file `C:\Users\calfr\coding\gavin\target\debug\gavin-mcp.exe`
Caused by:
  Access is denied. (os error 5)
       Error The "beforeDevCommand" terminated with a non-zero status code.
```

Four `gavin-mcp.exe` processes out of that path were open at the time, each
the MCP server of a different agent session in this checkout.

**This is a port defect, not a local mess.** On a unix host `cargo` unlinks
the old file and writes a new one; the running processes keep the old inode
and nothing notices. Only Windows turns it into a hard stop. And gavin's own
premise makes it the normal case rather than the unlucky one: the product
exists to run several agent sessions at once against one checkout, and each of
them holds a `gavin-mcp.exe` open for as long as it lives. **The more the tool
is used as designed, the less its own dev loop works.**

Same law as the installer card's second defect
([fix-windows-installer-collides-with-the-daemon](./fix-windows-installer-collides-with-the-daemon.md)
— an upgrade cannot overwrite a live `gavin-daemon.exe`), one layer down, and
worth fixing separately because the workaround differs: an installer can stop
what it is replacing, a dev build must not.

## Options, in the order they look promising

1. **Do not relink what is already current.** The failure is cargo deciding
   it needs a fresh link, then being unable to. If the sidecars were built
   into per-run staging names, or the dev loop tolerated a link failure when
   the existing binary is newer than every input, the common case stops
   biting. Look first at whether `--out-dir`/`CARGO_TARGET_DIR` for the
   sidecars alone buys this cheaply.
2. **Build the sidecars where the app looks, but under a name a running
   process never holds.** The dev app resolves its daemon as
   `current_exe().parent()/gavin-daemon.exe` and its MCP as the sibling
   `gavin-mcp.exe`, so the names are load-bearing — but only the daemon's
   is; nothing in a dev run execs `gavin-mcp.exe` except an agent CLI that
   was handed the path earlier.
3. **Fail usefully.** At minimum, `beforeDevCommand` should say which
   process holds the file and that stopping it is the developer's call,
   instead of an `os error 5` with no name in it.

Whatever the route, do not make the dev loop kill the processes it finds:
they are other people's live agent sessions, and taking their MCP server away
breaks a session that is mid-task.

## The workaround that got §1 ticked, for whoever hits it next

Overlay the hook and build the one sidecar that matters:

```
cargo build -p gavin-daemon
npx tauri dev --config <a json file with {"build":{"beforeDevCommand":"npm run dev"}}>
```

The stale `gavin-mcp.exe` stays where it is. The dev app launches, spawns its
own daemon and binds the dev endpoint normally — nothing else in the dev run
depends on the MCP binary being current.
