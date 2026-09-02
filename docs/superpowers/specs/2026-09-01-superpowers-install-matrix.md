# Superpowers install + detection matrix

Date: 2026-09-01 (probed 2026-09-02)
Card: `.gavin-root/plans/feat-superpowers-install-matrix.md`
Upstream: <https://github.com/obra/superpowers> — README + `.opencode/INSTALL.md`,
read 2026-09-02. Plugin version seen everywhere: **6.3.0**.

This document is the input to `superpowers.rs`. Every row says what gavin may
run, what it may read, and — where it may do neither — that it must ask the
human and take their word for it. A guessed detector lights a green LED that is
a lie; the `unverified` column exists so no such row gets written by accident.

## The matrix

| profile | gavin can install? | command | scope | detection | verified here |
|---|---|---|---|---|---|
| `claude-code` | **yes** | `claude plugin install superpowers@claude-plugins-official --scope project -y` | `user` / `project` / `local` (default `user`) | `claude plugin list --json`, cwd = workspace root; entry with `id` starting `superpowers@` and `enabled: true` | **yes** — install, reinstall, failure, uninstall and detection all run end to end |
| `codex` | no | in-TUI `/plugins` → search `superpowers` → *Install Plugin* | n/a | none known | **no** — `codex` resolves to a broken shim on this machine |
| `gemini` | no (see below) | `gemini extensions install https://github.com/obra/superpowers` | user-global only | `~/.gemini/extensions/superpowers/` exists | **yes** — installed, listed, uninstalled |
| `cursor` | no | in-agent-chat `/add-plugin superpowers` | n/a | none known | **no** — `cursor` not on PATH |
| `opencode` | no | add `"superpowers@git+https://github.com/obra/superpowers.git"` to the `plugin` array of `opencode.json`, then restart | global or project `opencode.json` | `plugin` array of `<root>/opencode.json` or `~/.config/opencode/opencode.json` contains an entry whose package name is `superpowers` | **partly** — file shape confirmed against the real config; the plugin was never loaded |
| `custom` | no | unknown — gavin has never heard of this agent | n/a | none | n/a |

Only `claude-code` gets an Install button. Everything else gets the
paste-able instruction and the manual "I've installed it", per S1 and S8.

**Gemini is the interesting "no".** It has a real CLI command, which is why S1's
original wording (Gemini implicitly installable) looked right. It is not, and the
reason is not a missing flag — see §3.

---

## 1. Claude Code — verified baseline

### Install

```
$ claude plugin install superpowers@claude-plugins-official --scope project -y
Installing plugin "superpowers@claude-plugins-official"...✔ Successfully installed plugin: superpowers@claude-plugins-official (scope: project)
; exit 0
```

Idempotent — a second run is a success, not an error:

```
Installing plugin "superpowers@claude-plugins-official"...✔ Plugin "superpowers@claude-plugins-official" is already installed (scope: project)
; exit 0
```

Failure is exit 1, and **the message is on stderr while the progress line is on
stdout**:

```
stdout: Installing plugin "nosuchplugin@claude-plugins-official"...
stderr: ✘ Failed to install plugin "nosuchplugin@claude-plugins-official": Plugin "nosuchplugin" not found in marketplace "claude-plugins-official"
; exit 1
```

So the drawer must show **both streams interleaved**; stdout alone reports a
failure as a truncated progress line with no reason.

`--scope project` writes `<root>/.claude/settings.json`:

```json
{
  "enabledPlugins": {
    "superpowers@claude-plugins-official": true
  }
}
```

`-y` is required: `claude plugin install --help` says the confirmation prompt is
skipped by `-y`, "required when stdin or stdout is not a TTY". A hidden run has
neither.

`claude plugin install --help` scopes: `user, project, or local (default:
"user")`.

### Detection

`claude plugin list --json` returns a JSON array. Union of keys observed across
9 entries:

```
enabled, id, installPath, installedAt, lastUpdated, projectPath, scope, version
```

`projectPath` is present only on non-`user` scopes. The superpowers entry at
user scope:

```json
{
  "id": "superpowers@claude-plugins-official",
  "version": "6.3.0",
  "scope": "user",
  "enabled": true,
  "installPath": "/Users/coalpila/.claude/plugins/cache/claude-plugins-official/superpowers/6.3.0",
  "installedAt": "2026-05-04T15:00:54.385Z",
  "lastUpdated": "2026-08-17T13:05:39.550Z"
}
```

and, after a project-scope install, a second entry appears alongside it:

```json
{
  "id": "superpowers@claude-plugins-official",
  "version": "6.3.0",
  "scope": "project",
  "enabled": true,
  "installPath": "/Users/coalpila/.claude/plugins/cache/claude-plugins-official/superpowers/6.3.0",
  "installedAt": "2026-09-02T06:58:27.752Z",
  "lastUpdated": "2026-09-02T06:58:27.752Z",
  "projectPath": "/private/tmp/.../probe-proj"
}
```

Note `projectPath` is the **canonicalised** cwd (`/private/tmp`, not `/tmp`).
Any detector that compared it to a path string would have to canonicalise too.

**It does not have to.** The decisive finding:

> `enabled` is computed relative to the process's cwd.

Same machine, same command, two directories:

```
$ cd ~ && claude plugin list --json
ponytail@ponytail local enabled=False /Users/coalpila/CloudStation/Coding/mandragora
ponytail@ponytail local enabled=False /Users/coalpila/CloudStation/Coding/mandragora/utils/card-classifier

$ cd ~/CloudStation/Coding/mandragora && claude plugin list --json
ponytail@ponytail local enabled=True  /Users/coalpila/CloudStation/Coding/mandragora
ponytail@ponytail local enabled=True  /Users/coalpila/CloudStation/Coding/mandragora/utils/card-classifier
```

So the detector is exactly S5, with no scope arithmetic and no path comparison:

> **run `claude plugin list --json` with cwd = the workspace root, and look for
> any entry whose `id` has the package name `superpowers` and whose `enabled` is
> `true`.**

Marketplace-agnostic on purpose: the README documents a second source
(`superpowers@superpowers-marketplace`), and a human who installed from there is
no less installed. Match on the part before `@`.

Scope-agnostic for the same reason, and because `enabled` has already done the
scoping: a user-scope plugin reads `enabled: true` from every directory, which
is the correct answer — it *is* active in a session started there.

`claude plugin list --json` needs no TTY and exits 0.

Environment probed with: `claude --version` → `2.1.258 (Claude Code)`.

---

## 2. Codex CLI — UNVERIFIED, no command

README, verbatim:

> ### Codex CLI
> Superpowers is available via the [official Codex plugin marketplace](https://github.com/openai/plugins).
> - Open the plugin search interface: `/plugins`
> - Search for Superpowers: `superpowers`
> - Select `Install Plugin`.

An in-TUI slash command. There is no `codex plugin` subcommand documented, and
none could be checked: `codex` on this machine resolves to a cmux shim whose
target is gone (`Error: codex not found in PATH`), and `~/.codex/` holds only an
empty `sessions/`.

No on-disk evidence is documented either. The upstream repo does carry a
`.codex-plugin/` directory (seen inside the fetched 6.3.0 tree), which implies
codex installs land somewhere under a codex config root, but *implies* is not
*verified* and this row must not guess.

**What would verify it:** a machine with a working `codex`; install through
`/plugins`, then diff `~/.codex/` before and after and run `codex --help` for a
`plugin` subcommand.

→ Row shows the paste-able `/plugins` sequence and the manual "I've installed
it". `asserted`, never `verified`.

---

## 3. Gemini CLI — verified, and verified *not* drivable

A real command exists and works:

```
$ gemini extensions install https://github.com/obra/superpowers
Extension "superpowers" installed successfully and enabled.
```

`gemini extensions --help` lists `install <source>`, `uninstall`, `list`,
`update`, `disable`, `enable`, `link`, `new`, `validate`, `config`. `install`
takes only `--auto-update` and `--pre-release`; **there is no `--yes`**.

That matters, because the command is interactive:

```
The extension you are about to install may have been created by a third-party
developer and sourced from a public repository. Google does not vet, endorse, or
guarantee the functionality or security of extensions. [...]
Agent skills inject specialized instructions and domain-specific knowledge into
the agent's system prompt. This can change how the agent interprets your
requests and interacts with your environment. [...]
Do you want to continue? [Y/n]:
```

With stdin closed (`< /dev/null`) it prompts anyway and installs nothing —
`~/.gemini/extensions/` stayed empty. With `printf 'y\n' |` it installs.

So gavin *could* drive it, by piping `y` into a security prompt about
third-party code that changes the agent's system prompt. It should not. That is
the same line S3 drew for Claude Code — the marketplace was chosen precisely so
there was "no trust prompt for gavin to answer on the human's behalf" — and
piping `y` is answering one, not avoiding one. **Gemini gets the copy-able
command, not a button.**

### Detection

`gemini extensions list` has two output modes and both are traps:

- The useful text goes to **stderr**, not stdout. `gemini extensions list
  2>/dev/null` prints nothing at all, installed or not.
- On this machine stderr also carries a ~60-line `GaxiosError` traceback from
  the CLI's unrelated auth onboarding (a 403 on
  `cloudaicompanion.licenses.selfAssign`), interleaved ahead of the payload.
- `--json` is rejected; the flag is `-o json` / `--output-format json`, and its
  JSON goes to stderr too.

The `-o json` payload is an array of:

```json
{
  "name": "superpowers",
  "version": "6.3.0",
  "path": "/Users/coalpila/.gemini/extensions/superpowers",
  "contextFiles": ["/Users/coalpila/.gemini/extensions/superpowers/GEMINI.md"],
  "installMetadata": {
    "source": "https://github.com/obra/superpowers",
    "type": "github-release",
    "releaseTag": "v6.3.0"
  }
}
```

with `hooks` and `skills` arrays after. **There is no `enabled` field in the
JSON** — the text mode's `Enabled (User): true` / `Enabled (Workspace): true`
comes from a separate file:

```
$ cat ~/.gemini/extensions/extension-enablement.json
{ "superpowers": { "overrides": ["/Users/coalpila/*"] } }
```

Parsing a JSON document out of a stream that also carries a stack trace is not a
detector, it is a bet. The on-disk evidence is unambiguous and needs no
subprocess at all:

> **`~/.gemini/extensions/superpowers/` is a directory.**

Installs are user-global; there is no project scope on `install` (only `enable`
/`disable` take `--scope`). So the home directory is the only place to look, and
"installed" and "active here" coincide — modulo an explicit per-workspace
`disable`, which this detector will miss and which is a state no gavin user will
be in by accident.

**What would verify the residual gap:** `gemini extensions disable --scope
workspace superpowers` inside a root, then confirm `extension-enablement.json`
grows a negative override that the directory check cannot see.

---

## 4. Cursor — UNVERIFIED, no command

README, verbatim:

> ### Cursor
> - In Cursor Agent chat, install from marketplace: `/add-plugin superpowers`
> - Or search for "superpowers" in the plugin marketplace.

`cursor` is not on PATH here and there is no `~/.cursor/`. gavin's own profile
already records (`agent_setup.rs`) that `cursor` is the IDE launcher whose
positionals are paths — so even the command it does have is not one that could
carry a slash command.

The upstream tree carries `.cursor-plugin/`, again implying an on-disk landing
spot without naming one.

**What would verify it:** a machine with Cursor; run `/add-plugin superpowers`
in agent chat, then diff `~/.cursor/` before and after.

→ Paste-able `/add-plugin superpowers`, manual assertion only.

---

## 5. opencode — no command, but real on-disk evidence

`.opencode/INSTALL.md`, verbatim:

> Add superpowers to the `plugin` array in your `opencode.json` (global or
> project-level):
>
> ```json
> { "plugin": ["superpowers@git+https://github.com/obra/superpowers.git"] }
> ```
>
> Restart OpenCode. The plugin installs through OpenCode's plugin manager and
> registers all skills.

The README's own entry for opencode is *"instruct OpenCode to fetch and follow
`.opencode/INSTALL.md`"* — i.e. upstream's answer is a prompt, not a command.

`opencode plugin <module>` does exist, but `--help` says the positional is an
**npm module name**, and Superpowers is distributed as a git spec, not an npm
package. It is the wrong door; INSTALL.md's own Windows workaround goes through
`npm install ... --prefix` rather than through it.

gavin could write that one JSON key itself — it already owns `opencode.json` for
MCP (`McpFormat::JsonLocal`, `config_file: "opencode.json"`). It should not, on
this card. INSTALL.md is a document with a migration section that removes an
older symlink layout; reproducing one line of it and calling the plugin
installed is exactly the "green LED that is a lie" this spike exists to prevent,
and the file is the human's. Offer the paste-able instruction.

### Detection

Read, without running anything:

- `<root>/opencode.json` → `.plugin[]`
- `~/.config/opencode/opencode.json` → `.plugin[]`

and match an entry whose package name (the part before `@`, allowing a leading
scope) is `superpowers`. Both files are plain JSON; the global one exists on
this machine with keys `["$schema", "model", "provider"]` and no `plugin` key,
which is the correct "absent" reading.

**Unverified end to end:** the file shape is upstream's own, and the global
config was read to confirm the key is a sibling of `model`/`provider`, but no
opencode session was started with the entry in place. That would need a
configured provider and a network install.

**What would verify it:** add the entry to a scratch `opencode.json`, start
opencode there, and ask "Tell me about your superpowers" — INSTALL.md's own
verification step.

---

## 6. `custom`

The sixth profile in `AGENT_PROFILES` is the user's own agent. gavin knows
neither its plugin mechanism nor whether it has one. The row is `unavailable`
with a named reason, and the manual assertion stays available — a human running
a custom harness can still tell gavin that Superpowers is in it.

---

## Consequences for `superpowers.rs`

1. Two detector kinds, not one: **a subprocess** (`claude-code`) and **a path or
   file read** (`gemini`, `opencode`). Two profiles (`codex`, `cursor`) and
   `custom` have neither and go straight to `unavailable`.
2. The Claude detector runs with **cwd = workspace root**. Running it from the
   app's cwd would answer a different question and get local-scope installs
   wrong.
3. Match plugin ids on the **package name**, not the full `name@marketplace`.
4. The install drawer shows **stdout and stderr together**. Claude's failure
   reason is on stderr only.
5. `-y` is not optional on the install, and a Finder-launched app's stripped
   PATH is the first thing that will break `claude` resolution — surface stderr
   verbatim when it does.
6. One install command, one profile. Nothing else gets a button, and the row
   that says so should say *why* — "Cursor installs from inside its own agent
   chat", not a greyed-out control with no explanation.
