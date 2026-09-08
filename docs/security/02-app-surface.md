# 02 — Tauri host & frontend surface

Pass 02 of the audit in `docs/security/00-threat-model.md`. Surfaces **S6**
(the Tauri host and its capabilities), **S7** (host-side process spawns), **S8**
(rendered untrusted content). Finding ids `AS-nn`.

## Scope

Commit `944eae2`, branch `sec/review-2026090801`, `PROTOCOL_VERSION` 34, read-only.
Files read in full or in the relevant part: `app/src-tauri/tauri.conf.json`,
`app/src-tauri/capabilities/default.json`, `app/src-tauri/Cargo.toml`,
`app/src-tauri/src/{lib,fileviewer,session,agent_setup,agent_usage,agent_tokens,agent_models,pull_request,superpowers,daemon,worktree_setup,workspace_delete,workspace_window,trash,config}.rs`,
`app/src-tauri/src/git/{run,commands,ops,conflict,runchanges,tracking,watch}.rs`,
`app/src/lib/{terminalRegistry,markdown,cardRun,agentModel,settings,worktreeSetup,notifications,dialog}.ts`,
`app/src/lib/{FileEditor,CardDetailModal,FilesHubView,OrchestrationRail,AppHubView,SettingsHubView,HomeHubView}.svelte`,
`crates/daemon/src/{osc,status,pty}.rs`, `crates/daemon/src/gavin.rs` (guard for
`DeleteCardFile`). Cross-checked the pinned crates in `~/.cargo` (`tauri 2.11.5`,
`tauri-plugin-opener 2.5.4`, `wry 0.55.1`) for navigation/IPC/opener defaults and
the two npm deps (`marked 18.0.9`, `dompurify 3.4.13`, `@xterm/xterm 6.0.0`,
`@xterm/addon-web-links 0.12.0`).

Tests run: one standalone Rust primitive (`scratchpad/app-pass/primitives.rs`,
`rustc -O`) mirroring the `[agent] file` join and the `trash_entry`
canonicalize-symlink behaviour. `node`/`vitest` was **not** run for the
`{@html}` claims — `app/node_modules` is absent and `npm install` is disallowed —
so those are argued from reading the pinned versions and the call sites.

## Findings

| id | severity | adversary | vuln/boundary | reproduced | one line |
|----|----------|-----------|---------------|------------|----------|
| AS-01 | Medium | A2 (via S8) | vulnerability | no (blast-radius argued) | `csp:null` + every `#[tauri::command]` reachable from any in-page script means one S8 XSS is total host compromise, with no second line of defence. |
| AS-02 | High | A2 | vulnerability | no (static trace) | `superpowers_status`/`superpowers_install` execute the first token of a **cloned repo's** `.gavin-root/config.toml` `[agent] command`, fired automatically when the workspace's Home/Settings tab renders. |
| AS-03 | Medium | A2 | vulnerability | yes (primitive) | `setup_agent_integration` writes gavin's marker block through `[agent] file` from repo config.toml with no path validation — an absolute or `..` value writes outside the workspace root. |
| AS-04 | Medium | A2 (via S8) / A1 | boundary (AD-1) | yes (by reading) | `read_file_for_viewer` / `write_file_for_editor` / `resolve_path_under_cursor` take a raw absolute path with no containment guard, unlike the six guarded explorer commands — arbitrary read/write for a compromised page. |
| AS-05 | Medium | A2 (via S8) | vulnerability | no | Every destructive confirmation lives only in the frontend (`dialog.ts`); an in-page script bypasses all of them and can also `restart_daemon` (kills the shared daemon). |
| AS-06 | Info | — | boundary (AD-5) | n.a. | Positive: the Claude OAuth token path is clean — Keychain→`curl -K -` on stdin, never argv/log/disk/frontend. |
| AS-07 | Low | A2 (via S8) | boundary (AD-4) | no | `{@html}` sinks are DOMPurify-sanitised (default config) and xterm runs with no `allowProposedApi` (OSC 52 off) and no OSC-title→tab-name path; residual risk is a DOMPurify/WebKit bypass, plus a Cmd+click path link that `open`s a repo file. |
| AS-08 | Low | A2 | vulnerability | no | The git wrapper uses argv arrays (good) but ref/branch/remote-taking commands omit `--` end-of-options; no injection reproduced because reachable inputs are slugged/human-typed and `ext::` is git-default-blocked. |
| AS-09 | Low | A2 (via S8) | boundary (AD-1) | no | `opener:allow-open-path` is scoped to `/**` and `**` (every path); from a compromised page `open_path` can launch arbitrary apps/files. |

---

### AS-01 — A compromised page is a compromised host (`csp:null`, all commands reachable)

**What.** `app/src-tauri/tauri.conf.json` sets `app.security.csp = null`, so Tauri
injects **no** Content-Security-Policy into the served document, and nothing sets
one at runtime (`lib.rs` registers no `on_web_resource_request`/CSP hook). The
window loads from `frontendDist` (`../build`) in the bundle, or
`http://localhost:1420` under `tauri dev`.

The frontend calls commands through `@tauri-apps/api`'s `invoke`, which dispatches
to `window.__TAURI_INTERNALS__.invoke`. That object is defined by Tauri's own
`core.js` init script on every page regardless of `withGlobalTauri` (which is
unset — `window.__TAURI__` is absent, but `__TAURI_INTERNALS__` is not). So **any
script running in the app's own origin can invoke every one of the ~165 commands**
registered in `lib.rs:70-237`. With no CSP there is also nothing stopping that
script from `fetch()`-ing an attacker origin to exfiltrate whatever it read, or
from loading a remote `<script src>`.

What that buys an attacker who achieves in-origin script execution: arbitrary file
write (`write_file_for_editor`, AS-04), arbitrary file read + exfil
(`read_file_for_viewer`), driving any PTY (`create_session`, `write_input`,
`queue_input` — inject stdin into another agent's shell), the whole git surface,
workspace/card deletion with no confirmation (AS-05), and `open_path` on `/**`
(AS-09).

**Where.** `app/src-tauri/tauri.conf.json` (`"csp": null`); `lib.rs:70-237`
(handler list); `~/.cargo/.../tauri-2.11.5/scripts/core.js` (`__TAURI_INTERNALS__`).

**Impact.** The blast radius of any S8 cross-site-scripting is total: full host
control as the user, no confirmation, no CSP to blunt exfiltration. A CSP would
not by itself stop `invoke`, but it is the standard second line that turns an
`{@html}`/renderer bug from "game over" into "contained".

**Reproduction / admission.** Not reproduced end-to-end — I did not find an S8 XSS
(AS-07 argues the two `{@html}` sinks and xterm currently hold). This finding is
the *amplifier*: it is argued from reading `tauri.conf.json` and the invoke plumbing.
One mitigating fact confirmed by reading `tauri-2.11.5/src/ipc/authority.rs:60-61`
and `manager/webview.rs`: the default capability grants only the **Local**
execution context (no `remote`/`urls` entry), so a webview that *navigates* to an
external origin lands in the Remote context and its `invoke` is denied by the ACL.
The exposure therefore requires script execution **within the app origin** (via a
renderer/`{@html}` hole), not a navigation away — which is exactly why AS-07's
sanitisation is load-bearing.

**Marked.** `vulnerability` (a permissive config that removes the mitigation the
threat model relies on). To reach it, S8 must inject script into the app origin —
see AS-07 for why that is currently blocked.

---

### AS-02 — Repo-supplied `[agent] command` is executed on tab render

**What.** `superpowers.rs::binary_for` (line 311) takes the workspace's agent
launch command straight from the cloned repo:

```
let configured = crate::agent_setup::root_agent_key(root, "command").unwrap_or_default();
configured.split_whitespace().next()... .unwrap_or(profile.command)
```

`root_agent_key` reads `.gavin-root/config.toml`'s `[agent] command`
(`agent_setup.rs:823`). `superpowers_status` (line 474) → `detect` → for a
`claude-code`-mechanism profile runs `run(&bin, ["plugin","list","--json"], root, …)`
with `Command::new(bin).current_dir(root)` (line 240, 336). `superpowers_install`
(line 492) runs `bin plugin install …`.

`bin` is the **first whitespace token of a value the cloned repo controls**. A
hostile repo shipping

```toml
[agent]
profile = "claude-code"
command = "./scripts/setup.sh"
```

plus a `scripts/setup.sh` gets that script executed (`cwd` = repo root) the moment
the workspace's Home tab renders — `HomeHubView.svelte:190` calls
`superpowersStatus(r)` whenever the workspace has no recorded superpowers mark, and
Home is the default view for a workspace with a root (`workspace.ts:564`). The
Settings tab calls it unconditionally (`SettingsHubView.svelte:119`). No Run click,
no confirmation.

**Where.** `app/src-tauri/src/superpowers.rs:311-318` (`binary_for`), `:329-340`
(`detect`/`run`), `:474-490` (`superpowers_status`), `:492-533` (`superpowers_install`);
`app/src/lib/HomeHubView.svelte:190`; `app/src/lib/SettingsHubView.svelte:119`.

**Impact.** Arbitrary binary/script execution as the user, from unread cloned-repo
content, triggered by a passive UI action (viewing a workspace). The args are fixed
(`plugin list`/`plugin install`), so it is "run this attacker-named program", not
"run this attacker command line" — but a repo can point at its own checked-in
script, so that distinction gives no protection.

**Reproduction / admission.** Not run against the app (building the Tauri lib is out
of scope for this pass); argued from a static trace with the file:line above.
`binary_for`'s "first token of config.toml `[agent] command`" is a two-line read; the
Home-tab trigger is `HomeHubView.svelte:184-196`.

**Marked.** `vulnerability`, cites **AD-6** ("Not accepted: the same keys arriving
from a repo the human just cloned"). Same root cause — repo config.toml treated as
the human's config — also feeds the launched agent's `sh -c <launchCommand>`
(`resolveAgent`/`composeLaunchCommand` → `create_session`), but that shell exec is
the daemon's (pass 01/03, S9); the *host-side* `Command::new` with a repo-controlled
binary is this one.

---

### AS-03 — `setup_agent_integration` writes outside the root via unvalidated `[agent] file`

**What.** `run_integration` (`agent_setup.rs:1159`) resolves the instructions file
with `resolved_instructions_file` (line 817), which is just

```
root_agent_key(root, "file").filter(...).unwrap_or_else(|| profile.instructions_file)
```

with **no path validation**, then `write_instructions_block` (line 1094) does
`root.join(instructions_file)` and `fs::write`, creating the file if absent. The
sibling `mcp_file` key *is* validated (`usable_mcp_path`, line 137, rejects absolute
and `..`), but `file` is not. A cloned repo shipping

```toml
[agent]
file = "../../../Users/me/.zshrc"     # or an absolute path
```

makes gavin append its `<!-- gavin:start -->…<!-- gavin:end -->` block to that file
when the human runs the init wizard's Integration step or "re-run integration"
(`WorkspaceRootControl.svelte:101`, `IntegrationStep.svelte:22`,
`PrdStep.svelte:93`).

**Where.** `app/src-tauri/src/agent_setup.rs:817-822` (`resolved_instructions_file`,
unvalidated), `:1094-1126` (`write_instructions_block`, `root.join` + `fs::write`),
contrasted with `:137-150` (`usable_mcp_path`, which *does* validate `mcp_file`).

**Impact.** Out-of-root file creation/append driven by unread repo content on a
human click. The written bytes are gavin's fixed marker block (an HTML comment plus
markdown), not attacker-chosen content, so it cannot inject shell into `.zshrc`
directly — but it can create files at arbitrary attacker-named paths and append to
files where those bytes matter (a git hook body, a YAML/TOML config), and it is a
clear boundary break.

**Reproduction.** `scratchpad/app-pass/primitives.rs` mirrors the exact operation
(`root.join(file)` then read-append-write). Output:

```
[agent] file = "/…/victim.txt"  -> wrote /…/victim.txt
[agent] file = "../victim.txt"  -> wrote /…/repo/../victim.txt
victim.txt now:
human's own file
<!-- gavin:start -->
## Gavin workspace
<!-- gavin:end -->
```

Both an absolute value and a `..` value land outside `repo/`.

**Marked.** `vulnerability`, cites **AD-3 / AD-6** (repo-shipped config reaching a
write on the human's click). The fix parity is obvious: run `file` through the same
`usable_mcp_path`-style check that already guards `mcp_file`.

---

### AS-04 — Raw-path file commands have no containment guard

**What.** The Files-tab explorer commands take a workspace `root` and enforce
component-wise containment against its canonicalised form, refusing symlinked
directories and `..`:

- `list_directory` (`fileviewer.rs:386`) — `canonical_root` + `resolve_existing` + symlink refusal ✓
- `create_file` (:431), `create_directory` (:446) — `resolve_new` ✓
- `rename_path` (:459) — `resolve_existing` (source) + `resolve_new` (dest) ✓
- `trash_entry` (:479) — `resolve_existing` ✓ (caveat below)
- `move_agent_file` (`agent_setup.rs:1591`) — rejects names containing `/` or `\`, `root.join` ✓ (name-only)

But three commands take a **raw absolute path with no root and no containment**:

- `read_file_for_viewer(path)` (`fileviewer.rs:54`) — `std::fs::read(&path)`, 1 MiB cap, returns content to the frontend.
- `write_file_for_editor(path, content)` (`:84`) — `std::fs::write(&path, content)`, creates parent dirs. Arbitrary-content write to any path the uid can write.
- `resolve_path_under_cursor(candidate, cwd)` (`:102`) — `canonicalize` + `is_file`; read-only, but discloses existence of any readable file and expands `~`.

`watch_file_for_viewer`/`unwatch_file_for_viewer` (`:178`, `:202`) likewise take a
bare path.

The containment guard (`inside_root` at `:315`, `resolve_existing` at `:322`,
`resolve_new` at `:344`) is genuinely well-built where it is applied — the header
comment at `:272-284` is accurate. It is simply absent from the reader/writer/watch
entry points.

**Where.** `fileviewer.rs:54, 84, 102, 178, 202` (unguarded); `:308-367, 386-483`
(the guard and its consumers).

**Impact.** For a **compromised page** (AS-01), `write_file_for_editor` is the
strongest primitive on the whole surface: arbitrary content to an arbitrary path
(drop a shell rc, a git hook, an LaunchAgent plist). `read_file_for_viewer` reads
any file (SSH keys, `~/.aws/credentials`, up to 1 MiB) straight back to the page,
which then exfiltrates freely because there is no CSP (AS-01).

**Reproduction / admission.** Argued from reading — `fs::read`/`fs::write` on the
raw argument is self-evident at `:55` and `:90`. Not reachable by an adversary today
without an S8 script-exec hole (the reader/writer are called only by gavin's own
tab code); the finding is that no host-side containment exists to fall back on if
that hole appears.

**Marked.** `boundary` for A1 under **AD-1** (a same-user process already has the
filesystem; these commands add nothing it lacked, and they legitimately serve tabs
that open files anywhere the human picked — a PRD on a shared volume, an attachment
on the Desktop). It is a **vulnerability amplifier** for the S8 case: the guard that
exists on five commands is missing on the two that matter most for arbitrary
read/write.

*Caveat on `trash_entry`:* `resolve_existing` calls `std::fs::canonicalize`, which
**follows a symlink to its target**. The doc comment at `:466-477` claims "A symlink
is trashed, never followed", but the primitive confirms the canonical path handed to
`trash_path` is the *target*, not the link — a link inside the root whose target is
also inside the root trashes the real target file. Containment holds (the target must
be inside the root), so this is a correctness/comment bug, not an escape.

---

### AS-05 — Every destructive confirmation is frontend-only; `restart_daemon` is a DoS

**What.** Gavin has no native confirm (the dialog plugin is narrowed to
`dialog:allow-open`; `capabilities/default.json`), so every "are you sure" is drawn
in-app by `dialog.ts`/`ConfirmPrompt` and lives entirely in the webview:
`trashEntry` (`FilesHubView.svelte:315`, danger prompt), card deletion
(`cardMenu.ts` → `executeDeletion` → `delete_card_file`), `git_discard_run`
(`RunChangesModal.svelte:87` → `reset --hard`), `discard_files` ("Always confirmed
in the UI"), `git_reset` (`GitGraph.svelte:141` behind `GitResetDialog`), workspace
delete (the six-screen wizard → `remove_gavin_footprint`), `end_orphan`
(`orphanActions.ts:37`), tab-close/`kill_session`.

Because the confirmation is a frontend construct and the command is a direct
`invoke`, a script in the page (AS-01) calls the command **and never draws the
prompt**. It can also invoke `restart_daemon` (`session.rs:1737`), whose recovery
path `kill_running_daemons` runs `pkill -x gavin-daemon` (`daemon.rs:59`) — killing
the daemon *shared with every other window and workspace*, whose sessions then come
back as bare shells marked `interrupted`.

**Where.** `app/src/lib/dialog.ts` (the only confirm layer); destructive call sites
listed above; `session.rs:1737` + `daemon.rs:58-65` (`restart_daemon` → `pkill`).

**Impact.** A compromised page silently trashes files, resets checkouts, deletes
cards/workspaces, and can DoS the whole app by killing the shared daemon — none of
which shows the human a prompt.

**Reproduction / admission.** Not reproduced (depends on the S8 hole of AS-01);
argued from reading. This is intrinsic to a design where confirmations are UI, not
capability — worth recording so a future host-side confirmation (or a re-check on
irreversible commands) is a deliberate decision.

**Marked.** `vulnerability` (the confirmation the product promises is defeated by
any in-page script). Reaching it needs S8 script exec (AS-07).

---

### AS-06 — OAuth token handling is clean (positive)

**What.** `agent_usage.rs` reads the Claude Code OAuth token from the Keychain
(`security find-generic-password …`, `:231`) or `~/.claude/.credentials.json`
(`:242`), and sends it to `curl` via `-K -` on **stdin** as a config blob
(`:278-289`, `run_curl` at `:342`) — never on argv, so it is invisible in `ps`. I
traced every use: it is not logged (`grep` for `println!`/`eprintln!`/`log::`/`dbg!`
in the module finds none touching the token), not written to disk, and never
returned to the frontend — only percentages and reset instants cross back
(`UsageReport`). `agent_tokens.rs` reads only local transcript JSONL files and needs
no credential (`:18-26`). The module header at `:18-24` states this contract and the
code keeps it.

**Where.** `agent_usage.rs:224-363`.

**Marked.** `boundary`/positive, consistent with **AD-5** (secrets at rest under the
`0700` dir are the shell-history boundary). No action.

---

### AS-07 — Rendered untrusted content: `{@html}` sanitised, xterm constrained

**What.** Two `{@html}` sinks render untrusted markdown:

- `FileEditor.svelte:377` renders `rendered`, which is `DOMPurify.sanitize(renderMarkdown(buffer))` (`:86`).
- `CardDetailModal.svelte:1322` renders `bodyHtml`, which is `DOMPurify.sanitize(renderMarkdown(content))` (`:184`).

Both go through the one markdown pass, `markdown.ts:16`:
`marked.parse(previewBody(content), { async: false, breaks: true })` — `marked
18.0.9` with **no custom extensions/renderers** and no other options, then
**DOMPurify 3.4.13 with the default config** (no `ADD_TAGS`, no
`ALLOW_UNKNOWN_PROTOCOLS`, no `ADD_ATTR`). Default DOMPurify strips `<script>`,
event-handler attributes, and dangerous URI schemes (`javascript:`), while keeping
ordinary markup and http/https/mailto/tel links. Sanitisation is on the path in both
sites; the eslint-disable comment at `CardDetailModal.svelte:1321` matches the code.

xterm (`terminalRegistry.ts`): `@xterm/xterm 6.0.0` with `FitAddon`, `WebLinksAddon`
(`:176`) and a custom `registerLinkProvider` (`:111`). **No `allowProposedApi`** is
set anywhere in `app/src` (grep empty), so xterm's OSC 52 clipboard write is *not*
enabled — an agent cannot write the clipboard through the terminal. Links activate
only on Cmd+click (`event.metaKey`, `:140`, `:179`): a URL → `openUrl` (http/https via
the opener), a path → `resolve_path_under_cursor` then in-app viewer or `openPath`.
The daemon's OSC handling is narrow: `osc.rs` parses **only** OSC 7 (cwd), and
`status.rs` parses OSC 133 / 9 / 99 / 777 for status — **no OSC 0/2 title parsing**,
and nothing pushes a PTY-set window title to the tab name or sidebar (session names
come from `gavin_name_session`/the user). So the classic "agent renames your tab" and
"agent writes your clipboard" vectors are both closed.

**Residual risk.** (1) A DOMPurify or WebKit parser bypass would give the S8 script
exec that AS-01/AS-04/AS-05 turn into full compromise — but that is a library/WebKit
issue, out of scope per the threat model. (2) OSC 7 lets an agent set the reported
cwd that `resolve_path_under_cursor` resolves relative paths against
(`cwdBySessionId`), and a Cmd+click path link resolving to e.g. a repo `*.command`
file would be handed to `open` — a phishing step needing a human click.

**Where.** `FileEditor.svelte:86,377`; `CardDetailModal.svelte:184,1322`;
`markdown.ts:8,16`; `terminalRegistry.ts:105-183`; `crates/daemon/src/osc.rs`,
`status.rs:196-255`.

**Reproduction / admission.** Not run — `app/node_modules` is absent and
`npm install` is disallowed, so I could not exercise DOMPurify/`marked` in vitest.
Argued from the pinned versions and the fact that both sites call
`DOMPurify.sanitize` with default config over `marked` output with no HTML-enabling
options. No bypass attempted.

**Marked.** `boundary` under **AD-4** (agent output is untrusted; gavin's duty is
not to execute it — which, via sanitisation + no-OSC-52 + no-title-plumbing, it
currently meets). Low because the mitigations are present; its weight is that AS-01
gives it no backstop.

---

### AS-08 — git wrapper uses argv but omits `--` on ref-taking commands

**What.** `git/run.rs:37` runs every git call as an **argv array** (`Command::new("git").args(args)`),
with `GIT_TERMINAL_PROMPT=0` and stdin nulled unless explicitly piped — no shell
string is ever built, so classic shell metacharacter injection is not possible.
Path/multi-value commands correctly terminate options with `--` (`conflict.rs`
`checkout … -- <path>`, `commands.rs` `with_paths` pushes `--`, `diff` uses `--`).

However several commands pass a user/repo-influenced ref, branch, remote or URL as a
bare positional **without** `--`: `checkout` → `switch <name>` (`commands.rs:391`),
`create_branch` → `branch <name> [from]` (`:399`), `merge` → `merge --no-edit <branch>`
(`:436`), `reset` → `reset <flag> <sha>` (`:160`), `merged_branches` → `branch --merged <base>`
(`:426`), `add_remote` → `remote add <name> <url>` (`:466`), `git_fetch`/`git_pull`/`git_push`
(`ops.rs:104-121`). A value beginning with `-` could in principle be read as an
option (`--upload-pack=`, `-c core.sshCommand=`, `--config=`).

**Impact / why Low.** No injection reproduced. The dangerous transports are blocked
by git's own defaults: `ext::` remotes need `-c protocol.ext.allow=always`, which
production `ops.rs` never sets (only a unit test does, `run.rs:323`). The reachable
inputs are constrained: branch names originate from slugged rail/card names
(`git.ts` `branchNameFrom`), sha/rev values are hex, and remote names/URLs are
human-typed in the git UI (AD-6 trusted). I could not construct a path where a
`-`-prefixed value with an executing option reaches a network/clone command with
attacker control.

**Where.** `git/run.rs:37-102`; `git/commands.rs:160,391,399,426,436,466`;
`git/ops.rs:104-121`.

**Marked.** `vulnerability` (hardening) — adding `--` before the first ref on these
commands is cheap and closes the class outright. Cites A2 (repo-influenced slugs).

---

### AS-09 — `opener:allow-open-path` scoped to every path

**What.** `capabilities/default.json` grants `opener:allow-open-path` with
`allow: [{ "path": "/**" }, { "path": "**" }]` — i.e. open any absolute or relative
path — plus `opener:default` (which enables `open_url` for `http`/`https`/`mailto`/`tel`
and `reveal_item_in_dir`). The opener plugin also injects a click interceptor
(`init-iife.js`) that routes any `<a>` with those schemes through `open_url`.

**Impact.** From a compromised page (AS-01), `invoke("plugin:opener|open_path", …)`
can `open` any file or app bundle on disk (macOS `open` launches `.app` bundles and
hands other files to their default handler). Legitimately the app only ever opens
files the human is already looking at, so the scope is far wider than the use.

**Where.** `capabilities/default.json` (`opener:allow-open-path`, `/**` and `**`);
`~/.cargo/.../tauri-plugin-opener-2.5.4/src/init-iife.js`.

**Marked.** `boundary` under **AD-1** (a same-user process can already `open`
anything); Low hardening — the scope could be narrowed to the workspace roots and
the temp dir. Its real weight is as a component of AS-01.

---

## Appendix — command → path/command argument → guard

Host-side `#[tauri::command]`s that take a filesystem path, a cwd, or a command
string. "Daemon-guarded" means the host forwards to the daemon, which enforces the
guard (pass 01); the daemon guard for `DeleteCardFile` is at
`crates/daemon/src/gavin.rs:1064-1082` (must be `.md`, no `..`, inside
`.gavin*/plans|docs|specs`).

| command | file | path/cmd argument | guard |
|---------|------|-------------------|-------|
| `read_file_for_viewer` | fileviewer.rs:54 | `path` (raw) | **none** (1 MiB cap only) |
| `write_file_for_editor` | fileviewer.rs:84 | `path` (raw) + content | **none** (creates parents) |
| `resolve_path_under_cursor` | fileviewer.rs:102 | `candidate`, `cwd` | **none** (canonicalize+is_file; read-only) |
| `watch_file_for_viewer` | fileviewer.rs:178 | `path` (raw) | **none** (read watch) |
| `unwatch_file_for_viewer` | fileviewer.rs:202 | `path` (raw) | **none** |
| `attachment_status` | fileviewer.rs:248 | `root`, `paths` | partial — `usable_attachment_path` refuses `..`, **allows absolute by design**; read-only stat |
| `list_directory` | fileviewer.rs:386 | `root`, `path` | ✓ canonical_root + resolve_existing + symlink refusal |
| `create_file` | fileviewer.rs:431 | `root`, `path` | ✓ resolve_new |
| `create_directory` | fileviewer.rs:446 | `root`, `path` | ✓ resolve_new |
| `rename_path` | fileviewer.rs:459 | `root`, `from`, `to` | ✓ resolve_existing + resolve_new |
| `trash_entry` | fileviewer.rs:479 | `root`, `path` | ✓ resolve_existing (follows symlink to target — AS-04 caveat) |
| `move_agent_file` | agent_setup.rs:1591 | `root`, `from`, `to` | ✓ name-only (rejects `/`,`\`) |
| `setup_agent_integration` | agent_setup.rs:1150 | `root_path` (+ `[agent] file`, `mcp_file` from config.toml) | partial — `mcp_file` validated (usable_mcp_path); **`file` NOT validated** (AS-03) |
| `compose_agent_prompt` | agent_setup.rs:1440 | `root_path`, `flow` | ✓ writes skill only to profile-fixed subdir; target used in prompt text only |
| `superpowers_status` / `superpowers_install` | superpowers.rs:474 / :492 | `root_path` → runs `[agent] command` first token | **none** — repo-controlled binary executed (AS-02) |
| `worktree_setup` | worktree_setup.rs:52 | `root_path` | read-only config parse |
| `delete_card_file` | session.rs:4160 | `path` | daemon-guarded (gavin.rs:1064) |
| `init_gavin_root` / `create_gavin_context` / `add_external_gavin_context` / `remove_external_gavin_context` | session.rs:4073-4128 | `root_path`/`folder` | daemon-guarded (pass 01) |
| `create_plan` / `set_plan_frontmatter_field` / `archive_card` / `unarchive_card` / `set_checklist_item` / `promote_checklist_item` / `set_root_config_field` | session.rs | `context_folder`/`path`/`root_path` | daemon-guarded (pass 01) |
| `create_session` | session.rs:3497 | `cwd`, `command` | passthrough → daemon `sh -c` (command from repo config via resolveAgent; S9/pass 03) |
| `restart_daemon` | session.rs:1737 | — | `pkill -x gavin-daemon` (kills shared daemon; AS-05) |
| `git_*` (all) | git/commands.rs, ops.rs, conflict.rs, runchanges.rs, tracking.rs | `cwd` + ref/branch/remote/url/path | cwd `is_dir` checked; **argv arrays** (no shell); `--` on path commands, omitted on ref commands (AS-08) |
| host `Command::new` spawns | agent_usage.rs (curl/security), agent_models.rs (opencode), pull_request.rs (gh), git/run.rs (git), superpowers.rs, daemon.rs (pkill/gavin-daemon) | — | argv arrays throughout; token via stdin not argv (AS-06); only superpowers reads its binary from repo config (AS-02) |

**Count.** Of the host-side commands that take a filesystem path: **6 apply the
canonical-root containment guard** (`list_directory`, `create_file`,
`create_directory`, `rename_path`, `trash_entry`, `move_agent_file`); **5 take a raw
path with no containment** (`read_file_for_viewer`, `write_file_for_editor`,
`resolve_path_under_cursor`, `watch_file_for_viewer`, `unwatch_file_for_viewer`);
and `setup_agent_integration` validates `mcp_file` but **not** `[agent] file`.
