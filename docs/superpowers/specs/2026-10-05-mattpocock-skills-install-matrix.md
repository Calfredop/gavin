# Matt Pocock's skills — install + detection matrix

Date: 2026-10-05 (probed 2026-10-06)
Card: `.gavin-root/plans/spike-mattpocock-skills-install-matrix.md` (nested in
`feat-replace-superpower.md`)
Upstream: <https://github.com/mattpocock/skills> — README and
`.claude-plugin/plugin.json`, read 2026-10-06.
Machine: macOS, Claude Code `2.1.291`, skills CLI `1.7.0` (`npx skills@latest`),
Node 22.22.3, gemini-cli `0.35.3`, opencode `1.18.25`, cursor-agent
`2026.10.01`. No `codex` binary on this machine.

This replaces `2026-09-01-superpowers-install-matrix.md` as the input to
`agent_skills.rs`. Same rule as before: a guessed detector lights a green LED
that is a lie, so every row says what was run, and anything that was not is
marked **UNVERIFIED**.

## The matrix

gavin's profiles are the six in `AGENT_PROFILES`: `claude-code`, `codex`,
`gemini`, `cursor`, `opencode`, `custom`. The brief's Kimi Code has **no gavin
profile**, so it has no row; a Kimi user runs it as `custom`.

| profile | route | gavin installs? | command gavin runs (cwd = workspace root) | detection | verified here |
|---|---|---|---|---|---|
| `claude-code` | plugin | **yes** | `claude plugin install mattpocock-skills --scope project -y` | `claude plugin list --json` in the root: an entry whose package name is `mattpocock-skills` with `enabled: true` | **yes** — install, reinstall, failure, fresh-machine failure, detection |
| `codex` | skills CLI | **yes** | `npx -y skills@latest add mattpocock/skills --skill '*' -a codex -y` | `skills-lock.json` lists a `source: "mattpocock/skills"` skill whose `.agents/skills/<name>/SKILL.md` exists | install + detection **yes**; Codex reading `.agents/skills/` is **docs-only** (no `codex` binary here) |
| `gemini` | skills CLI | **yes** | `… -a gemini-cli -y` | same, `.agents/skills/` | **yes** — `gemini skills list` lists them from the project's `.agents/skills/` |
| `cursor` | skills CLI | **yes** | `… -a cursor -y` | same, `.agents/skills/` | install + detection **yes**; Cursor reading `.agents/skills/` per cursor.com/docs/context/skills (read 2026-10-06), not run in Cursor |
| `opencode` | skills CLI | **yes** | `… -a opencode -y` | same, `.agents/skills/` | **yes** — `opencode debug skill` lists them from the project's `.agents/skills/` |
| `custom` | manual | no | none — skills.sh instructions + "I've installed it" | machine-local marker, shown as *asserted* | n/a |

Every CLI-route profile lands in the **same** directory: at project scope the
skills CLI's `codex`, `cursor`, `gemini-cli`, `opencode` (and `kimi-code-cli`)
entries all have `skillsDir: ".agents/skills"` (read from the CLI's agent
table, `dist/cli.mjs`). One install serves all five, which is also why
detection does not need the profile beyond "is this a CLI-route profile".

## 1. Claude Code — plugin route

### Install

```
$ claude plugin install mattpocock-skills --scope project -y
Installing plugin "mattpocock-skills"...✔ Successfully installed plugin: mattpocock-skills@claude-plugins-official (scope: project)
; exit 0, stderr empty
```

The bare name resolves to `mattpocock-skills@claude-plugins-official`.
Writes `<root>/.claude/settings.json`:

```json
{ "enabledPlugins": { "mattpocock-skills@claude-plugins-official": true } }
```

Idempotent:

```
Installing plugin "mattpocock-skills"...✔ Plugin "mattpocock-skills@claude-plugins-official" is already installed (scope: project)
; exit 0
```

Failure — progress on stdout, reason on **stderr** only (unchanged from the
Superpowers spike, so the drawer still interleaves both):

```
stdout: Installing plugin "mattpocock-nosuch"...
stderr: ✘ Failed to install plugin "mattpocock-nosuch": Plugin "mattpocock-nosuch" not found in any configured marketplace
; exit 1
```

**New finding — the marketplace is not always there.** Under a fresh `$HOME`
(a Claude Code that has never run interactively), `claude plugin list --json`
is `[]` and the real install fails exactly like the bad name above:

```
Installing plugin "mattpocock-skills"...✘ Failed to install plugin "mattpocock-skills": Plugin "mattpocock-skills" not found in any configured marketplace
; exit 1
```

After `claude plugin marketplace add anthropics/claude-plugins-official` (a
clone over HTTPS, exit 0) the same install succeeds. On a machine where Claude
Code has been used, `claude plugin marketplace list` shows
`claude-plugins-official` (Source: GitHub `anthropics/claude-plugins-official`).
gavin does not run the `marketplace add` itself; when stderr says *not found in
any configured marketplace*, the row's detail names that command so the human
can.

### Detection

`claude plugin list --json`, cwd = the workspace root, exit 0, no TTY needed.
Key set across this machine's entries is now
`enabled, id, installPath, installedAt, lastUpdated, mcpServers, noteDetails,
notes, projectEnabled, projectPath, scope, version` — `projectEnabled` is new
since the Superpowers spike. The project-scope entry after the install:

```json
{
  "id": "mattpocock-skills@claude-plugins-official",
  "version": "1.2.3",
  "scope": "project",
  "enabled": true,
  "installPath": "…/.claude/plugins/cache/claude-plugins-official/mattpocock-skills/1.2.3",
  "installedAt": "2026-10-06T06:58:39.045Z",
  "lastUpdated": "2026-10-06T06:58:39.045Z",
  "projectPath": "…/scratchpad/p2",
  "projectEnabled": true
}
```

`enabled` is still answered relative to the cwd. Same fresh `$HOME`, same entry:
`enabled: true` from the project root `p2`, `enabled: false` from a sibling
`p3`, and `enabled: false` from the subdirectory `p2/sub` — so the detector
must run in the root itself, not anywhere under it. A user-scope install makes
every entry with that id read `enabled: true` from anywhere, which is the right
answer (it is active in a session started there).

`projectEnabled` is **not** the field to read: it tracks only the cwd's
project settings, and from `~` it reads `true` because `~/.claude/settings.json`
is both the user and the "project" file there. `enabled` is the answer.

Detector, unchanged in shape from Superpowers': **any entry whose package name
(before the `@`) is `mattpocock-skills` and whose `enabled` is `true`.**

"Active for a session started here" = that entry exists with `enabled: true`.
It only reaches sessions started after the install.

## 2–5. Codex, Gemini CLI, Cursor, opencode — skills CLI route

### Install

```
$ npx -y skills@latest add mattpocock/skills --skill '*' -a <agent id> -y
```

Agent ids: `codex`, `gemini-cli`, `cursor`, `opencode`. Captured on a fresh
`git init` directory with the agent-detection environment stripped (see the
`AI_AGENT` note below), stdin `/dev/null`:

- exit **0**
- `.agents/skills/<38 dirs>` and `<root>/skills-lock.json` written; nothing
  else in the root
- stdout is empty without `--json`; the whole human report (a clack UI with
  box drawing, spinners and ANSI escapes, ~14 KB) goes to **stderr**
- `--json` puts a machine-readable array on stdout and leaves stderr as the
  human report:

```json
[
  {
    "name": "ask-matt",
    "status": "installed",
    "source": "mattpocock/skills",
    "ref": null,
    "hash": "16554b78…",
    "path": "…/p-cursor/.agents/skills/ask-matt",
    "scope": "project",
    "agents": ["Cursor"],
    "mode": "copy",
    "security": { "gen": "safe", "socket": "0 alerts", "snyk": "low", "details": "https://skills.sh/mattpocock/skills" }
  },
  …
]
```

gavin does **not** pass `--json`: the drawer is for a human, and the
detector, not the installer's report, decides what happened.

`skills-lock.json` (project lock, `version: 1`):

```json
{
  "version": 1,
  "skills": {
    "ask-matt": {
      "source": "mattpocock/skills",
      "sourceType": "github",
      "skillPath": "skills/engineering/ask-matt/SKILL.md",
      "computedHash": "16554b78…"
    },
    …
  }
}
```

Re-running is idempotent: exit 0, every entry `installed` again.

**Failure, bad source** — exit 1; with `--json` stdout is
`[{"status":"failed","error":"Failed to clone repository\nAuthentication failed for https://github.com/mattpocock/no-such-skills-repo-xyz.git. …"}]`,
and without it the same text ends stderr:

```
└  Installation failed

Failed to clone repository
Authentication failed for https://github.com/mattpocock/no-such-skills-repo-xyz.git.
```

**Failure, partial** — one unknown name among `--skill tdd no-such-skill`:
exit **1**, `tdd` installed, the unknown one `skipped`. An exit code alone
cannot tell "nothing happened" from "almost everything did"; the detector can.

**Stripped PATH** (`env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin`, the
Finder-launched shape): `npx` is not found at all, and calling
`/opt/homebrew/bin/npx` by absolute path still fails with
`env: node: No such file or directory` because npx is a Node script. gavin
resolves `npx` through `program::resolve_or_name` like every other binary it
runs and surfaces "npx was not found on PATH" verbatim; it does not try to
find Node itself.

**`AI_AGENT` changes the output, not the result.** Run from inside a Claude
Code session the CLI prints `●  claude-code_2-1-291_agent  Agent detected —
installing non-interactively`; with the variable stripped it prints `Tip: use
the --yes (-y) and --global (-g) flags…`. Same files, same exit code. gavin's
own process may carry `AI_AGENT` when launched from a terminal agent session,
and it does not matter.

### The set is 38 skills, not 27

`--skill '*'` installs every skill in the repo: **38** — the plugin's
engineering + productivity skills plus `in-progress/` (`chief-of-staff`,
`claude-handoff`, `loop-me`, `setup-ts-deep-modules`, `writing-beats`,
`writing-fragments`, `writing-shape`, …) and `misc/`
(`git-guardrails-claude-code`, `migrate-to-shoehorn`, `scaffold-exercises`,
`setup-pre-commit`). The plugin bundle is the 27 listed in
`.claude-plugin/plugin.json` (upstream `1.3.1`; the marketplace's pinned
`1.2.3` lists 25). So `'*'` is a **superset** of the plugin route, not parity
with it. It does include `setup-matt-pocock-skills` either way. Upstream's own
README tells skills.sh users to pick skills and "make sure
`setup-matt-pocock-skills` is one of them".

### Detection

Read, no subprocess:

1. `<root>/skills-lock.json` parses, and
2. at least one entry under `skills` has `source: "mattpocock/skills"`, and
3. that entry's `<root>/.agents/skills/<name>/SKILL.md` is a file.

Both halves matter. The lock is a repo file and travels with a clone; the skill
directories may be gitignored and not. A clone with the lock and no
directories is *absent* — and the human's fix is `npx skills
experimental_install`, which restores from the lock. A `.agents/skills/` with
no lock entry is someone else's skills (gavin's own `gavin-*` skills live there
for Codex) and is not evidence.

`npx skills list --json` would answer the same question, but it is a network-
capable Node start on a tab render; the two file reads are the whole answer.

### What "active here" means, per agent

- **Gemini CLI** — verified: `gemini skills list` in the project lists
  `ask-matt [Enabled] … Location: <root>/.agents/skills/ask-matt/SKILL.md`. It
  also logs `Skill conflict detected: "tdd" from "<root>/.agents/…" is
  overriding the same skill from "~/.agents/skills/…"` where a global copy
  exists — the project copy wins.
- **opencode** — verified: `opencode debug skill` lists the project's
  `.agents/skills/chief-of-staff/SKILL.md`. For names that also exist under
  `~/.agents/skills/` it reported the **global** location; either way the skill
  is loaded in the session.
- **Cursor** — docs: cursor.com/docs/context/skills lists `.agents/skills/`
  and `.cursor/skills/` as project skill directories. **UNVERIFIED** in a
  running Cursor; verify by opening the probe root in Cursor's agent and
  asking it to list its skills.
- **Codex** — docs: developers.openai.com/codex/skills (verified 2026-09-11,
  recorded in `agent_setup.rs`) names `.agents/skills/` as the repo skill
  root. **UNVERIFIED** live — no `codex` on this machine; verify with a working
  `codex` in the probe root.

All four: only sessions started after the install see the skills.

## 6. `custom`

gavin does not know the agent, so it does not guess a `-a` id. The row shows
the skills.sh instructions (`npx skills@latest add mattpocock/skills`, pick
the agent) and the manual "I've installed it", which writes the machine-local
marker and reads back as *asserted*.

## The five caveats

1. **`--scope project -y` for `mattpocock-skills`** — **verified**, on this
   machine and under a fresh `$HOME` (after the marketplace was added). Output
   above. The fresh-`$HOME` marketplace gap is the new wrinkle.
2. **Global (`-g`) installs** — **verified**. The lock lands at
   `~/.agents/.skill-lock.json`, or `$XDG_STATE_HOME/skills/.skill-lock.json`
   when that is set (`getSkillLockPath` in the CLI). Format `version: 3`:

   ```json
   { "version": 3, "skills": { "tdd": { "source": "mattpocock/skills", "sourceType": "github",
     "sourceUrl": "https://github.com/mattpocock/skills.git", "skillPath": "skills/engineering/tdd/SKILL.md",
     "skillFolderHash": "bf1bf5ff…", "pluginName": "mattpocock-skills", "installedAt": "…", "updatedAt": "…" } },
     "dismissed": {} }
   ```

   Skills go to `~/.agents/skills/<name>/`. Nothing is written in the project,
   so the project detector cannot misread it — it reads `<root>/skills-lock.json`
   only. A global install *does* reach Gemini and opencode sessions (both read
   `~/.agents/skills/`, seen above), so such a user sees *absent* and uses
   "I've installed it". gavin never installs globally (R8).
3. **Windows symlinks / `--copy`** — not run on Windows; **settled by the CLI
   source** and the probe output. With exactly one agent the CLI chooses
   `copy` mode on its own (`uniqueDirs.size <= 1 → installMode = "copy"`), and
   every probe above reported `"mode": "copy"` with real directories, no
   symlinks. Where it does symlink it uses a `junction` on `win32` (no
   developer mode needed), and a failed symlink falls back to copying. `--copy`
   changes nothing gavin reads: same `skills-lock.json` entry keys
   (`computedHash, skillPath, source, sourceType`), same directories. gavin
   does not pass it. **UNVERIFIED on a Windows machine**; verify by running the
   command there and checking `.agents\skills\tdd` is a directory.
4. **Version skew** — **verified that it exists and that gavin need not care.**
   The marketplace cache holds `1.2.3` while upstream's `plugin.json` is
   `1.3.1`. `claude plugin list --json` carries `version` and `lastUpdated`;
   the detector ignores both, because any enabled version is "installed".
   Updating is the plugin's own auto-update (R8).
5. **Coexistence with gavin's own skills** — **verified**. A root pre-seeded
   with `.agents/skills/gavin/SKILL.md` and `.claude/skills/gavin/SKILL.md`
   kept both files byte-for-byte through a full install (codex and
   claude-code), and `skills-lock.json` listed only the 38 upstream skills — no
   `gavin` entry. The lock tracks the CLI's installs only, which is why the
   detector keys on `source`, not on directory contents.

## Consequences for `agent_skills.rs`

1. Two detectors: a subprocess for `claude-code` (unchanged mechanism), and two
   file reads for the four CLI-route profiles. `custom` is the marker only.
2. Five Install buttons, not one. The CLI route is non-interactive with `-y`
   and asks no trust question on the human's behalf.
3. The CLI's human report is on **stderr**; the drawer keeps interleaving both
   streams, and strips ANSI escapes so it reads.
4. An install's exit code is advisory. Exit 1 can mean "mostly installed";
   the row is whatever the detector says next.
5. Install timeout: the CLI clones the repo — the 180 s ceiling stands.
6. When Claude's stderr says *not found in any configured marketplace*, name
   `claude plugin marketplace add anthropics/claude-plugins-official` in the
   detail rather than leave the human to decode it.
