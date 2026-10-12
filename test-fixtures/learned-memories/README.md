# Learned memories, as written and as read back

`cases.json` is one table read by two suites:

- `app/src/lib/cards/memoryCard.test.ts` — `memoryBullet` and `parseLearned`,
  which write an adopted memory into the `### Learned` section and read it back;
- `crates/daemon/src/memory_index.rs` — `parse_learned`, which rebuilds the
  vector index from that same section.

The app writes the section and the daemon reads it, in two languages. A memory
the daemon reads differently from how the app wrote it is one the search tool
returns with the wrong topics, or never returns at all. A case added here is
asserted on both sides.

`parse` cases are a `section` (the text from the `### Learned` heading to the
end of the block) and the `memories` it holds, each a `fact`, its `topics` and
its `why` (null when it has none). `bullet` cases are a card `body` and its
`topics` frontmatter value, and either the `bullet` Adopt writes or the `refuse`
reason it names instead; the TS suite checks every written bullet parses back to
the same memory.
