---
status: Done
kind: task
title: "[sec-hardening] The Windows .cmd/.bat rewrite hands POSIX-quoted arguments to cmd.exe even when they hold characters cmd.exe acts on"
parent: sec-hardening-2026-10-15.md
priority: low
complexity: moderate
labels: security, ready-for-agent, windows
---
Part of `sec-hardening-2026-10-15.md`. A hardening note from the 2026-10-15 security audit (run-1), not a finding. Full record: entry 178 of `results/hardening-all.json` in `~/security-audit-skill/gavin/run-1/`, outside this repo. Whether the re-parse is exploitable today is the open question of `sec-hunt-windows-cmd-reparse.md`; this card makes the answer not matter.

## What

On Windows, every command session's line goes through `shell::rewrite_for_windows_shim` before `sh -c`. When the leading word resolves on `PATH` only to a `.cmd` or `.bat`, with no extensionless sibling and no bundled node pair, `command_with_windows_shim` returns `<word>.cmd <rest of the line>`. MSYS `sh` then starts the shim, and the shim forwards its arguments to `cmd.exe` through `%*`. Everything after the leading word was quoted for POSIX `sh` (the prompt by `shellQuote`, a model by `quoteModel`), and `cmd.exe` does not honour POSIX quoting. The file's own comments say `cmd.exe` "splits a bare `&` and runs the tail" and truncates an argument at a newline.

## Why

The text after the leading word is often repository-written: a card body (verbatim for a direct-prompt task), a card's `model:`, a tool body. POSIX single quotes are the only thing keeping it one inert argument, and on this branch they are not a control at all. Refusing the rewrite when the arguments hold any character `cmd.exe` acts on keeps the line safe without having to prove how MSYS builds the Windows command line. It costs little: a multiline prompt already arrives truncated on this path, so the launches it refuses are ones that were already broken.

## Where (lines as of 2026-10-16; re-read before editing)

- `crates/daemon/src/pty.rs:163` (PtySession::spawn_with_env, Windows arm): `let c = crate::shell::rewrite_for_windows_shim(c, &resolve_against);` then `sh -c c`.
- `crates/daemon/src/shell.rs:228-266`: the doc comment describing the `.cmd` re-parse and the newline truncation.
- `crates/daemon/src/shell.rs:267` (rewrite_for_windows_shim): returns `String`.
- `crates/daemon/src/shell.rs:330` (command_with_windows_shim): the pure half.
- `crates/daemon/src/shell.rs:364-379`: the `.cmd`/`.bat` arm; the node-pair rewrite (366-376) runs `node.exe` directly and is not affected; the fallback at 378 is the re-parse.
- `crates/daemon/src/shell.rs:713-752`: the existing tests for the `.cmd` shapes (`agent 'do the thing'`, `cursor-agent.cmd --version`).

## Change

In the `.cmd`/`.bat` arm, when no node pair is found, look at `&command[word_end..]`. If it holds any of `& | < > ^ % ! " ( )`, a newline or a carriage return, do not rewrite. Return a refusal instead: change `command_with_windows_shim` and `rewrite_for_windows_shim` to return `Result<String, String>`, and have `spawn_with_env` fail the spawn with the message, so the session reports why it did not start rather than running a truncated or re-parsed line. Suggested words: "<word> is installed only as a .cmd shim, which passes its arguments through cmd.exe; gavin will not hand it this launch line. Install it so that <word>.exe or an extensionless <word> is on PATH." Every other arm is unchanged, and a line with none of those characters (`cursor-agent.cmd --version`) still rewrites.

## Test

In `shell.rs`'s tests, which are pure and run on every OS: with `files = ["/tools/agent.cmd"]` and no node pair, `agent 'a & b'`, `agent 'line1\nline2'`, `agent '100%'` and `agent --model 'x"y'` are refused; `agent 'do the thing'` still becomes `agent.cmd 'do the thing'`; with a node pair present, `agent 'a & b'` still rewrites to the node pair. The existing `.cmd` tests keep passing, adjusted only for the `Result`.

## Done when

- The `.cmd`/`.bat` fallback is never taken for a line whose arguments hold a character `cmd.exe` acts on, and the launch fails with a message naming the shim.
- The tests above exist, and the refusal cases fail before the change.
- The checks in CLAUDE.md pass for every part you touched, including the Windows CI job, and you commit only your own files.
