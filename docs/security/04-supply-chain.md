# 04 — Dependencies, build & release (S11)

Scope: commit `944eae2` on `sec/review-2026090801` (`PROTOCOL_VERSION` 34), audited
2026-09-08 with `cargo-audit 0.22.2`, `cargo-deny 0.20.2` (both built into a session
temp dir, never installed globally), `npm 10.9.8` / `node v22.22.3`, `rustc 1.97.1`,
`cargo 1.97.1`. Raw tool output, the tool versions, the scratch `deny.toml`, the
build-script census, and the audited workflow file are under `04-supply-chain/`; this
document summarises them and does not paste them. Nothing was fixed, no lockfile was
modified (`git status --short Cargo.lock app/package-lock.json` is empty after the
run), no source file was touched. Adversaries, surfaces, AD entries and severities
are those of `00-threat-model.md`. The threat model's premise that "the daemon and MCP
server travel inside the bundle" is true only on branch `Feat/multi-os-support`; on
`main` the bundle carries neither (SC-08), which conditions SC-06 and SC-07.

## Findings

| id | severity | adversary | vulnerability/boundary | evidence | one line |
|----|----------|-----------|------------------------|----------|----------|
| SC-01 | Info | A1 | boundary | `04-supply-chain/cargo-audit.txt`, `cargo-deny.txt` | `cargo audit`: 0 vulnerabilities, 18 warnings (17 unmaintained, 1 unsound); on the macOS build only `serial` (via `portable-pty`, never called) and the `unic-*` set (via `tauri-utils` → `urlpattern`) are compiled in — the other 12 are Linux-only gtk-rs. |
| SC-02 | Low | A1 | boundary (AD-7) | `04-supply-chain/npm-audit.txt`, `npm-audit.json` | `npm audit`: 8 advisories (1 critical, 2 high, 2 moderate, 3 low), all in devDependencies (vitest 1.6.1's nested vite 5.4.21 and esbuild 0.21.5, nanoid 3.3.16, cookie 0.6.0); nothing flagged ships in the bundle, and the critical one needs `@vitest/ui`, which is not installed. |
| SC-03 | Info | A1 | boundary (AD-1) | `04-supply-chain/build-scripts.txt`; `app/package.json`; `app/package-lock.json` | 113 locked crates run a `build.rs` (`libsqlite3-sys` compiles SQLite 3.45.0 from vendored source; none downloads); `npm ci` runs esbuild's and fsevents' install scripts; no `.npmrc`, so `ignore-scripts` is off; no git/file/link dependency anywhere; both lockfiles pin every version exactly with checksums. |
| SC-04 | Low | A1 | vulnerability | `git ls-tree -r --name-only main \| grep '^\.github'` (empty) | `main` has no CI: no commit is built, tested, or audited anywhere but the developer's machine; `ci.yml` exists only on `Feat/multi-os-support`. |
| SC-05 | Low | A1 (on the CI host) | vulnerability | `04-supply-chain/ci.yml.a538312.txt` | The branch's `ci.yml` pins four third-party actions by mutable tag, declares no `permissions:`, and runs `cargo` without `--locked`; it has no `pull_request_target`, no secrets, no artifact upload, and GitHub's cache scoping keeps fork PRs off `main`'s cache. |
| SC-06 | Medium (Info until a build is distributed) | A1 | vulnerability | `app/src-tauri/tauri.conf.json` — no `bundle.macOS.signingIdentity`, `bundle.windows.certificateThumbprint`, `plugins.updater`, entitlements | Every target ships unsigned and un-notarized with no updater: nothing distinguishes gavin's bundle from a modified one on any OS, and a compromised build host ships the daemon and MCP server inside it. |
| SC-07 | Info | A1 | boundary (AD-1) | `app/src-tauri/src/daemon.rs:6-12,45-48`; `app/src-tauri/src/agent_setup.rs:937-944` | The app launches `gavin-daemon` and hands every agent `gavin-mcp` by the path *beside its own executable*, with no integrity check; that directory is `target/debug/` in dev and `Gavin.app/Contents/MacOS/` in a bundle — user-writable either way. |
| SC-08 | Info | A1 | boundary | `app/src-tauri/tauri.conf.json` `build.beforeBuildCommand`, no `bundle.externalBin`/`resources`; `git show Feat/multi-os-support:app/src-tauri/tauri.bundle.conf.json` | On `main`, `tauri build` compiles the daemon and MCP server and then bundles neither, so the app would fail at `resolve_daemon_binary_path`; the sidecar staging that makes a working bundle is only on `Feat/multi-os-support`. |
| SC-09 | Info | A1 | boundary (AD-7) | `app/vite.config.js` `server:`; `app/src-tauri/tauri.conf.json` `build.devUrl` | `tauri dev` serves the app source on `127.0.0.1:1420` with HMR on the same port; vite 6.4.3's host and origin checks stop browser tabs and DNS rebinding; a same-host process gets nothing it lacked; `invoke` is dead outside Tauri; `TAURI_DEV_HOST` is the one knob that exceeds AD-7, and only by the developer's own hand. |
| SC-10 | Info | A2 | boundary | `crates/protocol/src/lib.rs:7,2139-2144`; `crates/gavin-mcp/src/main.rs:1032-1034` | The socket reader caps a line at 1 MiB and parses through `serde_json` (recursion-limited); the MCP server's stdin reader has no cap — its only peer is the agent that launched it, which already holds a shell. |
| SC-11 | Info | A1 | boundary | `Cargo.lock` (`libsqlite3-sys 0.28.0`); `04-supply-chain/build-scripts.txt` | The SQLite compiled into the daemon is 3.45.0 (January 2024) and RustSec does not track SQLite's own CVEs, so `cargo audit` is blind to it; no path found, because untrusted input reaches SQLite only as bound parameters. |

## SC-01 — RustSec: no vulnerabilities, 18 warnings, four crates reachable on macOS

`cargo audit` over the 571-entry `Cargo.lock` found **0 vulnerabilities** and **18
warnings**: 17 `unmaintained`, 1 `unsound` (`04-supply-chain/cargo-audit.txt`,
`cargo-audit.json`: `vulnerabilities.count = 0`). `cargo deny check` with the scratch
config agrees (`advisories FAILED` is those same unmaintained entries promoted to
errors by cargo-deny's `version = 2` defaults; `bans ok`, `sources ok`; `licenses
FAILED` only because the four workspace crates carry no `license` field while
`app/package.json` says MIT — a hygiene fact, not a risk).

One line per advisory, with reachability on the macOS build (`cargo tree --locked -i
<crate>` on the host target versus `--target all`):

| advisory | crate | version | fixed in | reachable from gavin |
|----------|-------|---------|----------|----------------------|
| RUSTSEC-2017-0008 | `serial` | 0.4.0 | none (unmaintained since 2017) | Compiled on macOS: `portable-pty 0.8.1` depends on it unconditionally. Gavin only ever calls `native_pty_system()` (`crates/daemon/src/pty.rs:1,17`); the serial-port `PtySystem` is dead code. Info. |
| RUSTSEC-2025-0075 / -0080 / -0081 / -0098 / -0100 | `unic-char-range`, `unic-common`, `unic-char-property`, `unic-ucd-version`, `unic-ucd-ident` | 0.9.0 | none (unmaintained) | Compiled on macOS via `urlpattern 0.3.0` ← `tauri-utils 2.9.3` (capability URL patterns, both normal and build-dependency). Static Unicode tables; no input from A2 reaches them. Info. |
| RUSTSEC-2024-0370 | `proc-macro-error` | 1.0.4 | none | Linux only (`gtk3-macros`). Not in the macOS graph. Info. |
| RUSTSEC-2024-0411..0420 (ten entries) | `atk`, `atk-sys`, `gdk`, `gdk-sys`, `gdkwayland-sys`, `gdkx11`, `gdkx11-sys`, `gtk`, `gtk-sys`, `gtk3-macros` | 0.18.2 | none (gtk-rs GTK3 bindings abandoned; Tauri 2 still targets GTK3) | Linux only, via `tao`/`wry`/`tauri`. Not in the macOS graph. Reachable on a Linux bundle as the whole windowing layer — a Tauri-wide condition every Tauri app shares. Info. |
| RUSTSEC-2024-0429 | `glib` | 0.18.5 | none | `VariantStrIter` unsoundness; Linux only; gavin never uses `glib` directly. Info. |

Housekeeping cargo-deny also reported: 37 duplicate crate versions (e.g. `toml` ×3,
`toml_edit` ×4 — the workspace pins `toml 0.8` / `toml_edit 0.22` while tauri pulls
newer ones), three `wildcard` warnings that are just the version-less
`protocol = { path = ... }` entries, and `sources ok` — every crate comes from
crates.io.

Marked **boundary**: an unmaintained-crate warning is a maintenance fact, not a defect
gavin promised to lack. Adversary A1 only in the sense that a future advisory against
one of these would be a same-user code-execution vector at build time.

## SC-02 — npm: 8 advisories, every one in devDependencies

`npm audit` over `app/package-lock.json` (lockfileVersion 3; 270 packages: 63 prod,
208 dev, 109 optional) reports **8**: 1 critical, 2 high, 2 moderate, 3 low
(`04-supply-chain/npm-audit.txt`, `npm-audit.json`). `node_modules` is not installed
in this worktree; `npm audit` works from the lockfile. Every flagged package is
`dev: true` in the lock; none is in `dependencies`, so none reaches
`frontendDist`.

| advisory | package | locked | fixed in | reachable from gavin |
|----------|---------|--------|----------|----------------------|
| GHSA-5xrq-8626-4rwp (critical, CVSS 9.8) | `vitest` (direct devDep `^1.0.0`) | 1.6.1 | 3.2.6; npm's fix is `vitest@5.0.0`, a major | Needs the Vitest **UI** server listening. `@vitest/ui` is absent from the lock and `npm test` is `vitest run`; no server listens. Not reachable. |
| GHSA-fx2h-pf6j-xcff (high, 7.5), GHSA-4w7w-66w2-5vf9, GHSA-v6wh-96g9-6wx3 | `vite` **nested** under `vitest/` and `vite-node/` | 5.4.21 | 6.4.3 / 6.4.2 / 6.4.3 | These copies exist only as vitest's module runner (`vite-node`); they never serve HTTP. Two of the three are Windows-only (`fs.deny` alternate paths; launch-editor NTLM over UNC). The top-level `vite` that serves `devUrl` is **6.4.3 and not flagged**. Not reachable. |
| GHSA-67mh-4wv8-2f99 (moderate, 5.3) | `esbuild` nested under the two vite 5 copies | 0.21.5 | 0.25.0 | esbuild's own `serve` mode; never started. The top-level esbuild is 0.25.12. Not reachable. |
| GHSA-2v37-7h3g-55p8 (high per npm, CVSS 5.9) | `nanoid` | 3.3.16 | 3.3.18; `npm audit fix` resolves it without a major | Only `postcss` (build-time CSS pipeline) depends on it; the bug is an infinite loop when a caller passes size 0 to a custom generator. Not reachable. |
| GHSA-pxg6-pf52-xh8x (low) | `cookie` | 0.6.0 | 0.7.0; transitively needs a `@sveltejs/kit` bump | Used by SvelteKit's server runtime; with `adapter-static` and `fallback: "index.html"` there is no server. Not reachable. |
| (roll-ups) | `@sveltejs/kit` 2.70.2, `@sveltejs/adapter-static`, `vite-node` 1.6.1 | — | — | Flagged only for depending on the above. |

Marked **boundary** under AD-7 (dev-only surfaces are dev-only) and rated **Low**
rather than Info because a `vitest` two-majors behind is the kind of debt that makes
the next real advisory unfixable without an upgrade the suites have to absorb. Nothing
here is a path for A2 or A3; A1 is the only adversary that can even execute
devDependency code, and it already has the uid.

## SC-03 — Install-time code execution and pinning

**Cargo.** 113 of the 571 locked crate versions ship a `build.rs`
(`04-supply-chain/build-scripts.txt`, generated against the local registry cache).
On the macOS host the ones that compile native code are `libsqlite3-sys 0.28.0`
(the vendored SQLite amalgamation, via `cc`), `mac-notification-sys 0.6.15` (the
Objective-C shim behind `tauri-plugin-notification`) and `objc2-exception-helper`;
`vswhom-sys`, `wayland-backend`, `iana-time-zone-haiku` are other-target. A grep of
every build script for `reqwest::`, `ureq::`, `curl`/`wget` spawns, `TcpStream` or
`hyper` found **no build script that downloads anything**; `libsqlite3-sys`'s
`bundled` feature compiles the source shipped in the crate (SC-11 for its age).
`reqwest 0.13.4` and `hyper 1.11.0` are in the lock but only for
`cfg(any(android, apple-not-macos))` inside `tauri`; `cargo tree --locked -i reqwest`
on the host prints nothing. `app/src-tauri/build.rs` is the only workspace build
script and calls `tauri_build::build()`. There is no `.cargo/config.toml` (no source
replacement), no `rust-toolchain` file (the toolchain floats with `rustup`'s
`stable`), and `Cargo.lock` has no `git+` or non-crates.io source.

**npm.** `app/package.json` has no `postinstall`, `prepare`, or `preinstall`; there is
no `.npmrc` at the repo root or in `app/`, so `ignore-scripts` is not set and `npm ci`
runs the install scripts the lock marks `hasInstallScript`: `esbuild` (three copies —
its script only checks that the platform binary from the optional `@esbuild/*`
package is the right version; it does not download when that package is present)
and `fsevents` (macOS optional). The lock has no `git+`, `file:`, or `link:`
resolution; every entry carries a `sha512` integrity hash. `package.json` ranges are
carets, so the lockfile is what pins; `npm ci` honours it, `npm install` would not.

Marked **boundary** under AD-1: a build script or install script that runs on the
developer's machine is A1's stated origin ("a rogue npm `postinstall`, a malicious
crate build script"), and the threat model accepts that A1 has the uid. Recording
which ones run is the deliverable; `ignore-scripts` would only remove the two npm
ones and break esbuild's version check.

## SC-04 — `main` has no CI

`git ls-tree -r --name-only main | grep '^\.github'` returns nothing; the same is
true of `HEAD`. The only workflow in the object store is
`.github/workflows/ci.yml` on `Feat/multi-os-support` (added in `7a03dcc`, reworked
in `a538312`, both 2026-09-07). Consequently nothing outside the developer's own
machine ever builds a commit, runs `cargo test --workspace`, runs the app suites, or
runs `cargo audit`/`npm audit`; `CLAUDE.md`'s "Checks" section is executed by hand
and by the agents sharing the tree.

Why this is a supply-chain finding and not a process nit: `CLAUDE.md` says several
agent sessions edit the shared checkout at once, and the human commits from that
tree. Those sessions are same-user processes (A1). With no independent build there is
no second opinion on what a commit contains, no lockfile-drift detection, and no
place to hang the audits this pass ran by hand. **Low**, **vulnerability**: the repo's
own workflow depends on checks it never runs automatically.

## SC-05 — The branch's `ci.yml`, audited

File: `04-supply-chain/ci.yml.a538312.txt` (identical content on `7a03dcc` for the
Linux job; `a538312` added the Windows job). Triggers: `push` to `main`,
`pull_request`, `workflow_dispatch`. Two jobs, `ubuntu-latest` and `windows-latest`.

- **Third-party actions, all pinned by mutable ref**: `actions/checkout@v4`,
  `actions/setup-node@v4` (GitHub-owned major tags), `dtolnay/rust-toolchain@stable`
  (a branch name — retargeted on every Rust release by design), `Swatinem/rust-cache@v2`
  (a community major tag). A retargeted tag runs whatever the tag owner pushes, with
  the job's token; the March 2025 `tj-actions/changed-files` compromise is the
  reference case. SHA pinning with a comment naming the version is the fix.
- **`permissions:`** absent at both workflow and job level, so the `GITHUB_TOKEN`
  gets the repository's default — read-only for repositories created after
  February 2023, write for older ones or where the org setting says so. The workflow
  needs only `contents: read`; it should say so.
- **`pull_request_target`**: not used. PRs run on `pull_request`, so a fork PR gets a
  read-only token and no secrets — correct.
- **Secrets**: none referenced. **Artifact uploads**: none. **Releases**: none — the
  workflow builds nothing that is shipped, so a poisoned CI run cannot reach users
  today (it also means SC-06's "build machine" is the developer's laptop).
- **Cache poisoning**: `Swatinem/rust-cache` keys on `Cargo.lock` and the toolchain;
  `setup-node` keys on `app/package-lock.json`. GitHub scopes cache *writes* to the
  run's ref and lets a run *read* only its own ref's and the base/default branch's
  caches, so a fork PR (`refs/pull/N/merge`) cannot seed a cache that a `main` run
  restores. A push to `main` reads only `main`'s caches. Acceptable.
- **Lockfile discipline**: `npm ci` (honours the lock); `cargo test`/`cargo check`
  **without `--locked`**, so a manifest edit that no longer matches `Cargo.lock`
  would be silently re-resolved on the runner instead of failing — the standard gate
  is `--locked` (or `--frozen`).
- **Runners** float (`ubuntu-latest`, `windows-latest`); `sudo apt-get install` from
  the runner's mirrors. Ordinary.
- Everything on the Windows job past `cargo check` is `continue-on-error: true` by
  stated intent (a port in flight), so a red Windows test is not a gate yet.

**Low**, **vulnerability**: the workflow trusts mutable third-party refs with an
unstated token scope. The adversary is A1 in the CI host's sense — code that runs as
the job.

## SC-06 — Unsigned, un-notarized, no updater

`app/src-tauri/tauri.conf.json` on `main` (and on `Feat/multi-os-support`) has no
`bundle.macOS.signingIdentity`, no `bundle.macOS.entitlements`, no
`bundle.windows.certificateThumbprint`, no `plugins.updater` (and no
`tauri-plugin-updater` in `Cargo.toml`), no `bundle.linux` signing keys. `bundle.targets`
is `"all"`. `git grep` for `signingIdentity|certificateThumbprint|updater|
hardenedRuntime|entitlements|notariz` on both refs is empty.

What an unsigned bundle means per OS:

- **macOS.** No Developer ID signature, so no notarization ticket and no hardened
  runtime. A quarantined download is refused by Gatekeeper — on current macOS there
  is no right-click-Open bypass; the user has to go to System Settings → Privacy &
  Security → Open Anyway, which is exactly the habit that makes a modified bundle
  indistinguishable from the real one. Without the hardened runtime there is no
  library validation (`DYLD_INSERT_LIBRARIES` and unsigned dylibs load), and a
  debugger can attach. Without a stable code identity, TCC grants (notifications via
  `tauri-plugin-notification`, any Automation the OS Trash route needs, Accessibility
  if it is ever asked for) key on the binary's path and cdhash and are lost or
  re-prompted on every rebuild. The bundle's contents — including the daemon and MCP
  server siblings once they are bundled (SC-08) — have no seal, so a modified
  `Contents/MacOS/gavin-daemon` fails no check anywhere.
- **Linux.** `.deb`/`.rpm` unsigned (no `dpkg-sig`/`rpmsign`), AppImage without its
  optional GPG signature. Distribution is a URL and whatever trust the user puts in
  it. `BUNDLING.md` on the branch notes the AppImage step downloads `linuxdeploy` on
  first use — a network fetch on the build host, itself unverified.
- **Windows.** No Authenticode, so SmartScreen shows "Unknown publisher" on the NSIS
  installer; NSIS defaults to a per-user install under `%LOCALAPPDATA%`, which any
  same-user process can rewrite.

What a compromised build machine could ship: the daemon (which owns every session's
PTY, stdin, and queued input — everything A1 wants) and the MCP server (whose
absolute path gavin writes into each workspace's `.mcp.json`/`.codex/config.toml`/
`.gemini/settings.json`/`opencode.json`, so every agent the human launches executes
it). There is no CI build (SC-04), so the build machine *is* the developer's laptop,
the machine on which A1 is defined. Between `cargo build --release` and `tauri build`
nothing verifies the binaries; no reproducible build, SBOM, or signature lets a
downstream party detect a swap.

**Medium** for any build that is distributed, because it delivers A1's "hide inside
something the human attributes to gavin" wholesale and no OS mechanism can push back.
**Info** for as long as the only builds are the developer's own from source (version
0.1.0, no release, no updater). Marked **vulnerability**: no AD entry accepts an
unverifiable release, and the threat model names signing under S11 as something
absent, not accepted.

## SC-07 — The daemon and the MCP server are whatever sits beside the app

`app/src-tauri/src/daemon.rs:6-12` (`resolve_daemon_binary_path`) returns
`current_exe().parent().join("gavin-daemon")`; `:45-48` (`spawn_real_daemon`) spawns
it with `Command::new(binary).spawn()` — no hash, no signature, no version check
beyond the protocol handshake the daemon then answers. `app/src-tauri/src/agent_setup.rs:937-944`
(`resolve_mcp_binary_path`) does the same for `gavin-mcp` and writes that absolute
path into the repo's agent MCP config, so the sibling is what every agent CLI runs.
`session.rs:1737-1749` (`restart_daemon`) kills the old one by **process name**
(`daemon.rs:59`, `pkill -x gavin-daemon`) and respawns the sibling.

Where the sibling lives: in `tauri dev`, `target/debug/` (populated by
`beforeDevCommand`'s `cargo build -p gavin-daemon -p gavin-mcp`); in a bundle built
from `Feat/multi-os-support`, `Gavin.app/Contents/MacOS/` on macOS, `/usr/bin/` on a
deb, the NSIS install dir on Windows. Every one of those is writable by the
developer's uid on a typical install. A same-user process can therefore replace the
binary the app itself will launch at the next start or the next "Restart daemon"
click, and the app will attribute the result to gavin.

This is **AD-1** exactly — A1 already has the uid and could run its own daemon on the
same socket path — so it is marked **boundary**, **Info**. It is recorded because it
names the concrete file A1 would target, and because it is the reason SC-06's signing
gap has a live consequence: a sealed, hardened-runtime bundle is the only thing that
would ever make the swap detectable, and even then only to a check gavin does not run
(`exec` of a child does not validate the parent's seal).

## SC-08 — On `main`, the bundle does not carry the daemon or the MCP server

`tauri.conf.json` on `main`: `build.beforeBuildCommand` is
`cargo build --release -p gavin-daemon -p gavin-mcp && npm run build`, and there is
**no** `bundle.externalBin` and **no** `bundle.resources`. `tauri build` therefore
compiles both binaries into `target/release/` and packages only `Gavin`; at first
launch `resolve_daemon_binary_path` points at a `Contents/MacOS/gavin-daemon` that
does not exist and `spawn_real_daemon` fails. The bundle that works exists only on
`Feat/multi-os-support`: `stage-sidecars.mjs` copies the two binaries to
`binaries/<name>-<host triple>` and `tauri.bundle.conf.json` (passed explicitly with
`--config`, because `tauri-build` would otherwise demand the staged files on every
`cargo test`) sets `externalBin` for them; `BUNDLING.md` there explains the split.

Not a security defect — a release-integrity fact — but every statement in this pass
about "the bundle" has to say which one, and the threat model's S11 wording assumes
the branch's. **Info**, marked **boundary** for want of a better label; adversary A1
only because it conditions SC-06/SC-07.

## SC-09 — What `tauri dev` puts on the loopback interface

`build.devUrl` is `http://localhost:1420`; `app/vite.config.js` sets `server.port:
1420`, `strictPort: true`, `host: process.env.TAURI_DEV_HOST || false`, and `hmr`
only when `TAURI_DEV_HOST` is set (then `ws://<host>:1421`). With the variable unset —
the desktop default — vite binds **loopback only** (`localhost` → `127.0.0.1` and
`::1`), refuses to move ports, and runs HMR as a WebSocket upgrade on the **same**
1420 listener. See the dev-server section below for the full picture; the finding is
the summary:

- Any process on the machine can reach it. That is host-wide, not uid-scoped, so a
  different uid could read the app's source over loopback — out of scope by the
  threat model ("another uid or root on the same host"). A same-user process (A1)
  can already read the files. **AD-7** and **AD-1**.
- Browser tabs cannot use it as a bridge: vite 6.4.3 has the `server.allowedHosts`
  check (default: `localhost`, `*.localhost`, IP-literal hosts) that 403s a DNS-rebound
  hostname, restricts CORS to localhost origins, and rejects HMR WebSocket upgrades
  with a foreign `Origin` (the CVE-2025-24010 fix, 6.0.9+). A web page can still
  fire `no-cors` requests at `127.0.0.1:1420` (modern Chrome gates that behind a
  Local Network Access prompt) but cannot read a byte back; the only state-changing
  endpoint is `/__open-in-editor?file=`, which opens a file in the developer's editor
  and returns nothing.
- The dev page has no `invoke`. `@tauri-apps/api/core`'s `invoke` calls
  `window.__TAURI_INTERNALS__`, which only the Tauri WebView injects; the app never
  guards for its absence (`grep __TAURI_INTERNALS__ app/src` is empty). A browser at
  `:1420` renders the SvelteKit SPA shell and every `backend.ts` call rejects. The
  daemon socket is reachable only through the Rust host's commands; vite proxies
  nothing to it.
- What it exposes: the frontend source under `/src/**` (transformed) and anything
  under vite's `server.fs.allow` root through `/@fs/` — for this layout at least
  `app/`, which includes `src-tauri/src/*.rs` (the `watch.ignored` entry only stops
  *watching* `src-tauri`, not serving it); `.env*`, `*.pem`/`*.crt` and `**/.git/**`
  are in vite's default `fs.deny`. Debug builds of Tauri 2 also enable the WKWebView
  Web Inspector regardless of the `devtools` feature — local, via Safari's Develop
  menu, same uid.

Nothing here exceeds **AD-7** in the default configuration. The one thing that does
is `TAURI_DEV_HOST`: set it (the mobile-dev path) and vite binds that address with HMR
on 1421, publishing the source tree to the LAN with the same host checks but no
authentication — the developer's own choice, so still within AD-7's spirit, but worth
knowing before setting it on a café network. Argued from `vite.config.js` and vite's
published changelog; not reproduced (no dev server was started, and `node_modules` is
absent in this worktree). **Info**, **boundary**.

## SC-10 — Line caps: the socket has one, MCP stdin does not

`crates/protocol/src/lib.rs:7` `MAX_LINE_BYTES = 1 MiB`; `:2139-2144` reads with
`take(MAX_LINE_BYTES).read_line` and bails on an unterminated line at the cap, then
`serde_json` parses it (serde_json's default recursion limit of 128 bounds the stack
against nested JSON). The daemon's `handle_connection` (`server.rs:3478-3482`) and
gavin-mcp's `SocketTransport` (`main.rs:29,64`) both go through it. gavin-mcp's
**stdin** side (`main.rs:1032-1034`, `stdin.lock().lines()`) has no cap: an
arbitrarily long JSON-RPC line is buffered whole. Its only writer is the agent CLI
that spawned it, which is A2 — a process that already has a shell as the user, so a
memory-exhaustion of its own MCP helper gains it nothing. **Info**, **boundary**; a
cap would be symmetry, not defence.

## SC-11 — The vendored SQLite is 3.45.0 and no audit tool sees it

`rusqlite 0.31.0` with the `bundled` feature compiles `libsqlite3-sys 0.28.0`'s
vendored amalgamation: `SQLITE_VERSION "3.45.0"` (released 2024-01-15). RustSec
tracks Rust crates, not the C library inside them, so `cargo audit` reports nothing
about SQLite ever; `npm audit` obviously does not either. Fixes released since — for
instance the integer overflows in `concat_ws()` (CVE-2025-3277, 3.49.1) and in
aggregate term handling (CVE-2025-6965, 3.50.2) — require attacker-controlled SQL.
The daemon issues only its own statements with bound parameters; card titles,
terminal bytes and paths arrive as values (pass 01 owns the query surface). No path,
so **Info**, **boundary**; the fact to record is that the SQLite version is frozen by
`Cargo.lock` independently of the OS and updates only with a `rusqlite` bump, which
the audit tooling will never prompt for.

## Load-bearing dependencies

Pinning convention for the whole workspace: every `Cargo.toml` range is a bare
major/minor caret (`"1"`, `"0.8"`, `"2"`), `Cargo.lock` pins exact versions with
crates.io checksums, and there is no `.cargo/config.toml` or `rust-toolchain` file. On
the npm side every `package.json` range is a caret (`typescript` is `~5.6.2`),
`package-lock.json` (v3) pins exact versions with `sha512` integrity. "Pinned exactly
by the lock" below therefore holds for every entry; the paragraphs say what each is
trusted to do.

**`portable-pty` 0.8.1** (`crates/daemon/Cargo.toml:16`, `"0.8"`). Trusted to open the
PTY pair, `fork`/`exec` the shell or agent with the right controlling terminal, resize,
and hand back master/child handles — it is the code that runs `/bin/sh -c` and every
agent CLI with the user's privileges (`crates/daemon/src/pty.rs:1,17`). It drags in
`serial 0.4.0` (unmaintained since 2017, SC-01) for a `PtySystem` gavin never
constructs. wezterm's crate, maintained; 0.8.1 is the latest 0.8.

**`rusqlite` 0.31.0, feature `bundled`** (`crates/daemon/Cargo.toml:15`, `"0.31"`).
Trusted to hold the registry, kanban and orchestration databases with correct
parameter binding; `bundled` means the system `libsqlite3` is never used — SQLite
3.45.0 is compiled from `libsqlite3-sys 0.28.0`'s vendored source by its `build.rs`
via `cc` (no download; `04-supply-chain/build-scripts.txt`). Same binary on every OS,
frozen by the lock (SC-11). `cargo tree --locked -e features -i libsqlite3-sys`
confirms `bundled` is the only feature path.

**`notify` 8.2.0 + `notify-debouncer-mini` 0.7.0** (`crates/daemon/Cargo.toml:18-19`,
`"8"`/`"0.7"`; also in `app/src-tauri/Cargo.toml`). Trusted to watch the `.gavin*`
folders and the workspace tree via FSEvents on macOS (one recursive root watch, per
the daemon's `gavin.rs`) and deliver paths that the daemon then parses as cards. Pure
Rust over the OS APIs; events are data, the parsing is S4 (passes 01/03).

**`vt100` 0.16.2 (with `vte` 0.15.0)** — the screen crate behind
`crates/daemon/src/screen.rs:30,41`. Trusted to parse every byte an agent or shell
emits into a bounded screen model (`INITIAL_ROWS × INITIAL_COLS`, `SCROLLBACK_ROWS`)
that survives the window. This is the one crate that consumes A2's raw output byte by
byte. `vt100` itself contains no `unsafe`; `vte` 0.15.0 beneath it has five `unsafe`
sites (its UTF-8 fast path) and neither crate carries a `forbid(unsafe_code)` lint, so
the expected failure mode of a parser bug is a panic on one session's thread, with
`vte`'s few unsafe lines the only place memory corruption could originate. Pinned
`"0.16"`.

**`serde_json` 1.0.151** (every crate, `"1"`). Trusted to turn each socket line and
each MCP stdin line into a `Request`/`Value` without stack or memory blow-up; the
socket side is behind the 1 MiB cap and serde_json's default recursion limit, the
MCP stdin side has only the latter (SC-10). Note that `min_version_for` gates request
*types*, so a widened payload deserialises with defaults on an older daemon
(`CLAUDE.md`, compat gate) — a protocol property, not a serde one.

**`tokio` 1.53.1** is present only because `tauri 2.11.5` needs it
(`cargo tree --locked -i tokio`); the daemon and `gavin-mcp` are synchronous `std`
code with no async runtime. **MCP transport:** `crates/gavin-mcp` uses no MCP crate at
all — no `rmcp`, no SDK. It reads JSON-RPC lines from stdin (`main.rs:1032-1034`),
answers with hand-built `{"jsonrpc":"2.0",...}` envelopes (`:958-962`), and talks to
the daemon over its own `SocketTransport` (`:29,64`) using the shared `protocol`
reader. Small surface, no third-party protocol code to audit.

**`tauri` 2.11.5 and its plugins** (`app/src-tauri/Cargo.toml:29-34`, all `"2"`;
`wry` 0.55.1, `tao` 0.35.3). The host process: WKWebView, the IPC bridge behind
`invoke`, and 165 commands. Each plugin's Rust and JS halves are at the same version
in both locks — `tauri-plugin-opener` 2.5.4 (`open` any path; the capability grants
`/**` and `**`, pass 02), `tauri-plugin-dialog` 2.7.2 (narrowed to `allow-open`; it
pulls `tauri-plugin-fs` 2.5.1 as a transitive that gavin never declares and whose
commands no capability grants, so it is compiled-in dead weight), `tauri-plugin-
clipboard-manager` 2.3.2 (read and write text), `tauri-plugin-os` 2.3.2 (`platform`
only), `tauri-plugin-notification` 2.3.3 (via `mac-notification-sys`, a build-script
ObjC compile). `@tauri-apps/api` 2.11.1 and `@tauri-apps/cli` 2.11.4 on the npm side.
`tauri-build` 2.6.3 is the build dependency that validates `tauri.conf.json` and would
demand `externalBin` files if they were configured (SC-08). `trash` 5.2.6 with default
features off is the OS-Trash route for workspace delete.

**`marked` 18.0.9** (`app/package.json`, `^18.0.9`). Trusted to turn card bodies and
previewed files into HTML (`app/src/lib/markdown.ts:16`, `breaks: true`, sync). It is
**not** trusted to sanitise: `markdown.ts:4` says so, and both `{@html}` sites wrap it
— `FileEditor.svelte:86` and `CardDetailModal.svelte:184` call `DOMPurify.sanitize`
on the result. A marked bug therefore lands in DOMPurify's lap, not the DOM's.

**`dompurify` 3.4.13** (`^3.4.13`). The one sanitiser between repo-controlled
markdown and a `"csp": null` WebView that can `invoke` 165 commands; its correctness
is what S8 rests on (pass 02). Current major; no advisory.

**`@xterm/xterm` 6.0.0, `@xterm/addon-fit` 0.11.0, `@xterm/addon-web-links` 0.12.0**
(`^6.0.0`, `^0.11.0`, `^0.12.0`). Trusted to render agent output and act on its escape
sequences (OSC 133, title, hyperlinks, OSC 52 — pass 02). Two addons are loaded
(`terminalRegistry.ts:174-175`): fit, and web-links, which turns URL-shaped text in A2's
output into clickable links that go to the opener plugin.

**`@codemirror/*` 6.x** (`view` 6.43.9, `state` 6.7.1, `language` 6.12.4, `commands`
6.11.0, nine `lang-*` packages, `theme-one-dark`). The file editor; trusted to display
and edit repo files as text and never to evaluate them. Language packages are parsers
only.

Dev-only load-bearing: `vite` 6.4.3 (the dev server of SC-09), `svelte` 5.56.8,
`@sveltejs/kit` 2.70.2 with `adapter-static` (SPA, no server), `vitest` 1.6.1 (SC-02).

## Build and release

`tauri.conf.json` on `main` builds the daemon and MCP server (`beforeBuildCommand`)
and bundles neither (SC-08); the branch's `stage-sidecars.mjs` + `tauri.bundle.conf.json`
is the working design and puts them beside the app binary via `externalBin`, which is
where `daemon.rs` and `agent_setup.rs` look (SC-07). No signing identity,
notarization, entitlements, Authenticode thumbprint, package signature, or updater is
configured on either ref (SC-06). There is no CI on `main` (SC-04); the branch's
workflow builds and tests but ships nothing, pins actions by tag and sets no
`permissions:` (SC-05). Consequently the release path today is: the developer's
laptop runs `cargo build --release`, `npm run build`, and `tauri build`, and whatever
comes out is distributed as-is — the machine on which A1 is defined is the build
machine, and no artefact carries anything a downstream party could verify.

## The dev server

Summarised in SC-09; the mechanics, for a developer running `tauri dev` all day:

| knob | value | effect |
|------|-------|--------|
| `build.devUrl` | `http://localhost:1420` | the WebView loads the page from vite, not from `frontendDist` |
| `server.host` | `false` (unless `TAURI_DEV_HOST`) | binds `127.0.0.1` and `::1` only |
| `server.port` / `strictPort` | `1420` / `true` | fixed port, fails rather than moves |
| `server.hmr` | `undefined` (unless `TAURI_DEV_HOST` → `ws://host:1421`) | HMR WebSocket on the same 1420 listener |
| `server.allowedHosts` | vite default (6.4.3) | `Host` must be `localhost`, `*.localhost`, or an IP literal — DNS rebinding gets 403; HMR upgrades with a foreign `Origin` are refused |
| `server.cors` | vite default (6.4.3) | localhost origins only; a web page cannot read responses |
| `server.fs.allow` / `deny` | vite default | `/@fs/` serves the workspace root (`app/`, including `src-tauri/`), denies `.env*`, `*.pem`, `*.crt`, `**/.git/**` |
| `/__open-in-editor` | vite built-in | opens the named file in the developer's editor; the one side-effecting endpoint |
| `invoke` | absent outside Tauri | a browser tab gets a dead SPA; nothing reaches the daemon |
| WKWebView inspector | on in debug builds | Safari's Develop menu, same uid |

Who can reach it: every process on the host, whatever its uid (loopback is not
uid-scoped); no browser tab from another origin, beyond blind `no-cors` requests. What
they get: the frontend and host source, live, and the ability to open a file in the
developer's editor. What they do not get: the daemon, any session, any card, any
`invoke`. **AD-7** covers it; `TAURI_DEV_HOST` is the only way past it and it is the
developer's own hand on the knob.
