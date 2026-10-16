---
kind: task
title: "[sec-hunt] Finish the blocked audit unit: whether cmd.exe re-parses a POSIX-quoted launch line on the Windows .cmd shim path"
status: To Do
priority: low
complexity: moderate
labels: security, ready-for-human, windows
---
Finish a coverage unit the 2026-10-15 security audit (run-1) could not close. Its decisive check needs a Windows host with Git for Windows, which the audit did not have, and its hunter was cut short before writing a candidate. This card is the rest of that hunt: a source half any agent can do, then one run on Windows by the owner. Coverage id: `crates%2Fdaemon%2Fsrc%2Fshell.rs%23rewrite_for_windows_shim::crates%2Fdaemon%2Fsrc%2Fshell.rs%23command_with_windows_shim::crates%2Fdaemon%20%28Windows%20PTY%20spawn%29::ATTACK-CLASSES.md%23Injection`.

Full record: the unit's entry in `coverage-ledger.json` and REPORT.md §6 in `~/security-audit-skill/gavin/run-1/`, outside this repo. The audit card is `review-security-audit-2026-10-15.md`.

## The unit

On Windows, the daemon passes every command session's line (an agent command plus a POSIX-quoted card prompt, tool bodies, `[worktree] setup` chains) through `shell::rewrite_for_windows_shim` before `sh -c`. When the leading word resolves on `PATH` only to a `.cmd` or `.bat`, with no extensionless sibling and no bundled node pair, the line becomes `<word>.cmd <rest>`, and MSYS `sh` hands the POSIX-quoted arguments to `cmd.exe` through the shim's `%*`. POSIX single quotes are the only control, and `cmd.exe` does not honour them. The boundary is repository-controlled text that gavin quotes into a launch line against `cmd.exe`'s parser: could a quoted argument run as a host command, outside the agent CLI's own permission prompts?

## Open questions

1. When Git for Windows' MSYS runtime spawns a `.cmd`/`.bat`, how does it build the Windows command line from argv, and can a single POSIX-quoted argument holding `"`, `&`, `|`, `%` or `^` escape its quoting once `cmd.exe` parses it?
2. Does any shipped agent profile, on a stock Windows install, resolve to a `.cmd` with no extensionless sibling and no bundled node pair? Cursor Agent is the case named in source, and its node-pair branch avoids the re-parse.
3. Which repository-controlled text can sit on the first line of the launch line (`cmd.exe` truncates at a newline): a direct-prompt card's body, a card's `model:`/`effort:`, anything else?

## What is already known

- `crates/daemon/src/pty.rs:163` (PtySession::spawn_with_env): every command line goes through `rewrite_for_windows_shim`, then `sh -c`.
- `crates/daemon/src/shell.rs:364-379` (command_with_windows_shim): the `.cmd`/`.bat` arm; with no node pair it returns `{word}{ext}<rest>` (378) with no escaping for `cmd.exe`. The node-pair rewrite runs `node.exe` directly and does not re-parse. The doc comment (shell.rs:228-266) says `cmd.exe` splits a bare `&` and truncates an argument at the first newline.
- Standard card prompts start with a fixed gavin line, so with the newline truncation their card text may never reach the parser. A direct-prompt task (`isDirectPrompt`, `app/src/lib/cards/cardRunActions.ts:721`) sends the card body verbatim, so card text can be the first line.
- A card's `model:` and `effort:` reach the first line unvalidated and POSIX-quoted only (`app/src/lib/cards/cardAgent.ts:59`, `app/src/lib/agents/agentModel.ts:52`, `:67`, `:124`), and are not in the review digest (`sec-hardening-review-digest-launch-frontmatter.md`).
- The first-run review shows the composed prompt before launch when `requireReview` is on (the default). With it off, nothing is shown.
- Two hardening cards already narrow this whatever the answer: `sec-hardening-windows-cmd-shim-refuse-specials.md` refuses the `.cmd` fallback for lines holding `cmd.exe` metacharacters, and `sec-hardening-review-digest-launch-frontmatter.md` puts the frontmatter fields under review. Check whether either has landed before you start; if the refusal is in, the Windows run below should show the refusal.

## Method

Source half (any machine): answer question 1 from the MSYS2 runtime's spawn and argument-quoting code for the Git for Windows version gavin documents, question 2 from the agent profiles (`app/src/lib/core/settings.ts`, `app/src-tauri/src/agent_setup.rs`) and each CLI's published Windows install layout, and question 3 by tracing every builder of the launch line to its first newline. Use the pure `command_with_windows_shim` tests in `shell.rs` for anything that can be shown without Windows. Write the findings under a dated "## Comments" heading.

Windows half (the owner): one run on a Windows machine with Git for Windows, against a throwaway workspace and a fake CLI, never a real agent. Nothing in this card should be run against the live daemon.

## Outcome

For each root cause confirmed, by the source half or by the Windows run, file a `sec-fix-<slug>.md` card in the shape of the confirmed audit cards, with a failing regression test named in its Fix. If the re-parse cannot escape, or no shipped profile reaches the `.cmd` branch, close with that evidence under ## Comments.

## Done when

- Questions 1 to 3 each have an answer under ## Comments, with the source lines or test that show it.
- Once the source half is done, file the Windows check with `gavin_request_human(<this card>, "test", …)` using exactly this text: "On a Windows machine with Git for Windows, put a file fake-agent.cmd containing `@echo %*` alone on PATH, set a custom agent profile's command to fake-agent, run a direct-prompt card in a throwaway workspace whose whole body is the single line `x" & echo reparsed> "%TEMP%\gavin-reparse.txt" & rem "`, and confirm that %TEMP%\gavin-reparse.txt does not exist afterwards and the session either echoed the line whole or refused to launch."
- Every confirmed root cause has its own `sec-fix-*` card, linked from the Comments, or the card is closed with the evidence.
