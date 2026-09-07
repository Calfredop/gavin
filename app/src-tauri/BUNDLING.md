# Packaging gavin

```
cd app && npm run bundle
```

That is `tauri build --config src-tauri/tauri.bundle.conf.json`, and the
extra config file is the whole point of this note.

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

`beforeBuildCommand` runs `stage-sidecars.sh --release`, which builds the
two binaries and copies them to `binaries/<name>-<host triple>` — the
suffixed spelling `externalBin` looks for and strips again when it
bundles. The directory is gitignored.

## Targets

`bundle.targets` is `"all"`: `.app` + `.dmg` on macOS, and `.deb`,
`.rpm` and `.AppImage` on Linux. The AppImage step downloads
`linuxdeploy` on first use, so the first Linux bundle needs network.

Linux build host needs the same packages CI installs (see
`.github/workflows/ci.yml`): `libwebkit2gtk-4.1-dev`, `libgtk-3-dev`'s
transitive set, `librsvg2-dev`, `patchelf` and friends.
