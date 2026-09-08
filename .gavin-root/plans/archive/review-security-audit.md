---
order: 6144
title: [review] security audit
status: Done
complexity: intricate
---
Do a full security audit, especially of the rust daemon. Can it be accessed by other processes? How is the communication between the tauri app and the daemon protected? If I would like to create an interface between the tauri app and the daemon (for remote proxy mediated integration of mobile app) what would the best secure approach be? Write an md report.

## What this audit assumes

Three adversaries, in this order. Nothing else is in scope — in particular, someone
with physical access to an unlocked machine is not.

1. **A same-user process** — a rogue npm postinstall, a malicious dependency,
   anything already running as you.
2. **An agent gavin runs** — a prompt-injected coding agent holding `gavin_*` MCP
   access, and a cloned repo whose `.gavin*/plans/*.md` bodies become agent prompts
   verbatim.
3. **Future remote exposure** — what changes the moment the daemon is reachable off
   the machine.

## Rules every pass follows

- **Never touch the running daemon.** No `pkill`, no restart. Every reproduction
  runs against an isolated daemon under a temp `$HOME`, which gets its own socket
  and databases.
- **A reproduction, or an admission.** Every high-severity finding either carries
  the steps that demonstrate it, or says in one line that it is argued from
  reading and not reproduced.
- **Describe, do not weaponise.** Impact and a minimal repro; no polished exploit,
  no extraction tooling.
- **Separate a vulnerability from a boundary.** "Any process running as you can do
  X" is the design until the threat model says otherwise — say which it is, every
  time.

## Checklist

- [x] Write `docs/security/00-threat-model.md`: the three adversaries above, each
      surface named against them, and an explicit accepted-by-design list. Every
      pass cites it, so it lands before any pass starts.
- [x] Daemon & protocol pass (`sec-daemon-protocol.md`) → `docs/security/01-daemon-protocol.md`
- [x] Tauri host & frontend pass (`sec-app-surface.md`) → `docs/security/02-app-surface.md`
- [x] Agent & workspace-content pass (`sec-agent-surface.md`) → `docs/security/03-agent-surface.md`
- [x] Dependency & build pass (`sec-supply-chain.md`) → `docs/security/04-supply-chain.md`
- [x] Remote-access design proposal (`sec-remote-access.md`) → `docs/security/05-remote-access.md`
- [x] Write `docs/security/README.md` — the report: every finding deduped across
      the five passes, ranked by severity, each stating whether it was reproduced.
      One root cause is one entry, however many surfaces saw it.
- [x] File one To Do card per fix worth doing, after the dedupe: severity, the fix,
      and a link to the finding. Nothing on the accepted-by-design list becomes a
      card.

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->
