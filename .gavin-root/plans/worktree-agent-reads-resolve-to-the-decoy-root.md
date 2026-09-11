---
order: 6144
title: A worktree agent's gavin_* reads answer about the decoy .gavin-root, so every board read fails
status: To Do
priority: high
---
The read half of
[fix-worktree-agent-card-writes-forbidden.md](./done/fix-worktree-agent-card-writes-forbidden.md),
which fixed the writes. This one is older and still live.

`gavin-mcp`'s `find_gavin_root` (`crates/gavin-mcp/src/main.rs:180`) walks up
from its own cwd. `.gavin-root/` is tracked in git, so a rail's worktree
carries a second copy of it — the same decoy `cardHomeNote` warns agents about
— and every root-scoped tool resolves to that copy instead of the workspace.
No watcher owns it, so the daemon answers `workspace not open in gavin`.

Measured from the agent transcripts: **132 failures since 2026-08-21**, still
happening, every one of them from a worktree cwd. `gavin_get_board` takes 126
of them, `gavin_get_orchestration` 6. A rail agent therefore cannot read the
board it is being judged against, and a relative card path it passes resolves
against the decoy rather than the real card.

## Shape of the fix

The daemon already knows the answer: a session's `workspace_path` now names
the workspace it belongs to (the write-half card), and `resolve_hello` has the
record in hand when it mints the `agent` identity. So `HelloAck` can carry that
root, and `gavin-mcp` prefers it over walking up from cwd.

- [ ] `Response::HelloAck` gains the session's workspace root
- [ ] `gavin-mcp` prefers it, falling back to `find_gavin_root` when it is absent — an older daemon sends nothing, and that has to keep working
- [ ] `resolve_against_root` then resolves a relative card path against the real workspace, not the decoy
- [ ] A test with a worktree cwd whose own `.gavin-root` exists, proving the read goes to the workspace

A response gaining a field is invisible to `min_version_for`, which gates
request TYPES — that is safe here only because an absent field has a defined
meaning (fall back to the walk). It must not become a field the tool needs.
