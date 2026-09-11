---
title: [fix] Source-grep tests fail on a CRLF checkout
status: To Do
priority: medium
complexity: simple
---
On this Windows machine `git config core.autocrlf` is `true`, so every
tracked file is CRLF on disk. Ten tests in `app/` read source files raw
(`import.meta.glob(..., { query: "?raw" })`) and assert with expected
strings that hardcode a bare `\n`, or slice a function body with
`indexOf("\n...")`. They fail on this checkout and pass on an LF one.
Found 2026-09-10 while verifying
[fix-resume-unwritten-conversation](./done/fix-resume-unwritten-conversation.md);
the same ten fail at HEAD (607c560) in a detached worktree, so they are
the checkout's, not any card's in flight.

```
autoCommitSurfaces.test.ts    > re-reads before it splices, so it cannot undo an agent's edit
cardTabSurfaces.test.ts       > stops being dismissable by Escape or a click outside once inline
complexitySurfaces.test.ts    > keeps unrated reachable rather than making the agent guess
complexitySurfaces.test.ts    > proposes the level before writing it, like the kind
orchestrationClearDone.test.ts> only archives in archive mode, and only cards the board calls Done
orchestrationGavinTool.test.ts> asks the tick to run again once the step is resolved
orchestrationGavinTool.test.ts> files the step done before arming the target rail
orchestrationGavinTool.test.ts> starts nothing on a verdict that is not a start
reviewSurfaces.test.ts        > reopens the conversation when the profile can
toolLibraryLayout.test.ts     > lets its text controls shrink with the form
```

The rest of the suite (5229 tests) is green on the same checkout, so the
source-grep tests are the only thing the line ending reaches.

## It reaches the Rust crate too, and it ships (found 2026-09-11)

Re-confirmed on 2026-09-11 from
[feat-windows-port-on-a-windows-machine](./feat-windows-port-on-a-windows-machine.md):
the same ten, unchanged. But `cd app && npm test` is not the only suite
this costs, and the second one **decides between the two options below**.

`cargo test -p app` fails `agent_setup::tests::{an_opencode_root_gets_its_skills_agent_file_and_mcp_entry,
the_opencode_agent_file_carries_the_git_only_grant}` with
`must open with frontmatter`. That was read as a path-separator problem
on the windows-port card; it is not. The cause:

```
app/src-tauri/src/opencode_commit_agent.md: 23 of 23 lines CRLF
app/src-tauri/src/gavin_skill.md:          134 of 134 lines CRLF
head -c 12 opencode_commit_agent.md  ->  -   -   -  \r  \n   d   e   s   c
```

These are `include_str!`'d (agent_setup.rs:791, 626…), so the bytes
`core.autocrlf` put on disk are compiled into the binary verbatim and
written straight back out. The test asserts `starts_with("---\n")` and
gets `---\r\n`. Note the `.rs` files themselves are LF here, so this is
not the Rust string literals — it is the **markdown they embed**.

Two consequences:

- **Option 1 cannot fix these.** Normalising inside each `source()`
  helper reaches the ten TS tests and nothing else; `include_str!`
  happens at compile time, in another crate, with no helper in the path.
  Only a `.gitattributes` pinning `eol=lf` fixes both suites at once.
- **This is not test-only.** The skills and agent files gavin writes into
  a user's repo carry whatever line endings the BUILD machine's checkout
  had — a Windows build ships CRLF skills, a mac build ships LF ones.
  The embedded content of a release should not depend on the builder's
  `core.autocrlf`, which is an argument for pinning it in the repo rather
  than in the tests regardless of what the suites want.

## Fix

- [ ] Decide where the normalisation belongs. Either every `source()`
      helper in the test files does `.replace(/\r\n/g, "\n")` once
      (the tests are the thing that assumes LF, so they own the
      assumption), or the repo pins LF on checkout with a
      `.gitattributes` (`* text=auto eol=lf`) so no tool on any OS sees
      CRLF. The second also protects the Rust string literals and the
      skill markdown that `complexitySurfaces` reads; the first is a
      smaller change and does not touch every developer's checkout.
- [ ] Apply it and run `cd app && npm test` on a CRLF checkout: the ten
      above pass, nothing else changes.
- [ ] Tick the app checks line on
      [the windows port card](./feat-windows-port-on-a-windows-machine.md)
      only after this lands; before it, `npm test` cannot be green there.
