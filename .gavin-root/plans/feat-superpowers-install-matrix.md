---
order: 1024
kind: task
title: [spike] Superpowers install + detection matrix
parent: feat-superpowers-integration.md
---
For each of gavin's five agent profiles, establish exactly how the
Superpowers plugin is installed and how gavin can tell whether it is --
without guessing.

Read https://github.com/obra/superpowers and each harness's own
plugin/extension docs. For every profile in `AGENT_PROFILES`
(`app/src-tauri/src/agent_setup.rs`) record:

- the install command, or that there is none gavin can run (Cursor and
  Kimi are in-TUI slash commands, so the app cannot drive them),
- the scope flag, if the harness has scopes at all,
- the detection command and its exact output shape,
- the on-disk evidence a detector can read when no command exists.

Verify what you can on this machine and capture the raw output. Claude
Code is the verified baseline: `claude plugin list --json` returns a JSON
array whose entries carry `id`, `scope`, `enabled` and `installPath`;
`superpowers@claude-plugins-official` 6.3.0 is installed at user scope,
and `~/.claude/settings.json` holds
`enabledPlugins["superpowers@claude-plugins-official"] = true` (project
scope writes the same key into `<root>/.claude/settings.json`, local
scope into `settings.local.json`).

Mark anything you could not run as UNVERIFIED and say what would verify
it. A guessed detector lights a green LED that is a lie, which is worse
than a row that admits it does not know.

Deliverable:
`docs/superpowers/specs/2026-09-01-superpowers-install-matrix.md` -- one
table row per profile, then a short section each with the captured
output. Write no app code; this card ends at the document.
