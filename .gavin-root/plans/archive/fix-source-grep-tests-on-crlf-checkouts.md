---
order: 8192
title: [fix] Source-grep tests fail on a CRLF checkout
labels: windows
status: Done
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

- [x] Decide where the normalisation belongs. Either every `source()`
      helper in the test files does `.replace(/\r\n/g, "\n")` once
      (the tests are the thing that assumes LF, so they own the
      assumption), or the repo pins LF on checkout with a
      `.gitattributes` (`* text=auto eol=lf`) so no tool on any OS sees
      CRLF. The second also protects the Rust string literals and the
      skill markdown that `complexitySurfaces` reads; the first is a
      smaller change and does not touch every developer's checkout.
      **Decided: `.gitattributes`**, 2026-09-22 — the section above
      leaves no real choice, since only the repo pin reaches the
      `include_str!`'d markdown. The tests are left as they are: they
      assume LF, and LF is now what every checkout has.
- [x] Apply it and run `cd app && npm test` on a CRLF checkout: the ten
      above pass, nothing else changes.
      Done 2026-09-22 in the `gavin-win-crlf-and-app-crate` worktree —
      the before/after runs are in the section below. Nine of the ten
      went green; the tenth (`orchestrationClearDone`) was already green
      at this baseline, so there was nothing left of it to fix.
- [ ] Tick the app checks line on
      [the windows port card](./feat-windows-port-on-a-windows-machine.md)
      only after this lands; before it, `npm test` cannot be green there.
      **Left open on purpose**: "lands" means merged to `main`, and the
      merge is the human's. Once it is in, the root checkout and every
      worktree cut before it still need the one-time refresh below
      before `npm test` can be green there — and that line then reads
      12 red for reasons that are not this card's (below).

## Applied, 2026-09-22

**One new file.** The index was already LF in every text file
(`git ls-files --eol`: 1257 `i/lf`, 56 `i/-text`, 9 empty), so
`* text=auto eol=lf` renormalises nothing — the commit adds
`.gitattributes` and rewrites no tracked file. The orchestration note
that worried this route "renormalises every CRLF file in the repo" and
would conflict with the seven live branches does not apply: CRLF only
ever existed on disk, put there by `core.autocrlf=true` at checkout,
never in a blob. Explicit `binary` lines cover `png`/`ico`/`icns` and
the daemon's `.raw` PTY capture, which must stay byte-exact.

**The pin changes nothing on disk by itself.** A checkout made before
it keeps CRLF, and `git status` stays clean because the index's stat
cache still matches. Refreshing means re-checking out the CLEAN files —
`checkout-index` skips a file whose stat matches, so delete first, and
`-u` writes the new stat back so the refresh does not show up as the
phantom modification `git-status-crlf-phantom-modifications` describes.
The recipe is in CLAUDE.md (Traps); this worktree's 1256 files were
refreshed with it, leaving `git status` exactly as it was.

**`cd app && npm test`, same worktree, before and after the refresh:**

```
before  21 failed / 5730 passed, 13 files red   (the main baseline)
after   12 failed / 5739 passed,  8 files red
```

Gone, and nothing newly red: the nine of the ten that were still
failing — `autoCommitSurfaces` ×1, `cardTabSurfaces` ×1,
`complexitySurfaces` ×2, `orchestrationGavinTool` ×3, `reviewSurfaces`
×1, `toolLibraryLayout` ×1. The 12 that remain are the baseline
everyone has on `main`, and none is about line endings:
`workspaceToolsActions` ×8 (a `layoutState` mock with no `workspaces`),
`bestOfNActions` / `codeReviewActions` / `criticalReviewActions` (a
`vi.mock` missing `agentDefaultsStore`), and one source-grep drift each
in `commandGate`, `orchestrationGavinTool`, `toolPlatformGate` and
`indicatorSurfaces`.

**`cargo test -p app agent_setup`:** `must open with frontmatter` is
gone — `the_opencode_agent_file_carries_the_git_only_grant` passes and
`opencode_commit_agent.md` now compiles in as `---\n`. 61 pass, 4 fail,
and the four are the `\` vs `/` skill-path assertions that
[fix-app-crate-windows-path-shape-failures](./fix-app-crate-windows-path-shape-failures.md)
owns: `a_{cursor,gemini,codex}_root_…` and
`an_opencode_root_gets_its_skills_agent_file_and_mcp_entry`, which used
to die at the frontmatter check before reaching its path assertion.

**Also on the branch:** the Windows CI job's `npm test` comment no
longer names this card as the reason it reports instead of gating — the
reason now is the 12-red baseline, none of it platform-specific, and
the step stays a report until the app suite is green on `main`.
CLAUDE.md gained the line-ending trap with the refresh recipe.

**Side observation, not acted on:** git classes
`app/src/lib/cards/bestOfN.ts` and `app/src/lib/review/reviewBoard.ts`
as binary because each carries a literal NUL as a map-key separator.
`text=auto` leaves them alone and they contain no CR, so the pin does
not touch them — but `git diff` on them says "Binary files differ".
