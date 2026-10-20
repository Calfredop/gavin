---
kind: task
title: [spike] Matt Pocock skills install + detection matrix
parent: feat-replace-superpower.md
complexity: moderate
---
For each of gavin's six known agent profiles, establish exactly how Matt Pocock's skills are installed and how gavin can tell whether they are — without guessing. This spike replaces the Superpowers matrix; its findings finalize the matrix in the parent plan before any implementation step runs.

Prior research (2026-10-05, verified on this machine with Claude Code 2.1.289 and skills CLI 1.7.0) is the brief — confirm it, don't redo it from scratch:

- Claude Code plugin route: `claude plugin install mattpocock-skills --scope project -y`. The plugin is in the official pre-configured marketplace (`claude-plugins-official`), nothing to `marketplace add` first. Detection: `claude plugin list --json` run in the workspace root, entry id `mattpocock-skills@claude-plugins-official`, fields `scope` / `enabled` / `installPath` — the same shape gavin already parses for Superpowers. Verified at user scope; verify `--scope project` for this plugin specifically.
- CLI route (vercel-labs/skills, `npx skills@latest add mattpocock/skills`): fully non-interactive — `--skill <names...>` (`'*'` = all), `--agent <agents...>`, `-y/--yes`, `--all`, `--copy`, `-g/--global`, `--json`. Agent ids: `claude-code`, `codex`, `cursor`, `gemini-cli`, `opencode`, `kimi-code-cli`. At project scope every agent except Claude Code reads `.agents/skills/` (Claude gets `.claude/skills/<name>` symlinks into it); the CLI writes `skills-lock.json` (format `version: 1`, per-skill `source: "mattpocock/skills"` + `computedHash`) at the project root.

For every profile in `AGENT_PROFILES` (`app/src-tauri/src/agent_setup.rs`) record:

- the exact install command gavin would run, its scope flags, and captured raw output (success AND failure — a Finder-launched app's stripped PATH is the first thing that will bite),
- the detection strategy and its exact evidence: command output shape or on-disk files (`skills-lock.json` contents, skill dir presence per profile),
- what "active for a session started in this workspace on this machine" means for that route.

Then settle the open caveats, each verified or marked UNVERIFIED with the step that would verify it:

1. `--scope project -y` on `claude plugin install` for `mattpocock-skills` specifically (prior research verified the mechanism at user scope only).
2. Global-scope (`-g`) CLI install: where the global lock file actually lands (`~/.agents/.skill-lock.json`? `$XDG_STATE_HOME`?) and its format — README and `skill-lock.ts` describe a `version: 3` shape with `skillFolderHash`, unlike the project lock's `version: 1`. Gavin installs at project scope only, but detection must not misread a global install.
3. Windows: does the default symlink mode work without developer mode, or must gavin pass `--copy`? Check what `--copy` changes in `skills-lock.json` and on disk.
4. Version skew: the official marketplace listing pins a sha, so installed plugin versions can lag the repo — confirm `claude plugin list --json` exposes enough (`version`, `lastUpdated`) that gavin need not care.
5. Whether `skills-lock.json` entries and `.agents/skills/` coexist cleanly with gavin's own workspace skills (gavin writes its own skill files into workspaces; the lock file only tracks the CLI's installs).

Mark anything you could not run as UNVERIFIED. A guessed detector lights a green LED that is a lie, which is worse than a row that admits it does not know.

Deliverable: `docs/superpowers/specs/2026-10-05-mattpocock-skills-install-matrix.md` — one table row per profile, then a short section each with the captured output, then the five caveats settled. Write no app code; this card ends at the document.
