---
kind: task
title: The Codex base-URL rewriter puts its flag inside $'…' strings, heredoc bodies and function names
status: Done
priority: low
complexity: simple
---
Branch `feat/headroom` (headroom-03, a4bb26eb; unchanged at c1de88b8). Work in `.gavin-worktrees/feat-headroom`.

## The defect

`with_codex_base_url` (`crates/daemon/src/headroom/compress.rs:471`) inserts ` -c 'openai_base_url="…"'` after every word that `command_words` (`compress.rs:506-580`) reads as a command naming `codex`. The doc comment (`compress.rs:503-505`) promises that a construct the scanner cannot read "costs it a command word it does not see, and a line whose Codex it does not see is left alone". Three constructs instead produce a FALSE command word, and the flag lands in text or in syntax:

1. **`$'…'` (ANSI-C quoting).** `compress.rs:556-559` treats `$'` as a plain `'`, so the `\'` inside it ends the quote early.
   - `codex exec $'it\'s done; codex is fine'` becomes `… $'it\'s done; codex -c 'openai_base_url="…"' is fine'`.
   - Run under `/bin/sh -c` with a fake `codex`: the prompt codex receives is `it's done; codex -c openai_base_url=http://127.0.0.1:…/p/<id>/v1 is fine`.
2. **Heredoc bodies.** The newline arm (`compress.rs:566-569`) starts a new command inside a heredoc.
   - `cat > notes.txt <<EOF\ncodex = true\nEOF\ncodex exec x` writes `codex -c 'openai_base_url="…"' = true` into `notes.txt`.
3. **Function definitions.** `codex() { command codex "$@"; }; codex exec x` becomes `codex -c '…'() { … }`, a shell syntax error. The session fails to start, where the uncompressed line ran.

All three were reproduced by running the scanner's exact functions on these lines. The app never composes such lines. They reach the rewriter from MCP spawns whose first word is `codex` (`Launch::Command`), from a hand-written `[agent] command`, and from a `[worktree] setup` chained ahead of the agent.

A milder relative, not required here: a `codex` behind `time`, `env`, `nohup`, `exec`, `then`, `{` or `!` is not seen. In `codex exec a && time codex exec b` only the first is routed, yet the session is marked compressed, contrary to "every Codex in the line" (`compress.rs:463-467`).

## What to do

Make the scanner refuse what it cannot read, rather than guess: return `None` from `with_codex_base_url` (so the decision is `NoRecipe`, which is honest) when the line contains `$'`, a `<<` heredoc operator outside quotes, or a command word immediately followed by `(`. If you handle the reserved and prefix words (`time`, `env`, `nohup`, `exec`, `then`, `{`, `!`), handle them the same way: either see through them or refuse the line. Never mark a partly routed line compressed.

Update the doc comment at `compress.rs:495-505` to say what the scanner now refuses. Add one test per construct above next to the existing `with_codex_base_url` tests, asserting `None`, and keep every existing case green.

Run `cargo test -p gavin-daemon --bin gavin-daemon headroom::compress`.
