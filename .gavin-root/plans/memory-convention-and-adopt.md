---
order: 2048
kind: task
title: Memory convention and Adopt gate
parent: feat-vectorized-memory.md
complexity: moderate
---
Tighten proposed-memory cards and Adopt so facts are one clean unit the vector
index can trust. Read `app/src/lib/cards/memoryCard.ts`, its tests,
`CardDetailModal.svelte` (Adopt), and the gavin skill "Proposing a memory".

Do:
- Support optional `topics:` frontmatter (comma-separated); keep board `labels:
  memory` as the memory marker — topics are not board labels.
- Enforce one fact line + optional `Why:` only; Adopt (and adoptBlockedReason /
  equivalent) refuse empty, multi-fact, or overlong facts with a clear sentence.
- Encode topics into the Learned bullet on Adopt, e.g.
  `- Fact. (topics: a, b)` plus indented Why lines; parse them back for tests
  and for the daemon reindex path's contract (document the exact grammar in
  the module header; keep `### Learned` / marker-block rules intact).
- Unit-test bullet build, refuse paths, topics round-trip, and appendLearned
  still idempotent.
- Do not add the vector index or MCP tool here.

Done when memoryCard tests are green and Adopt copy names the new refusals.
