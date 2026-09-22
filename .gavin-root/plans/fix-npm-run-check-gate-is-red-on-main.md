---
title: [fix] the npm run check CI gate is red on main, on both Linux and Windows
status: To Do
priority: high
complexity: trivial
---
Measured 2026-09-22 on `main` (662e977): `cd app && npm run check` reports
**6 errors** (and 36 warnings) and exits non-zero.

```
src/lib/core/contextMenu.test.ts    104:32  Argument of type '{}' is not assignable to parameter of type 'EventTarget'
src/lib/core/contextMenu.test.ts    110:9   'closest' does not exist in type 'EventTarget'
src/lib/core/contextMenu.test.ts    113:34  'closest' does not exist in type 'EventTarget'
src/lib/review/criticalReview.test.ts 17:30 Cannot find module 'node:fs' or its corresponding type declarations
src/lib/review/criticalReview.test.ts 18:22 Cannot find module 'node:path' or its corresponding type declarations
src/lib/review/criticalReview.test.ts 125:24 Property 'dirname' does not exist on type 'ImportMeta'
```

**Why it matters more than six type errors usually would.** `npm run check`
is a **gate** — no `continue-on-error` — in both CI jobs:
`.github/workflows/ci.yml` runs it bare in `Linux (Rust + app)` and again in
`Windows (compiles)`, where
[feat-windows-port-on-a-windows-machine](./feat-windows-port-on-a-windows-machine.md)
§5 promoted it on the strength of a 0-error measurement on 2026-09-11, with
the comment "A red here is a real regression in the port". None of these six
is the port's: neither file existed when that measurement was taken, and every
error is platform-independent, so the gate fails on Linux too. Every push to
`main` fails CI on a line that is supposed to mean something.

Two ways it can go wrong from here, which is the argument for fixing it rather
than noting it: a permanently-red gate trains everyone to ignore the job, and
the §5 comment makes the next Windows agent read its own red as a port
regression.

## The fix is in the two test files, not in the gate

- `criticalReview.test.ts` reaches for `node:fs`, `node:path` and
  `import.meta.dirname`. It needs node types in scope for the tsconfig
  `npm run check` uses (`app/tsconfig.json`) — check how the other
  source-grep tests that read files raw avoid this; most go through
  `import.meta.glob(..., { query: "?raw" })` and never touch `node:fs`,
  which may be the cheaper fix than widening `types`.
- `contextMenu.test.ts` hands object literals where an `EventTarget` is
  wanted. The production signature is the thing to look at: if what it
  really needs is `{ closest(sel: string): Element | null }`, the parameter
  type is wrong and the test is right.

Do not silence either with `@ts-expect-error` or by taking the gate back off —
the gate is correct and the measurement behind it was correct on the day.

**Check the Linux job as well before closing.** The two jobs run the same
command, so a fix proved locally on Windows settles both, but the Linux job
has been red for the same reason and nobody has said so on a card.
