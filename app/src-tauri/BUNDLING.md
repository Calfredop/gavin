# Packaging gavin

```
cd app && npm run bundle
```

That is `tauri build --config src-tauri/tauri.bundle.conf.json -- --locked`,
and the extra config file is the whole point of this note.

This file is about how the bundle is *assembled*. Signing, notarization,
key custody and the gate that stops an unsigned build reaching anyone are
in [`docs/RELEASING.md`](../../docs/RELEASING.md); `npm run bundle` on its
own produces an unsigned bundle, which is a developer artefact and nothing
more.

## Why `externalBin` is not in `tauri.conf.json`

`gavin-daemon` and `gavin-mcp` have to ship **beside the app binary**:
`resolve_daemon_binary_path` (`daemon.rs`) and `resolve_mcp_binary_path`
(`agent_setup.rs`) both join against `current_exe().parent()`, and the
absolute `gavin-mcp` path gavin writes into a workspace's agent config
has to keep resolving after an update. `bundle.externalBin` is what puts
them there — inside `Gavin.app/Contents/MacOS/` on macOS and in
`/usr/bin/` on a deb, which is where the main binary lives too.

But `externalBin` is validated by `tauri-build`, i.e. by the app crate's
**build script**, not by the bundler. With it in `tauri.conf.json`, a
plain `cargo build --workspace` or `cargo test --workspace` fails with

```
resource path `binaries/gavin-daemon-<triple>` doesn't exist
```

on any machine that has not staged the sidecars first — which is every
clean checkout, every CI job, and every agent that runs the check
CLAUDE.md documents. Packaging is the only thing that needs those files,
so packaging is the only thing that pays for them: the base config stays
clean and `npm run bundle` merges this file in (the CLI passes the merged
config to the build script through `TAURI_CONFIG`).

`tauri dev` needs nothing from this file. In dev the app resolves its
siblings out of `target/debug/`, where cargo has already put them —
which is what `beforeDevCommand`'s `cargo build -p gavin-daemon -p
gavin-mcp` is for.

The name matters: only `tauri.conf.json` and `tauri.<platform>.conf.json`
are auto-discovered. `tauri.bundle.conf.json` is not a platform name, so
it is read only when passed with `--config`.

## What produces the sidecars

`beforeBuildCommand` runs `stage-sidecars.mjs --release`, which builds the
two binaries and copies them to `binaries/<name>-<host triple><.exe>` —
the suffixed spelling `externalBin` looks for and strips again when it
bundles. The directory is gitignored.

**`--locked` twice.** The script builds the sidecars with `--locked`, and
`npm run bundle` passes `--locked` through to the cargo invocation the
Tauri CLI makes for the app itself. A release has to be reproducible from
its tag; without the flag a manifest edit that no longer matches
`Cargo.lock` is silently re-resolved on the build host instead of failing.

**What signing covers.** `externalBin` copies the two sidecars into
`Contents/MacOS/` *before* the bundler signs, so a signed bundle seals
`gavin-daemon` and `gavin-mcp` along with `Gavin`. That is the only reason
the audit's SC-07 (the app launches whatever binary sits beside it) ever
becomes detectable: on a sealed, hardened-runtime bundle a swapped sidecar
breaks `codesign --verify --deep`.

**Node, not `sh`.** `beforeBuildCommand` runs through the Tauri CLI's
shell, which is `cmd /C` on Windows, and a stock Git for Windows install
does not put `sh.exe` on PATH — its default only adds `<git>/cmd`. The
shell version of this script was therefore a Windows bundle that failed
before it started. Node is already a hard requirement: the same command
line runs `npm run build` after it.

## Targets

`bundle.targets` is `"all"`: `.app` + `.dmg` on macOS, and `.deb`,
`.rpm` and `.AppImage` on Linux. The AppImage step downloads
`linuxdeploy` on first use, so the first Linux bundle needs network.

Windows narrows that to `["nsis"]` in `tauri.windows.conf.json` — which
is auto-discovered by name, unlike `tauri.bundle.conf.json`. "all" there
would also build an MSI, and the WiX toolchain behind it is a second
download, a second signing story and a format that cannot express a
per-user install; NSIS gives the one installer this app needs.

Linux build host needs the same packages CI installs (see
`.github/workflows/ci.yml`): `libwebkit2gtk-4.1-dev`, `libgtk-3-dev`'s
transitive set, `librsvg2-dev`, `patchelf` and friends.

A Windows build host needs Git for Windows (which the app requires at
runtime anyway, see the windows-port card), the MSVC build tools, and
WebView2 — present on Windows 11 and on any updated Windows 10.

## Windows: the install directory and the daemon

`nsis/hooks.nsh` is merged into Tauri's generated `installer.nsi` through
`bundle.windows.nsis.installerHooks` in `tauri.windows.conf.json`. It
fixes two things the stock template gets wrong for this app, both read
out of the generated script rather than found by running it.

**The template's per-user default, `%LOCALAPPDATA%\Gavin`, is the
daemon's state directory.** `protocol::resolve_app_support_dir` answers
`%LOCALAPPDATA%\gavin` on Windows, and Windows paths are
case-insensitive, so a default install puts `Gavin.exe` and the two
sidecars beside `kanban.sqlite`, `orchestration.sqlite`,
`registry.sqlite`, `daemon.token` and `daemon.log`. The uninstaller then
leaves the folder behind without a word (its `RMDir` is not `/r`), its
"Delete the application data" checkbox misses the databases, and the
arrangement is one `/r` away from deleting the human's boards. The hooks
move the default to `%LOCALAPPDATA%\Programs\Gavin` -- the per-user
counterpart of Program Files, and where `scripts/start-stable-win.ps1`
already looks first -- make the directory page refuse the state
directory outright, and redirect a silent install (`/S`, or `/D=`) that
names it. An install that finds the previous one registered in the
state directory stops that daemon, removes its four binaries by name
(never the folder) and retargets the shortcuts. The checkbox now removes
the state directory too.

**The two directories must not converge again.** `hooks.nsh` spells the
state directory out by hand, because it has no way to ask `protocol`;
if `resolve_app_support_dir` moves, the hooks move with it, and the doc
comment on that function says so.

**Nothing stopped the daemon.** The template checks for a running
`Gavin.exe` and never for `gavin-daemon.exe`, which the app spawns
detached so that it outlives every window. Windows will not overwrite a
running executable, so an upgrade over a live daemon kept the old
daemon binary and the new app then talked to it -- the version skew
`gavin-mcp` fails closed on, reached by installing. The pre-install and
pre-uninstall hooks stop the daemon that runs from the folder being
written, aimed at that one image path and never at the process name
(`taskkill /IM` would reach the dev tree's daemon too); interactively
they ask first, the way the template asks about `Gavin.exe`, and a
silent or passive run (the updater's) does not ask.

Every one of those paths compiles into the same `setup.exe`, and none
of them can be exercised by a suite: an install stops the daemon that
holds every agent session on the machine, so running it is the human's
step. Read the generated `target/release/nsis/x64/installer.nsi` for
what the installer will do; run it for what it did.
