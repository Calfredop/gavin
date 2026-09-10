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
