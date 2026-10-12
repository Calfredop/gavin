---
order: 4096
kind: task
title: Daemon embed index and gavin_search_memories
parent: feat-vectorized-memory.md
complexity: complex
---
Add local embedding retrieval for adopted memories. Stack is locked: BGE-small
via fastembed (BGESmallENV15Q), per-root SQLite vectors in the daemon state
dir, model cache under Gavin's data dir, lazy download on first embed.

Do:
- Daemon module: embed passages/queries (BGE query prefix on queries only),
  upsert/delete by stable memory id (hash of fact text or Learned bullet key),
  search by cosine with optional topics filter + limit; rebuild from a parsed
  `### Learned` section when the instructions file drift-checks fail.
- Protocol request/response for search (and any upsert/reindex the app/daemon
  need internally); bump PROTOCOL_VERSION / min_version_for as required; MCP
  exposes `gavin_search_memories(query, topics?, limit?)` — empty corpus →
  empty list, not a hard error; missing model → clear error.
- Tests: embed+rank a tiny fixture corpus; topics filter; rebuild-from-Learned
  matches hand-built bullets from the convention grammar; no network in tests
  (vendored/fixture ONNX or test seam).
- Out of scope: auto-inject into prompts; machine-memory pressure; TypeSafe
  by-meaning; changing Adopt UX beyond calling upsert (parent checklist wires
  the app call).

Done when protocol/daemon/mcp tests covering search + reindex are green.
