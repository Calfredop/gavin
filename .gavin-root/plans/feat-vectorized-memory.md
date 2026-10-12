---
complexity: complex
order: 13312
kind: plan
title: [feat] vectorized memory
status: In Progress
---
<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->

Semantic retrieval over **adopted** workspace memories. Note cards + Adopt stay;
`### Learned` stays the durable store; a local vector index is derived from it.
Agents retrieve via one MCP tool — no auto-injection into prompts, no change to
machine-memory pressure or TypeSafe by-meaning search.

Locked stack: `BAAI/bge-small-en-v1.5` (quantized ONNX via `fastembed` /
`BGESmallENV15Q`) in the daemon; 384-d vectors in per-workspace SQLite under
the daemon state dir (not committed); model weights cached under Gavin's data
dir, downloaded lazily on first embed. Queries use BGE's retrieval prefix;
passages (Learned bullets) do not. Corpus is tiny — brute-force cosine is enough.

Convention (settled):
- Memory card: `kind: note`, `labels: memory`, optional `topics:` frontmatter,
  body = one fact line + optional `Why:` line only.
- Adopt refuses empty, multi-fact, or overlong fact bodies (and explains why).
- Learned bullet keeps topics in the durable text, e.g.
  `- Fact text. (topics: daemon, pty)` then indented `Why:` lines — so reindex
  from the instructions file stays complete.

Init (settled):
- Setup wizard + Home resume gain a **Memory** step: ensure BGE weights are
  cached and the per-root index matches `### Learned` (empty Learned → empty
  ready index). Skip allowed (“not now”), same spirit as Superpowers.
- Opening an existing workspace/worktree with Learned content **backfills**
  automatically (same ensure path); a fresh open with no Learned still gets
  the wizard step for first download.

- [x] Nested task: memory convention (shape, topics, Adopt gate, Learned encoding)
- [x] Nested task: daemon embed index + `gavin_search_memories`
- [x] Nested task: memory init phase (wizard/Home + open backfill)
- [x] Wire Adopt → index upsert after a successful Learned write (app calls daemon;
      failure surfaces; card still adopted into Learned — index heals on next search)
- [x] Heal drift: on search, if Learned hash/mtime disagrees with the index, rebuild
      from `### Learned` before querying (no agent reindex tool)
- [x] Update the gavin skill "Proposing a memory" paragraph for topics + one-fact rule
- [x] Checks: daemon/protocol/mcp tests for index + tool; `memoryCard` unit tests;
      `cargo test` for touched crates; `cd app && npm test` for touched suites
- [ ] Human test: Adopt a tagged memory note, then from an agent session call gavin_search_memories with a paraphrase and a topic filter — expect that fact ranked; edit Learned by hand and search again — index matches the file
